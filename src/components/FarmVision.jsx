import { useEffect, useRef, useState } from 'react';
import { Camera, FlaskConical, History, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { catalogue, resultKeys, sampleRecord, validateResult } from '../../supabase/functions/_shared/vision.js';
import './FarmVision.css';
import FarmAdvisory from './FarmAdvisory.jsx';

const headings = { observations: 'What is visible', concerns: 'Possible concerns', next_checks: 'Suggested checks', limitations: 'What this image cannot tell us' };
const when = time => new Date(time).toLocaleString();
function readHistory(key) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(rows) ? rows.filter(row => {
      try { validateResult(row.result); return row.status === 'complete' && ['sample', 'meta'].includes(row.mode) && catalogue.some(x => x.id === row.image_id); } catch { return false; }
    }).slice(0, 20) : [];
  } catch { return []; }
}
async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('analyse-farm-image', { body });
  if (error) {
    let message = 'Analysis service unavailable. Ask your administrator to deploy the function and check its configuration.';
    try { const details = await error.context?.json(); if (details?.error) message = details.error; } catch { /* Network or non-JSON gateway error. */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
export default function FarmVision({ farmId, userId }) {
  const storageKey = `kagua-vision-v1:${userId}:${farmId}`;
  const [imageId, setImageId] = useState(catalogue[0].id);
  const [mode, setMode] = useState('sample');
  const [history, setHistory] = useState(() => readHistory(storageKey).filter(r => r.farm_id === farmId && r.created_by === userId));
  const [record, setRecord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [imageError, setImageError] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const image = catalogue.find(x => x.id === imageId);
  function remember(row, shared = false) {
    validateResult(row.result);
    const saved = { ...row, shared };
    setRecord(saved);
    setHistory(previous => {
      const next = [saved, ...previous.filter(x => x.id !== saved.id)].slice(0, 20);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { setNotice('Browser storage is unavailable. This result is visible for this session only.'); }
      return next;
    });
  }
  async function run(action) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'analyse' && mode === 'sample') {
        remember(sampleRecord(image, farmId, userId, crypto.randomUUID(), new Date().toISOString()));
        setNotice('Sample opened. Saved to this browser only; no model was called.');
      } else if (action === 'history') {
        const { data, error: failure } = await supabase.from('farm_image_analyses').select('*').eq('farm_id', farmId).in('image_id', catalogue.map(image => image.id)).eq('status', 'complete').order('created_at', { ascending: false }).limit(20);
        if (!mounted.current) return;
        if (failure) throw new Error('Shared history is unavailable. Apply the vision database migration first. Browser history remains available.');
        const rows = (data || []).map(r => ({ ...r, shared: true }));
        rows.forEach(r => validateResult(r.result));
        setHistory(previous => {
          const merged = [...rows, ...previous.filter(r => !rows.some(x => x.id === r.id))].sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0,20);
          try { localStorage.setItem(storageKey, JSON.stringify(merged)); } catch { /* Loaded history stays in memory. */ }
          return merged;
        });
        setNotice(rows.length ? 'Shared farm history loaded.' : 'No shared analyses yet.');
      } else {
        const body = action === 'sync'
          ? { farm_id: farmId, image_id: record.image_id, mode: 'sample', request_id: record.id }
          : { farm_id: farmId, image_id: image.id, mode: 'meta', request_id: crypto.randomUUID() };
        const data = await invoke(body);
        if (!mounted.current) return;
        remember(data.record, true);
        setNotice(action === 'sync' ? 'Sample saved to shared farm history.' : 'Meta analysis complete and saved to farm history.');
      }
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  function changeImage(id) { setImageId(id); setRecord(null); setError(''); setNotice(''); setImageError(false); }
  return <><FarmAdvisory key={`${farmId}:${userId}`} farmId={farmId} userId={userId}/><section className="panel vision-panel" aria-labelledby="vision-heading">
    <header className="vision-heading"><div><span className="eyebrow">DAS FARM · COMPUTER VISION</span><h2 id="vision-heading">A closer look at your flock</h2><p>Explore reference images and keep the evidence beside each finding.</p></div><span className="vision-badge"><FlaskConical size={14}/> Demo images</span></header>
    <div className="vision-layout"><div className="vision-evidence">
      <label htmlFor="vision-image">Reference image</label><select id="vision-image" disabled={busy} value={imageId} onChange={e => changeImage(e.target.value)}>{catalogue.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
      <div className="vision-image-wrap">{imageError ? <p role="alert">This image could not be loaded. Check its file path in the catalogue.</p> : <img src={record?.image_path || image.path} alt={record?.image_title || image.title} onError={() => setImageError(true)}/>}<span><Camera size={13}/> Reference photo · not a Das Farm capture</span></div>
      <strong>{image.zone}</strong><p className="vision-credit">{image.credit}{image.sourceUrl && <> · <a href={image.sourceUrl} target="_blank" rel="noreferrer">Original source</a></>}</p>
      <p className="vision-caption">Independent still image. It cannot establish movement, resource visits or changes over time.</p>
    </div><div className="vision-analysis">
      <label htmlFor="vision-mode">Analysis mode</label><select id="vision-mode" disabled={busy} value={mode} onChange={e => { setMode(e.target.value); setRecord(null); setError(''); setNotice(''); }}><option value="sample">Presentation · sample result</option><option value="meta">Meta · actual image analysis</option></select>
      <p>{mode === 'sample' ? 'Prepared observations for your presentation. No AI inference is performed.' : 'Sends the selected reference photo to Meta. Requires the deployed service, API key and model access.'}</p>
      <button className="primary-button vision-run" disabled={busy || imageError} onClick={() => run('analyse')}><Sparkles size={16}/>{busy ? 'Working…' : mode === 'sample' ? 'Show sample result' : 'Analyse with Meta'}</button>
      <div aria-live="polite">{notice && <p className="vision-notice">{notice}</p>}</div>{error && <p role="alert" className="vision-error">{error}</p>}
      {record ? <article className={`vision-result ${record.mode}`}><span className="vision-badge">{record.mode === 'sample' ? 'SAMPLE RESULT · PREWRITTEN' : 'META RESULT · MODEL GENERATED'}</span><h3>{record.image_title}</h3><p className="vision-caption">{record.mode === 'sample' ? 'Sample opened' : 'Analysed'} {when(record.created_at)} · {record.shared ? 'Shared farm history' : 'This browser only'}{record.model ? ` · ${record.model}` : ''}</p>{resultKeys.map(key => <section key={key}><h4>{headings[key]}</h4><ul>{record.result[key].length ? record.result[key].map((line,i) => <li key={i}>{line}</li>) : <li>No specific finding reported.</li>}</ul></section>)}{record.mode === 'sample' && !record.shared && <button className="outline-button" disabled={busy} onClick={() => run('sync')}>Save sample to farm history</button>}</article> : <div className="vision-empty"><Camera size={26}/><strong>Your evidence stays in view</strong><p>Choose an image and open its sample result, or select Meta analysis once configured.</p></div>}
    </div></div>
    <footer className="vision-history"><div className="vision-history-heading"><h3><History size={16}/> Analysis history</h3><button className="outline-button" disabled={busy} onClick={() => run('history')}>Load shared history</button></div><p className="vision-caption">Samples are saved in this browser. Sharing requires the database migration and deployed service. Public reference photos remain public.</p>{history.length ? <div className="vision-history-list">{history.map(row => <button key={row.id} disabled={busy} onClick={() => { changeImage(row.image_id); setMode(row.mode); setRecord(row); }}><span className={`vision-history-dot ${row.mode}`}/><span><strong>{row.image_title}</strong><small>{row.mode === 'sample' ? 'Prewritten sample' : 'Meta analysis'} · {row.shared ? 'Shared' : 'Browser'} · {when(row.created_at)}</small></span></button>)}</div> : <p>No analyses opened yet.</p>}</footer>
  </section></>;
}
