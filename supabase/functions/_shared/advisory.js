// Kagua Livestock: Farm Advisory shared core (browser + Edge Function).
//
// Real-data only. The advisory pairs ONE zone-linked telemetry record with the
// farm's own camera photo for that record (Fill-out-data or ESP32 snapshot in
// Supabase Storage) and asks Meta models to read it:
//   - SAM 3.1 segments candidate chicken regions (distribution evidence).
//   - Muse Spark vision reads flock distribution across feeders, brooders and
//     free-roam areas, then combines that with the sensor readings into one
//     plain-language advisory with a normal/attention verdict.
//
// No sample, demo or prepared findings exist in this module. When a model call
// fails, buildAdvisory() returns a labelled readings-only template instead of
// inventing visual evidence.

export const ADVISORY_MODE = 'meta';
export const DEFAULT_VISION_MODEL = 'muse-spark-1.3';
export const DEFAULT_SAM_MODEL = 'sam-3.1';
export const MAX_PHOTO_BYTES = 8000000;
export const SIGNED_URL_TTL_SECONDS = 600;

// Metrics backed by real Supabase columns. CO2 is stored by the app inside
// measurements (see the Fill-out-data form); there is no ground-moisture
// column, so it is deliberately not listed here.
export const metrics = [
  { key: 'temperature_c', label: 'Temperature', unit: '°C' },
  { key: 'humidity_pct', label: 'Humidity', unit: '%' },
  { key: 'ammonia_ppm', label: 'Ammonia', unit: 'ppm' },
  { key: 'co2_ppm', label: 'Carbon dioxide', unit: 'ppm' },
];

export const telemetrySelect =
  'id,farm_id,zone_id,device_id,captured_at,temperature_c,humidity_pct,ammonia_ppm,measurements,raw_payload,animal_observation,is_night';
export const snapshotSelect =
  'id,farm_id,zone_id,telemetry_event_id,captured_at,storage_bucket,storage_path,content_type,file_size_bytes,is_night';

// Alert types that count as recognized environmental warnings for the exact
// record being advised. Demo seed types are excluded on purpose.
export const RECOGNIZED_WARNING_TYPES = ['environmental_warning', 'threshold_exceeded'];

export function numeric(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim())) &&
    Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

function isCo2Key(key) {
  const norm = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm.includes('co2') || (norm.includes('carbon') && norm.includes('oxide') && !norm.includes('monoxide'));
}

export function extractCo2(row) {
  for (const source of [row?.measurements, row?.raw_payload]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, raw] of Object.entries(source)) {
      if (!isCo2Key(key)) continue;
      const value = numeric(raw);
      if (value !== null) return value;
    }
  }
  return null;
}

export function readingValues(row) {
  return {
    temperature_c: numeric(row?.temperature_c),
    humidity_pct: numeric(row?.humidity_pct),
    ammonia_ppm: numeric(row?.ammonia_ppm),
    co2_ppm: extractCo2(row),
  };
}

export function evaluateEvidence(row, rules = [], alerts = []) {
  const values = readingValues(row);
  const operators = {
    gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b,
    lte: (a, b) => a <= b, eq: (a, b) => a === b, neq: (a, b) => a !== b,
  };
  const checks = rules.filter(
    rule =>
      rule.farm_id === row.farm_id && rule.enabled === true &&
      (!rule.zone_id || rule.zone_id === row.zone_id) &&
      metrics.some(m => m.key === rule.metric_key) &&
      values[rule.metric_key] !== null && numeric(rule.threshold) !== null &&
      operators[rule.operator]?.(values[rule.metric_key], Number(rule.threshold)),
  );
  const warnings = alerts.filter(
    alert =>
      alert.farm_id === row.farm_id && alert.telemetry_event_id === row.id &&
      (!alert.zone_id || alert.zone_id === row.zone_id) && !alert.resolved_at &&
      RECOGNIZED_WARNING_TYPES.includes(alert.alert_type),
  );
  const severity = [...checks, ...warnings].some(x => x.severity === 'critical')
    ? 'critical'
    : [...checks, ...warnings].some(x => x.severity === 'warning')
      ? 'warning'
      : 'info';
  return {
    values,
    severity,
    checks: checks
      .map(r => ({ id: r.id, metric_key: r.metric_key, operator: r.operator, threshold: Number(r.threshold) }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    warning_ids: warnings.map(a => a.id).sort(),
  };
}

// History contract shared with the farm_image_analyses table and the UI.
export const resultKeys = ['observations', 'concerns', 'next_checks', 'limitations'];

function checkLines(value, key) {
  if (!Array.isArray(value) || value.length > 12 ||
    value.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) {
    throw new Error(`Vision analysis has an invalid ${key} section.`);
  }
  return value.map(item => item.trim());
}

export function validateResult(value) {
  if (!value || typeof value !== 'object' || resultKeys.some(key => !(key in value))) {
    throw new Error('The model returned an invalid analysis. Please try again.');
  }
  return Object.fromEntries(resultKeys.map(key => [key, checkLines(value[key], key)]));
}

// Disease, pathogen and treatment terms that must never appear in generated text.
const FORBIDDEN_TERMS = [
  'influenza', 'avian flu', 'bird flu', 'newcastle', 'gumboro', 'marek', 'coccidiosis',
  'bronchitis', 'mycoplasma', 'salmonella', 'cholera', 'fowl pox', 'laryngotracheitis',
  'virus', 'viral', 'bacteria', 'bacterial', 'infection', 'infected', 'diagnos', 'pathogen',
  'antibiotic', 'vaccin', 'medicine', 'medication', 'dosage', 'dose', 'treatment',
];

export function findForbiddenTerm(text) {
  const lower = ` ${String(text || '').toLowerCase()} `;
  return FORBIDDEN_TERMS.find(term => lower.includes(term)) ?? null;
}

// Strict JSON schema for the Muse Spark vision call: flock distribution plus
// the combined advisory sections and a normal/attention verdict.
export const VISION_SCHEMA = {
  type: 'object',
  properties: {
    distribution: {
      type: 'object',
      description: 'Visible chickens per area. Use 0 when an area shows no birds or cannot be distinguished.',
      properties: {
        total_visible: { type: 'integer', description: 'Chickens clearly visible in the photo.' },
        at_feeders: { type: 'integer', description: 'Visible chickens at feeders or feeding equipment.' },
        in_brooders: { type: 'integer', description: 'Visible chickens inside brooders or brooder houses.' },
        free_roam: { type: 'integer', description: 'Visible chickens on free-roam or open ground.' },
      },
      required: ['total_visible', 'at_feeders', 'in_brooders', 'free_roam'],
      additionalProperties: false,
    },
    behavior_flags: {
      type: 'array',
      description: 'Short observed-behaviour codes, e.g. evenly_spread, huddling, crowding_at_feeders.',
      items: { type: 'string' },
    },
    observations: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    next_checks: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['normal', 'attention'], description: 'Overall flock verdict for this photo and readings.' },
    verdict_reason: { type: 'string', description: 'One plain-language sentence behind the verdict.' },
  },
  required: ['distribution', 'behavior_flags', 'observations', 'concerns', 'next_checks', 'limitations', 'verdict', 'verdict_reason'],
  additionalProperties: false,
};

const VISION_SYSTEM_PROMPT = [
  'You inspect a poultry photo from a farm camera together with its sensor readings.',
  'Count the chickens you can clearly see, split by area: at feeders or feeding equipment,',
  'inside brooders or brooder houses, and on free-roam or open ground. Combine what you see',
  'with the readings into one verdict: "normal" when the flock looks evenly settled for the',
  'conditions, or "attention" when the distribution or readings suggest the farmer should go',
  'and look. Rules you must follow:',
  '- Describe only visible evidence; mark uncertainty instead of guessing.',
  '- Never name, suggest or rule out any disease, pathogen or condition.',
  '- Never recommend medicines, vaccines, doses or treatments.',
  '- Never invent numbers that are not in the input or clearly visible.',
  '- A still photo cannot prove movement, feeding rates, drinking, or change over time.',
  '- Plain language for a farmer, short sentences, no jargon, no alarmist wording.',
].join('\n');

export function buildVisionMessages({ zoneName, values, samRegions, farmerNote, imageUrl }) {
  const payload = {
    zone: zoneName,
    readings: {
      temperature_c: values.temperature_c,
      humidity_pct: values.humidity_pct,
      ammonia_ppm: values.ammonia_ppm,
      co2_ppm: values.co2_ppm,
    },
    sam_candidate_chicken_regions: samRegions,
    farmer_note: farmerNote || null,
  };
  return [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Read this farm photo with its telemetry and return the flock distribution and advisory:\n${JSON.stringify(payload)}` },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];
}

export function validateVisionAnalysis(value) {
  if (!value || typeof value !== 'object') throw new Error('Vision analysis is not an object.');
  const d = value.distribution;
  const intsOk = d && typeof d === 'object' &&
    ['total_visible', 'at_feeders', 'in_brooders', 'free_roam'].every(
      key => Number.isInteger(d[key]) && d[key] >= 0 && d[key] <= 100000,
    );
  if (!intsOk) throw new Error('Vision analysis has an invalid distribution section.');
  if (!['normal', 'attention'].includes(value.verdict)) throw new Error('Vision analysis has an invalid verdict.');
  if (typeof value.verdict_reason !== 'string' || !value.verdict_reason.trim() || value.verdict_reason.length > 500) {
    throw new Error('Vision analysis has an invalid verdict reason.');
  }
  const sections = validateResult(value);
  const behavior_flags = checkLines(value.behavior_flags, 'behavior_flags');
  const texts = [...sections.observations, ...sections.concerns, ...sections.next_checks, ...sections.limitations,
    value.verdict_reason, ...behavior_flags];
  for (const text of texts) {
    const term = findForbiddenTerm(text);
    if (term) throw new Error(`Vision analysis contains forbidden wording ("${term.trim()}").`);
  }
  return {
    distribution: {
      total_visible: d.total_visible, at_feeders: d.at_feeders, in_brooders: d.in_brooders, free_roam: d.free_roam,
    },
    behavior_flags,
    ...sections,
    verdict: value.verdict,
    verdict_reason: value.verdict_reason.trim(),
  };
}

export function advisoryImageRef(snapshot, row) {
  if (snapshot?.id && snapshot?.storage_path) {
    return {
      image_id: `snapshot:${snapshot.id}`,
      image_title: 'Farm camera photo for this reading',
      image_path: snapshot.storage_path,
      revision: 1,
    };
  }
  return { image_id: `reading:${row.id}`, image_title: 'Reading without a linked photo', image_path: '', revision: 1 };
}

function readingsLine(values) {
  return metrics
    .map(metric => `${metric.label}: ${values[metric.key] === null ? 'Unavailable' : `${values[metric.key]} ${metric.unit}`}`)
    .join('; ');
}

function distributionLine(distribution) {
  if (!distribution) return null;
  return `Visible chickens: ${distribution.total_visible} in total — ${distribution.at_feeders} at feeders, ` +
    `${distribution.in_brooders} in brooders, ${distribution.free_roam} free-roam.`;
}

// Assembles the stored advisory. `vision` is the validated Muse Spark result or
// null when model analysis was unavailable; `stages` records what actually ran.
export function buildAdvisory({ row, zoneName, rules = [], alerts = [], snapshot = null, visual = [], vision = null, stages = {} }) {
  if (!row?.id || !row.farm_id || !row.zone_id) throw new Error('Select a zone-linked telemetry record from your farm.');
  const evidence = evaluateEvidence(row, rules, alerts);
  const flagged = evidence.checks.length > 0 || evidence.warning_ids.length > 0;
  const needsAttention = vision?.verdict === 'attention' || flagged;
  const samRegions = visual.find(frame => frame.source === 'sam');
  const samCount = samRegions ? samRegions.boxes.length : null;

  const observations = [];
  const concerns = [];
  const next_checks = [];
  const limitations = [];
  if (vision) {
    observations.push(...vision.observations);
    concerns.push(...vision.concerns);
    next_checks.push(...vision.next_checks);
    limitations.push(...vision.limitations);
    const spread = distributionLine(vision.distribution);
    if (spread) observations.unshift(spread);
    if (samCount !== null) {
      observations.push(`SAM 3.1 segmentation marked ${samCount} candidate chicken region${samCount === 1 ? '' : 's'} in this photo. This is supporting evidence, not a verified flock count.`);
    }
    if (vision.behavior_flags.length) observations.push(`Observed behaviour: ${vision.behavior_flags.join(', ')}.`);
  } else {
    observations.push(`Readings for ${zoneName}: ${readingsLine(evidence.values)}.`);
    if (samCount !== null) {
      observations.push(`SAM 3.1 segmentation marked ${samCount} candidate chicken region${samCount === 1 ? '' : 's'} in the linked photo. This is supporting evidence, not a verified flock count.`);
    }
    if (snapshot) {
      concerns.push('The photo could not be read by the AI models this time, so this advisory covers the sensor readings only.');
    } else {
      concerns.push('No photo is linked to this reading, so this advisory covers the sensor readings only.');
    }
    next_checks.push(
      'Visit the zone and look at how the birds are spread across feeders, brooders and open ground.',
      'If birds look crowded, huddled, or unusually still, stay longer and call your vet if it continues.',
    );
  }
  if (flagged) {
    concerns.push('A configured reading rule or an existing environmental warning matches this record. Review the evidence below and inspect the area.');
  } else if (!vision) {
    concerns.push('No configured rule or recognized warning matches this record. This alone does not establish that conditions are safe.');
  }
  if (stages.vision && stages.vision !== 'ok') limitations.push(`Muse Spark vision: ${stages.vision}.`);
  if (stages.sam && stages.sam !== 'ok' && stages.sam !== 'skipped') limitations.push(`SAM 3.1 segmentation: ${stages.sam}.`);
  limitations.push('A still photo cannot establish movement, feeding or drinking rates, or changes over time.');

  const result = validateResult({
    observations: observations.slice(0, 12),
    concerns: concerns.slice(0, 12),
    next_checks: next_checks.slice(0, 12),
    limitations: limitations.slice(0, 12),
  });
  const verdictText = needsAttention ? 'needs attention' : 'looks normal';
  return {
    version: 2,
    telemetry_event_id: row.id,
    farm_id: row.farm_id,
    zone_id: row.zone_id,
    device_id: row.device_id,
    captured_at: row.captured_at,
    snapshot: snapshot ? { id: snapshot.id, storage_path: snapshot.storage_path, captured_at: snapshot.captured_at } : null,
    evidence,
    visual,
    vision,
    stages,
    generated: vision !== null,
    result,
    title: `Farm advisory · ${zoneName} · ${verdictText}`,
    message: `${readingsLine(evidence.values)}. This record ${verdictText}` +
      `${vision?.verdict_reason ? `: ${vision.verdict_reason}` : '.'}` +
      `${vision ? ` ${distributionLine(vision.distribution)}` : ''}` +
      `${result.concerns[0] ? ` ${result.concerns[0]}` : ''}` +
      `${result.next_checks[0] ? ` ${result.next_checks[0]}` : ''}`,
  };
}

// Parses the documented SAM Responses output grammar:
// https://dev.meta.ai/docs/sam/overview — one line per image, boxes as
// <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|> tokens. Masks are not decoded;
// the advisory stores candidate regions only.
export function parseSamBoxes(payload) {
  if (!payload || payload.error ||
    (typeof payload.output_text !== 'string' && !Array.isArray(payload.output)) ||
    payload.output?.some(item => item.content?.some(part => part.type === 'refusal'))) {
    throw new Error('SAM returned an unsupported response.');
  }
  if (payload?.status && payload.status !== 'completed') throw new Error('SAM did not complete this image.');
  const text = typeof payload?.output_text === 'string'
    ? payload.output_text
    : (payload?.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n');
  if (typeof text !== 'string') throw new Error('SAM returned an unsupported response.');
  const boxes = [];
  for (const match of text.matchAll(/<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/g)) {
    const [x1, y1, x2, y2, width, height] = match.slice(1).map(Number);
    if (!width || !height || x2 < x1 || y2 < y1 || x2 >= width || y2 >= height) {
      throw new Error('SAM returned invalid region coordinates.');
    }
    boxes.push({ x1, y1, x2, y2, width, height });
    if (boxes.length > 1000) throw new Error('Too many SAM regions for this advisory.');
  }
  if (text.trim() && !boxes.length) throw new Error('SAM output could not be read. No advisory was published.');
  return boxes;
}
