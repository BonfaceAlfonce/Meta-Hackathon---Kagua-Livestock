import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, Bell, Bird, Camera, Check, ChevronDown, ClipboardList, Clock3, Cloud, Cpu, Database, Download, Eye, EyeOff, Filter, ImagePlus, LayoutDashboard, Leaf, LockKeyhole, LogOut, Menu, MessageCircle, Moon, Search, Settings2, ShieldAlert, ShieldCheck, Sun, Thermometer, Droplets, Wifi, Wind, X } from 'lucide-react';
import { supabase, supabaseConfigured } from './lib/supabase.js';
import OutbreakShield from './OutbreakShield.jsx';

const plans = [
  { name: 'Watch', cameras: 1, price: '1,500', description: 'A clear view of one animal area.', features: ['Live camera snapshots', 'Sensor readings and alerts', 'Monthly farm health report'] },
  { name: 'Farm', cameras: 4, price: '4,500', description: 'Coverage for your key farm zones.', features: ['Everything in Watch', 'Up to 4 monitored zones', 'Weekly reports and night checks'], featured: true },
  { name: 'Ranch', cameras: 6, price: '6,500', description: 'Barns, stables and open range.', features: ['Everything in Farm', 'Up to 6 monitored zones', 'Daily summary and priority alerts'] },
  { name: 'Estate', cameras: 12, price: '11,500', description: 'Visibility across the whole farm.', features: ['Everything in Ranch', 'Up to 12 monitored zones', 'Custom reports and team access'] },
];
const sampleSnapshots = [
  { id: 'sample-chicks', zone: 'Free-range chick area', captured_at: new Date().toISOString(), time: 'Example · daytime', src: '/images/chicks-free-range.jpg', is_night: false, note: 'Sample photo · ESP32 snapshot preview', isDemo: true },
  { id: 'sample-brooder', zone: 'Brooder house', captured_at: new Date(Date.now() - 3600000).toISOString(), time: 'Example · 1 hour ago', src: '/images/flock-house.jpg', is_night: false, note: 'Sample photo · ESP32 snapshot preview', isDemo: true },
  { id: 'sample-hens', zone: 'Free-roam pasture', captured_at: new Date(Date.now() - 7200000).toISOString(), time: 'Example · 2 hours ago', src: '/images/free-range-hens.jpg', is_night: false, note: 'Sample photo · ESP32 snapshot preview', isDemo: true },
  { id: 'sample-white-flock', zone: 'Poultry enclosure', captured_at: new Date(Date.now() - 10800000).toISOString(), time: 'Example · 3 hours ago', src: '/images/brooder-chicks.jpg', is_night: false, note: 'Sample photo · ESP32 snapshot preview', isDemo: true },
];
const DEFAULT_FARM_TIMEZONE = 'Africa/Nairobi';
const resolveTimeZone = tz => {
  const candidate = tz || DEFAULT_FARM_TIMEZONE;
  try { Intl.DateTimeFormat(undefined, { timeZone: candidate }); return candidate; }
  catch { return DEFAULT_FARM_TIMEZONE; }
};
const fmtTime = (value, timeZone) => {
  if (!value) return '—';
  const tz = resolveTimeZone(timeZone);
  try {
    return new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short', timeZone: tz });
  } catch { return new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); }
};
const fmtNow = (timeZone, now = new Date()) => {
  const tz = resolveTimeZone(timeZone);
  try {
    return now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: tz, timeZoneName: 'short' });
  } catch { return now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
};
const fmtMetric = (value, digits = 1) => value === null || value === undefined ? '—' : Number(value).toFixed(digits);
const E164_RE = /^[+][1-9][0-9]{7,14}$/;
const normalizePhoneE164 = (raw, countryCode) => {
  let digits = String(raw || '').replace(/[\s\-().]/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  else if (digits.startsWith('0')) {
    const cc = { KE: '254' }[String(countryCode || 'KE').toUpperCase()] || null;
    if (cc) digits = `+${cc}${digits.slice(1)}`;
  } else if (!digits.startsWith('+')) digits = `+${digits}`;
  return digits;
};
const isCo2Key = key => { const norm = String(key).toLowerCase().replace(/[^a-z0-9]/g, ''); return norm.includes('co2') || (norm.includes('carbon') && norm.includes('oxide') && !norm.includes('monoxide')); };
const extractCo2 = source => {
  if (!source || typeof source !== 'object') return null;
  for (const [key, raw] of Object.entries(source)) {
    if (!isCo2Key(key)) continue;
    if (raw === null || raw === undefined || raw === '') continue;
    if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) continue;
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return null;
};

const fileToAnalysisImage = file => new Promise(resolve => {
  const fallback = () => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const base64 = url.includes(',') ? url.split(',')[1] : '';
      resolve(base64 ? { base64, contentType: file.type || 'image/jpeg' } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  };
  const MAX_SIDE = 1280;
  if (!('createImageBitmap' in window)) { fallback(); return; }
  createImageBitmap(file).then(bitmap => {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    canvas.toBlob(blob => {
      if (!blob) { fallback(); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const base64 = url.includes(',') ? url.split(',')[1] : '';
        resolve(base64 ? { base64, contentType: 'image/jpeg' } : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.82);
  }).catch(fallback);
});

function Brand() { return <div className="brand"><span className="brand-mark"><Bird size={21} strokeWidth={2.4}/></span><span className="brand-name">kagua<span>-livestock</span></span></div>; }
function IconButton({ children, label, onClick, className = '' }) { return <button className={`icon-button ${className}`} aria-label={label} onClick={onClick}>{children}</button>; }

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const submit = async event => { event.preventDefault(); setBusy(true); setError(''); try { await onLogin(email.trim(), password); } catch (err) { setError(err.message || 'Sign-in failed. Check your credentials.'); } finally { setBusy(false); } };
  return <main className="login-page"><section className="login-image"><div className="login-image-top"><Brand/></div><div className="login-image-copy"><span className="eyebrow light">A better way to care</span><h1>Your animals,<br/>in good hands.</h1><p>Stay close to your farm, from the barn to the open range, wherever the day takes you.</p></div><div className="login-image-foot"><span><span className="live-dot"/> Farm monitoring</span><span>Private farm access</span></div></section><section className="login-panel"><div className="login-top"><span className="login-help">Need help? <a href="mailto:hello@kagua.co.ke">Talk to us</a></span></div><div className="login-card"><span className="eyebrow">WELCOME BACK</span><h2>Sign in to your farm</h2><p className="login-sub">Use the account invited by your farm administrator.</p><form onSubmit={submit}><label htmlFor="email">Email address</label><div className="input-wrap"><span className="input-at">@</span><input id="email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="username" required/></div><div className="password-label"><label htmlFor="password">Password</label><a href="mailto:hello@kagua.co.ke?subject=Password%20reset">Forgot password?</a></div><div className="input-wrap"><LockKeyhole size={16} className="input-leading"/><input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required/><button type="button" className="reveal-button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div>{error && <div className="form-error">{error}</div>}<button className="primary-button sign-in-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={17}/></button></form><div className="login-secure"><ShieldCheck size={15}/> Farm access is limited to your membership</div><div className="invite-note"><span className="invite-icon"><Bird size={16}/></span><span><strong>Need an account?</strong><br/>Ask your farm administrator to invite you.</span></div></div><div className="login-footer">© 2026 Kagua Livestock <span>·</span> Made for the people who care</div></section></main>;
}

function LoadingScreen({ message = 'Connecting to your farm…' }) { return <main className="connection-screen"><Brand/><div className="connection-card"><span className="loading-ring"/><strong>{message}</strong></div></main>; }

function App() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [memberships, setMemberships] = useState([]);
  const [activeFarmId, setActiveFarmId] = useState('');
  const [farmLoading, setFarmLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [page, setPage] = useState('Overview');
  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('All zones');
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [zones, setZones] = useState([]);
  const [devices, setDevices] = useState([]);
  const [readings, setReadings] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [reports, setReports] = useState([]);
  const [phonePermission, setPhonePermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [whatsAppPhone, setWhatsAppPhone] = useState('');
  const [whatsAppConsent, setWhatsAppConsent] = useState(false);
  const [waCurrent, setWaCurrent] = useState('');
  const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('kagua-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {}
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  });
  // Fill-out-data submissions persist in the farm database; no browser copy is kept.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('kagua-theme', theme); } catch {}
  }, [theme]);

  const activeMembership = memberships.find(member => member.farm_id === activeFarmId) || null;
  const activeFarm = activeMembership?.farm || null;
  const farmTimezone = resolveTimeZone(activeFarm?.timezone);
  const farmTimezoneRef = useRef(farmTimezone);
  farmTimezoneRef.current = farmTimezone;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { setNow(new Date()); }, [activeFarmId]);
  const visibleSnapshots = snapshots.length ? snapshots : sampleSnapshots;
  const showingSampleSnapshots = visibleSnapshots.some(photo => photo.isDemo);
  const userName = session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || session?.user?.email?.split('@')[0] || 'Farmer';

  const signIn = async (email, password) => {
    if (!supabase) throw new Error('Database is not configured. Add the project URL and publishable key to .env, then restart Vite.');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const loadFarmData = useCallback(async farmId => {
    if (!supabase || !farmId) return;
    setDataLoading(true); setDataError('');
    setZones([]); setDevices([]); setReadings([]); setSnapshots([]); setAlerts([]); setReports([]);
    const [zoneRes, deviceRes, readingRes, snapshotRes, alertRes, reportRes] = await Promise.all([
      supabase.from('farm_zones').select('id,name,zone_type,is_night_monitored,status').eq('farm_id', farmId).order('name'),
      supabase.from('sensor_devices').select('id,zone_id,device_code,name,kind,status,last_seen_at,capabilities').eq('farm_id', farmId).order('name'),
      supabase.from('telemetry_events').select('*').eq('farm_id', farmId).order('captured_at', { ascending: false }).limit(200),
      supabase.from('camera_snapshots').select('id,zone_id,device_id,captured_at,storage_bucket,storage_path,is_night,ai_summary,ai_labels,metadata').eq('farm_id', farmId).order('captured_at', { ascending: false }).limit(24),
      supabase.from('farm_alerts').select('id,zone_id,device_id,severity,alert_type,title,message,occurred_at,acknowledged_at,resolved_at').eq('farm_id', farmId).order('occurred_at', { ascending: false }).limit(50),
      supabase.from('farm_reports').select('id,report_type,period_start,period_end,status,storage_bucket,storage_path,generated_at').eq('farm_id', farmId).order('period_start', { ascending: false }).limit(20),
    ]);
    const firstError = [zoneRes, deviceRes, readingRes, snapshotRes, alertRes, reportRes].find(result => result.error);
    if (firstError) { setDataError(firstError.error.message); setDataLoading(false); return; }
    const zoneRows = zoneRes.data || [];
    const zoneName = new Map(zoneRows.map(zone => [zone.id, zone.name]));
    const rows = (readingRes.data || []).map(row => ({ ...row, zone: zoneName.get(row.zone_id) || 'Farm level', time: fmtTime(row.captured_at, farmTimezoneRef.current), temp: row.temperature_c, humidity: row.humidity_pct, ammonia: row.ammonia_ppm, co2: extractCo2({ ...row, ...(row.measurements || {}), ...((row.raw_payload && typeof row.raw_payload === 'object' && !Array.isArray(row.raw_payload)) ? row.raw_payload : {}) }), status: row.is_night ? 'Night reading' : 'Recorded' }));
    setZones(zoneRows); setDevices(deviceRes.data || []); setReadings(rows); setAlerts(alertRes.data || []); setReports(reportRes.data || []);
    const photoRows = await Promise.all((snapshotRes.data || []).map(async row => {
      const { data, error } = await supabase.storage.from(row.storage_bucket || 'farm-media').createSignedUrl(row.storage_path, 3600);
      const demoImage = row.metadata?.demo === true;
      return { ...row, src: error ? (demoImage ? row.metadata?.demo_image_url || '' : '') : data?.signedUrl || (demoImage ? row.metadata?.demo_image_url || '' : ''), isDemo: demoImage, zone: zoneName.get(row.zone_id) || 'Farm level', time: fmtTime(row.captured_at, farmTimezoneRef.current), note: row.ai_summary || (row.is_night ? 'Night snapshot' : 'Camera snapshot') };
    }));
    setSnapshots(photoRows.filter(photo => photo.src)); setDataLoading(false);
  }, []);

  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return; }
    supabase.auth.getSession().then(({ data, error }) => { if (error) setDataError(error.message); setSession(data.session); setAuthLoading(false); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchMemberships = async () => {
      if (!session?.user || !supabase) { setMemberships([]); setActiveFarmId(''); return; }
      setFarmLoading(true); setDataError('');
      const { data: memberRows, error } = await supabase.from('farm_members').select('farm_id,role').eq('user_id', session.user.id);
      if (cancelled) return;
      if (error) { setDataError(error.message); setMemberships([]); setActiveFarmId(''); setFarmLoading(false); return; }
      if (!memberRows?.length) { setMemberships([]); setActiveFarmId(''); setFarmLoading(false); return; }
      const ids = [...new Set(memberRows.map(row => row.farm_id))];
      const { data: farmRows, error: farmError } = await supabase.from('farms').select('id,name,county,locality,timezone').in('id', ids);
      if (cancelled) return;
      if (farmError) { setDataError(farmError.message); setMemberships([]); setActiveFarmId(''); }
      else {
        const farmMap = new Map((farmRows || []).map(farm => [farm.id, farm]));
        const rows = memberRows.map(member => ({ ...member, farm: farmMap.get(member.farm_id) })).filter(member => member.farm);
        setMemberships(rows);
        setActiveFarmId(current => rows.some(row => row.farm_id === current) ? current : rows[0]?.farm_id || '');
      }
      setFarmLoading(false);
    };
    fetchMemberships();
    return () => { cancelled = true; };
  }, [session]);

  useEffect(() => {
    if (!activeFarmId || !supabase) { setZones([]); setDevices([]); setReadings([]); setSnapshots([]); setAlerts([]); setReports([]); return; }
    loadFarmData(activeFarmId);
    const channel = supabase.channel(`farm-${activeFarmId}-changes`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'telemetry_events', filter: `farm_id=eq.${activeFarmId}` }, payload => {
        loadFarmData(activeFarmId);
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('New farm reading', { body: `A new reading arrived at ${fmtTime(payload.new.captured_at, farmTimezoneRef.current)}.` });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'farm_alerts', filter: `farm_id=eq.${activeFarmId}` }, () => loadFarmData(activeFarmId))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'camera_snapshots', filter: `farm_id=eq.${activeFarmId}` }, () => loadFarmData(activeFarmId))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeFarmId, loadFarmData]);

  useEffect(() => {
    let cancelled = false;
    const fetchWaPreference = async () => {
      setWaCurrent('');
      if (!supabase || !session?.user || !activeFarmId) return;
      const { data } = await supabase.from('notification_preferences').select('phone_e164,enabled,consented_at').eq('farm_id', activeFarmId).eq('user_id', session.user.id).eq('channel', 'whatsapp').limit(1).maybeSingle();
      if (cancelled || !data) return;
      if (data.phone_e164) setWhatsAppPhone(data.phone_e164);
      if (data.enabled) setWaCurrent(`On file: ${data.phone_e164} · consent saved ${fmtTime(data.consented_at, farmTimezone)}`);
    };
    fetchWaPreference();
    return () => { cancelled = true; };
  }, [session, activeFarmId, farmTimezone]);

  const latestTempRow = readings.find(row => row.temp !== null && row.temp !== undefined);
  const latestHumidityRow = readings.find(row => row.humidity !== null && row.humidity !== undefined);
  const latestAmmoniaRow = readings.find(row => row.ammonia !== null && row.ammonia !== undefined);
  const latestCo2Row = readings.find(row => row.co2 !== null && row.co2 !== undefined);
  const latestTemp = latestTempRow?.temp;
  const latestHumidity = latestHumidityRow?.humidity;
  const latestAmmonia = latestAmmoniaRow?.ammonia;
  const latestCo2 = latestCo2Row?.co2;
  const latestDetail = row => row ? `${row.zone} · ${fmtTime(row.captured_at, farmTimezone)}` : 'No readings yet';
  const openAlerts = alerts.filter(alert => !alert.acknowledged_at && !alert.resolved_at);
  const filteredReadings = useMemo(() => readings.filter(row => (zoneFilter === 'All zones' || row.zone === zoneFilter) && `${row.zone} ${row.status} ${row.time} ${row.animal_observation || ''}`.toLowerCase().includes(search.toLowerCase())), [readings, zoneFilter, search]);

  const requestPhonePermission = async () => {
    if (!('Notification' in window)) { setPhonePermission('unsupported'); return; }
    const result = await Notification.requestPermission(); setPhonePermission(result);
    if (result === 'granted') new Notification('Kagua notifications enabled', { body: 'This device can show farm alerts while the app is open.' });
  };

  const saveWhatsAppOptIn = async event => {
    event.preventDefault(); setNotice('');
    const phone = normalizePhoneE164(whatsAppPhone, activeFarm?.country_code);
    if (!E164_RE.test(phone)) { setNotice('Enter the WhatsApp number starting with + and the country code, e.g. +2547XXXXXXXX.'); return; }
    if (!activeFarmId || !session?.user || !whatsAppConsent) return;
    const { data: existing, error: readError } = await supabase.from('notification_preferences').select('id').eq('farm_id', activeFarmId).eq('user_id', session.user.id).eq('channel', 'whatsapp').limit(1).maybeSingle();
    if (readError) { setNotice(readError.message); return; }
    const payload = { farm_id: activeFarmId, user_id: session.user.id, channel: 'whatsapp', enabled: true, phone_e164: phone, consented_at: new Date().toISOString(), consent_text_version: 'kagua-whatsapp-consent-v1', consent_source: 'web-settings', revoked_at: null };
    const result = existing ? await supabase.from('notification_preferences').update(payload).eq('id', existing.id) : await supabase.from('notification_preferences').insert(payload);
    if (result.error) { setNotice(result.error.message); return; }
    setWhatsAppPhone(phone);
    setWaCurrent(`On file: ${phone} · consent saved ${fmtTime(new Date().toISOString(), farmTimezone)}`);
    const { data: farmRow, error: farmReadError } = await supabase.from('farms').select('*').eq('id', activeFarmId).single();
    const waKey = farmRow ? Object.keys(farmRow).find(key => /whatsapp/i.test(key) && /phone|number|reachable/i.test(key)) || Object.keys(farmRow).find(key => /whatsapp/i.test(key)) : null;
    if (farmReadError || !waKey) { setNotice(`WhatsApp consent saved for ${phone}. The farm record has no WhatsApp number column to update.`); return; }
    const { error: farmWriteError } = await supabase.from('farms').update({ [waKey]: phone }).eq('id', activeFarmId);
    setNotice(farmWriteError
      ? `WhatsApp consent saved for ${phone}. The farm record number was not updated (${farmWriteError.message}).`
      : `WhatsApp consent saved. ${phone} is now the WhatsApp reachable number on ${activeFarm?.name || 'this farm'}.`);
  };

  const acknowledgeAlert = async id => {
    if (!supabase || !session?.user || !activeFarmId) return;
    const { error } = await supabase.from('farm_alerts').update({ acknowledged_at: new Date().toISOString(), acknowledged_by: session.user.id }).eq('id', id);
    if (error) setDataError(error.message);
    else loadFarmData(activeFarmId);
  };
  const exportCsv = () => {
    const headers = ['Captured at','Zone','Temperature C','Humidity pct','Ammonia ppm','CO2 ppm','Night','Observation','Measurements'];
    const cells = filteredReadings.map(row => [row.captured_at, row.zone, row.temp ?? '', row.humidity ?? '', row.ammonia ?? '', row.co2 ?? '', row.is_night, row.animal_observation || '', JSON.stringify(row.measurements || {})]);
    const csv = [headers, ...cells].map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${activeFarm?.name || 'farm'}-telemetry.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  if (!supabaseConfigured) return <main className="connection-screen"><Brand/><div className="connection-card connection-error"><strong>Database settings are missing</strong><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to the project’s <code>.env</code>, then restart Vite.</p></div></main>;
  if (authLoading) return <LoadingScreen message="Checking your sign-in…"/>;
  if (!session) return <Login onLogin={signIn}/>;
  if (farmLoading) return <LoadingScreen message="Finding your farm memberships…"/>;
  if (!memberships.length) return <main className="connection-screen"><Brand/><div className="connection-card no-farm-card"><span className="eyebrow">ACCOUNT READY</span><h2>Your account isn’t linked to a farm yet.</h2><p>Signed in as <strong>{session.user.email}</strong>. Add this user to <code>public.farm_members</code> with the owner role, then refresh this page.</p><div className="user-id-block"><span>Account user ID</span><code>{session.user.id}</code></div>{dataError && <div className="form-error">{dataError}</div>}<button className="outline-button" onClick={() => supabase.auth.signOut()}><LogOut size={15}/> Sign out</button></div></main>;
  if (!activeFarm) return <main className="connection-screen"><Brand/><div className="connection-card connection-error"><strong>Couldn’t open this farm</strong><p>The membership was found, but its farm details did not load. Check the <code>farms</code> read policy and the browser console, then refresh.</p>{dataError && <div className="form-error">{dataError}</div>}<button className="outline-button" onClick={() => window.location.reload()}>Reload app</button></div></main>;

  const navItems = [{ name: 'Overview', icon: LayoutDashboard }, { name: 'Alerts', icon: Bell }, { name: 'Readings', icon: Activity }, { name: 'Fill out data', icon: ClipboardList }, { name: 'Records', icon: Clock3 }, { name: 'Outbreak Shield', icon: ShieldAlert }, { name: 'Photos', icon: Camera }, { name: 'Packages', icon: Leaf }, { name: 'Settings', icon: Settings2 }];
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}><div className="sidebar-brand"><Brand/><IconButton label="Close menu" className="close-mobile" onClick={() => setMobileNav(false)}><X size={19}/></IconButton></div>
      <label className="farm-select-label" htmlFor="farm-select">ACTIVE FARM</label><select id="farm-select" className="farm-select" value={activeFarmId} onChange={event => setActiveFarmId(event.target.value)}>{memberships.map(member => <option key={member.farm_id} value={member.farm_id}>{member.farm.name}</option>)}</select>
      <div className="nav-label">MENU</div><nav>{navItems.map(({ name, icon: Icon }) => <button key={name} onClick={() => { setPage(name); setMobileNav(false); }} className={`nav-item ${page === name ? 'active' : ''}`}><Icon size={18}/><span>{name}</span>{name === 'Overview' && <span className="nav-live"/>}</button>)}</nav><div className="sidebar-spacer"/><div className="sidebar-tip"><span className="tip-icon"><Leaf size={17}/></span><strong>A little care goes a long way.</strong><p>Farm readings are visible to members assigned to this farm.</p><button onClick={() => setPage('Readings')}>View farm readings <ArrowRight size={14}/></button></div><button className="sidebar-help" onClick={() => window.location.href='mailto:hello@kagua.co.ke'}>Help & support</button>
      <div className="user-menu-wrap"><button className="user-profile" onClick={() => setUserMenu(value => !value)}><span className="user-avatar">{userName.slice(0,2).toUpperCase()}</span><span className="profile-copy"><strong>{userName}</strong><small>{session.user.email}</small></span></button>{userMenu && <div className="user-dropdown"><button onClick={() => { setPage('Settings'); setUserMenu(false); }}><Settings2 size={16}/> Settings</button><button onClick={() => supabase.auth.signOut()}><LogOut size={16}/> Sign out</button></div>}</div>
    </aside>
    {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)}/>}
    <main className="main-area"><header className="topbar"><div className="topbar-left"><IconButton label="Open menu" className="menu-toggle" onClick={() => setMobileNav(true)}><Menu size={20}/></IconButton><span className="breadcrumb">{activeFarm.name}<span>›</span><strong>{page}</strong></span></div><div className="topbar-right"><span className="last-updated"><span className="live-dot"/> {dataLoading ? 'Syncing' : 'Connected'}</span><button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</button><button className="primary-button compact-button topbar-add" onClick={() => setPage('Fill out data')}><ClipboardList size={15}/> Fill out data</button><button className="outline-button compact-button topbar-signout" onClick={() => supabase.auth.signOut()} aria-label="Sign out"><LogOut size={15}/> Sign out</button><span className="topbar-user"><span className="user-avatar small">{userName.slice(0,2).toUpperCase()}</span></span></div></header>
      <div className="page-content"><div className="page-heading"><div><div className="date-line" title={`Farm time · ${farmTimezone}`}><Clock3 size={14}/> {activeFarm.county || activeFarm.locality || 'Farm dashboard'} <span>·</span> {fmtNow(farmTimezone, now)}</div><h1>{page === 'Overview' ? `Welcome, ${userName}` : page}</h1><p>{page === 'Overview' ? 'Live information from your farm’s database records.' : page === 'Alerts' ? 'Every farm alert with the problem and what to do about it.' : page === 'Readings' ? 'Environmental and animal readings recorded by your devices.' : page === 'Fill out data' ? 'Submit temperature, humidity, ammonia, CO₂, notes and a photo to your farm.' : page === 'Photos' ? 'Camera images uploaded to your private farm storage.' : page === 'Records' ? 'Alerts and telemetry history from this farm.' : page === 'Packages' ? 'Choose monitoring coverage for the way you care for your animals.' : page === 'Outbreak Shield' ? 'Early warning when flock signs suggest a contagious outbreak, on this farm and nearby.' : 'Manage your account and notification preferences.'}</p></div><span className="outline-button"><ShieldCheck size={14}/> Member access</span></div>
        {dataError && <div className="db-error"><AlertTriangle size={16}/><span><strong>Database query failed</strong><br/>{dataError}</span><button onClick={() => loadFarmData(activeFarmId)}>Retry</button></div>}
        {dataLoading && <div className="sync-banner"><span className="loading-ring small-ring"/> Syncing the latest farm records…</div>}
        {page === 'Overview' && <>
          <section className="stats-grid"><MetricCard icon={<Thermometer size={18}/>} tone="temp-icon" label="Latest temperature" value={fmtMetric(latestTemp)} unit={latestTemp == null ? '' : '°C'} detail={latestDetail(latestTempRow)}/><MetricCard icon={<Droplets size={18}/>} tone="humidity-icon" label="Latest humidity" value={fmtMetric(latestHumidity,0)} unit={latestHumidity == null ? '' : '%'} detail={latestDetail(latestHumidityRow)}/><MetricCard icon={<Wind size={18}/>} tone="air-icon" label="Latest ammonia" value={fmtMetric(latestAmmonia)} unit={latestAmmonia == null ? '' : 'ppm'} detail={latestDetail(latestAmmoniaRow)}/><MetricCard icon={<Cloud size={18}/>} tone="co2-icon" label="Latest CO₂" value={fmtMetric(latestCo2, 0)} unit={latestCo2 == null ? '' : 'ppm'} detail={latestCo2Row ? `Carbon dioxide · ${latestDetail(latestCo2Row)}` : 'No readings yet'}/><MetricCard icon={<Activity size={18}/>} tone="flock-icon" label="Farm status" value={devices.length ? `${devices.filter(device => device.status === 'active').length}/${devices.length}` : '—'} unit={devices.length ? 'devices' : ''} detail={`${zones.length} monitored zones · ${openAlerts.length} open alerts`}/></section>
          {openAlerts.length > 0 && <section className="alert-card"><span className="alert-icon"><AlertTriangle size={18}/></span><div className="alert-copy"><strong>{openAlerts[0].title}</strong><p>{openAlerts[0].message} · {fmtTime(openAlerts[0].occurred_at, farmTimezone)}</p></div><button className="alert-action" onClick={() => setPage('Records')}>View alerts <ArrowRight size={15}/></button></section>}
          <section className="content-grid"><article className="panel chart-panel"><div className="panel-header"><div><h2>Latest readings</h2><p>Most recent records from your connected devices</p></div><button className="text-action" onClick={() => setPage('Readings')}>All readings <ArrowRight size={14}/></button></div><div className="latest-reading-list">{readings.slice(0,5).map(row => <div className="latest-reading-row" key={row.id}><span className="sensor-dot"/><strong>{row.zone}</strong><span>{row.temp == null ? '—' : `${fmtMetric(row.temp)}°C`}</span><span>{row.humidity == null ? '—' : `${fmtMetric(row.humidity,0)}% RH`}</span><span>{row.co2 == null ? '—' : `${fmtMetric(row.co2,0)} ppm CO₂`}</span><time>{fmtTime(row.captured_at, farmTimezone)}</time></div>)}{!readings.length && <EmptyState title="No telemetry received yet" copy="Your farm is connected. Readings will appear here after a device sends new farm data."/>}</div><div className="chart-footer"><span><span className="live-dot"/> Live updates from your farm’s database records</span><span>{readings.length} recent readings loaded</span></div></article>
            <article className="panel zones-panel"><div className="panel-header"><div><h2>Farm zones</h2><p>Configured monitored areas</p></div><span className="text-action">{zones.length} zones</span></div><div className="zone-list">{zones.map(zone => { const device = devices.find(item => item.zone_id === zone.id); const reading = readings.find(item => item.zone_id === zone.id); return <div className="zone-row" key={zone.id}><span className={`zone-dot ${device?.status === 'active' ? 'good' : 'watch'}`}/><div className="zone-copy"><strong>{zone.name}</strong><small>{zone.zone_type.replace('_',' ')} · {device?.name || 'No device assigned'}</small></div><div className="zone-reading"><strong>{reading?.temp == null ? '—' : `${fmtMetric(reading.temp)}°`}</strong><small>{reading?.humidity == null ? '—' : `${fmtMetric(reading.humidity,0)}% RH`}</small></div><span className={`health-pill ${device?.status === 'active' ? 'good-pill' : 'watch-pill'}`}>{device?.status || zone.status}</span></div>; })}{!zones.length && <EmptyState title="No zones set up" copy="Add a barn, stable, pasture, or free-roam zone to organize farm data."/>}</div><div className="zones-footer"><span><span className="sensor-dot"/> {devices.filter(device => device.status === 'active').length} active devices</span><span>{zones.filter(zone => zone.is_night_monitored).length} night zones</span></div></article></section>
          <SnapshotPanel snapshots={visibleSnapshots} isDemo={showingSampleSnapshots} onOpen={photo => setSelectedPhoto(photo)} onAll={() => setPage('Photos')}/>
          <HowItWorks />
          <div className="db-note">All readings, alerts, and images shown here are loaded from the selected farm. Access is limited to members assigned to this farm.</div>
        </>}
        {page === 'Readings' && <section className="panel data-panel"><div className="data-toolbar"><div className="toolbar-left"><div className="search-box"><Search size={16}/><input placeholder="Search readings..." value={search} onChange={event => setSearch(event.target.value)}/></div><label className="filter-select"><Filter size={15}/><select value={zoneFilter} onChange={event => setZoneFilter(event.target.value)}><option>All zones</option>{zones.map(zone => <option key={zone.id}>{zone.name}</option>)}</select><ChevronDown size={14}/></label></div><div className="toolbar-actions"><button className="primary-button compact-button" onClick={() => setPage('Fill out data')}><ClipboardList size={15}/> Fill out data</button><button className="outline-button" onClick={exportCsv}><Download size={15}/> Export CSV</button></div></div><div className="table-scroll"><table><thead><tr><th>CAPTURED</th><th>ZONE</th><th>TEMPERATURE</th><th>HUMIDITY</th><th>AMMONIA</th><th>CO₂</th><th>OTHER DATA</th><th>STATUS</th></tr></thead><tbody>{filteredReadings.map(row => <tr key={row.id}><td>{fmtTime(row.captured_at, farmTimezone)}</td><td>{row.zone}</td><td>{row.temp == null ? '—' : `${fmtMetric(row.temp)}°C`}</td><td>{row.humidity == null ? '—' : `${fmtMetric(row.humidity,0)}%`}</td><td>{row.ammonia == null ? '—' : `${fmtMetric(row.ammonia)} ppm`}</td><td>{row.co2 == null ? '—' : `${fmtMetric(row.co2,0)} ppm`}</td><td>{row.animal_observation || Object.keys(row.measurements || {}).join(', ') || '—'}</td><td><span className={`health-pill ${row.is_night ? 'watch-pill' : 'good-pill'}`}>{row.status}</span></td></tr>)}</tbody></table>{!filteredReadings.length && <EmptyState title="No readings match" copy={readings.length ? 'Try another zone or search term.' : 'No telemetry rows have been recorded for this farm yet.'}/>}</div><div className="table-footer"><span>Showing <strong>{filteredReadings.length}</strong> of <strong>{readings.length}</strong> records</span><span>Farm-scoped query</span></div></section>}
        {page === 'Fill out data' && <ManualReadingPanel zones={zones} farm={activeFarm} userId={session?.user?.id} onSubmitted={() => loadFarmData(activeFarmId)} onViewReadings={() => setPage('Readings')} onViewPhotos={() => setPage('Photos')} />}
        {page === 'Alerts' && <AlertsPanel alerts={alerts} zones={zones} timeZone={farmTimezone} onAcknowledge={acknowledgeAlert} />}
        {page === 'Outbreak Shield' && <OutbreakShield supabase={supabase} farm={activeFarm} role={activeMembership.role} zones={zones} userId={session.user.id}/>}
        {page === 'Records' && <section className="panel data-panel"><HealthGauges temp={latestTemp} humidity={latestHumidity} ammonia={latestAmmonia} co2={latestCo2} /><div className="records-heading"><div><h2>Farm alerts and events</h2><p>Recent alerts and telemetry received from your devices.</p></div><span className="health-pill good-pill">{openAlerts.length} open alerts</span></div><div className="record-list">{alerts.map(alert => <div className="record-item" key={`alert-${alert.id}`}><span className={`record-icon ${alert.severity === 'critical' ? 'alert-rec-icon' : 'temp-icon'}`}><AlertTriangle size={17}/></span><div className="record-copy"><strong>{alert.title}</strong><p>{alert.message}</p></div><time>{fmtTime(alert.occurred_at, farmTimezone)}</time></div>)}{readings.slice(0,10).map(row => <div className="record-item" key={`reading-${row.id}`}><span className="record-icon temp-icon"><Activity size={17}/></span><div className="record-copy"><strong>Reading received · {row.zone}</strong><p>{row.temp == null ? '' : `Temperature ${fmtMetric(row.temp)}°C · `}{row.humidity == null ? '' : `Humidity ${fmtMetric(row.humidity,0)}% · `}{row.ammonia == null ? '' : `Ammonia ${fmtMetric(row.ammonia)} ppm`}{row.co2 == null ? '' : ` · CO₂ ${fmtMetric(row.co2,0)} ppm`}{row.animal_observation ? ` · ${row.animal_observation}` : ''}</p></div><time>{fmtTime(row.captured_at, farmTimezone)}</time></div>)}{!alerts.length && !readings.length && <EmptyState title="No farm records yet" copy="Alerts and telemetry will show here when your devices begin sending data."/>}</div><h3 className="subsection-heading">Reports</h3><div className="record-list">{reports.map(report => <div className="record-item" key={`report-${report.id}`}><span className="record-icon cam-rec-icon"><Clock3 size={17}/></span><div className="record-copy"><strong>{report.report_type} report · {report.status}</strong><p>{fmtTime(report.period_start, farmTimezone)} – {fmtTime(report.period_end, farmTimezone)}</p></div><time>{report.generated_at ? fmtTime(report.generated_at, farmTimezone) : 'Not generated'}</time></div>)}{!reports.length && <p className="small-muted">No reports have been generated for this farm yet.</p>}</div></section>}
        {page === 'Photos' && <section className="panel photos-page-panel"><div className="panel-header"><div><h2>Camera snapshots</h2><p>{showingSampleSnapshots ? 'Demo image references · real ESP32 images appear after upload.' : 'Images loaded from the farm’s private Storage bucket.'}</p></div><span className="select-button"><Camera size={14}/> {visibleSnapshots.length} {showingSampleSnapshots ? 'examples' : 'images'}</span></div>{showingSampleSnapshots && <div className="snapshot-demo-note">Demo only: reference photos and readings are illustrative, not captured by this farm’s ESP32. Real camera snapshots are private to your farm.</div>}<div className="photos-page-grid">{visibleSnapshots.map(photo => <button className="photo-card" key={photo.id} onClick={() => setSelectedPhoto(photo)}><div className="photo-image-wrap"><img src={photo.src} alt={`${photo.zone} ${photo.isDemo ? 'sample' : 'camera'} snapshot`}/><span className="photo-cam"><Camera size={12}/>{photo.zone}</span><span className="photo-mood"><Check size={11}/>{photo.isDemo ? 'Sample' : photo.is_night ? 'Night' : 'Snapshot'}</span></div><div className="photo-meta"><strong>{photo.zone}</strong><span>{photo.time}</span></div></button>)}</div></section>}
        {page === 'Packages' && <section className="packages-page"><div className="packages-page-intro"><span className="eyebrow">FARM MONITORING & INSTALLATION</span><h2>Plans for every kind of farm.</h2><p>Proposed monthly plans for poultry, cattle, horses, and free-roaming ranches. Hardware and installation are confirmed after a farm assessment.</p></div><div className="package-grid package-grid-full">{plans.map(plan => <article key={plan.name} className={`package-card ${plan.featured ? 'featured' : ''}`}>{plan.featured && <span className="popular-tag">POPULAR</span>}<span className="package-cameras">{plan.cameras} {plan.cameras === 1 ? 'camera' : 'cameras'}</span><h3>{plan.name}</h3><p className="package-detail">{plan.description}</p><div className="package-price"><strong>KES {plan.price}</strong><span>/ month</span></div><ul>{plan.features.map(feature => <li key={feature}><Check size={13}/>{feature}</li>)}</ul><a className={`package-cta ${plan.featured ? 'primary-package-cta' : ''}`} href={`mailto:hello@kagua.co.ke?subject=${encodeURIComponent(`Farm installation enquiry - ${plan.name}`)}&body=${encodeURIComponent(`Hello Kagua Livestock,\n\nI am interested in the ${plan.name} plan (${plan.cameras} cameras).\nFarm location:\nAnimal types:\nPhone number:`)}`}>Connect your farm <ArrowRight size={14}/></a></article>)}</div><div className="package-disclaimer">Proposed rates only; reports, connectivity, equipment, installation, and final pricing are agreed after a farm assessment.</div></section>}
        {page === 'Settings' && <section className="panel settings-panel"><div className="records-heading"><div><h2>Notifications</h2><p>Choose how this account receives farm alerts.</p></div></div><div className="settings-row"><span className="settings-icon"><Bell size={18}/></span><div><strong>Browser notifications</strong><p>{phonePermission === 'granted' ? 'Enabled on this device while the app is open.' : phonePermission === 'denied' ? 'Blocked by browser settings.' : 'Allow this device to show new-reading alerts while the app is open.'}</p></div><button className="outline-button" onClick={requestPhonePermission} disabled={phonePermission === 'granted' || phonePermission === 'unsupported'}>{phonePermission === 'granted' ? 'Enabled' : 'Enable'}</button></div><div className="settings-row whatsapp-settings"><span className="settings-icon"><Bell size={18}/></span><div><strong>WhatsApp opt-in</strong><p>Two quick steps: say hello on WhatsApp first, then save your consent below. Saving stores this number on the farm record as the WhatsApp reachable number.</p><div className="wa-start"><a className="wa-button" href="https://wa.me/254732487473?text=Hello%20Kagua%20Livestock" target="_blank" rel="noreferrer"><MessageCircle size={16}/> Say hello on WhatsApp</a><p>Step 1 · This opens a chat with <strong>+254 732 487 473</strong> and a ready hello message — just press send. WhatsApp only lets the farm message you within 24 hours after you message us, so this hello switches alerts on.</p></div><form onSubmit={saveWhatsAppOptIn} className="whatsapp-form"><input type="tel" value={whatsAppPhone} onChange={event => setWhatsAppPhone(event.target.value)} placeholder="+254 7XX XXX XXX" aria-label="WhatsApp number" required/><label className="consent-check"><input type="checkbox" checked={whatsAppConsent} onChange={event => setWhatsAppConsent(event.target.checked)} required/><span>I agree to receive farm alerts from Kagua Livestock on WhatsApp.</span></label><button className="primary-button compact-button" disabled={!whatsAppConsent}>Save WhatsApp consent</button></form>{waCurrent && <p className="notice-text">{waCurrent}</p>}{notice && <p className="notice-text">{notice}</p>}</div></div><div className="settings-row"><span className="settings-icon"><ShieldCheck size={18}/></span><div><strong>Farm access</strong><p>{activeMembership.role} · {activeFarm.name}</p></div><span className="small-muted">Membership controlled by farm administrator</span></div></section>}
        <footer className="page-footer"><span>© 2026 Kagua Livestock</span><span><span className="live-dot"/> Database · {dataLoading ? 'Syncing' : 'Connected'}</span><span>{activeMembership.role} access</span></footer>
      </div>
    </main>
    {selectedPhoto && <div className="modal-backdrop" role="presentation" onClick={() => setSelectedPhoto(null)}><div className="photo-modal" role="dialog" aria-modal="true" aria-label={`${selectedPhoto.zone} photo`} onClick={event => event.stopPropagation()}><div className="modal-top"><div><strong>{selectedPhoto.zone}</strong><span>Farm camera · {selectedPhoto.time}</span></div><IconButton label="Close photo" onClick={() => setSelectedPhoto(null)}><X size={19}/></IconButton></div><img src={selectedPhoto.src} alt={`${selectedPhoto.zone} farm camera snapshot`}/><div className="modal-bottom"><span>{selectedPhoto.note}</span><span>{selectedPhoto.is_night ? 'Night capture' : 'Camera snapshot'}</span></div></div></div>}
  </div>;
}

function ManualReadingPanel({ zones, farm, userId, onSubmitted, onViewReadings, onViewPhotos }) {
  return <section className="panel manual-panel">
    <div className="panel-header"><div><h2>Fill out data</h2><p>For {farm?.name || 'this farm'} · readings go straight into your farm’s database records as the latest data.</p></div><span className="health-pill good-pill">Saves to database</span></div>
    <div className="manual-layout">
      <ManualReadingForm zones={zones} farm={farm} userId={userId} onSubmitted={onSubmitted} onViewReadings={onViewReadings} onViewPhotos={onViewPhotos} />
      <aside className="manual-side">
        <h3>Where does it go?</h3>
        <ul>
          <li><Activity size={14}/> Temperature, humidity and ammonia are stored as a new reading under {farm?.name || 'your farm'}.</li>
          <li><Cloud size={14}/> Carbon dioxide is stored with the same reading, so the CO₂ card updates too.</li>
          <li><Camera size={14}/> Your photo is uploaded to the farm’s private storage and appears under snapshots. You can run an AI photo check and review the summary before submitting.</li>
          <li><Check size={14}/> The dashboard refreshes automatically — your entry becomes the latest data.</li>
        </ul>
      </aside>
    </div>
  </section>;
}

function ManualReadingForm({ zones, farm, userId, onSubmitted, onViewReadings, onViewPhotos }) {
  const [zoneId, setZoneId] = useState('farm');
  const [temp, setTemp] = useState('');
  const [humidity, setHumidity] = useState('');
  const [ammonia, setAmmonia] = useState('');
  const [co2, setCo2] = useState('');
  const [observation, setObservation] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoName, setPhotoName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [done, setDone] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiDraft, setAiDraft] = useState('');
  const [aiMeta, setAiMeta] = useState(null);

  const pickPhoto = event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (photoPreview && photoPreview.startsWith('blob:')) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setPhotoName(file.name || 'farm photo');
    setAiDraft(''); setAiMeta(null); setAiError('');
  };
  const clearPhoto = () => {
    if (photoPreview && photoPreview.startsWith('blob:')) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null); setPhotoPreview(''); setPhotoName('');
    setAiDraft(''); setAiMeta(null); setAiError('');
  };
  const parseOptional = (raw, label, min, max) => {
    if (raw === '' || raw === null || raw === undefined) return { value: null };
    const num = Number(raw);
    if (!Number.isFinite(num)) return { error: `${label} must be a number.` };
    if ((min !== null && num < min) || (max !== null && num > max)) return { error: `${label} looks out of range.` };
    return { value: num };
  };
  const isNightNow = tz => {
    try {
      const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz || 'Africa/Nairobi' }).format(new Date()));
      return hour < 6 || hour >= 18;
    } catch { return false; }
  };
  const analyzePhoto = async () => {
    setAiError('');
    if (!photoFile) { setAiError('Choose a photo first, then run the photo check.'); return; }
    if (!supabase || !farm?.id) { setAiError('Photo analysis is not available right now.'); return; }
    setAiBusy(true);
    try {
      const image = await fileToAnalysisImage(photoFile);
      if (!image) throw new Error('Could not read the photo for analysis.');
      const t = parseOptional(temp, 'Temperature (°C)', -10, 60);
      const h = parseOptional(humidity, 'Humidity (%)', 0, 100);
      const a = parseOptional(ammonia, 'Ammonia (ppm)', 0, 1000);
      const c = parseOptional(co2, 'CO₂ (ppm)', 0, 100000);
      const { data, error: fnError } = await supabase.functions.invoke('analyze-photo', {
        body: {
          farmId: farm.id,
          zoneName: zoneId === 'farm' ? 'Farm level' : (zones.find(zone => zone.id === zoneId)?.name || 'Farm level'),
          readings: { temperature_c: t.value, humidity_pct: h.value, ammonia_ppm: a.value, co2_ppm: c.value, observation: observation.trim() || null, isNight: isNightNow(farm.timezone) },
          imageBase64: image.base64,
          contentType: image.contentType,
        },
      });
      if (fnError) throw new Error('Photo analysis is not available right now. You can still submit without it.');
      const summary = String(data?.summary || '').trim();
      if (!summary) throw new Error('The photo check returned no summary. You can still submit without it.');
      setAiDraft(summary);
      setAiMeta({ title: data?.suggestedTitle || '', severity: data?.suggestedSeverity || '', model: data?.model || '' });
    } catch (err) { setAiError(err.message || 'Photo analysis failed. You can still submit without it.'); }
    finally { setAiBusy(false); }
  };
  const submit = async event => {
    event.preventDefault(); setError(''); setDone(null);
    const t = parseOptional(temp, 'Temperature (°C)', -10, 60);
    const h = parseOptional(humidity, 'Humidity (%)', 0, 100);
    const a = parseOptional(ammonia, 'Ammonia (ppm)', 0, 1000);
    const c = parseOptional(co2, 'CO₂ (ppm)', 0, 100000);
    const bad = [t, h, a, c].find(part => part.error);
    if (bad) { setError(bad.error); return; }
    if (t.value === null && h.value === null && a.value === null && c.value === null) { setError('Enter at least one reading: temperature, humidity, ammonia or CO₂.'); return; }
    if (!supabase) { setError('Database is not configured.'); return; }
    if (!farm?.id) { setError('No farm is open.'); return; }
    const zid = zoneId === 'farm' ? null : zoneId;
    const zoneLabel = zid ? (zones.find(zone => zone.id === zid)?.name || 'Farm level') : 'Farm level';
    setBusy(true); setProgress('Saving reading…');
    try {
      const capturedAt = new Date().toISOString();
      const measurements = {};
      if (c.value !== null) measurements.co2_ppm = c.value;
      const { data: inserted, error: insertError } = await supabase.from('telemetry_events').insert({
        farm_id: farm.id,
        zone_id: zid,
        source_event_id: `manual-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        captured_at: capturedAt,
        received_at: capturedAt,
        temperature_c: t.value,
        humidity_pct: h.value,
        ammonia_ppm: a.value,
        measurements,
        animal_observation: observation.trim() || null,
        is_night: isNightNow(farm.timezone),
        raw_payload: { source: 'manual-form', submitted_by: userId || null },
      }).select('id').single();
      if (insertError) throw new Error(insertError.message);
      let photoSaved = false;
      const aiSummary = aiDraft.trim() || null;
      if (photoFile) {
        setProgress('Uploading photo…');
        const ext = (photoFile.name && photoFile.name.includes('.') ? photoFile.name.split('.').pop() : 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `${farm.id}/manual/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
        const { error: uploadError } = await supabase.storage.from('farm-media').upload(path, photoFile, { contentType: photoFile.type || 'image/jpeg', upsert: false });
        if (uploadError) throw new Error(`Reading saved, but the photo upload failed: ${uploadError.message}`);
        setProgress('Linking photo…');
        const { error: snapError } = await supabase.from('camera_snapshots').insert({
          farm_id: farm.id,
          zone_id: zid,
          telemetry_event_id: inserted.id,
          captured_at: capturedAt,
          storage_bucket: 'farm-media',
          storage_path: path,
          content_type: photoFile.type || 'image/jpeg',
          file_size_bytes: photoFile.size,
          is_night: isNightNow(farm.timezone),
          ai_summary: aiSummary,
          ai_labels: aiMeta ? [{ model: aiMeta.model || 'photo-analysis', title: aiMeta.title || null, severity: aiMeta.severity || null }] : [],
          metadata: { source: 'manual-form', submitted_by: userId || null },
        });
        if (snapError) throw new Error(`Reading and photo file saved, but the snapshot record failed: ${snapError.message}`);
        photoSaved = true;
      }
      setDone({ zone: zoneLabel, time: capturedAt, photoSaved, aiSaved: photoSaved && Boolean(aiSummary) });
      setTemp(''); setHumidity(''); setAmmonia(''); setCo2(''); setObservation(''); clearPhoto();
      onSubmitted();
    } catch (err) { setError(err.message || 'Submission failed.'); }
    finally { setBusy(false); setProgress(''); }
  };
  return <form className="manual-form" onSubmit={submit}>
    <label className="manual-field"><span>Zone</span><select value={zoneId} onChange={event => setZoneId(event.target.value)} disabled={busy}><option value="farm">Farm level</option>{zones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
    <div className="manual-grid">
      <label className="manual-field"><span><Thermometer size={13}/> Temperature (°C)</span><input type="number" inputMode="decimal" step="0.1" min="-10" max="60" placeholder="e.g. 31.5" value={temp} onChange={event => setTemp(event.target.value)} disabled={busy} /></label>
      <label className="manual-field"><span><Droplets size={13}/> Humidity (%)</span><input type="number" inputMode="decimal" step="1" min="0" max="100" placeholder="e.g. 64" value={humidity} onChange={event => setHumidity(event.target.value)} disabled={busy} /></label>
      <label className="manual-field"><span><Wind size={13}/> Ammonia (ppm)</span><input type="number" inputMode="decimal" step="0.1" min="0" placeholder="e.g. 12" value={ammonia} onChange={event => setAmmonia(event.target.value)} disabled={busy} /></label>
      <label className="manual-field"><span><Cloud size={13}/> CO₂ · carbon dioxide (ppm)</span><input type="number" inputMode="decimal" step="1" min="0" placeholder="e.g. 900" value={co2} onChange={event => setCo2(event.target.value)} disabled={busy} /></label>
    </div>
    <label className="manual-field"><span>Farmer note (optional)</span><input type="text" maxLength={140} placeholder="e.g. Birds active, bedding dry" value={observation} onChange={event => setObservation(event.target.value)} disabled={busy} /></label>
    <div className="manual-field"><span>Photo — take one now or choose from device</span>
      <label className="photo-pick"><ImagePlus size={16}/><span>{photoName || 'Take / choose photo'}</span><input type="file" accept="image/*" capture="environment" onChange={pickPhoto} disabled={busy} aria-label="Take or choose a photo" /></label>
      {photoPreview && <div className="photo-preview"><img src={photoPreview} alt="Chosen reading photo preview" /><button type="button" className="outline-button" onClick={clearPhoto} disabled={busy}><X size={14}/> Remove photo</button></div>}
      {photoPreview && <div className="ai-panel">
        {!aiDraft
          ? <div className="ai-actions"><button type="button" className="outline-button" onClick={analyzePhoto} disabled={busy || aiBusy}><Camera size={14}/> {aiBusy ? 'Checking photo…' : 'Check photo with AI'}</button><small>Looks at this photo together with the readings above and drafts a summary for your review.</small></div>
          : <div className="ai-draft"><p><strong>Review this photo summary</strong>{aiMeta?.severity ? ` · suggested ${aiMeta.severity}` : ''}{aiMeta?.title ? ` · ${aiMeta.title}` : ''}</p><textarea value={aiDraft} onChange={event => setAiDraft(event.target.value)} rows={4} maxLength={2000} disabled={busy} aria-label="Reviewed photo summary" /><div className="ai-actions"><button type="button" className="outline-button" onClick={analyzePhoto} disabled={busy || aiBusy}>Re-check</button><button type="button" className="outline-button" onClick={() => { setAiDraft(''); setAiMeta(null); }}>Discard</button></div><small>Saved with the photo under snapshots when you submit.</small></div>}
        {aiError && <div className="form-error">{aiError}</div>}
      </div>}
    </div>
    {error && <div className="form-error">{error}</div>}
    {done && !error && <div className="manual-done"><strong><Check size={14}/> Saved to {farm?.name || 'your farm'} · {done.zone} · {fmtTime(done.time, farm?.timezone)}</strong><p>{done.photoSaved ? 'Reading, note and photo stored. The photo is now under snapshots.' : 'Reading and note stored.'} {done.aiSaved ? ' The reviewed photo summary was saved with the photo.' : ''} The dashboard now shows this as the latest data.</p><div className="manual-done-actions"><button type="button" className="outline-button" onClick={onViewReadings}>View readings</button><button type="button" className="outline-button" onClick={onViewPhotos}>View photos</button></div></div>}
    <div className="manual-actions"><button className="primary-button" type="submit" disabled={busy}><ClipboardList size={15}/> {busy ? (progress || 'Saving…') : 'Submit'}</button><button className="outline-button" type="button" disabled={busy} onClick={() => { setTemp(''); setHumidity(''); setAmmonia(''); setCo2(''); setObservation(''); clearPhoto(); setError(''); setDone(null); }}>Clear</button></div>
  </form>;
}

const ALERT_ACTIONS = [
  { match: ['heat', 'hot', 'warm', 'temperature', 'temp'], steps: ['Open vents and improve airflow in the zone', 'Give cool, clean drinking water', 'Reduce crowding so heat can escape', 'Recheck the temperature in 1–2 hours'] },
  { match: ['cold', 'chill', 'freez'], steps: ['Check the heat source is working', 'Close draughts but keep some airflow', 'Watch for huddling and add dry bedding if needed'] },
  { match: ['humidity', 'humid', 'wet', 'damp', 'moist'], steps: ['Improve ventilation to dry the air', 'Replace wet bedding with dry litter', 'Check drinkers and roof for leaks'] },
  { match: ['ammonia', 'smell', 'odour', 'odor', 'litter'], steps: ['Ventilate the house immediately', 'Remove wet litter and droppings', 'Check drainage around drinkers'] },
  { match: ['co2', 'carbon', 'dioxide', 'stuffy', 'air quality'], steps: ['Ventilate to bring in fresh air', 'Lower crowding if the house feels stuffy', 'Recheck the reading after airing out'] },
];
const DEFAULT_ALERT_ACTIONS = ['Visit the zone and look at the flock', 'Check feed and clean water', 'Call your vet if birds look weak, sleepy or off feed'];
const getAlertActions = alert => {
  const text = `${alert?.alert_type || ''} ${alert?.title || ''} ${alert?.message || ''}`.toLowerCase();
  return (ALERT_ACTIONS.find(group => group.match.some(word => text.includes(word))) || { steps: DEFAULT_ALERT_ACTIONS }).steps;
};

function AlertsPanel({ alerts, zones, timeZone, onAcknowledge }) {
  const zoneName = id => zones.find(zone => zone.id === id)?.name || 'Farm level';
  const open = alerts.filter(alert => !alert.acknowledged_at && !alert.resolved_at);
  const past = alerts.filter(alert => alert.acknowledged_at || alert.resolved_at);
  return <section className="panel alerts-panel">
    <div className="panel-header"><div><h2>Farm alerts</h2><p>Same alerts that reach your phone and browser — newest first.</p></div><span className={`health-pill ${open.length ? 'watch-pill' : 'good-pill'}`}>{open.length} open</span></div>
    {!alerts.length && <EmptyState title="No alerts yet" copy="When a sensor reading crosses a rule, the alert lands here with steps to fix it." />}
    <div className="alerts-list">
      {open.map(alert => <AlertCard key={alert.id} alert={alert} zone={zoneName(alert.zone_id)} timeZone={timeZone} open onAcknowledge={onAcknowledge} />)}
      {past.map(alert => <AlertCard key={alert.id} alert={alert} zone={zoneName(alert.zone_id)} timeZone={timeZone} onAcknowledge={onAcknowledge} />)}
    </div>
  </section>;
}

function AlertCard({ alert, zone, timeZone, open, onAcknowledge }) {
  return <article className={`alert-item severity-${alert.severity || 'info'}`}>
    <div className="alert-item-top"><span className={`severity-pill severity-${alert.severity || 'info'}`}>{alert.severity || 'info'}</span><strong>{alert.title}</strong><time>{fmtTime(alert.occurred_at, timeZone)}</time></div>
    <p className="alert-zone">{zone}</p>
    <p className="alert-problem">{alert.message}</p>
    <h4>What to do</h4>
    <ol>{getAlertActions(alert).map(step => <li key={step}>{step}</li>)}</ol>
    <div className="alert-item-foot">{open ? <button className="outline-button" onClick={() => onAcknowledge(alert.id)}><Check size={14}/> Mark as handled</button> : <span className="small-muted">Handled{alert.acknowledged_at ? ` · ${fmtTime(alert.acknowledged_at, timeZone)}` : ''}</span>}</div>
  </article>;
}

function Gauge({ label, value, unit, min, max, goodMin, goodMax, digits = 1 }) {
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const state = value == null ? 'none' : (value >= goodMin && value <= goodMax ? 'good' : 'bad');
  const marker = value == null ? null : clamp01((value - min) / (max - min)) * 100;
  const goodStart = clamp01((goodMin - min) / (max - min)) * 100;
  const goodWidth = clamp01((goodMax - min) / (max - min)) * 100 - goodStart;
  return <div className={`gauge gauge-${state}`}>
    <div className="gauge-top"><span>{label}</span><strong>{value == null ? '—' : `${fmtMetric(value, digits)}${unit}`}</strong></div>
    <div className="gauge-track" role="img" aria-label={`${label}: ${value == null ? 'no data' : `${fmtMetric(value, digits)}${unit}, ${state === 'good' ? 'in the green zone' : 'outside the green zone'}`}`}>
      <span className="gauge-zone" style={{ left: `${goodStart}%`, width: `${goodWidth}%` }} />
      {marker !== null && <span className="gauge-marker" style={{ left: `${marker}%` }} />}
    </div>
    <div className="gauge-scale"><span>{min}{unit}</span><span className="gauge-green-label">Green {goodMin}–{goodMax}</span><span>{max}{unit}</span></div>
  </div>;
}

function HealthGauges({ temp, humidity, ammonia, co2 }) {
  return <div className="gauges-block">
    <div className="records-heading"><div><h2>Farm health at a glance</h2><p>Latest value against the green comfort zone — red means act.</p></div></div>
    <div className="gauges-grid">
      <Gauge label="Temperature" value={temp} unit="°C" min={20} max={40} goodMin={30} goodMax={33} />
      <Gauge label="Humidity" value={humidity} unit="%" min={20} max={100} goodMin={50} goodMax={70} digits={0} />
      <Gauge label="Ammonia" value={ammonia} unit=" ppm" min={0} max={50} goodMin={0} goodMax={25} />
      <Gauge label="Carbon dioxide" value={co2} unit=" ppm" min={400} max={2500} goodMin={400} goodMax={1000} digits={0} />
    </div>
  </div>;
}

function HowItWorks() {
  return <section className="panel how-panel">
    <div className="panel-header"><div><h2>How your farm stays connected</h2><p>From coop sensors to your phone in seconds.</p></div></div>
    <div className="how-flow">
      <div className="how-node"><span className="how-icon"><Cpu size={20}/></span><strong>ESP32 + camera</strong><small>Sensors read the air; the camera watches the flock</small></div>
      <span className="how-arrow"><ArrowRight size={18}/></span>
      <div className="how-node"><span className="how-icon"><Wifi size={20}/></span><strong>Wi-Fi link</strong><small>Readings stream live from the coop</small></div>
      <span className="how-arrow"><ArrowRight size={18}/></span>
      <div className="how-node"><span className="how-icon"><Database size={20}/></span><strong>Farm database</strong><small>Every reading stored per farm, per zone</small></div>
      <span className="how-arrow"><ArrowRight size={18}/></span>
      <div className="how-node"><span className="how-icon"><Bell size={20}/></span><strong>Reports &amp; alerts</strong><small>Cross a safe limit and the farm tells you</small></div>
    </div>
  </section>;
}

function MetricCard({ icon, tone, label, value, unit, detail }) { return <article className="stat-card"><div className="stat-heading"><span className={`stat-icon ${tone}`}>{icon}</span><span className="stat-name">{label}</span></div><div className="stat-value">{value}<span>{unit}</span></div><div className="stat-bottom"><span className="range-note">{detail}</span></div></article>; }
function EmptyState({ title, copy }) { return <div className="empty-state"><strong>{title}</strong><span>{copy}</span></div>; }
function SnapshotPanel({ snapshots, isDemo, onOpen, onAll }) { return <section className="panel photo-panel"><div className="panel-header"><div><h2>From the farm</h2><p>{isDemo ? 'Sample gallery · ESP32 snapshots will appear here.' : 'Recent snapshots from this farm’s private camera storage'}</p></div><button className="text-action" onClick={onAll}>See all photos <ArrowRight size={14}/></button></div>{isDemo && <div className="snapshot-demo-note">Example photos only — no camera has uploaded to this farm yet.</div>}<div className="photo-grid">{snapshots.slice(0,3).map(photo => <button className="photo-card" key={photo.id} onClick={() => onOpen(photo)}><div className="photo-image-wrap"><img src={photo.src} alt={`${photo.zone} ${photo.isDemo ? 'sample' : 'farm camera'} snapshot`} loading="lazy"/><span className="photo-cam"><Camera size={12}/>{photo.zone}</span><span className="photo-mood"><Check size={11}/>{photo.isDemo ? 'Sample' : photo.is_night ? 'Night' : 'Snapshot'}</span></div><div className="photo-meta"><strong>{photo.zone}</strong><span>{photo.time}</span></div></button>)}</div></section>; }

export default App;
