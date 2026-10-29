// Pure view logic for the Outbreak Shield page (unit-tested in outbreakView.test.js).

export const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3 };

export const RISK_META = {
  none: { label: 'No warning signs', tone: 'calm' },
  low: { label: 'Watch', tone: 'watch' },
  medium: { label: 'Elevated', tone: 'elevated' },
  high: { label: 'High risk', tone: 'high' },
};

export const EDITOR_ROLES = new Set(['owner', 'admin', 'operator']);

/** Fixed, approved guidance — never AI-generated. */
export const BIOSECURITY_STEPS = [
  'Keep the affected zone closed; move no birds in or out.',
  'Limit entry to essential staff and record who goes in.',
  'Use a footbath and change boots and clothing between zones.',
  'Clean and disinfect drinkers, feeders and equipment.',
  'Keep dead birds in a sealed container away from the flock.',
  'Pause sales and transfers of birds and eggs from affected zones.',
  'Call your veterinarian and share the summary below.',
];

export function canEdit(role) {
  return EDITOR_ROLES.has(role);
}

/** Calendar day in the farm's timezone, YYYY-MM-DD. Falls back to UTC for unknown zones. */
export function farmToday(timeZone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function formatDay(isoDate) {
  if (!isoDate) return '—';
  const date = new Date(`${isoDate}T12:00:00Z`);
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Most recent assessment day present, and the rows for it. */
export function latestDay(assessments) {
  const day = assessments.reduce((max, row) => (row.assessed_on > max ? row.assessed_on : max), '');
  return { day, rows: day ? assessments.filter((row) => row.assessed_on === day) : [] };
}

export function highestRisk(rows) {
  return rows.reduce((top, row) => (RISK_ORDER[row.risk_level] > RISK_ORDER[top] ? row.risk_level : top), 'none');
}

/** Zones in the order the pattern reached them (rank 1 first). */
export function spreadTimeline(rows, zoneNames) {
  return rows
    .filter((row) => row.is_spreading)
    .map((row) => ({
      zoneId: row.zone_id,
      zoneName: zoneNames.get(row.zone_id) || 'Zone',
      rank: row.signals?.spreadRank ?? Number.MAX_SAFE_INTEGER,
      firstDetectedOn: row.signals?.spreadFirstDetectedOn || row.assessed_on,
      riskLevel: row.risk_level,
    }))
    .sort((a, b) => a.rank - b.rank || a.zoneName.localeCompare(b.zoneName));
}

/** Short, factual lines for a zone card, built only from stored signal values. */
export function zoneFacts(signals = {}) {
  const facts = [];
  if (signals.missingTodayLog) facts.push({ key: 'missing', text: "Today's flock log is missing", tone: 'muted' });
  if (typeof signals.deaths === 'number') {
    const usual = typeof signals.baselineDeaths === 'number' ? ` · usual ${signals.baselineDeaths}` : '';
    facts.push({ key: 'deaths', text: `${signals.deaths} ${signals.deaths === 1 ? 'death' : 'deaths'}${usual}`, tone: signals.mortalitySpike ? 'alert' : 'normal' });
  }
  if (typeof signals.lowestIntakePct === 'number') {
    facts.push({ key: 'intake', text: `Intake ${signals.lowestIntakePct}% of normal`, tone: signals.intakeDrop ? 'alert' : 'normal' });
  }
  if (typeof signals.activityChangePct === 'number') {
    const sign = signals.activityChangePct > 0 ? '+' : '';
    facts.push({ key: 'activity', text: `Activity ${sign}${signals.activityChangePct}%`, tone: signals.activityDrop ? 'alert' : 'normal' });
  }
  if (signals.respiratorySigns) facts.push({ key: 'breathing', text: 'Breathing problems reported', tone: 'alert' });
  if (typeof signals.sickCount === 'number' && signals.sickCount > 0) {
    facts.push({ key: 'sick', text: `${signals.sickCount} sick`, tone: 'normal' });
  }
  return facts;
}

/** Risk per day for one zone over the last `days` days, oldest first (null = not assessed). */
export function zoneHistory(assessments, zoneId, endDay, days = 7) {
  const byDay = new Map(assessments.filter((row) => row.zone_id === zoneId).map((row) => [row.assessed_on, row.risk_level]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.parse(`${endDay}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, riskLevel: byDay.get(day) ?? null });
  }
  return out;
}

function normaliseCounty(value) {
  return (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The newest regional signal for the farm's county, plus how many other counties are on alert. */
export function regionalForFarm(signals, county) {
  const target = normaliseCounty(county);
  const sorted = [...signals].sort((a, b) => (a.window_end < b.window_end ? 1 : a.window_end > b.window_end ? -1 : 0));
  const own = target ? sorted.find((s) => normaliseCounty(s.county) === target) ?? null : null;
  const newestEnd = sorted[0]?.window_end;
  const others = sorted.filter((s) => s.window_end === newestEnd && normaliseCounty(s.county) !== target).length;
  return { own, otherCounties: others };
}

export function aiBadge(status) {
  if (status === 'generated') return { label: 'Explained by Muse Spark', ai: true };
  if (status === 'fallback') return { label: 'Standard summary', ai: false };
  return { label: 'Explanation pending', ai: false };
}

const PERCENT_FIELDS = ['feedIntakePct', 'waterIntakePct'];

/**
 * Validates the daily log form. Returns { errors, row } where `row` is ready for
 * flock_health_logs. Mirrors the database checks so users get instant feedback.
 */
export function validateLog(form) {
  const errors = {};
  const toInt = (value) => (value === '' || value === null || value === undefined ? null : Number(value));
  const flockSize = toInt(form.flockSize);
  const deaths = toInt(form.deaths);
  const sickCount = toInt(form.sickCount) ?? 0;

  if (!form.zoneId) errors.zoneId = 'Choose a zone.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.logDate || '')) errors.logDate = 'Choose a date.';
  if (flockSize !== null && (!Number.isInteger(flockSize) || flockSize <= 0)) errors.flockSize = 'Enter a whole number above 0.';
  if (deaths === null) errors.deaths = 'Enter deaths (0 if none).';
  else if (!Number.isInteger(deaths) || deaths < 0) errors.deaths = 'Enter a whole number, 0 or more.';
  if (!Number.isInteger(sickCount) || sickCount < 0) errors.sickCount = 'Enter a whole number, 0 or more.';
  if (!errors.deaths && !errors.sickCount && !errors.flockSize && flockSize !== null && deaths + sickCount > flockSize) {
    errors.deaths = 'Deaths plus sick birds cannot exceed the flock size.';
  }
  const percents = {};
  for (const field of PERCENT_FIELDS) {
    const value = toInt(form[field]);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 200)) errors[field] = 'Enter 0–200 (100 = normal).';
    percents[field] = value;
  }
  const notes = (form.notes || '').trim();
  if (notes.length > 1000) errors.notes = 'Keep notes under 1000 characters.';

  if (Object.keys(errors).length) return { errors, row: null };
  return {
    errors,
    row: {
      zone_id: form.zoneId,
      log_date: form.logDate,
      flock_size: flockSize,
      deaths,
      sick_count: sickCount,
      feed_intake_pct: percents.feedIntakePct,
      water_intake_pct: percents.waterIntakePct,
      respiratory_signs: Boolean(form.respiratorySigns),
      notes: notes || null,
      source: 'farmer',
    },
  };
}
