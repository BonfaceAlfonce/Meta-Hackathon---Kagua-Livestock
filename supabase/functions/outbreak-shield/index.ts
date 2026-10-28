/**
 * Outbreak Shield Edge Function.
 *
 * POST /functions/v1/outbreak-shield
 *   Scheduled run:  header `x-cron-secret: <OUTBREAK_CRON_SECRET>`   -> all farms
 *   User run:       header `Authorization: Bearer <user access token>` -> farms where the
 *                   user is owner/admin/operator (e.g. the dashboard's "Run check" button)
 *   Optional JSON body: { "date": "YYYY-MM-DD", "farmId": "<uuid>" }
 *
 * For each farm it loads recent flock logs, activity telemetry and stored assessments,
 * scores every active zone with the tested scoring module, and upserts
 * outbreak_assessments. It then recomputes anonymised county signals into
 * regional_signals.
 *
 * Muse Spark (Meta Model API) explains new or changed medium/high results and
 * regional signals; it never sets a risk level. Output that fails the no-diagnosis
 * guardrail, API errors, a missing key, or an exhausted per-run budget all fall
 * back to deterministic template text (ai_status = "fallback").
 *
 * Deploy with JWT verification off, because auth is enforced here and must accept
 * both the cron secret and user tokens:
 *   supabase functions deploy outbreak-shield --no-verify-jwt
 * Secrets:
 *   supabase secrets set OUTBREAK_CRON_SECRET=<long random string>
 *   supabase secrets set MODEL_API_KEY=<Meta Model API key>
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { addDays, aggregateRegional, DEFAULT_CONFIG, type RiskLevel, type ZoneDayRisk } from '../_shared/outbreakScoring.ts';
import {
  buildFarmAssessments,
  localDate,
  peakRiskPerFarm,
  planAssessmentWrites,
  regionalWindow,
  timingSafeEqual,
  type AssessmentRow,
  type ExistingAssessment,
  type FlockLogRow,
  type RegionalAssessmentRow,
  type TelemetryRow,
} from '../_shared/outbreakPipeline.ts';
import {
  explainRegion,
  explainZone,
  fallbackRegionalExplanation,
  fallbackZoneExplanation,
  needsAi,
  type ExplainOutcome,
  type RegionalContext,
  type ZoneContext,
  type ZoneExplanation,
} from '../_shared/outbreakExplain.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 1000;
const MAX_BACKFILL_DAYS = 60;
const EDITOR_ROLES = ['owner', 'admin', 'operator'];
/** Caps Muse Spark calls per run (cost and time limit); remaining items get template text. */
const MAX_AI_CALLS_PER_RUN = 25;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

/** Reads every page of a PostgREST query; Supabase caps responses at 1000 rows by default. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function readBody(req: Request): Promise<{ date?: string; farmId?: string }> {
  const text = await req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object.');
  const { date, farmId } = body as Record<string, unknown>;
  if (date !== undefined && (typeof date !== 'string' || !ISO_DATE.test(date))) throw new HttpError(400, 'date must be YYYY-MM-DD.');
  if (farmId !== undefined && (typeof farmId !== 'string' || !UUID.test(farmId))) throw new HttpError(400, 'farmId must be a UUID.');
  if (date) {
    const todayUtc = new Date().toISOString().slice(0, 10);
    // One day of slack: farms east of UTC are already on "tomorrow".
    if (date > addDays(todayUtc, 1) || date < addDays(todayUtc, -MAX_BACKFILL_DAYS)) {
      throw new HttpError(400, `date must be within the last ${MAX_BACKFILL_DAYS} days.`);
    }
  }
  return { date: date as string | undefined, farmId: farmId as string | undefined };
}

/** Returns null for a scheduled run (all farms) or the farm IDs the user may run checks for. */
async function authorize(req: Request, admin: SupabaseClient): Promise<string[] | null> {
  const cronSecret = Deno.env.get('OUTBREAK_CRON_SECRET') ?? '';
  const providedSecret = req.headers.get('x-cron-secret');
  if (providedSecret !== null) {
    if (cronSecret.length >= 16 && timingSafeEqual(providedSecret, cronSecret)) return null;
    throw new HttpError(401, 'Invalid scheduler credentials.');
  }

  const token = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Sign in required.');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Sign in required.');

  const { data: memberships, error: memberError } = await admin
    .from('farm_members')
    .select('farm_id')
    .eq('user_id', data.user.id)
    .in('role', EDITOR_ROLES);
  if (memberError) throw new Error(memberError.message);
  const farmIds = (memberships ?? []).map((m: { farm_id: string }) => m.farm_id);
  if (!farmIds.length) throw new HttpError(403, 'Only farm owners, admins and operators can run outbreak checks.');
  return farmIds;
}

interface FarmRow {
  id: string;
  timezone: string;
  country_code: string;
  county: string | null;
}

async function assessFarm(admin: SupabaseClient, farm: FarmRow, requestedDate: string | undefined) {
  const assessedOn = requestedDate ?? localDate(new Date(), farm.timezone);
  const windowStart = addDays(assessedOn, -DEFAULT_CONFIG.baselineDays);
  const spreadStart = addDays(assessedOn, -(DEFAULT_CONFIG.spreadWindowDays - 1));

  const { data: zones, error: zoneError } = await admin
    .from('farm_zones')
    .select('id, name')
    .eq('farm_id', farm.id)
    .eq('status', 'active');
  if (zoneError) throw new Error(zoneError.message);
  const zoneNames = new Map((zones ?? []).map((z: { id: string; name: string }) => [z.id, z.name]));
  const zoneIds = [...zoneNames.keys()];
  if (!zoneIds.length) return { assessedOn, rows: [], changed: [], zoneNames };

  const logs = await fetchAll<FlockLogRow>((from, to) =>
    admin
      .from('flock_health_logs')
      .select('zone_id, log_date, flock_size, deaths, sick_count, feed_intake_pct, water_intake_pct, respiratory_signs')
      .eq('farm_id', farm.id)
      .gte('log_date', windowStart)
      .lte('log_date', assessedOn)
      .order('log_date')
      .range(from, to),
  );

  // Pad the UTC range by a day on each side; rows are bucketed into local days afterwards.
  const telemetry = await fetchAll<TelemetryRow>((from, to) =>
    admin
      .from('telemetry_events')
      .select('zone_id, captured_at, activity_level')
      .eq('farm_id', farm.id)
      .not('activity_level', 'is', null)
      .gte('captured_at', `${addDays(windowStart, -1)}T00:00:00Z`)
      .lt('captured_at', `${addDays(assessedOn, 2)}T00:00:00Z`)
      .order('captured_at')
      .range(from, to),
  );

  const { data: previous, error: previousError } = await admin
    .from('outbreak_assessments')
    .select('zone_id, assessed_on, risk_level')
    .eq('farm_id', farm.id)
    .gte('assessed_on', spreadStart)
    .lt('assessed_on', assessedOn);
  if (previousError) throw new Error(previousError.message);
  const previousRisks: ZoneDayRisk[] = (previous ?? []).map(
    (p: { zone_id: string; assessed_on: string; risk_level: RiskLevel }) => ({
      zoneId: p.zone_id,
      assessedOn: p.assessed_on,
      riskLevel: p.risk_level,
    }),
  );

  const rows = buildFarmAssessments({
    farmId: farm.id,
    assessedOn,
    zoneIds,
    logs,
    telemetry,
    timeZone: farm.timezone,
    previousRisks,
  });

  const { data: existing, error: existingError } = await admin
    .from('outbreak_assessments')
    .select('zone_id, risk_level, score, is_spreading, signals, ai_status')
    .eq('farm_id', farm.id)
    .eq('assessed_on', assessedOn);
  if (existingError) throw new Error(existingError.message);
  const { changed, unchanged } = planAssessmentWrites(rows, (existing ?? []) as ExistingAssessment[]);

  // Two writes so unchanged rows keep their existing AI text (their ai_* columns are not sent).
  for (const batch of [changed, unchanged]) {
    if (!batch.length) continue;
    const { error } = await admin.from('outbreak_assessments').upsert(batch, { onConflict: 'zone_id,assessed_on' });
    if (error) throw new Error(error.message);
  }
  return { assessedOn, rows, changed, zoneNames };
}

interface AiBudget {
  remaining: number;
  generated: number;
  fallback: number;
}

function aiClient(apiKey: string) {
  return { apiKey, timeoutMs: 20_000, maxRetries: 2, maxRetryDelayMs: 5_000 };
}

/** Fills ai_* for rows whose result changed. AI only for medium/high, within budget; templates otherwise. */
async function explainAssessments(
  admin: SupabaseClient,
  rows: AssessmentRow[],
  zoneNames: Map<string, string>,
  apiKey: string,
  budget: AiBudget,
) {
  for (const row of rows) {
    const ctx: ZoneContext = {
      zoneName: zoneNames.get(row.zone_id) ?? 'this zone',
      riskLevel: row.risk_level,
      score: row.score,
      isSpreading: row.is_spreading,
      signals: row.signals,
    };
    let outcome: ExplainOutcome<ZoneExplanation>;
    if (needsAi(row.risk_level) && apiKey && budget.remaining > 0) {
      budget.remaining--;
      outcome = await explainZone(ctx, aiClient(apiKey));
      if (outcome.reason) console.warn(`outbreak-shield: AI fallback for zone ${row.zone_id}: ${outcome.reason}`);
    } else {
      outcome = { status: 'fallback', value: fallbackZoneExplanation(ctx) };
    }
    if (outcome.status === 'generated') budget.generated++;
    else budget.fallback++;

    const { error } = await admin
      .from('outbreak_assessments')
      .update({
        ai_status: outcome.status,
        ai_summary: outcome.value.explanation,
        ai_farmer_message: outcome.value.farmerMessage,
        ai_vet_summary: outcome.value.vetSummary,
      })
      .eq('zone_id', row.zone_id)
      .eq('assessed_on', row.assessed_on);
    if (error) throw new Error(error.message);
  }
}

async function refreshRegionalSignals(admin: SupabaseClient, asOf: string) {
  const { windowStart, windowEnd } = regionalWindow(asOf);
  const assessments = await fetchAll<RegionalAssessmentRow>((from, to) =>
    admin
      .from('outbreak_assessments')
      .select('farm_id, risk_level, farms!inner(country_code, county)')
      .gte('assessed_on', windowStart)
      .lte('assessed_on', windowEnd)
      .in('risk_level', ['medium', 'high'])
      .order('id')
      .range(from, to),
  );

  const signals = aggregateRegional(peakRiskPerFarm(assessments));

  const { data: existingRows, error: existingError } = await admin
    .from('regional_signals')
    .select('id, country_code, county, farms_affected, farms_high, risk_level, ai_status')
    .eq('window_end', windowEnd);
  if (existingError) throw new Error(existingError.message);
  type ExistingRegional = {
    id: string;
    country_code: string;
    county: string;
    farms_affected: number;
    farms_high: number;
    risk_level: RiskLevel;
    ai_status: string;
  };
  const keyOf = (country: string, county: string) => `${country}|${county.toLowerCase()}`;
  const existing = new Map(((existingRows ?? []) as ExistingRegional[]).map((r) => [keyOf(r.country_code, r.county), r]));

  // Only new or changed signals are rewritten (and re-explained); unchanged ones keep their AI text.
  const changed: RegionalContext[] = [];
  for (const s of signals) {
    const old = existing.get(keyOf(s.countryCode, s.county));
    const same =
      old !== undefined &&
      old.ai_status !== 'pending' &&
      old.farms_affected === s.farmsAffected &&
      old.farms_high === s.farmsHigh &&
      old.risk_level === s.riskLevel;
    if (!same) {
      // Reuse the stored spelling so case differences never create duplicate rows.
      changed.push({
        countryCode: s.countryCode,
        county: old?.county ?? s.county,
        windowStart,
        windowEnd,
        farmsAffected: s.farmsAffected,
        farmsHigh: s.farmsHigh,
        riskLevel: s.riskLevel,
      });
    }
  }
  if (changed.length) {
    const { error } = await admin.from('regional_signals').upsert(
      changed.map((c) => ({
        country_code: c.countryCode,
        county: c.county,
        window_start: c.windowStart,
        window_end: c.windowEnd,
        farms_affected: c.farmsAffected,
        farms_high: c.farmsHigh,
        risk_level: c.riskLevel,
        ai_status: 'pending',
        ai_summary: null,
      })),
      { onConflict: 'country_code,county,window_end' },
    );
    if (error) throw new Error(error.message);
  }

  // Remove signals for this window that no longer meet the threshold (e.g. data was corrected).
  const current = new Set(signals.map((s) => keyOf(s.countryCode, s.county)));
  const stale = [...existing.entries()].filter(([key]) => !current.has(key)).map(([, r]) => r.id);
  if (stale.length) {
    const { error } = await admin.from('regional_signals').delete().in('id', stale);
    if (error) throw new Error(error.message);
  }
  return { count: signals.length, changed };
}

async function explainRegionalSignals(admin: SupabaseClient, changed: RegionalContext[], apiKey: string, budget: AiBudget) {
  for (const ctx of changed) {
    let outcome: ExplainOutcome<{ summary: string }>;
    if (apiKey && budget.remaining > 0) {
      budget.remaining--;
      outcome = await explainRegion(ctx, aiClient(apiKey));
      if (outcome.reason) console.warn(`outbreak-shield: AI fallback for region ${ctx.county}: ${outcome.reason}`);
    } else {
      outcome = { status: 'fallback', value: fallbackRegionalExplanation(ctx) };
    }
    if (outcome.status === 'generated') budget.generated++;
    else budget.fallback++;

    const { error } = await admin
      .from('regional_signals')
      .update({ ai_status: outcome.status, ai_summary: outcome.value.summary })
      .eq('country_code', ctx.countryCode)
      .eq('county', ctx.county)
      .eq('window_end', ctx.windowEnd);
    if (error) throw new Error(error.message);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) throw new Error('Function is missing Supabase configuration.');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const allowedFarmIds = await authorize(req, admin);
    const body = await readBody(req);
    if (body.farmId && allowedFarmIds && !allowedFarmIds.includes(body.farmId)) {
      throw new HttpError(403, 'You cannot run checks for that farm.');
    }

    let farmQuery = admin.from('farms').select('id, timezone, country_code, county');
    if (body.farmId) farmQuery = farmQuery.eq('id', body.farmId);
    else if (allowedFarmIds) farmQuery = farmQuery.in('id', allowedFarmIds);
    const { data: farms, error: farmError } = await farmQuery;
    if (farmError) throw new Error(farmError.message);

    const riskCounts: Record<RiskLevel, number> = { none: 0, low: 0, medium: 0, high: 0 };
    const failedFarms: string[] = [];
    let zonesAssessed = 0;
    let spreadingFarms = 0;
    const apiKey = Deno.env.get('MODEL_API_KEY') ?? '';
    const budget: AiBudget = { remaining: MAX_AI_CALLS_PER_RUN, generated: 0, fallback: 0 };

    // Sequential on purpose: keeps database and API load predictable for small projects.
    for (const farm of (farms ?? []) as FarmRow[]) {
      try {
        const { rows, changed, zoneNames } = await assessFarm(admin, farm, body.date);
        zonesAssessed += rows.length;
        rows.forEach((r) => riskCounts[r.risk_level]++);
        if (rows.some((r) => r.is_spreading)) spreadingFarms++;
        await explainAssessments(admin, changed, zoneNames, apiKey, budget);
      } catch (error) {
        console.error(`outbreak-shield: farm ${farm.id} failed`, error);
        failedFarms.push(farm.id);
      }
    }

    const regionalAsOf = body.date ?? new Date().toISOString().slice(0, 10);
    const regional = await refreshRegionalSignals(admin, regionalAsOf);
    await explainRegionalSignals(admin, regional.changed, apiKey, budget);

    return json(failedFarms.length ? 207 : 200, {
      mode: allowedFarmIds ? 'user' : 'scheduled',
      farmsProcessed: (farms ?? []).length - failedFarms.length,
      zonesAssessed,
      riskCounts,
      spreadingFarms,
      regionalSignals: regional.count,
      ai: { configured: Boolean(apiKey), generated: budget.generated, fallback: budget.fallback },
      failedFarms,
    });
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error('outbreak-shield: unexpected error', error);
    return json(500, { error: 'Outbreak check failed. See function logs.' });
  }
});
