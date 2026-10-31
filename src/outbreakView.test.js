import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aiBadge,
  canEdit,
  checkStatusText,
  farmToday,
  highestRisk,
  latestDay,
  regionalForFarm,
  spreadTimeline,
  timeAgo,
  validateLog,
  zoneFacts,
  zoneHistory,
} from './outbreakView.js';

const row = (zone_id, assessed_on, risk_level, extra = {}) => ({ zone_id, assessed_on, risk_level, is_spreading: false, signals: {}, ...extra });

describe('latestDay / highestRisk', () => {
  it('picks the newest day and its highest risk', () => {
    const rows = [row('a', '2026-10-27', 'high'), row('a', '2026-10-28', 'medium'), row('b', '2026-10-28', 'low')];
    const { day, rows: today } = latestDay(rows);
    assert.equal(day, '2026-10-28');
    assert.equal(today.length, 2);
    assert.equal(highestRisk(today), 'medium');
    assert.equal(highestRisk([]), 'none');
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
    assert.deepEqual(timeline.map((t) => [t.zoneName, t.firstDetectedOn]), [['Brooder 2', '2026-10-27'], ['Brooder 1', '2026-10-28']]);
  });
});

describe('zoneFacts', () => {
  it('builds facts only from stored values and marks triggered signals', () => {
    const facts = zoneFacts({ deaths: 14, baselineDeaths: 1, mortalitySpike: true, lowestIntakePct: 60, intakeDrop: true, activityChangePct: -50, activityDrop: true, respiratorySigns: true, sickCount: 0 });
    assert.deepEqual(facts.map((f) => f.text), ['14 deaths · usual 1', 'Intake 60% of normal', 'Activity -50%', 'Breathing problems reported']);
    assert.equal(facts.every((f) => f.tone === 'alert'), true);
  });

  it('uses the singular for one death', () => {
    assert.equal(zoneFacts({ deaths: 1, baselineDeaths: 1 })[0].text, '1 death · usual 1');
  });

  it('flags a missing log and skips unknown values', () => {
    assert.deepEqual(zoneFacts({ missingTodayLog: true, deaths: null, lowestIntakePct: null }), [
      { key: 'missing', text: "Today's flock log is missing", tone: 'muted' },
    ]);
  });
});

describe('zoneHistory', () => {
  it('returns one entry per day, oldest first, with gaps as null', () => {
    const history = zoneHistory([row('a', '2026-10-28', 'high'), row('a', '2026-10-26', 'low'), row('b', '2026-10-28', 'high')], 'a', '2026-10-28', 3);
    assert.deepEqual(history, [
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
    assert.equal(result.own.window_end, '2026-10-28');
    assert.equal(result.otherCounties, 1);
  });

  it('returns no own signal when the farm has no county', () => {
    assert.deepEqual(regionalForFarm(signals, null), { own: null, otherCounties: 2 });
  });
});

describe('validateLog', () => {
  const base = { zoneId: 'z', logDate: '2026-10-28', flockSize: '500', deaths: '3', sickCount: '', feedIntakePct: '', waterIntakePct: '80', respiratorySigns: false, notes: '  ' };

  it('produces a database row with numbers and nulls for blanks', () => {
    assert.deepEqual(validateLog(base), {
      errors: {},
      row: { zone_id: 'z', log_date: '2026-10-28', flock_size: 500, deaths: 3, sick_count: 0, feed_intake_pct: null, water_intake_pct: 80, respiratory_signs: false, notes: null, source: 'farmer' },
    });
  });

  it('rejects impossible or missing values with readable messages', () => {
    assert.match(validateLog({ ...base, deaths: '' }).errors.deaths, /Enter deaths/);
    assert.match(validateLog({ ...base, deaths: '-1' }).errors.deaths, /whole number/);
    assert.match(validateLog({ ...base, deaths: '2.5' }).errors.deaths, /whole number/);
    assert.match(validateLog({ ...base, deaths: '400', sickCount: '200' }).errors.deaths, /cannot exceed/);
    assert.match(validateLog({ ...base, waterIntakePct: '250' }).errors.waterIntakePct, /0–200/);
    assert.notEqual(validateLog({ ...base, zoneId: '' }).errors.zoneId, undefined);
    assert.notEqual(validateLog({ ...base, notes: 'x'.repeat(1001) }).errors.notes, undefined);
  });
});

describe('small helpers', () => {
  it('only editors can log and run checks', () => {
    assert.deepEqual(['owner', 'admin', 'operator', 'viewer'].map(canEdit), [true, true, true, false]);
  });

  it('uses the farm timezone for today', () => {
    const lateUtc = new Date('2026-10-27T22:30:00Z');
    assert.equal(farmToday('Africa/Nairobi', lateUtc), '2026-10-28');
    assert.equal(farmToday('Bad/Zone', lateUtc), '2026-10-27');
  });

  it('labels AI status honestly', () => {
    assert.deepEqual(aiBadge('generated'), { label: 'Explained by Muse Spark', ai: true });
    assert.equal(aiBadge('fallback').ai, false);
    assert.equal(aiBadge('pending').label, 'Explanation pending');
  });
});

describe('check freshness', () => {
  const now = new Date('2026-10-30T10:00:00Z');

  it('formats relative times', () => {
    assert.equal(timeAgo('2026-10-30T09:59:30Z', now), 'just now');
    assert.equal(timeAgo('2026-10-30T09:56:00Z', now), '4 min ago');
    assert.equal(timeAgo('2026-10-30T07:30:00Z', now), '2 h ago');
    assert.equal(timeAgo('2026-10-28T09:00:00Z', now), '2 d ago');
    assert.equal(timeAgo(null, now), null);
    assert.equal(timeAgo('not a date', now), null);
  });

  it('shows the last check and the newest change', () => {
    const rows = [{ updated_at: '2026-10-30T07:30:00Z' }, { updated_at: '2026-10-30T08:00:00Z' }];
    assert.equal(checkStatusText('2026-10-30T09:56:00Z', rows, now), 'Checked 4 min ago · last change 2 h ago');
    assert.equal(checkStatusText(null, rows, now), 'Last change 2 h ago');
    assert.equal(checkStatusText('2026-10-30T09:56:00Z', [], now), 'Checked 4 min ago');
    assert.equal(checkStatusText(null, [], now), '');
  });
});
