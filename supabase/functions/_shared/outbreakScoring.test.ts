import { describe, expect, it } from 'vitest';
import {
  addDays,
  aggregateRegional,
  assessZone,
  DEFAULT_CONFIG,
  detectSpread,
  type DailyActivity,
  type DailyFlockLog,
  type FarmWindowRisk,
} from './outbreakScoring.ts';

const TODAY = '2026-10-28';

function log(daysAgo: number, overrides: Partial<DailyFlockLog> = {}): DailyFlockLog {
  return {
    logDate: addDays(TODAY, -daysAgo),
    flockSize: 500,
    deaths: 1,
    sickCount: 0,
    feedIntakePct: 100,
    waterIntakePct: 100,
    respiratorySigns: false,
    ...overrides,
  };
}

/** Seven normal days of history (1 death/day) plus today's log. */
function history(today: Partial<DailyFlockLog>): DailyFlockLog[] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => log(d)).concat(log(0, today));
}

function activityHistory(todayLevel: number | null, baseline = 50): DailyActivity[] {
  return [1, 2, 3, 4, 5, 6, 7]
    .map((d): DailyActivity => ({ date: addDays(TODAY, -d), activityLevel: baseline }))
    .concat({ date: TODAY, activityLevel: todayLevel });
}

describe('assessZone', () => {
  it('returns none on a normal day', () => {
    const result = assessZone({ assessedOn: TODAY, logs: history({}), activity: activityHistory(50) });
    expect(result.riskLevel).toBe('none');
    expect(result.score).toBe(0);
    expect(result.signals.mortalitySpike).toBe(false);
    expect(result.signals.baselineDeaths).toBe(1);
    expect(result.signals.deathThreshold).toBe(3);
  });

  it('never rates a single signal as high — a mortality spike alone is medium', () => {
    const result = assessZone({ assessedOn: TODAY, logs: history({ deaths: 12 }) });
    expect(result.signals.mortalitySpike).toBe(true);
    expect(result.riskLevel).toBe('medium');
  });

  it('rates a mortality spike corroborated by an intake drop as high', () => {
    const result = assessZone({ assessedOn: TODAY, logs: history({ deaths: 12, waterIntakePct: 60 }) });
    expect(result.signals.intakeDrop).toBe(true);
    expect(result.signals.lowestIntakePct).toBe(60);
    expect(result.riskLevel).toBe('high');
  });

  it('rates a mortality spike plus an activity drop as high', () => {
    const result = assessZone({
      assessedOn: TODAY,
      logs: history({ deaths: 12 }),
      activity: activityHistory(30),
    });
    expect(result.signals.activityDrop).toBe(true);
    expect(result.signals.activityChangePct).toBe(-40);
    expect(result.riskLevel).toBe('high');
  });

  it('caps at medium without a mortality spike, even with every other signal', () => {
    const result = assessZone({
      assessedOn: TODAY,
      logs: history({ feedIntakePct: 50, respiratorySigns: true }),
      activity: activityHistory(20),
    });
    expect(result.score).toBe(6);
    expect(result.riskLevel).toBe('medium');
  });

  it('rates one non-mortality signal as low', () => {
    const result = assessZone({ assessedOn: TODAY, logs: history({ respiratorySigns: true }) });
    expect(result.riskLevel).toBe('low');
  });

  it('scales the threshold with the baseline so a high-normal flock is not flagged', () => {
    const logs = [1, 2, 3, 4, 5, 6, 7].map((d) => log(d, { deaths: 4, flockSize: 2000 }));
    logs.push(log(0, { deaths: 10, flockSize: 2000 }));
    const result = assessZone({ assessedOn: TODAY, logs });
    expect(result.signals.deathThreshold).toBe(12);
    expect(result.signals.mortalitySpike).toBe(false);
  });

  it('flags a spike when daily deaths reach 1% of the flock, even above the threshold baseline', () => {
    const logs = [1, 2, 3, 4, 5, 6, 7].map((d) => log(d, { deaths: 2, flockSize: 300 }));
    logs.push(log(0, { deaths: 3, flockSize: 300 }));
    const result = assessZone({ assessedOn: TODAY, logs });
    expect(result.signals.mortalitySpike).toBe(true);
  });

  it('uses the fallback floor when there is too little history', () => {
    const result = assessZone({ assessedOn: TODAY, logs: [log(1), log(0, { deaths: 3, flockSize: 1000 })] });
    expect(result.signals.usedFallbackBaseline).toBe(true);
    expect(result.signals.deathThreshold).toBe(DEFAULT_CONFIG.minDeathsForSpike);
    expect(result.signals.mortalitySpike).toBe(true);
  });

  it('ignores history outside the baseline window', () => {
    const old = [10, 11, 12, 13].map((d) => log(d, { deaths: 50 }));
    const result = assessZone({ assessedOn: TODAY, logs: [...old, log(0, { deaths: 3 })] });
    expect(result.signals.usedFallbackBaseline).toBe(true);
  });

  it('reports unknown (null), not false, when today has no log', () => {
    const result = assessZone({ assessedOn: TODAY, logs: [log(1), log(2), log(3)] });
    expect(result.signals.missingTodayLog).toBe(true);
    expect(result.signals.mortalitySpike).toBeNull();
    expect(result.signals.intakeDrop).toBeNull();
    expect(result.riskLevel).toBe('none');
  });

  it('leaves intake unknown when neither intake value was recorded', () => {
    const result = assessZone({ assessedOn: TODAY, logs: history({ feedIntakePct: null, waterIntakePct: null }) });
    expect(result.signals.intakeDrop).toBeNull();
  });

  it('leaves activity unknown with missing readings or a zero baseline', () => {
    expect(assessZone({ assessedOn: TODAY, logs: history({}), activity: activityHistory(null) }).signals.activityDrop).toBeNull();
    expect(assessZone({ assessedOn: TODAY, logs: history({}), activity: activityHistory(10, 0) }).signals.activityDrop).toBeNull();
  });

  it('rejects malformed dates', () => {
    expect(() => assessZone({ assessedOn: '28/10/2026', logs: [] })).toThrow(RangeError);
  });
});

describe('detectSpread', () => {
  it('detects spread when two zones reach medium+ within the window, ordered by first detection', () => {
    const result = detectSpread(
      [
        { zoneId: 'zone-b', assessedOn: TODAY, riskLevel: 'high' },
        { zoneId: 'zone-a', assessedOn: addDays(TODAY, -1), riskLevel: 'medium' },
        { zoneId: 'zone-a', assessedOn: TODAY, riskLevel: 'high' },
      ],
      TODAY,
    );
    expect(result.isSpreading).toBe(true);
    expect(result.zones.map((z) => z.zoneId)).toEqual(['zone-a', 'zone-b']);
    expect(result.zones[0]).toMatchObject({ firstDetectedOn: addDays(TODAY, -1), peakRiskLevel: 'high' });
  });

  it('does not report spread for zones outside the window or below medium', () => {
    const result = detectSpread(
      [
        { zoneId: 'zone-a', assessedOn: TODAY, riskLevel: 'high' },
        { zoneId: 'zone-b', assessedOn: addDays(TODAY, -2), riskLevel: 'high' },
        { zoneId: 'zone-c', assessedOn: TODAY, riskLevel: 'low' },
      ],
      TODAY,
    );
    expect(result.isSpreading).toBe(false);
    expect(result.zones).toHaveLength(1);
  });
});

describe('aggregateRegional', () => {
  const farm = (farmId: string, county: string | null, peakRiskLevel: FarmWindowRisk['peakRiskLevel']): FarmWindowRisk => ({
    farmId,
    countryCode: 'ke',
    county,
    peakRiskLevel,
  });

  it('emits a signal when 3 farms in a county are medium+', () => {
    const [signal] = aggregateRegional([
      farm('f1', 'Kiambu', 'high'),
      farm('f2', 'Kiambu', 'medium'),
      farm('f3', 'Kiambu', 'medium'),
    ]);
    expect(signal).toEqual({ countryCode: 'KE', county: 'Kiambu', farmsAffected: 3, farmsHigh: 1, riskLevel: 'medium' });
  });

  it('suppresses counties with fewer than 3 affected farms (k-anonymity)', () => {
    expect(aggregateRegional([farm('f1', 'Kiambu', 'high'), farm('f2', 'Kiambu', 'high'), farm('f3', 'Kiambu', 'low')])).toEqual([]);
  });

  it('rates the region high when at least 2 farms are high', () => {
    const [signal] = aggregateRegional([farm('f1', 'Kiambu', 'high'), farm('f2', 'Kiambu', 'high'), farm('f3', 'Kiambu', 'medium')]);
    expect(signal.riskLevel).toBe('high');
  });

  it('counts a farm once, normalises county names, and skips farms without a county', () => {
    const signals = aggregateRegional([
      farm('f1', 'Kiambu', 'medium'),
      farm('f1', 'kiambu ', 'high'),
      farm('f2', ' KIAMBU', 'medium'),
      farm('f3', null, 'high'),
      farm('f4', '', 'high'),
    ]);
    expect(signals).toEqual([]);
  });

  it('never includes farm identifiers in its output', () => {
    const signals = aggregateRegional([farm('secret-1', 'Nakuru', 'high'), farm('secret-2', 'Nakuru', 'high'), farm('secret-3', 'Nakuru', 'high')]);
    expect(JSON.stringify(signals)).not.toMatch(/secret/);
  });
});
