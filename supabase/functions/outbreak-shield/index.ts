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
 * regional_signals. AI explanations are added separately (status stays "pending").
 *
 * Deploy with JWT verification off, because auth is enforced here and must accept
 * both the cron secret and user tokens:
 *   supabase functions deploy outbreak-shield --no-verify-jwt
 * Secrets: supabase secrets set OUTBREAK_CRON_SECRET=<long random string>
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { addDays, aggregateRegional, DEFAULT_CONFIG, type RiskLevel, type ZoneDayRisk } from '../_shared/outbreakScoring.ts';
import {
  buildFarmAssessments,
  localDate,
  peakRiskPerFarm,
  regionalWindow,
  timingSafeEqual,
  type FlockLogRow,
  type RegionalAssessmentRow,
  type TelemetryRow,
} from '../_shared/outbreakPipeline.ts';

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
    .select('id')
    .eq('farm_id', farm.id)
    .eq('status', 'active');
  if (zoneError) throw new Error(zoneError.message);
  const zoneIds = (zones ?? []).map((z: { id: string }) => z.id);
  if (!zoneIds.length) return { assessedOn, rows: [] };

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

  const { error: upsertError } = await admin.from('outbreak_assessments').upsert(rows, { onConflict: 'zone_id,assessed_on' });
  if (upsertError) throw new Error(upsertError.message);
  return { assessedOn, rows };
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
  if (signals.length) {
    const { error } = await admin.from('regional_signals').upsert(
      signals.map((s) => ({
        country_code: s.countryCode,
        county: s.county,
        window_start: windowStart,
        window_end: windowEnd,
        farms_affected: s.farmsAffected,
        farms_high: s.farmsHigh,
        risk_level: s.riskLevel,
        ai_status: 'pending',
        ai_summary: null,
      })),
      { onConflict: 'country_code,county,window_end' },
    );
    if (error) throw new Error(error.message);
  }

  // Remove signals for this window that no longer meet the threshold (e.g. data was corrected).
  const { data: existing, error: existingError } = await admin
    .from('regional_signals')
    .select('id, country_code, county')
    .eq('window_end', windowEnd);
  if (existingError) throw new Error(existingError.message);
  const current = new Set(signals.map((s) => `${s.countryCode}|${s.county.toLowerCase()}`));
  const stale = (existing ?? [])
    .filter((r: { country_code: string; county: string }) => !current.has(`${r.country_code}|${r.county.toLowerCase()}`))
    .map((r: { id: string }) => r.id);
  if (stale.length) {
    const { error } = await admin.from('regional_signals').delete().in('id', stale);
    if (error) throw new Error(error.message);
  }
  return signals.length;
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

    // Sequential on purpose: keeps database load predictable for small projects.
    for (const farm of (farms ?? []) as FarmRow[]) {
      try {
        const { rows } = await assessFarm(admin, farm, body.date);
        zonesAssessed += rows.length;
        rows.forEach((r) => riskCounts[r.risk_level]++);
        if (rows.some((r) => r.is_spreading)) spreadingFarms++;
      } catch (error) {
        console.error(`outbreak-shield: farm ${farm.id} failed`, error);
        failedFarms.push(farm.id);
      }
    }

    const regionalAsOf = body.date ?? new Date().toISOString().slice(0, 10);
    const regionalSignals = await refreshRegionalSignals(admin, regionalAsOf);

    return json(failedFarms.length ? 207 : 200, {
      mode: allowedFarmIds ? 'user' : 'scheduled',
      farmsProcessed: (farms ?? []).length - failedFarms.length,
      zonesAssessed,
      riskCounts,
      spreadingFarms,
      regionalSignals,
      failedFarms,
    });
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error('outbreak-shield: unexpected error', error);
    return json(500, { error: 'Outbreak check failed. See function logs.' });
  }
});
