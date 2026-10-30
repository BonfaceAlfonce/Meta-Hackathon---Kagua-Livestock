import { useEffect, useRef, useState } from 'react';
import { Camera, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { advisoryFeeds, advisoryImageId, buildAdvisory, metrics, telemetrySelect } from '../../supabase/functions/_shared/advisory.js';
import { validateResult } from '../../supabase/functions/_shared/vision.js';
import './FarmAdvisory.css';
const when = value => value ? new Date(value).toLocaleString() : 'Unavailable';
function loadLocal(key, farmId) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(rows) ? rows.filter(row => {
      try { validateResult(row.result); return row.farm_id === farmId && row.image_id === advisoryImageId && row.advisory?.farm_id === farmId && ['sample','meta'].includes(row.mode); } catch { return false; }
    }).slice(0,10) : [];
  } catch { return []; }
}
export default function FarmAdvisory({ farmId, userId }) {
  const storageKey = `kagua-advisory-v1:${userId}:${farmId}`;
  const [context, setContext] = useState({ readings: [], rules: [], alerts: [], zones: [] });
  const [telemetryId, setTelemetryId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('sample');
  const [record, setRecord] = useState(null);
  const [history, setHistory] = useState(() => loadLocal(storageKey, farmId));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const mounted = useRef(true), lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => { mounted.current = false; };
  }, [farmId]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(history)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [history, storageKey]);
  async function refresh() {
    setLoading(true); setError(''); setRecord(null); setNotice('');
    try {
      const responses = await Promise.all([
        supabase.from('telemetry_events').select(telemetrySelect).eq('farm_id', farmId).not('zone_id','is',null).order('captured_at',{ ascending: false }).limit(50),
        supabase.from('alert_rules').select('id,farm_id,zone_id,metric_key,operator,threshold,severity,enabled').eq('farm_id',farmId).eq('enabled',true),
        supabase.from('farm_alerts').select('id,farm_id,zone_id,telemetry_event_id,alert_type,severity,resolved_at').eq('farm_id',farmId).neq('alert_type','farm_advisory').order('occurred_at',{ ascending: false }).limit(100),
        supabase.from('farm_zones').select('id,name').eq('farm_id',farmId)
      ]);
      if (!mounted.current) return;
      if (responses.some(x => x.error)) throw new Error('Could not load the existing Das Farm readings, rules or warnings. Refresh to retry; no values will be substituted.');
      const next = { readings: responses[0].data || [], rules: responses[1].data || [], alerts: responses[2].data || [], zones: responses[3].data || [] };
      setContext(next); setTelemetryId(next.readings[0]?.id || '');
    } catch (err) { if (mounted.current) { setContext({ readings: [], rules: [], alerts: [], zones: [] }); setTelemetryId(''); setError(err.message); } }
    finally { if (mounted.current) setLoading(false); }
  }
  function remember(row, shared) {
    validateResult(row.result);
    if (row.farm_id !== farmId || row.advisory?.farm_id !== farmId) throw new Error('Advisory farm mismatch.');
    const saved = { ...row, shared };
    setRecord(saved);
    setHistory(previous => [saved, ...previous.filter(x => x.id !== saved.id && !(saved.signature && x.signature === saved.signature))].slice(0,10));
  }
  async function run() {
    if (lock.current) return;
    const reading = context.readings.find(x => x.id === telemetryId);
    if (!reading) { setError('Select an existing Das Farm telemetry record first.'); return; }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    let local = null;
    try {
      if (mode === 'sample') {
        const visual = advisoryFeeds.map(image => ({ image_id: image.id, source: 'prepared', boxes: [] }));
        const advisory = buildAdvisory(reading, context.rules, context.alerts, visual);
        const signature = JSON.stringify(advisory);
        local = history.find(x => x.mode === 'sample' && x.signature === signature) || {
          id: crypto.randomUUID(), farm_id: farmId, image_id: advisoryImageId, image_title: 'Das Farm · two-image advisory',
          mode: 'sample', model: null, created_at: new Date().toISOString(), status: 'complete', result: advisory.result, advisory, signature
        };
        remember(local, local.shared || false);
        setNotice('Prepared advisory assembled from the selected record. Publishing to the existing alert display…');
      } else setRecord(null);
      const { data, error: failure } = await supabase.functions.invoke('farm-advisory', { body: {
        farm_id: farmId, telemetry_event_id: reading.id, mode, request_id: crypto.randomUUID()
      } });
      if (!mounted.current) return;
      if (failure || data?.error) {
        let message = data?.error || 'Deploy the advisory function and apply its database migration to publish dashboard alerts.';
        try { const payload = await failure?.context?.json(); if (payload?.error) message = payload.error; } catch { /* No JSON gateway error. */ }
        throw new Error(message);
      }
      remember({ ...data.record, signature: local?.signature }, true);
      setNotice(data.reused ? 'Existing advisory reused. No duplicate alert or new SAM request was created.' : 'Advisory saved to analysis history and the existing dashboard alert display.');
    } catch (err) {
      if (mounted.current) {
        setError(err.message);
        setNotice(local ? 'Prepared sample is available in this browser only. Publishing was not confirmed; no SAM inference was performed.' : 'No combined advisory was published. There was no sample fallback.');
      }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function loadShared() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const { data, error: failure } = await supabase.from('farm_image_analyses').select('*').eq('farm_id',farmId).eq('image_id',advisoryImageId).eq('status','complete').order('created_at',{ ascending: false }).limit(10);
      if (!mounted.current) return;
      if (failure) throw new Error('Advisory shared history is unavailable. Apply the advisory migration first.');
      const rows = (data || []).filter(x => x.advisory).map(x => ({ ...x, shared: true }));
      rows.forEach(x => validateResult(x.result));
      setHistory(previous => [...rows, ...previous.filter(x => !rows.some(r => r.id === x.id))].slice(0,10));
      setNotice(rows.length ? 'Saved advisory history loaded.' : 'No published advisories yet.');
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const reading = context.readings.find(x => x.id === telemetryId);
  const preview = reading ? buildAdvisory(reading, context.rules, context.alerts) : null;
  const shown = record?.advisory || preview;
  const zoneName = id => context.zones.find(x => x.id === id)?.name || `Zone ${id?.slice(0,8) || 'unavailable'}`;
  return <section className="panel vision-panel advisory-panel" aria-labelledby="advisory-heading">
    <header className="vision-heading"><div><span className="eyebrow">DAS FARM · ENVIRONMENT & CAMERA CONTEXT</span><h2 id="advisory-heading">Farm advisory</h2><p>Two simulated feed images, paired with an existing Das Farm reading.</p></div><span className="vision-badge"><ShieldCheck size={14}/> Observations & inspection checks</span></header>
    <div className="advisory-feeds">{advisoryFeeds.map(feed => <figure key={feed.id}><img src={feed.url} alt={`${feed.title}: owner-supplied poultry reference`} onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement.querySelector('.advisory-image-error').hidden = false; }}/><p className="advisory-image-error" hidden>Reference image unavailable. No visual finding can be confirmed.</p><figcaption><Camera size={13}/>{feed.title} · demo reference</figcaption></figure>)}</div>
    <p className="vision-caption">These are independent reference images, paired for the demo; they are not a timeline or synchronized farm captures. The third gallery image remains a reference.</p>
    <div className="advisory-controls"><div><label htmlFor="advisory-reading">Existing Das Farm telemetry</label><select id="advisory-reading" disabled={busy || loading || !context.readings.length} value={telemetryId} onChange={e => { setTelemetryId(e.target.value); setRecord(null); setNotice(''); setError(''); }}>{!context.readings.length && <option value="">{loading ? 'Loading existing readings…' : 'No zone-linked readings available'}</option>}{!telemetryId && context.readings.length > 0 && <option value="">Choose a current record</option>}{context.readings.map(row => <option key={row.id} value={row.id}>{zoneName(row.zone_id)} · {when(row.captured_at)}</option>)}</select></div><div><label htmlFor="advisory-mode">Visual processing</label><select id="advisory-mode" disabled={busy || loading} value={mode} onChange={e => { setMode(e.target.value); setRecord(null); setNotice(''); setError(''); }}><option value="sample">Prepared sample · no SAM inference</option><option value="meta">Meta SAM · actual segmentation</option></select></div></div>
    {shown && <><p className="vision-caption">{record ? 'Saved evidence' : 'Selected evidence'} · {zoneName(shown.zone_id)} · recorded {when(shown.captured_at)}</p><div className="advisory-readings">{metrics.map(metric => <div key={metric.key}><span>{metric.label}</span><strong>{shown.evidence.values[metric.key] === null ? 'Unavailable' : `${shown.evidence.values[metric.key]} ${metric.unit}`}</strong></div>)}</div></>}
    <div className="advisory-actions"><button className="primary-button vision-run" disabled={busy || loading || !reading} onClick={run}>{busy ? 'Processing…' : mode === 'sample' ? 'Run sample advisory' : 'Run SAM advisory'}</button><button className="outline-button" disabled={busy || loading} onClick={refresh}>Refresh readings</button></div>
    <p className="vision-caption">Sample mode uses prepared visual context and the displayed database values. SAM mode requires server configuration. Neither mode generates medical recommendations.</p>
    <div aria-live="polite">{notice && <p className="vision-notice">{notice}</p>}</div>{error && <p role="alert" className="vision-error">{error}</p>}{storageError && <p className="vision-error">Browser history could not be saved. Keep this session open or load shared history after publishing.</p>}
    {record && <article className={`vision-result ${record.mode}`}><span className="vision-badge">{record.mode === 'sample' ? 'SAMPLE ADVISORY · PREPARED VISUAL INPUTS' : 'SAM SEGMENTATION · TEMPLATE ADVISORY'}</span><h3>{record.advisory.title}</h3><p>{record.advisory.message}</p><p className="vision-caption">{record.shared ? 'Published to existing alerts' : 'Browser only · not published'} · {when(record.created_at)}{record.model && ` · ${record.model}`}</p>{[['observations','Visual context'],['concerns','Risk flags'],['next_checks','Inspection checks'],['limitations','Evidence limits']].map(([key,title]) => <section key={key}><h4>{title}</h4><ul>{record.result[key].map((line,index) => <li key={index}>{line}</li>)}</ul></section>)}{record.advisory.evidence.checks.length > 0 && <section><h4>Existing configured rules matched</h4><ul>{record.advisory.evidence.checks.map(rule => <li key={rule.id}>{metrics.find(x => x.key === rule.metric_key)?.label} · {rule.operator} {rule.threshold}</li>)}</ul></section>}</article>}
    <footer className="vision-history"><div className="vision-history-heading"><h3>Advisory history</h3><button className="outline-button" disabled={busy || loading} onClick={loadShared}>Load saved advisories</button></div><div className="vision-history-list">{history.map(row => <button key={row.id} disabled={busy || loading} onClick={() => { setTelemetryId(context.readings.some(reading => reading.id === row.advisory.telemetry_event_id) ? row.advisory.telemetry_event_id : ''); setRecord(row); setNotice('Saved evidence shown; select a telemetry record to start another run.'); setError(''); setMode(row.mode); }}><span className={`vision-history-dot ${row.mode}`}/><span><strong>{row.advisory.title}</strong><small>{row.mode === 'sample' ? 'Prepared visuals' : 'SAM visuals'} · {row.shared ? 'Published' : 'Browser only'} · {when(row.created_at)}</small></span></button>)}</div>{!history.length && <p>No advisory runs yet.</p>}</footer>
  </section>;
}
