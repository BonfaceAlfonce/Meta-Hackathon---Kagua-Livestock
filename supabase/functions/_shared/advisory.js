import { demoImageUrls } from './demo-images.js';
export const advisoryFeeds = demoImageUrls.slice(0, 2).map((url, index) => ({ id: `das-gallery-${index + 1}`, title: `Simulated feed ${index + 1}`, url, revision: 1 }));
export const advisoryImageId = 'das-advisory-pair-v1';
export const telemetrySelect = 'id,farm_id,zone_id,device_id,captured_at,temperature_c,humidity_pct,ammonia_ppm,measurements';
export const metrics = [
  { key: 'temperature_c', label: 'Temperature', unit: '°C' },
  { key: 'humidity_pct', label: 'Humidity', unit: '%' },
  { key: 'ammonia_ppm', label: 'Ammonia', unit: 'ppm' },
  { key: 'ground_moisture_pct', label: 'Ground moisture', unit: '%' },
];
function numeric(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
}
export function readingValues(row) {
  return Object.fromEntries(metrics.map(metric => [metric.key, numeric(metric.key === 'ground_moisture_pct' ? row.measurements?.ground_moisture_pct : row[metric.key])]));
}
export function evaluateEvidence(row, rules = [], alerts = []) {
  const values = readingValues(row);
  const operators = { gt: (a,b) => a>b, gte: (a,b) => a>=b, lt: (a,b) => a<b, lte: (a,b) => a<=b, eq: (a,b) => a===b, neq: (a,b) => a!==b };
  const checks = rules.filter(rule => rule.farm_id === row.farm_id && rule.enabled === true && (!rule.zone_id || rule.zone_id === row.zone_id) && metrics.some(m => m.key === rule.metric_key) && values[rule.metric_key] !== null && numeric(rule.threshold) !== null && operators[rule.operator]?.(values[rule.metric_key], Number(rule.threshold)));
  const warnings = alerts.filter(alert => alert.farm_id === row.farm_id && alert.telemetry_event_id === row.id && (!alert.zone_id || alert.zone_id === row.zone_id) && !alert.resolved_at && ['demo_high_ammonia', 'environmental_warning', 'threshold_exceeded'].includes(alert.alert_type));
  const severity = [...checks, ...warnings].some(x => x.severity === 'critical') ? 'critical' : [...checks, ...warnings].some(x => x.severity === 'warning') ? 'warning' : 'info';
  return { values, severity, checks: checks.map(r => ({ id: r.id, metric_key: r.metric_key, operator: r.operator, threshold: Number(r.threshold) })).sort((a,b) => a.id.localeCompare(b.id)), warning_ids: warnings.map(a => a.id).sort() };
}
// Advisory wording is a closed template. No free-text model or alert message is interpolated.
export function buildAdvisory(row, rules = [], alerts = [], visual = []) {
  if (!row?.id || !row.farm_id || !row.zone_id) throw new Error('Select a zone-linked telemetry record from Das Farm.');
  const evidence = evaluateEvidence(row, rules, alerts);
  const readings = metrics.map(metric => `${metric.label}: ${evidence.values[metric.key] === null ? 'Unavailable' : `${evidence.values[metric.key]} ${metric.unit}`}`).join('; ');
  const flagged = evidence.checks.length > 0 || evidence.warning_ids.length > 0;
  const observations = ['Two owner-supplied reference images are paired with this telemetry record for demonstration; they are not synchronized ground captures.'];
  for (const frame of visual) {
    const feed = advisoryFeeds.find(x => x.id === frame.image_id);
    if (!feed) continue;
    observations.push(frame.source === 'sam' && Array.isArray(frame.boxes)
      ? `${feed.title}: SAM returned ${frame.boxes.length} candidate chicken regions. This is not a verified flock count or behaviour measurement.`
      : `${feed.title}: prepared demonstration input; no SAM inference or verified visual finding is available.`);
  }
  const concerns = flagged
    ? ['An existing environmental warning or configured reading rule is associated with this record. Review the evidence and inspect the area.']
    : ['No matching configured rule or recognized environmental warning was found. This does not establish that conditions are safe.'];
  const next_checks = flagged
    ? ['Inspect bedding and ground condition in the associated zone.', 'Check ventilation equipment operation and review the displayed readings.', 'If you observe concerning signs in the birds, contact your vet.']
    : ['Inspect the associated area and review these readings against the farm’s existing configured limits.', 'If you observe concerning signs in the birds, contact your vet.'];
  const limitations = ['Demo/reference images and predefined telemetry; not verified ground evidence.', 'A still image cannot establish movement, feeding or drinking rates, changes over time, or environmental measurements.', 'Missing values remain unavailable. No additional sensor inputs or new thresholds were created.'];
  return { version: 1, telemetry_event_id: row.id, farm_id: row.farm_id, zone_id: row.zone_id, device_id: row.device_id, captured_at: row.captured_at,
    evidence, visual, feeds: advisoryFeeds, result: { observations, concerns, next_checks, limitations },
    title: `DEMO · Das Farm environmental ${flagged ? 'review' : 'observations'}`,
    message: `DEMO advisory. ${readings}. ${concerns[0]} ${next_checks.join(' ')}` };
}
export function parseSamBoxes(payload) {
  if (!payload || payload.error || (typeof payload.output_text !== 'string' && !Array.isArray(payload.output)) || payload.output?.some(item => item.content?.some(part => part.type === 'refusal'))) throw new Error('SAM returned an unsupported response.');
  if (payload?.status && payload.status !== 'completed') throw new Error('SAM did not complete this image.');
  const text = typeof payload?.output_text === 'string' ? payload.output_text : (payload?.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n');
  if (typeof text !== 'string') throw new Error('SAM returned an unsupported response.');
  const boxes = [];
  for (const match of text.matchAll(/<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/g)) {
    const [x1,y1,x2,y2,width,height] = match.slice(1).map(Number);
    if (!width || !height || x2 < x1 || y2 < y1 || x2 >= width || y2 >= height) throw new Error('SAM returned invalid region coordinates.');
    boxes.push({ x1,y1,x2,y2,width,height });
    if (boxes.length > 1000) throw new Error('Too many SAM regions for this demonstration.');
  }
  if (text.trim() && !boxes.length) throw new Error('SAM output could not be read. No advisory was published.');
  return boxes;
}
