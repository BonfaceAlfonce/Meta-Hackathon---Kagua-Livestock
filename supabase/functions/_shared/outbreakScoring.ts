/**
 * Outbreak Shield — deterministic scoring.
 *
 * Pure functions with no I/O and no dependencies, so they run unchanged in the
 * Supabase Edge Function (Deno) and in Vitest (Node).
 *
 * The language model never decides a risk level; it only explains results
 * produced here. Thresholds are configurable defaults for flagging patterns
 * that deserve follow-up — they are not validated veterinary thresholds and
 * this module never produces a diagnosis.
 *
 * Dates are ISO calendar days ("YYYY-MM-DD") in the farm's local timezone;
 * the caller converts timestamps before calling these functions.
 */

export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface DailyFlockLog {
  logDate: string;
  flockSize: number | null;
  deaths: number;
  sickCount: number;
  /** Percent of the flock's normal intake (100 = normal). */
  feedIntakePct: number | null;
  /** Percent of the flock's normal intake (100 = normal). */
  waterIntakePct: number | null;
  respiratorySigns: boolean;
}

export interface DailyActivity {
  date: string;
  /** Mean of telemetry_events.activity_level for that day, or null if no readings. */
  activityLevel: number | null;
}

export interface ScoringConfig {
  baselineDays: number;
  minBaselineDays: number;
  minDeathsForSpike: number;
  deathMultiplier: number;
  /** Daily deaths as a fraction of flock size that always counts as a spike. */
  dailyMortalityFraction: number;
  activityDropFraction: number;
  /** Intake at or below this percent of normal counts as a drop. */
  intakeDropPct: number;
  weights: { mortality: number; activity: number; intake: number; respiratory: number };
  levels: { low: number; medium: number; high: number };
  spreadWindowDays: number;
  minFarmsForRegionalSignal: number;
  minHighFarmsForRegionalHigh: number;
}

export const DEFAULT_CONFIG: Readonly<ScoringConfig> = Object.freeze({
  baselineDays: 7,
  minBaselineDays: 3,
  minDeathsForSpike: 3,
  deathMultiplier: 3,
  dailyMortalityFraction: 0.01,
  activityDropFraction: 0.3,
  intakeDropPct: 80,
  weights: Object.freeze({ mortality: 4, activity: 2, intake: 2, respiratory: 2 }),
  levels: Object.freeze({ low: 2, medium: 4, high: 6 }),
  spreadWindowDays: 2,
  minFarmsForRegionalSignal: 3,
  minHighFarmsForRegionalHigh: 2,
}) as ScoringConfig;

/** `null` means "not enough data to evaluate", which is different from `false`. */
export interface ZoneSignals {
  mortalitySpike: boolean | null;
  activityDrop: boolean | null;
  intakeDrop: boolean | null;
  respiratorySigns: boolean | null;
  deaths: number | null;
  deathThreshold: number | null;
  baselineDeaths: number | null;
  activityChangePct: number | null;
  lowestIntakePct: number | null;
  sickCount: number | null;
  missingTodayLog: boolean;
  usedFallbackBaseline: boolean;
}

export interface ZoneAssessment {
  assessedOn: string;
  riskLevel: RiskLevel;
  score: number;
  signals: ZoneSignals;
}

const RISK_ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

export function isAtLeast(level: RiskLevel, minimum: RiskLevel): boolean {
  return RISK_ORDER[level] >= RISK_ORDER[minimum];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new RangeError(`${label} must be an ISO date (YYYY-MM-DD), got "${value}"`);
  }
}

/** Calendar-day arithmetic in UTC so local timezones and DST never shift results. */
export function addDays(isoDate: string, days: number): string {
  const time = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Scores one zone for one day. O(n) in the number of logs/activity rows passed.
 */
export function assessZone(
  input: { assessedOn: string; logs: DailyFlockLog[]; activity?: DailyActivity[] },
  config: ScoringConfig = DEFAULT_CONFIG,
): ZoneAssessment {
  const { assessedOn, logs, activity = [] } = input;
  assertIsoDate(assessedOn, 'assessedOn');

  const windowStart = addDays(assessedOn, -config.baselineDays);
  const inBaseline = (date: string) => date >= windowStart && date < assessedOn;

  let today: DailyFlockLog | undefined;
  const baselineDeaths: number[] = [];
  for (const log of logs) {
    if (log.logDate === assessedOn) today = log;
    else if (inBaseline(log.logDate) && isFiniteNumber(log.deaths) && log.deaths >= 0) {
      baselineDeaths.push(log.deaths);
    }
  }

  const signals: ZoneSignals = {
    mortalitySpike: null,
    activityDrop: null,
    intakeDrop: null,
    respiratorySigns: null,
    deaths: null,
    deathThreshold: null,
    baselineDeaths: null,
    activityChangePct: null,
    lowestIntakePct: null,
    sickCount: null,
    missingTodayLog: !today,
    usedFallbackBaseline: false,
  };

  if (today) {
    signals.deaths = today.deaths;
    signals.sickCount = today.sickCount;
    signals.respiratorySigns = today.respiratorySigns;

    let threshold: number;
    if (baselineDeaths.length >= config.minBaselineDays) {
      const baseline = median(baselineDeaths);
      signals.baselineDeaths = baseline;
      threshold = Math.max(config.minDeathsForSpike, Math.ceil(config.deathMultiplier * baseline));
    } else {
      // New flock or gaps in logging: no reliable history, so use a fixed floor.
      signals.usedFallbackBaseline = true;
      threshold = config.minDeathsForSpike;
    }
    signals.deathThreshold = threshold;

    const fractionSpike =
      isFiniteNumber(today.flockSize) && today.flockSize > 0 &&
      today.deaths / today.flockSize >= config.dailyMortalityFraction;
    signals.mortalitySpike = today.deaths >= threshold || fractionSpike;

    const intakes = [today.feedIntakePct, today.waterIntakePct].filter(isFiniteNumber);
    if (intakes.length) {
      signals.lowestIntakePct = Math.min(...intakes);
      signals.intakeDrop = signals.lowestIntakePct <= config.intakeDropPct;
    }
  }

  const todayActivity = activity.find((a) => a.date === assessedOn)?.activityLevel;
  const baselineActivity = activity
    .filter((a) => inBaseline(a.date) && isFiniteNumber(a.activityLevel))
    .map((a) => a.activityLevel as number);
  if (isFiniteNumber(todayActivity) && baselineActivity.length >= config.minBaselineDays) {
    const reference = mean(baselineActivity);
    if (reference > 0) {
      const change = (todayActivity - reference) / reference;
      signals.activityChangePct = Math.round(change * 1000) / 10;
      signals.activityDrop = change <= -config.activityDropFraction;
    }
  }

  const { weights, levels } = config;
  const score =
    (signals.mortalitySpike ? weights.mortality : 0) +
    (signals.activityDrop ? weights.activity : 0) +
    (signals.intakeDrop ? weights.intake : 0) +
    (signals.respiratorySigns ? weights.respiratory : 0);

  let riskLevel: RiskLevel = 'none';
  if (score >= levels.low) riskLevel = 'low';
  if (score >= levels.medium) riskLevel = 'medium';
  // High requires a mortality spike corroborated by at least one other signal,
  // so no single noisy input can trigger the strongest alert.
  if (score >= levels.high && signals.mortalitySpike) riskLevel = 'high';

  return { assessedOn, riskLevel, score, signals };
}

export interface ZoneDayRisk {
  zoneId: string;
  assessedOn: string;
  riskLevel: RiskLevel;
}

export interface SpreadResult {
  isSpreading: boolean;
  /** Zones at medium+ within the window, ordered by first detection (then zoneId for stability). */
  zones: { zoneId: string; firstDetectedOn: string; peakRiskLevel: RiskLevel }[];
}

/**
 * Detects within-farm spread: two or more zones at medium+ inside the window
 * ending on `asOf` (inclusive). O(n) plus a sort of the affected zones.
 */
export function detectSpread(
  risks: ZoneDayRisk[],
  asOf: string,
  config: ScoringConfig = DEFAULT_CONFIG,
): SpreadResult {
  assertIsoDate(asOf, 'asOf');
  const windowStart = addDays(asOf, -(config.spreadWindowDays - 1));
  const byZone = new Map<string, { firstDetectedOn: string; peakRiskLevel: RiskLevel }>();

  for (const r of risks) {
    if (r.assessedOn < windowStart || r.assessedOn > asOf || !isAtLeast(r.riskLevel, 'medium')) continue;
    const current = byZone.get(r.zoneId);
    if (!current) {
      byZone.set(r.zoneId, { firstDetectedOn: r.assessedOn, peakRiskLevel: r.riskLevel });
    } else {
      if (r.assessedOn < current.firstDetectedOn) current.firstDetectedOn = r.assessedOn;
      if (RISK_ORDER[r.riskLevel] > RISK_ORDER[current.peakRiskLevel]) current.peakRiskLevel = r.riskLevel;
    }
  }

  const zones = [...byZone.entries()]
    .map(([zoneId, v]) => ({ zoneId, ...v }))
    .sort((a, b) => a.firstDetectedOn.localeCompare(b.firstDetectedOn) || a.zoneId.localeCompare(b.zoneId));

  return { isSpreading: zones.length >= 2, zones };
}

export interface FarmWindowRisk {
  farmId: string;
  countryCode: string;
  county: string | null;
  /** Highest zone risk on this farm during the regional window. */
  peakRiskLevel: RiskLevel;
}

export interface RegionalSignal {
  countryCode: string;
  county: string;
  farmsAffected: number;
  farmsHigh: number;
  riskLevel: Extract<RiskLevel, 'medium' | 'high'>;
}

/**
 * Groups farms by country + county and emits a signal only when at least
 * `minFarmsForRegionalSignal` distinct farms are at medium+. Output contains
 * aggregates only — never farm identifiers. O(n).
 */
export function aggregateRegional(
  farms: FarmWindowRisk[],
  config: ScoringConfig = DEFAULT_CONFIG,
): RegionalSignal[] {
  const groups = new Map<string, { countryCode: string; county: string; farms: Map<string, RiskLevel> }>();

  for (const f of farms) {
    const county = f.county?.trim().replace(/\s+/g, ' ');
    if (!county || !isAtLeast(f.peakRiskLevel, 'medium')) continue;
    const countryCode = f.countryCode.trim().toUpperCase();
    const key = `${countryCode}|${county.toLowerCase()}`;

    let group = groups.get(key);
    if (!group) {
      group = { countryCode, county, farms: new Map() };
      groups.set(key, group);
    }
    const previous = group.farms.get(f.farmId);
    if (!previous || RISK_ORDER[f.peakRiskLevel] > RISK_ORDER[previous]) group.farms.set(f.farmId, f.peakRiskLevel);
  }

  const signals: RegionalSignal[] = [];
  for (const { countryCode, county, farms: members } of groups.values()) {
    if (members.size < config.minFarmsForRegionalSignal) continue;
    const farmsHigh = [...members.values()].filter((level) => level === 'high').length;
    signals.push({
      countryCode,
      county,
      farmsAffected: members.size,
      farmsHigh,
      riskLevel: farmsHigh >= config.minHighFarmsForRegionalHigh ? 'high' : 'medium',
    });
  }
  return signals.sort((a, b) => b.farmsAffected - a.farmsAffected || a.county.localeCompare(b.county));
}
