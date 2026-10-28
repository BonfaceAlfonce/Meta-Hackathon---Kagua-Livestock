import { describe, expect, it } from 'vitest';
import {
  buildFarmAssessments,
  dailyActivityByZone,
  localDate,
  peakRiskPerFarm,
  regionalWindow,
  timingSafeEqual,
  toFlockLog,
  type FlockLogRow,
} from './outbreakPipeline.ts';
import { addDays } from './outbreakScoring.ts';

const TODAY = '2026-10-28';

function logRow(zoneId: string, daysAgo: number, overrides: Partial<FlockLogRow> = {}): FlockLogRow {
  return {
    zone_id: zoneId,
    log_date: addDays(TODAY, -daysAgo),
    flock_size: 500,
    deaths: 1,
    sick_count: 0,
    feed_intake_pct: 100,
    water_intake_pct: 100,
    respiratory_signs: false,
    ...overrides,
  };
}

const normalWeek = (zoneId: string) => [1, 2, 3, 4, 5, 6, 7].map((d) => logRow(zoneId, d));

describe('localDate', () => {
  it('uses the farm timezone, not UTC', () => {
    // 22:30 UTC on Oct 27 is already Oct 28 in Nairobi (UTC+3).
    expect(localDate('2026-10-27T22:30:00Z', 'Africa/Nairobi')).toBe('2026-10-28');
    expect(localDate('2026-10-27T22:30:00Z', 'UTC')).toBe('2026-10-27');
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(localDate('2026-10-27T22:30:00Z', 'Not/AZone')).toBe('2026-10-27');
  });
});

describe('toFlockLog', () => {
  it('converts numeric strings from Postgres and keeps unknown intake as null', () => {
    expect(toFlockLog(logRow('z', 0, { deaths: '4', feed_intake_pct: '72.50', water_intake_pct: null }))).toMatchObject({
      deaths: 4,
      feedIntakePct: 72.5,
      waterIntakePct: null,
    });
  });
});

describe('dailyActivityByZone', () => {
  it('averages readings per zone per local day and skips unusable rows', () => {
    const result = dailyActivityByZone(
      [
        { zone_id: 'a', captured_at: '2026-10-28T06:00:00Z', activity_level: 40 },
        { zone_id: 'a', captured_at: '2026-10-28T12:00:00Z', activity_level: '60' },
        { zone_id: 'a', captured_at: '2026-10-27T22:00:00Z', activity_level: 30 }, // Oct 28 in Nairobi
        { zone_id: null, captured_at: '2026-10-28T06:00:00Z', activity_level: 99 },
        { zone_id: 'a', captured_at: '2026-10-28T07:00:00Z', activity_level: null },
      ],
      'Africa/Nairobi',
    );
    expect(result.get('a')).toEqual([{ date: '2026-10-28', activityLevel: 130 / 3 }]);
    expect(result.size).toBe(1);
  });
});

describe('buildFarmAssessments', () => {
  const base = { farmId: 'farm-1', assessedOn: TODAY, telemetry: [], timeZone: 'Africa/Nairobi', previousRisks: [] };

  it('produces one row per zone, including zones with no logs', () => {
    const rows = buildFarmAssessments({ ...base, zoneIds: ['a', 'b'], logs: [...normalWeek('a'), logRow('a', 0)] });
    expect(rows.map((r) => [r.zone_id, r.risk_level])).toEqual([['a', 'none'], ['b', 'none']]);
    expect(rows[1].signals.missingTodayLog).toBe(true);
    expect(rows.every((r) => r.ai_status === 'pending' && r.ai_summary === null)).toBe(true);
  });

  it('marks spread across zones using stored results from yesterday', () => {
    const rows = buildFarmAssessments({
      ...base,
      zoneIds: ['a', 'b'],
      logs: [...normalWeek('a'), ...normalWeek('b'), logRow('a', 0), logRow('b', 0, { deaths: 15, water_intake_pct: 55 })],
      previousRisks: [{ zoneId: 'a', assessedOn: addDays(TODAY, -1), riskLevel: 'high' }],
    });
    const zoneB = rows.find((r) => r.zone_id === 'b')!;
    expect(zoneB.risk_level).toBe('high');
    expect(zoneB.is_spreading).toBe(true);
    expect(zoneB.signals.spreadRank).toBe(2);
    // The farm-wide start date is the earliest affected zone, not this zone's own first day.
    expect(zoneB.signals.spreadFirstDetectedOn).toBe(TODAY);
    expect(zoneB.signals.spreadStartedOn).toBe(addDays(TODAY, -1));
    // Zone A recovered today, so it is not flagged as spreading now.
    expect(rows.find((r) => r.zone_id === 'a')!.is_spreading).toBe(false);
  });

  it('does not mark spread for a single affected zone', () => {
    const rows = buildFarmAssessments({
      ...base,
      zoneIds: ['a', 'b'],
      logs: [...normalWeek('a'), ...normalWeek('b'), logRow('a', 0), logRow('b', 0, { deaths: 15, water_intake_pct: 55 })],
    });
    expect(rows.some((r) => r.is_spreading)).toBe(false);
  });
});

describe('peakRiskPerFarm', () => {
  it('keeps each farm once at its highest risk and skips rows without farm data', () => {
    const result = peakRiskPerFarm([
      { farm_id: 'f1', risk_level: 'medium', farms: { country_code: 'KE', county: 'Kiambu' } },
      { farm_id: 'f1', risk_level: 'high', farms: { country_code: 'KE', county: 'Kiambu' } },
      { farm_id: 'f2', risk_level: 'high', farms: null },
    ]);
    expect(result).toEqual([{ farmId: 'f1', countryCode: 'KE', county: 'Kiambu', peakRiskLevel: 'high' }]);
  });

  it('accepts the join as an object or a one-element array', () => {
    const result = peakRiskPerFarm([
      { farm_id: 'f1', risk_level: 'high', farms: [{ country_code: 'KE', county: 'Nakuru' }] },
      { farm_id: 'f2', risk_level: 'medium', farms: [] },
    ]);
    expect(result).toEqual([{ farmId: 'f1', countryCode: 'KE', county: 'Nakuru', peakRiskLevel: 'high' }]);
  });
});

describe('helpers', () => {
  it('builds an inclusive 7-day regional window', () => {
    expect(regionalWindow(TODAY)).toEqual({ windowStart: '2026-10-22', windowEnd: TODAY });
  });

  it('compares secrets without short-circuiting', () => {
    expect(timingSafeEqual('s3cret-value', 's3cret-value')).toBe(true);
    expect(timingSafeEqual('s3cret-value', 's3cret-valuX')).toBe(false);
    expect(timingSafeEqual('short', 'longer-secret')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
