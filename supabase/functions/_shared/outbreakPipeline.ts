/**
 * Outbreak Shield — pure data shaping between Supabase rows and the scoring module.
 * No I/O, so the whole pipeline is unit-testable in Vitest and reused by the Edge Function.
 */
import {
  addDays,
  assessZone,
  DEFAULT_CONFIG,
  detectSpread,
  isAtLeast,
  type DailyActivity,
  type DailyFlockLog,
  type FarmWindowRisk,
  type RiskLevel,
  type ScoringConfig,
  type ZoneDayRisk,
} from './outbreakScoring.ts';

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** Converts an instant to the farm's local calendar day. Unknown timezones fall back to UTC. */
export function localDate(instant: string | Date, timeZone: string): string {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(typeof instant === 'string' ? new Date(instant) : instant);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface FlockLogRow {
  zone_id: string;
  log_date: string;
  flock_size: number | string | null;
  deaths: number | string;
  sick_count: number | string;
  feed_intake_pct: number | string | null;
  water_intake_pct: number | string | null;
  respiratory_signs: boolean;
}

export function toFlockLog(row: FlockLogRow): DailyFlockLog {
  return {
    logDate: row.log_date,
    flockSize: toNumberOrNull(row.flock_size),
    deaths: toNumberOrNull(row.deaths) ?? 0,
    sickCount: toNumberOrNull(row.sick_count) ?? 0,
    feedIntakePct: toNumberOrNull(row.feed_intake_pct),
    waterIntakePct: toNumberOrNull(row.water_intake_pct),
    respiratorySigns: Boolean(row.respiratory_signs),
  };
}

export interface TelemetryRow {
  zone_id: string | null;
  captured_at: string;
  activity_level: number | string | null;
}

/** Averages activity per zone per local day. O(n). */
export function dailyActivityByZone(rows: TelemetryRow[], timeZone: string): Map<string, DailyActivity[]> {
  const sums = new Map<string, Map<string, { total: number; count: number }>>();
  for (const row of rows) {
    const level = toNumberOrNull(row.activity_level);
    if (!row.zone_id || level === null) continue;
    const day = localDate(row.captured_at, timeZone);
    let byDay = sums.get(row.zone_id);
    if (!byDay) sums.set(row.zone_id, (byDay = new Map()));
    const acc = byDay.get(day) ?? { total: 0, count: 0 };
    acc.total += level;
    acc.count += 1;
    byDay.set(day, acc);
  }
  const result = new Map<string, DailyActivity[]>();
  for (const [zoneId, byDay] of sums) {
    result.set(zoneId, [...byDay].map(([date, { total, count }]) => ({ date, activityLevel: total / count })));
  }
  return result;
}

export interface AssessmentRow {
  farm_id: string;
  zone_id: string;
  assessed_on: string;
  risk_level: RiskLevel;
  score: number;
  signals: Record<string, unknown>;
  is_spreading: boolean;
  ai_status: 'pending';
  ai_summary: null;
  ai_farmer_message: null;
  ai_vet_summary: null;
}

/**
 * Scores every zone of one farm for `assessedOn` and marks spread using
 * today's results plus previously stored results inside the spread window.
 */
export function buildFarmAssessments(
  input: {
    farmId: string;
    assessedOn: string;
    zoneIds: string[];
    logs: FlockLogRow[];
    telemetry: TelemetryRow[];
    timeZone: string;
    previousRisks: ZoneDayRisk[];
  },
  config: ScoringConfig = DEFAULT_CONFIG,
): AssessmentRow[] {
  const logsByZone = new Map<string, DailyFlockLog[]>();
  for (const row of input.logs) {
    const list = logsByZone.get(row.zone_id) ?? [];
    list.push(toFlockLog(row));
    logsByZone.set(row.zone_id, list);
  }
  const activityByZone = dailyActivityByZone(input.telemetry, input.timeZone);

  const assessed = input.zoneIds.map((zoneId) => ({
    zoneId,
    result: assessZone(
      { assessedOn: input.assessedOn, logs: logsByZone.get(zoneId) ?? [], activity: activityByZone.get(zoneId) ?? [] },
      config,
    ),
  }));

  const todayRisks: ZoneDayRisk[] = assessed.map(({ zoneId, result }) => ({
    zoneId,
    assessedOn: input.assessedOn,
    riskLevel: result.riskLevel,
  }));
  const spread = detectSpread([...input.previousRisks, ...todayRisks], input.assessedOn, config);
  const spreadRank = new Map(spread.zones.map((z, i) => [z.zoneId, { rank: i + 1, firstDetectedOn: z.firstDetectedOn }]));

  return assessed.map(({ zoneId, result }) => {
    const spreadInfo = spreadRank.get(zoneId);
    return {
      farm_id: input.farmId,
      zone_id: zoneId,
      assessed_on: input.assessedOn,
      risk_level: result.riskLevel,
      score: result.score,
      signals: {
        ...result.signals,
        spreadRank: spread.isSpreading && spreadInfo ? spreadInfo.rank : null,
        spreadFirstDetectedOn: spread.isSpreading && spreadInfo ? spreadInfo.firstDetectedOn : null,
        thresholdsVersion: 'default-v1',
      },
      is_spreading: spread.isSpreading && spreadInfo !== undefined && isAtLeast(result.riskLevel, 'medium'),
      ai_status: 'pending',
      ai_summary: null,
      ai_farmer_message: null,
      ai_vet_summary: null,
    };
  });
}

type FarmLocation = { country_code: string; county: string | null };

export interface RegionalAssessmentRow {
  farm_id: string;
  risk_level: RiskLevel;
  /** PostgREST returns an object for this many-to-one join; untyped clients model it as an array. */
  farms: FarmLocation | FarmLocation[] | null;
}

/** Reduces assessment rows to each farm's peak risk for the regional window. O(n). */
export function peakRiskPerFarm(rows: RegionalAssessmentRow[]): FarmWindowRisk[] {
  const order: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };
  const byFarm = new Map<string, FarmWindowRisk>();
  for (const row of rows) {
    const location = Array.isArray(row.farms) ? row.farms[0] : row.farms;
    if (!location) continue;
    const current = byFarm.get(row.farm_id);
    if (!current || order[row.risk_level] > order[current.peakRiskLevel]) {
      byFarm.set(row.farm_id, {
        farmId: row.farm_id,
        countryCode: location.country_code,
        county: location.county,
        peakRiskLevel: row.risk_level,
      });
    }
  }
  return [...byFarm.values()];
}

/** Inclusive date range for the regional window ending on `asOf`. */
export function regionalWindow(asOf: string, days = 7): { windowStart: string; windowEnd: string } {
  return { windowStart: addDays(asOf, -(days - 1)), windowEnd: asOf };
}

/** Constant-time string comparison for shared secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
