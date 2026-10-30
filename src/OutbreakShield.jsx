import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, ClipboardCopy, ClipboardList, Clock3, Info, MapPin, NotebookPen, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, Stethoscope } from 'lucide-react';
import {
  aiBadge,
  BIOSECURITY_STEPS,
  canEdit,
  checkStatusText,
  farmToday,
  formatDay,
  highestRisk,
  latestDay,
  regionalForFarm,
  RISK_META,
  spreadTimeline,
  validateLog,
  zoneFacts,
  zoneHistory,
} from './outbreakView.js';
import './outbreak.css';

const HISTORY_DAYS = 7;
const ASSESSMENT_COLUMNS = 'zone_id,assessed_on,risk_level,score,signals,is_spreading,ai_status,ai_summary,ai_farmer_message,ai_vet_summary,updated_at';
const REGIONAL_COLUMNS = 'id,country_code,county,window_start,window_end,farms_affected,farms_high,risk_level,ai_status,ai_summary';

function RiskBadge({ level }) {
  const meta = RISK_META[level] || RISK_META.none;
  return <span className={`os-badge os-${meta.tone}`}>{meta.label}</span>;
}

/** Turns a Supabase Functions error into a readable message without exposing internals. */
async function functionErrorMessage(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch {
    // Non-JSON error bodies fall through to the generic message.
  }
  return 'The outbreak check could not run. Please try again.';
}

export default function OutbreakShield({ supabase, farm, role, zones, userId }) {
  const [assessments, setAssessments] = useState([]);
  const [regionalSignals, setRegionalSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState(null);
  const [openVet, setOpenVet] = useState(null);
  const [copied, setCopied] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const editor = canEdit(role);

  const zoneNames = useMemo(() => new Map(zones.map((zone) => [zone.id, zone.name])), [zones]);

  const load = useCallback(async () => {
    setLoadError('');
    const since = new Date(Date.now() - (HISTORY_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const [assessmentRes, regionalRes, checkRes] = await Promise.all([
      supabase.from('outbreak_assessments').select(ASSESSMENT_COLUMNS).eq('farm_id', farm.id).gte('assessed_on', since).order('assessed_on', { ascending: false }).limit(500),
      supabase.from('regional_signals').select(REGIONAL_COLUMNS).order('window_end', { ascending: false }).limit(50),
      supabase.from('outbreak_farm_checks').select('last_checked_at').eq('farm_id', farm.id).maybeSingle(),
    ]);
    // Freshness is optional: if its table is missing or unreadable, the page still works without it.
    setLastCheckedAt(checkRes.error ? null : checkRes.data?.last_checked_at ?? null);
    const failed = [assessmentRes, regionalRes].find((res) => res.error);
    if (failed) setLoadError(failed.error.message);
    else {
      setAssessments(assessmentRes.data || []);
      setRegionalSignals(regionalRes.data || []);
    }
    setLoading(false);
  }, [supabase, farm.id]);

  useEffect(() => {
    setLoading(true);
    load();
    const channel = supabase
      .channel(`outbreak-${farm.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outbreak_assessments', filter: `farm_id=eq.${farm.id}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'regional_signals' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outbreak_farm_checks', filter: `farm_id=eq.${farm.id}` }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, farm.id, load]);

  // Re-render every minute so "Checked 4 min ago" stays current.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { day, rows: todayRows } = useMemo(() => latestDay(assessments), [assessments]);
  const overall = highestRisk(todayRows);
  const timeline = useMemo(() => spreadTimeline(todayRows, zoneNames), [todayRows, zoneNames]);
  const regional = useMemo(() => regionalForFarm(regionalSignals, farm.county), [regionalSignals, farm.county]);
  const sortedRows = useMemo(
    () => [...todayRows].sort((a, b) => (b.score - a.score) || (zoneNames.get(a.zone_id) || '').localeCompare(zoneNames.get(b.zone_id) || '')),
    [todayRows, zoneNames],
  );
  const showBiosecurity = overall === 'high' || overall === 'medium' || timeline.length > 0 || regional.own;

  const runCheck = async () => {
    setRunning(true);
    setRunMessage(null);
    const { data, error } = await supabase.functions.invoke('outbreak-shield', { body: { farmId: farm.id } });
    if (error) setRunMessage({ tone: 'error', text: await functionErrorMessage(error) });
    else {
      const zonesAssessed = data?.zonesAssessed ?? 0;
      const ai = data?.ai?.generated ? ` · ${data.ai.generated} explained by Muse Spark` : '';
      setRunMessage({ tone: 'ok', text: `Check complete: ${zonesAssessed} ${zonesAssessed === 1 ? 'zone' : 'zones'} assessed${ai}.` });
      await load();
    }
    setRunning(false);
    return !error;
  };

  const copyVetSummary = async (row) => {
    const text = [`Kagua Outbreak Shield — ${farm.name}`, `Date: ${row.assessed_on}`, row.ai_vet_summary || '', '', 'Kagua flags patterns for follow-up. It does not diagnose disease.'].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(row.zone_id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setOpenVet(row.zone_id);
    }
  };

  const toggleStep = (index) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div className="os-page">
      <section className={`os-status os-status-${RISK_META[overall].tone}`}>
        <span className="os-status-icon">{overall === 'none' ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}</span>
        <div className="os-status-copy">
          <span className="eyebrow">OUTBREAK SHIELD{day ? ` · ${formatDay(day)}` : ''}</span>
          <h2>
            {loading ? 'Loading flock risk…' : !day ? 'No outbreak checks yet' : overall === 'none' ? 'No warning signs on this farm' : `${RISK_META[overall].label} on this farm`}
          </h2>
          <p>
            {timeline.length > 0
              ? `Similar warning signs in ${timeline.length} zones — the pattern may be spreading.`
              : day
                ? 'Daily risk from flock logs and sensor activity. Kagua flags patterns for follow-up; it does not diagnose disease.'
                : "Log today's flock numbers, then run a check to see each zone's risk."}
          </p>
          {!loading && checkStatusText(lastCheckedAt, todayRows, now) && (
            <small className="os-status-meta">
              <Clock3 size={11} /> {checkStatusText(lastCheckedAt, todayRows, now)}
            </small>
          )}
        </div>
        {editor && (
          <button className="primary-button os-run" onClick={runCheck} disabled={running}>
            <RefreshCw size={15} className={running ? 'os-spin' : ''} /> {running ? 'Checking…' : 'Run check'}
          </button>
        )}
      </section>

      <div className="os-live" aria-live="polite">
        {runMessage && <div className={`os-run-message os-run-${runMessage.tone}`}>{runMessage.text}</div>}
        {loadError && (
          <div className="db-error">
            <AlertTriangle size={16} />
            <span><strong>Outbreak data could not load</strong><br />{loadError}</span>
            <button onClick={load}>Retry</button>
          </div>
        )}
      </div>

      <section className={`os-regional ${regional.own ? `os-regional-${RISK_META[regional.own.risk_level].tone}` : ''}`}>
        <span className="os-regional-icon"><MapPin size={17} /></span>
        <div>
          {regional.own ? (
            <>
              <strong>Regional warning · {regional.own.county}</strong>
              <p>{regional.own.ai_summary || `${regional.own.farms_affected} farms in ${regional.own.county} reported warning signs.`}</p>
              <small>
                {regional.own.farms_affected} farms with warning signs · {regional.own.farms_high} at high risk · {formatDay(regional.own.window_start)}–{formatDay(regional.own.window_end)} · No individual farm is identified
              </small>
            </>
          ) : farm.county ? (
            <>
              <strong>No regional warning for {farm.county}</strong>
              <p>
                Warnings appear when 3 or more farms in a county show warning signs within 7 days.
                {regional.otherCounties > 0 && ` ${regional.otherCounties} other ${regional.otherCounties === 1 ? 'county has' : 'counties have'} an active warning.`}
              </p>
            </>
          ) : (
            <>
              <strong>Regional warnings are off for this farm</strong>
              <p>Ask a farm admin to set the farm's county so Kagua can warn you about outbreaks nearby.</p>
            </>
          )}
        </div>
      </section>

      {timeline.length > 0 && (
        <section className="panel os-panel">
          <div className="panel-header"><div><h2>How it is spreading</h2><p>Zones in the order the warning signs appeared</p></div></div>
          <ol className="os-timeline">
            {timeline.map((step) => (
              <li key={step.zoneId}>
                <span className={`os-dot os-${RISK_META[step.riskLevel].tone}`} />
                <strong>{step.zoneName}</strong>
                <span>since {formatDay(step.firstDetectedOn)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="os-zone-grid">
        {!loading && !sortedRows.length && (
          <div className="panel os-panel">
            <div className="empty-state">
              <strong>No zone results yet</strong>
              <span>{editor ? 'Add a flock log below, then press Run check.' : 'Results appear after a farm operator logs flock numbers and runs a check.'}</span>
            </div>
          </div>
        )}
        {sortedRows.map((row) => {
          const badge = aiBadge(row.ai_status);
          const history = zoneHistory(assessments, row.zone_id, day, HISTORY_DAYS);
          return (
            <article key={row.zone_id} className={`panel os-zone os-zone-${RISK_META[row.risk_level].tone}`}>
              <header className="os-zone-head">
                <div>
                  <h3>{zoneNames.get(row.zone_id) || 'Zone'}</h3>
                  <span className={`os-ai ${badge.ai ? 'os-ai-on' : ''}`}>{badge.ai && <Sparkles size={11} />} {badge.label}</span>
                </div>
                <RiskBadge level={row.risk_level} />
              </header>
              <ul className="os-facts">
                {zoneFacts(row.signals).map((fact) => <li key={fact.key} className={`os-fact-${fact.tone}`}>{fact.text}</li>)}
              </ul>
              {row.ai_farmer_message && <p className="os-message">{row.ai_farmer_message}</p>}
              {row.ai_summary && <p className="os-summary">{row.ai_summary}</p>}
              <div className="os-history" aria-label={`Risk over the last ${HISTORY_DAYS} days`}>
                {history.map((entry) => (
                  <span key={entry.day} title={`${formatDay(entry.day)}: ${entry.riskLevel ? RISK_META[entry.riskLevel].label : 'not checked'}`} className={`os-history-cell ${entry.riskLevel ? `os-${RISK_META[entry.riskLevel].tone}` : 'os-empty'}`} />
                ))}
                <small>Last {HISTORY_DAYS} days</small>
              </div>
              {row.ai_vet_summary && (
                <footer className="os-zone-foot">
                  <button className="text-action" onClick={() => setOpenVet(openVet === row.zone_id ? null : row.zone_id)}>
                    <Stethoscope size={13} /> Vet summary {openVet === row.zone_id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button className="text-action" onClick={() => copyVetSummary(row)}>
                    {copied === row.zone_id ? <><Check size={13} /> Copied</> : <><ClipboardCopy size={13} /> Copy for vet</>}
                  </button>
                </footer>
              )}
              {openVet === row.zone_id && <pre className="os-vet">{row.ai_vet_summary}</pre>}
            </article>
          );
        })}
      </section>

      {showBiosecurity && (
        <section className="panel os-panel">
          <div className="panel-header">
            <div><h2>Biosecurity checklist</h2><p>Standard steps to limit spread while you wait for your veterinarian</p></div>
            <span className="health-pill good-pill">{checked.size}/{BIOSECURITY_STEPS.length} done</span>
          </div>
          <ul className="os-checklist">
            {BIOSECURITY_STEPS.map((step, index) => (
              <li key={step}>
                <label>
                  <input type="checkbox" checked={checked.has(index)} onChange={() => toggleStep(index)} />
                  <span>{step}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editor ? (
        <FlockLogForm supabase={supabase} farm={farm} zones={zones} userId={userId} onSaved={runCheck} running={running} />
      ) : (
        <div className="os-note"><Info size={14} /> Only farm owners, admins and operators can log flock numbers or run checks.</div>
      )}

      <p className="os-disclaimer">
        <ClipboardList size={13} /> Kagua flags unusual patterns for follow-up. It does not diagnose disease or recommend treatment. Avian influenza and Newcastle disease are reportable in many countries — if you suspect an outbreak, contact your veterinarian or county veterinary office.
      </p>
    </div>
  );
}

function FlockLogForm({ supabase, farm, zones, userId, onSaved, running }) {
  const activeZones = zones.filter((zone) => zone.status !== 'retired');
  const emptyForm = () => ({
    zoneId: activeZones[0]?.id || '',
    logDate: farmToday(farm.timezone),
    flockSize: '',
    deaths: '',
    sickCount: '',
    feedIntakePct: '',
    waterIntakePct: '',
    respiratorySigns: false,
    notes: '',
  });
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  const update = (field) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setStatus(null);
    const { errors: found, row } = validateLog(form);
    setErrors(found);
    if (!row) return;
    setSaving(true);
    const { error } = await supabase
      .from('flock_health_logs')
      .upsert({ ...row, farm_id: farm.id, recorded_by: userId }, { onConflict: 'zone_id,log_date' });
    setSaving(false);
    if (error) {
      setStatus({ tone: 'error', text: error.message });
      return;
    }
    setStatus({ tone: 'ok', text: 'Log saved. Updating risk…' });
    setForm((current) => ({ ...emptyForm(), zoneId: current.zoneId, logDate: current.logDate }));
    const checked = await onSaved();
    setStatus(
      checked
        ? { tone: 'ok', text: 'Log saved and risk updated.' }
        : { tone: 'error', text: 'Log saved, but the risk check failed. Press Run check to try again.' },
    );
  };

  const field = (name, label, props = {}) => (
    <label className={`os-field ${errors[name] ? 'os-field-error' : ''}`}>
      <span>{label}</span>
      <input value={form[name]} onChange={update(name)} aria-invalid={Boolean(errors[name])} {...props} />
      {errors[name] && <small>{errors[name]}</small>}
    </label>
  );

  if (!activeZones.length) {
    return <div className="os-note"><Info size={14} /> Add a farm zone first; flock logs are recorded per zone.</div>;
  }

  return (
    <section className="panel os-panel">
      <div className="panel-header">
        <div><h2><NotebookPen size={15} /> Daily flock log</h2><p>One entry per zone per day. Saving again for the same day updates it.</p></div>
      </div>
      <form className="os-form" onSubmit={submit} noValidate>
        <label className={`os-field ${errors.zoneId ? 'os-field-error' : ''}`}>
          <span>Zone</span>
          <select value={form.zoneId} onChange={update('zoneId')}>
            {activeZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
          </select>
          {errors.zoneId && <small>{errors.zoneId}</small>}
        </label>
        {field('logDate', 'Date', { type: 'date', max: farmToday(farm.timezone) })}
        {field('flockSize', 'Birds in zone', { type: 'number', min: 1, inputMode: 'numeric', placeholder: 'e.g. 500' })}
        {field('deaths', 'Deaths today', { type: 'number', min: 0, inputMode: 'numeric', placeholder: '0' })}
        {field('sickCount', 'Sick birds', { type: 'number', min: 0, inputMode: 'numeric', placeholder: '0' })}
        {field('feedIntakePct', 'Feed eaten (% of normal)', { type: 'number', min: 0, max: 200, inputMode: 'numeric', placeholder: '100' })}
        {field('waterIntakePct', 'Water drunk (% of normal)', { type: 'number', min: 0, max: 200, inputMode: 'numeric', placeholder: '100' })}
        <label className="os-check">
          <input type="checkbox" checked={form.respiratorySigns} onChange={update('respiratorySigns')} />
          <span>Breathing problems seen (coughing, sneezing, gasping)</span>
        </label>
        <label className={`os-field os-field-wide ${errors.notes ? 'os-field-error' : ''}`}>
          <span>Notes (optional)</span>
          <input value={form.notes} onChange={update('notes')} maxLength={1000} placeholder="Anything unusual you noticed" />
          {errors.notes && <small>{errors.notes}</small>}
        </label>
        <div className="os-form-actions">
          <button className="primary-button" type="submit" disabled={saving || running}>{saving ? 'Saving…' : running ? 'Updating risk…' : 'Save and check'}</button>
          {status && <span className={`os-form-status os-run-${status.tone}`} role="status">{status.text}</span>}
        </div>
      </form>
    </section>
  );
}
