import { describe, expect, it } from 'vitest';
import {
  aiBadge,
  canEdit,
  farmToday,
  highestRisk,
  latestDay,
  regionalForFarm,
  spreadTimeline,
  validateLog,
  zoneFacts,
  zoneHistory,
} from './outbreakView.js';

const row = (zone_id, assessed_on, risk_level, extra = {}) => ({ zone_id, assessed_on, risk_level, is_spreading: false, signals: {}, ...extra });

describe('latestDay / highestRisk', () => {
  it('picks the newest day and its highest risk', () => {
    const rows = [row('a', '2026-10-27', 'high'), row('a', '2026-10-28', 'medium'), row('b', '2026-10-28', 'low')];
    const { day, rows: today } = latestDay(rows);
    expect(day).toBe('2026-10-28');
    expect(today).toHaveLength(2);
    expect(highestRisk(today)).toBe('medium');
    expect(highestRisk([])).toBe('none');
  });
});

describe('spreadTimeline', () => {
  it('orders spreading zones by rank and names them', () => {
    const names = new Map([['a', 'Brooder 1'], ['b', 'Brooder 2']]);
    const timeline = spreadTimeline(
      [
        row('a', '2026-10-28', 'high', { is_spreading: true, signals: { spreadRank: 2, spreadFirstDetectedOn: '2026-10-28' } }),
        row('b', '2026-10-28', 'high', { is_spreading: true, signals: { spreadRank: 1, spreadFirstDetectedOn: '2026-10-27' } }),
        row('c', '2026-10-28', 'none'),
      ],
      names,
    );
    expect(timeline.map((t) => [t.zoneName, t.firstDetectedOn])).toEqual([['Brooder 2', '2026-10-27'], ['Brooder 1', '2026-10-28']]);
  });
});

describe('zoneFacts', () => {
  it('builds facts only from stored values and marks triggered signals', () => {
    const facts = zoneFacts({ deaths: 14, baselineDeaths: 1, mortalitySpike: true, lowestIntakePct: 60, intakeDrop: true, activityChangePct: -50, activityDrop: true, respiratorySigns: true, sickCount: 0 });
    expect(facts.map((f) => f.text)).toEqual(['14 deaths · usual 1', 'Intake 60% of normal', 'Activity -50%', 'Breathing problems reported']);
    expect(facts.every((f) => f.tone === 'alert')).toBe(true);
  });

  it('flags a missing log and skips unknown values', () => {
    expect(zoneFacts({ missingTodayLog: true, deaths: null, lowestIntakePct: null })).toEqual([
      { key: 'missing', text: "Today's flock log is missing", tone: 'muted' },
    ]);
  });
});

describe('zoneHistory', () => {
  it('returns one entry per day, oldest first, with gaps as null', () => {
    const history = zoneHistory([row('a', '2026-10-28', 'high'), row('a', '2026-10-26', 'low'), row('b', '2026-10-28', 'high')], 'a', '2026-10-28', 3);
    expect(history).toEqual([
      { day: '2026-10-26', riskLevel: 'low' },
      { day: '2026-10-27', riskLevel: null },
      { day: '2026-10-28', riskLevel: 'high' },
    ]);
  });
});

describe('regionalForFarm', () => {
  const signals = [
    { county: 'Kiambu', window_end: '2026-10-27', risk_level: 'medium' },
    { county: 'Kiambu', window_end: '2026-10-28', risk_level: 'high' },
    { county: 'Nakuru', window_end: '2026-10-28', risk_level: 'medium' },
    { county: 'Nyeri', window_end: '2026-10-20', risk_level: 'medium' },
  ];

  it("returns the newest signal for the farm's county, ignoring case and spacing", () => {
    const result = regionalForFarm(signals, ' kiambu ');
    expect(result.own.window_end).toBe('2026-10-28');
    expect(result.otherCounties).toBe(1);
  });

  it('returns no own signal when the farm has no county', () => {
    expect(regionalForFarm(signals, null)).toEqual({ own: null, otherCounties: 2 });
  });
});

describe('validateLog', () => {
  const base = { zoneId: 'z', logDate: '2026-10-28', flockSize: '500', deaths: '3', sickCount: '', feedIntakePct: '', waterIntakePct: '80', respiratorySigns: false, notes: '  ' };

  it('produces a database row with numbers and nulls for blanks', () => {
    expect(validateLog(base)).toEqual({
      errors: {},
      row: { zone_id: 'z', log_date: '2026-10-28', flock_size: 500, deaths: 3, sick_count: 0, feed_intake_pct: null, water_intake_pct: 80, respiratory_signs: false, notes: null, source: 'farmer' },
    });
  });

  it('rejects impossible or missing values with readable messages', () => {
    expect(validateLog({ ...base, deaths: '' }).errors.deaths).toMatch(/Enter deaths/);
    expect(validateLog({ ...base, deaths: '-1' }).errors.deaths).toMatch(/whole number/);
    expect(validateLog({ ...base, deaths: '2.5' }).errors.deaths).toMatch(/whole number/);
    expect(validateLog({ ...base, deaths: '400', sickCount: '200' }).errors.deaths).toMatch(/cannot exceed/);
    expect(validateLog({ ...base, waterIntakePct: '250' }).errors.waterIntakePct).toMatch(/0–200/);
    expect(validateLog({ ...base, zoneId: '' }).errors.zoneId).toBeDefined();
    expect(validateLog({ ...base, notes: 'x'.repeat(1001) }).errors.notes).toBeDefined();
  });
});

describe('small helpers', () => {
  it('only editors can log and run checks', () => {
    expect(['owner', 'admin', 'operator', 'viewer'].map(canEdit)).toEqual([true, true, true, false]);
  });

  it('uses the farm timezone for today', () => {
    const lateUtc = new Date('2026-10-27T22:30:00Z');
    expect(farmToday('Africa/Nairobi', lateUtc)).toBe('2026-10-28');
    expect(farmToday('Bad/Zone', lateUtc)).toBe('2026-10-27');
  });

  it('labels AI status honestly', () => {
    expect(aiBadge('generated')).toEqual({ label: 'Explained by Muse Spark', ai: true });
    expect(aiBadge('fallback').ai).toBe(false);
    expect(aiBadge('pending').label).toBe('Explanation pending');
  });
});
