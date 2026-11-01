import { useEffect, useRef, useState } from 'react';
import { Camera, ScanEye, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { metrics, readingValues, telemetrySelect, validateResult } from '../../supabase/functions/_shared/advisory.js';
import './FarmAdvisory.css';

const when = value => value ? new Date(value).toLocaleString() : 'Unavailable';

async function findPhoto(farmId, reading) {
  const select = 'id,storage_bucket,storage_path,captured_at,is_night';
  const { data: linked } = await supabase.from('camera_snapshots').select(select)
    .eq('farm_id', farmId).eq('telemetry_event_id', reading.id)
    .order('captured_at', { ascending: false }).limit(1);
  let row = linked?.[0] || null;
  if (!row && reading.zone_id) {
    const { data: zonal } = await supabase.from('camera_snapshots').select(select)
      .eq('farm_id', farmId).eq('zone_id', reading.zone_id)
      .order('captured_at', { ascending: false }).limit(1);
    row = zonal?.[0] || null;
  }
  if (!row) return null;
  const { data: signed, error } = await supabase.storage.from(row.storage_bucket || 'farm-media').createSignedUrl(row.storage_path, 3600);
  if (error || !signed?.signedUrl) return { ...row, src: '', failed: true };
  return { ...row, src: signed.signedUrl };
}

export default function FarmAdvisory({ farmId, farmName, userId, zones = [], initialTelemetryId = '' }) {
  const [context, setContext] = useState({ readings: [], rules: [], alerts: [] });
  const [zoneChoice, setZoneChoice] = useState('all');
  const [telemetryId, setTelemetryId] = useState('');
  const [photo, setPhoto] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState(null);
  const [history, setHistory] = useState([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true), lock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    setZoneChoice('all'); setTelemetryId(''); setRecord(null); setHistory([]); setPhoto(null);
    refresh();
    loadShared();
    return () => { mounted.current = false; };
  }, [farmId]);

  const filteredReadings = zoneChoice === 'all'
    ? context.readings
    : context.readings.filter(row => row.zone_id === zoneChoice);

  useEffect(() => {
    if (!context.readings.length) return;
    if (initialTelemetryId && context.readings.some(row => row.id === initialTelemetryId)) {
      const target = context.readings.find(row => row.id === initialTelemetryId);
      setZoneChoice(target.zone_id || 'all');
      setTelemetryId(initialTelemetryId);
    } else if (!telemetryId || !filteredReadings.some(row => row.id === telemetryId)) {
      setTelemetryId(filteredReadings[0]?.id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTelemetryId, context.readings, zoneChoice]);

  const reading = context.readings.find(x => x.id === telemetryId) || null;

  useEffect(() => {
    let cancelled = false;
    setPhoto(null);
    if (!reading) return;
    setPhotoLoading(true);
    findPhoto(farmId, reading)
      .then(found => { if (!cancelled && mounted.current) setPhoto(found); })
      .catch(() => { if (!cancelled && mounted.current) setPhoto({ failed: true }); })
      .finally(() => { if (!cancelled && mounted.current) setPhotoLoading(false); });
    return () => { cancelled = true; };
  }, [farmId, reading?.id]);

  const zoneName = id => zones.find(x => x.id === id)?.name || (id ? `Zone ${String(id).slice(0, 8)}` : 'Farm level');

  async function refresh() {
    setLoading(true); setError(''); setRecord(null); setNotice('');
    try {
      const responses = await Promise.all([
        supabase.from('telemetry_events').select(telemetrySelect).eq('farm_id', farmId).not('zone_id', 'is', null).order('captured_at', { ascending: false }).limit(50),
        supabase.from('alert_rules').select('id,farm_id,zone_id,metric_key,operator,threshold,severity,enabled').eq('farm_id', farmId).eq('enabled', true),
        supabase.from('farm_alerts').select('id,farm_id,zone_id,telemetry_event_id,alert_type,severity,resolved_at').eq('farm_id', farmId).neq('alert_type', 'farm_advisory').order('occurred_at', { ascending: false }).limit(100),
      ]);
      if (!mounted.current) return;
      if (responses.some(x => x.error)) throw new Error('Could not load the farm readings, rules or warnings. Refresh to retry; no values will be substituted.');
      const next = { readings: responses[0].data || [], rules: responses[1].data || [], alerts: responses[2].data || [] };
      setContext(next);
      setTelemetryId(next.readings[0]?.id || '');
    } catch (err) { if (mounted.current) { setContext({ readings: [], rules: [], alerts: [] }); setTelemetryId(''); setError(err.message); } }
    finally { if (mounted.current) setLoading(false); }
  }

  async function loadShared() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const { data, error: failure } = await supabase.from('farm_image_analyses').select('*').eq('farm_id', farmId).eq('status', 'complete').order('created_at', { ascending: false }).limit(10);
      if (!mounted.current) return;
      if (failure) throw new Error('Advisory history is unavailable. Apply the advisory migration first.');
      const rows = (data || []).filter(x => x.advisory?.version === 2).map(x => ({ ...x, shared: true }));
      rows.forEach(x => validateResult(x.result));
      setHistory(rows);
      setNotice(rows.length ? 'Saved advisory history loaded.' : 'No published advisories yet. Select the latest reading and run an advisory.');
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  async function run() {
    if (lock.current) return;
    if (!reading) { setError('Select an existing telemetry record from this farm first.'); return; }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: failure } = await supabase.functions.invoke('farm-advisory', {
        body: { farm_id: farmId, telemetry_event_id: reading.id, request_id: crypto.randomUUID() },
      });
      if (!mounted.current) return;
      if (failure || data?.error) {
        let message = data?.error || 'Deploy the farm-advisory function and apply its database migration first.';
        try { const payload = await failure?.context?.json(); if (payload?.error) message = payload.error; } catch { /* No JSON gateway error. */ }
        throw new Error(message);
      }
      validateResult(data.record.result);
      const saved = { ...data.record, shared: true };
      setRecord(saved);
      setHistory(previous => [saved, ...previous.filter(x => x.id !== saved.id)].slice(0, 10));
      setNotice(data.reused ? 'Existing advisory reused. No duplicate alert or new model request was created.' : 'Advisory saved to analysis history and published to the dashboard alerts.');
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  const values = reading ? readingValues(reading) : null;
  const vision = record?.advisory?.vision || null;
  const stages = record?.advisory?.stages || null;
  const verdict = !record ? '' : record.advisory.generated === false ? 'template' : (vision?.verdict === 'attention' ? 'attention' : 'normal');

  return <section className="panel vision-panel advisory-panel" aria-labelledby="advisory-heading">
    <header className="vision-heading"><div><span className="eyebrow">{farmName || 'YOUR FARM'} · ENVIRONMENT & CAMERA</span><h2 id="advisory-heading">Farm advisory</h2><p>Your latest farm photo and readings, read by Meta vision models into one plain-language advisory.</p></div><span className="vision-badge"><ShieldCheck size={14}/> Observations & inspection checks</span></header>

    <div className="advisory-controls">
      <div><label htmlFor="advisory-zone">Zone</label><select id="advisory-zone" disabled={busy || loading} value={zoneChoice} onChange={e => { setZoneChoice(e.target.value); setRecord(null); setNotice(''); setError(''); }}><option value="all">All zones · latest first</option>{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></div>
      <div><label htmlFor="advisory-reading">Farm telemetry record</label><select id="advisory-reading" disabled={busy || loading || !filteredReadings.length} value={telemetryId} onChange={e => { setTelemetryId(e.target.value); setRecord(null); setNotice(''); setError(''); }}>{!filteredReadings.length && <option value="">{loading ? 'Loading existing readings…' : 'No zone-linked readings available'}</option>}{!telemetryId && filteredReadings.length > 0 && <option value="">Choose a record</option>}{filteredReadings.map(row => <option key={row.id} value={row.id}>{zoneName(row.zone_id)} · {when(row.captured_at)}</option>)}</select></div>
    </div>

    {reading && values && <><p className="vision-caption">Selected evidence · {zoneName(reading.zone_id)} · recorded {when(reading.captured_at)}{reading.is_night ? ' · night' : ''}</p><div className="advisory-readings">{metrics.map(metric => <div key={metric.key}><span>{metric.label}</span><strong>{values[metric.key] === null ? 'Unavailable' : `${values[metric.key]} ${metric.unit}`}</strong></div>)}</div></>}

    <div className="vision-image-wrap advisory-photo">
      {photoLoading && <p className="vision-caption">Loading the farm photo for this record…</p>}
      {!photoLoading && photo?.src && <><img src={photo.src} alt={`Farm camera photo for ${zoneName(reading?.zone_id)}`} onError={e => { e.currentTarget.style.display = 'none'; }} /><span><Camera size={13}/> Farm camera · {when(photo.captured_at)}{photo.is_night ? ' · night' : ''}</span></>}
      {!photoLoading && !photo?.src && <p role={photo ? undefined : 'status'}>{photo?.failed ? 'The farm photo for this record could not be opened. The advisory will cover the readings only.' : 'No photo is linked to this record yet. Submit one from Fill out data, or run a readings-only advisory.'}</p>}
    </div>

    <div className="advisory-actions"><button className="primary-button vision-run" disabled={busy || loading || !reading} onClick={run}><ScanEye size={16}/> {busy ? 'Processing…' : 'Run advisory'}</button><button className="outline-button" disabled={busy || loading} onClick={() => { refresh(); loadShared(); }}>Refresh latest data</button></div>
    <p className="vision-caption">SAM 3.1 segments the flock photo and Muse Spark combines it with the readings above. No photo is ever invented; missing values stay unavailable.</p>
    <div aria-live="polite">{notice && <p className="vision-notice">{notice}</p>}</div>{error && <p role="alert" className="vision-error">{error}</p>}

    {record && <article className="vision-result meta"><span className={`verdict-badge verdict-${verdict}`}>{verdict === 'attention' ? 'NEEDS ATTENTION' : verdict === 'template' ? 'READINGS-ONLY TEMPLATE' : 'LOOKS NORMAL'}</span><h3>{record.advisory.title}</h3><p>{record.advisory.message}</p>
      <p className="vision-caption">Published to alerts · {when(record.created_at)}{record.model ? ` · ${record.model}` : ''}{stages?.sam ? ` · SAM: ${stages.sam}` : ''}{stages?.vision ? ` · Vision: ${stages.vision}` : ''}</p>
      {vision && <section><h4>Flock distribution in this photo</h4><div className="distribution-grid"><div><span>Total visible</span><strong>{vision.distribution.total_visible}</strong></div><div><span>At feeders</span><strong>{vision.distribution.at_feeders}</strong></div><div><span>In brooders</span><strong>{vision.distribution.in_brooders}</strong></div><div><span>Free-roam</span><strong>{vision.distribution.free_roam}</strong></div></div>{vision.behavior_flags.length > 0 && <p className="vision-caption">Observed behaviour: {vision.behavior_flags.join(', ')}</p>}</section>}
      {[['observations', 'Visual context'], ['concerns', 'Risk flags'], ['next_checks', 'Inspection checks'], ['limitations', 'Evidence limits']].map(([key, title]) => <section key={key}><h4>{title}</h4><ul>{record.result[key].map((line, index) => <li key={index}>{line}</li>)}</ul></section>)}
      {record.advisory.evidence.checks.length > 0 && <section><h4>Configured rules matched</h4><ul>{record.advisory.evidence.checks.map(rule => <li key={rule.id}>{metrics.find(x => x.key === rule.metric_key)?.label} · {rule.operator} {rule.threshold}</li>)}</ul></section>}
    </article>}

    <footer className="vision-history"><div className="vision-history-heading"><h3>Advisory history</h3><button className="outline-button" disabled={busy || loading} onClick={loadShared}>Load saved advisories</button></div><div className="vision-history-list">{history.map(row => <button key={row.id} disabled={busy || loading} onClick={() => { setTelemetryId(context.readings.some(r => r.id === row.advisory.telemetry_event_id) ? row.advisory.telemetry_event_id : telemetryId); setRecord(row); setNotice('Saved advisory shown; select a telemetry record to start another run.'); setError(''); }}><span className="vision-history-dot meta" /><span><strong>{row.advisory.title}</strong><small>Published · {when(row.created_at)}</small></span></button>)}</div>{!history.length && <p>No advisories yet. Run one on the latest reading above.</p>}</footer>
  </section>;
}
