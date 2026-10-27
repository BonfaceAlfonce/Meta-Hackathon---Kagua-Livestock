import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, Bell, Bird, Camera, Check, ChevronDown, Clock3, Download, Eye, EyeOff, Filter, LayoutDashboard, Leaf, LockKeyhole, LogOut, Menu, Search, Settings2, ShieldCheck, Thermometer, Droplets, Wind, X } from 'lucide-react';
import { supabase, supabaseConfigured } from './lib/supabase.js';

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
const fmtTime = value => value ? new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtMetric = (value, digits = 1) => value === null || value === undefined ? '—' : Number(value).toFixed(digits);

function Brand() { return <div className="brand"><span className="brand-mark"><Bird size={21} strokeWidth={2.4}/></span><span className="brand-name">kagua<span>.</span></span></div>; }
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
  const [notice, setNotice] = useState('');

  const activeMembership = memberships.find(member => member.farm_id === activeFarmId) || null;
  const activeFarm = activeMembership?.farm || null;
  const visibleSnapshots = snapshots.length ? snapshots : sampleSnapshots;
  const showingSampleSnapshots = visibleSnapshots.some(photo => photo.isDemo);
  const userName = session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || session?.user?.email?.split('@')[0] || 'Farmer';

  const signIn = async (email, password) => {
    if (!supabase) throw new Error('Supabase is not configured. Add the project URL and publishable key to .env, then restart Vite.');
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
      supabase.from('telemetry_events').select('id,zone_id,device_id,animal_id,captured_at,received_at,temperature_c,humidity_pct,ammonia_ppm,measurements,animal_observation,activity_level,battery_voltage,signal_strength_dbm,is_night').eq('farm_id', farmId).order('captured_at', { ascending: false }).limit(200),
      supabase.from('camera_snapshots').select('id,zone_id,device_id,captured_at,storage_bucket,storage_path,is_night,ai_summary,ai_labels,metadata').eq('farm_id', farmId).order('captured_at', { ascending: false }).limit(24),
      supabase.from('farm_alerts').select('id,zone_id,device_id,severity,alert_type,title,message,occurred_at,acknowledged_at,resolved_at').eq('farm_id', farmId).order('occurred_at', { ascending: false }).limit(50),
      supabase.from('farm_reports').select('id,report_type,period_start,period_end,status,storage_bucket,storage_path,generated_at').eq('farm_id', farmId).order('period_start', { ascending: false }).limit(20),
    ]);
    const firstError = [zoneRes, deviceRes, readingRes, snapshotRes, alertRes, reportRes].find(result => result.error);
    if (firstError) { setDataError(firstError.error.message); setDataLoading(false); return; }
    const zoneRows = zoneRes.data || [];
    const zoneName = new Map(zoneRows.map(zone => [zone.id, zone.name]));
    const rows = (readingRes.data || []).map(row => ({ ...row, zone: zoneName.get(row.zone_id) || 'Farm level', time: fmtTime(row.captured_at), temp: row.temperature_c, humidity: row.humidity_pct, ammonia: row.ammonia_ppm, status: row.is_night ? 'Night reading' : 'Recorded' }));
    setZones(zoneRows); setDevices(deviceRes.data || []); setReadings(rows); setAlerts(alertRes.data || []); setReports(reportRes.data || []);
    const photoRows = await Promise.all((snapshotRes.data || []).map(async row => {
      const { data, error } = await supabase.storage.from(row.storage_bucket || 'farm-media').createSignedUrl(row.storage_path, 3600);
      const demoImage = row.metadata?.demo === true;
      return { ...row, src: error ? (demoImage ? row.metadata?.demo_image_url || '' : '') : data?.signedUrl || (demoImage ? row.metadata?.demo_image_url || '' : ''), isDemo: demoImage, zone: zoneName.get(row.zone_id) || 'Farm level', time: fmtTime(row.captured_at), note: row.ai_summary || (row.is_night ? 'Night snapshot' : 'Camera snapshot') };
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
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('New farm reading', { body: `A new reading arrived at ${fmtTime(payload.new.captured_at)}.` });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'farm_alerts', filter: `farm_id=eq.${activeFarmId}` }, () => loadFarmData(activeFarmId))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'camera_snapshots', filter: `farm_id=eq.${activeFarmId}` }, () => loadFarmData(activeFarmId))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeFarmId, loadFarmData]);

  const latestTemp = readings.find(row => row.temp !== null && row.temp !== undefined)?.temp;
  const latestHumidity = readings.find(row => row.humidity !== null && row.humidity !== undefined)?.humidity;
  const latestAmmonia = readings.find(row => row.ammonia !== null && row.ammonia !== undefined)?.ammonia;
  const openAlerts = alerts.filter(alert => !alert.acknowledged_at && !alert.resolved_at);
  const filteredReadings = useMemo(() => readings.filter(row => (zoneFilter === 'All zones' || row.zone === zoneFilter) && `${row.zone} ${row.status} ${row.time} ${row.animal_observation || ''}`.toLowerCase().includes(search.toLowerCase())), [readings, zoneFilter, search]);

  const requestPhonePermission = async () => {
    if (!('Notification' in window)) { setPhonePermission('unsupported'); return; }
    const result = await Notification.requestPermission(); setPhonePermission(result);
    if (result === 'granted') new Notification('Kagua notifications enabled', { body: 'This device can show farm alerts while the app is open.' });
  };

  const saveWhatsAppOptIn = async event => {
    event.preventDefault(); setNotice('');
    if (!activeFarmId || !session?.user || !whatsAppConsent) return;
    const { data: existing, error: readError } = await supabase.from('notification_preferences').select('id').eq('farm_id', activeFarmId).eq('user_id', session.user.id).eq('channel', 'whatsapp').limit(1).maybeSingle();
    if (readError) { setNotice(readError.message); return; }
    const payload = { farm_id: activeFarmId, user_id: session.user.id, channel: 'whatsapp', enabled: true, phone_e164: whatsAppPhone, consented_at: new Date().toISOString(), consent_text_version: 'kagua-whatsapp-consent-v1', consent_source: 'web-settings', revoked_at: null };
    const result = existing ? await supabase.from('notification_preferences').update(payload).eq('id', existing.id) : await supabase.from('notification_preferences').insert(payload);
    setNotice(result.error ? result.error.message : 'WhatsApp consent saved. Message delivery still needs the Kagua WhatsApp service to be configured.');
  };

  const exportCsv = () => {
    const headers = ['Captured at','Zone','Temperature C','Humidity pct','Ammonia ppm','Night','Observation','Measurements'];
    const cells = filteredReadings.map(row => [row.captured_at, row.zone, row.temp ?? '', row.humidity ?? '', row.ammonia ?? '', row.is_night, row.animal_observation || '', JSON.stringify(row.measurements || {})]);
    const csv = [headers, ...cells].map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${activeFarm?.name || 'farm'}-telemetry.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  if (!supabaseConfigured) return <main className="connection-screen"><Brand/><div className="connection-card connection-error"><strong>Supabase settings are missing</strong><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to the project’s <code>.env</code>, then restart Vite.</p></div></main>;
  if (authLoading) return <LoadingScreen message="Checking your sign-in…"/>;
  if (!session) return <Login onLogin={signIn}/>;
  if (farmLoading) return <LoadingScreen message="Finding your farm memberships…"/>;
  if (!memberships.length) return <main className="connection-screen"><Brand/><div className="connection-card no-farm-card"><span className="eyebrow">ACCOUNT READY</span><h2>Your account isn’t linked to a farm yet.</h2><p>Signed in as <strong>{session.user.email}</strong>. Add this user to <code>public.farm_members</code> with the owner role, then refresh this page.</p><div className="user-id-block"><span>Supabase Auth user ID</span><code>{session.user.id}</code></div>{dataError && <div className="form-error">{dataError}</div>}<button className="outline-button" onClick={() => supabase.auth.signOut()}><LogOut size={15}/> Sign out</button></div></main>;
  if (!activeFarm) return <main className="connection-screen"><Brand/><div className="connection-card connection-error"><strong>Couldn’t open this farm</strong><p>The membership was found, but its farm details did not load. Check the <code>farms</code> read policy and the browser console, then refresh.</p>{dataError && <div className="form-error">{dataError}</div>}<button className="outline-button" onClick={() => window.location.reload()}>Reload app</button></div></main>;

  const navItems = [{ name: 'Overview', icon: LayoutDashboard }, { name: 'Readings', icon: Activity }, { name: 'Records', icon: Clock3 }, { name: 'Photos', icon: Camera }, { name: 'Packages', icon: Leaf }, { name: 'Settings', icon: Settings2 }];
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}><div className="sidebar-brand"><Brand/><IconButton label="Close menu" className="close-mobile" onClick={() => setMobileNav(false)}><X size={19}/></IconButton></div>
      <label className="farm-select-label" htmlFor="farm-select">ACTIVE FARM</label><select id="farm-select" className="farm-select" value={activeFarmId} onChange={event => setActiveFarmId(event.target.value)}>{memberships.map(member => <option key={member.farm_id} value={member.farm_id}>{member.farm.name}</option>)}</select>
      <div className="nav-label">MENU</div><nav>{navItems.map(({ name, icon: Icon }) => <button key={name} onClick={() => { setPage(name); setMobileNav(false); }} className={`nav-item ${page === name ? 'active' : ''}`}><Icon size={18}/><span>{name}</span>{name === 'Overview' && <span className="nav-live"/>}</button>)}</nav><div className="sidebar-spacer"/><div className="sidebar-tip"><span className="tip-icon"><Leaf size={17}/></span><strong>A little care goes a long way.</strong><p>Farm readings are visible to members assigned to this farm.</p><button onClick={() => setPage('Readings')}>View farm readings <ArrowRight size={14}/></button></div><button className="sidebar-help" onClick={() => window.location.href='mailto:hello@kagua.co.ke'}>Help & support</button>
      <div className="user-menu-wrap"><button className="user-profile" onClick={() => setUserMenu(value => !value)}><span className="user-avatar">{userName.slice(0,2).toUpperCase()}</span><span className="profile-copy"><strong>{userName}</strong><small>{session.user.email}</small></span></button>{userMenu && <div className="user-dropdown"><button onClick={() => { setPage('Settings'); setUserMenu(false); }}><Settings2 size={16}/> Settings</button><button onClick={() => supabase.auth.signOut()}><LogOut size={16}/> Sign out</button></div>}</div>
    </aside>
    {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)}/>}
    <main className="main-area"><header className="topbar"><div className="topbar-left"><IconButton label="Open menu" className="menu-toggle" onClick={() => setMobileNav(true)}><Menu size={20}/></IconButton><span className="breadcrumb">{activeFarm.name}<span>›</span><strong>{page}</strong></span></div><div className="topbar-right"><span className="last-updated"><span className="live-dot"/> {dataLoading ? 'Syncing' : 'Connected'}</span><span className="topbar-user"><span className="user-avatar small">{userName.slice(0,2).toUpperCase()}</span></span></div></header>
      <div className="page-content"><div className="page-heading"><div><div className="date-line"><Clock3 size={14}/> {activeFarm.county || activeFarm.locality || 'Farm dashboard'} <span>·</span> {new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div><h1>{page === 'Overview' ? `Welcome, ${userName}` : page}</h1><p>{page === 'Overview' ? 'Live information from your farm’s Supabase records.' : page === 'Readings' ? 'Environmental and animal readings recorded by your devices.' : page === 'Photos' ? 'Camera images uploaded to your private farm storage.' : page === 'Records' ? 'Alerts and telemetry history from this farm.' : page === 'Packages' ? 'Choose monitoring coverage for the way you care for your animals.' : 'Manage your account and notification preferences.'}</p></div><span className="outline-button"><ShieldCheck size={14}/> Member access</span></div>
        {dataError && <div className="db-error"><AlertTriangle size={16}/><span><strong>Supabase query failed</strong><br/>{dataError}</span><button onClick={() => loadFarmData(activeFarmId)}>Retry</button></div>}
        {dataLoading && <div className="sync-banner"><span className="loading-ring small-ring"/> Syncing the latest farm records…</div>}
        {page === 'Overview' && <>
          <section className="stats-grid"><MetricCard icon={<Thermometer size={18}/>} tone="temp-icon" label="Latest temperature" value={fmtMetric(latestTemp)} unit={latestTemp == null ? '' : '°C'} detail="Most recent available sensor value"/><MetricCard icon={<Droplets size={18}/>} tone="humidity-icon" label="Latest humidity" value={fmtMetric(latestHumidity,0)} unit={latestHumidity == null ? '' : '%'} detail="Most recent available sensor value"/><MetricCard icon={<Wind size={18}/>} tone="air-icon" label="Latest ammonia" value={fmtMetric(latestAmmonia)} unit={latestAmmonia == null ? '' : 'ppm'} detail="Most recent available sensor value"/><MetricCard icon={<Activity size={18}/>} tone="flock-icon" label="Farm status" value={devices.length ? `${devices.filter(device => device.status === 'active').length}/${devices.length}` : '—'} unit={devices.length ? 'devices' : ''} detail={`${zones.length} monitored zones · ${openAlerts.length} open alerts`}/></section>
          {openAlerts.length > 0 && <section className="alert-card"><span className="alert-icon"><AlertTriangle size={18}/></span><div className="alert-copy"><strong>{openAlerts[0].title}</strong><p>{openAlerts[0].message} · {fmtTime(openAlerts[0].occurred_at)}</p></div><button className="alert-action" onClick={() => setPage('Records')}>View alerts <ArrowRight size={15}/></button></section>}
          <section className="content-grid"><article className="panel chart-panel"><div className="panel-header"><div><h2>Latest readings</h2><p>Most recent records from your connected devices</p></div><button className="text-action" onClick={() => setPage('Readings')}>All readings <ArrowRight size={14}/></button></div><div className="latest-reading-list">{readings.slice(0,5).map(row => <div className="latest-reading-row" key={row.id}><span className="sensor-dot"/><strong>{row.zone}</strong><span>{row.temp == null ? '—' : `${fmtMetric(row.temp)}°C`}</span><span>{row.humidity == null ? '—' : `${fmtMetric(row.humidity,0)}% RH`}</span><time>{fmtTime(row.captured_at)}</time></div>)}{!readings.length && <EmptyState title="No telemetry received yet" copy="Your farm is connected. Readings will appear here after a device or ingestion function writes to telemetry_events."/>}</div><div className="chart-footer"><span><span className="live-dot"/> Live updates via Supabase Realtime</span><span>{readings.length} recent readings loaded</span></div></article>
            <article className="panel zones-panel"><div className="panel-header"><div><h2>Farm zones</h2><p>Configured monitored areas</p></div><span className="text-action">{zones.length} zones</span></div><div className="zone-list">{zones.slice(0,5).map(zone => { const device = devices.find(item => item.zone_id === zone.id); const reading = readings.find(item => item.zone_id === zone.id); return <div className="zone-row" key={zone.id}><span className={`zone-dot ${device?.status === 'active' ? 'good' : 'watch'}`}/><div className="zone-copy"><strong>{zone.name}</strong><small>{zone.zone_type.replace('_',' ')} · {device?.name || 'No device assigned'}</small></div><div className="zone-reading"><strong>{reading?.temp == null ? '—' : `${fmtMetric(reading.temp)}°`}</strong><small>{reading?.humidity == null ? '—' : `${fmtMetric(reading.humidity,0)}% RH`}</small></div><span className={`health-pill ${device?.status === 'active' ? 'good-pill' : 'watch-pill'}`}>{device?.status || zone.status}</span></div>; })}{!zones.length && <EmptyState title="No zones set up" copy="Add a barn, stable, pasture, or free-roam zone to organize farm data."/>}</div><div className="zones-footer"><span><span className="sensor-dot"/> {devices.filter(device => device.status === 'active').length} active devices</span><span>{zones.filter(zone => zone.is_night_monitored).length} night zones</span></div></article></section>
          <SnapshotPanel snapshots={visibleSnapshots} isDemo={showingSampleSnapshots} onOpen={photo => setSelectedPhoto(photo)} onAll={() => setPage('Photos')}/>
          <div className="db-note">All readings, alerts, and images shown here are loaded from the selected farm. Access is governed by Supabase Auth, farm membership, grants, and RLS.</div>
        </>}
        {page === 'Readings' && <section className="panel data-panel"><div className="data-toolbar"><div className="toolbar-left"><div className="search-box"><Search size={16}/><input placeholder="Search readings..." value={search} onChange={event => setSearch(event.target.value)}/></div><label className="filter-select"><Filter size={15}/><select value={zoneFilter} onChange={event => setZoneFilter(event.target.value)}><option>All zones</option>{zones.map(zone => <option key={zone.id}>{zone.name}</option>)}</select><ChevronDown size={14}/></label></div><button className="outline-button" onClick={exportCsv}><Download size={15}/> Export CSV</button></div><div className="table-scroll"><table><thead><tr><th>CAPTURED</th><th>ZONE</th><th>TEMPERATURE</th><th>HUMIDITY</th><th>AMMONIA</th><th>OTHER DATA</th><th>STATUS</th></tr></thead><tbody>{filteredReadings.map(row => <tr key={row.id}><td>{fmtTime(row.captured_at)}</td><td>{row.zone}</td><td>{row.temp == null ? '—' : `${fmtMetric(row.temp)}°C`}</td><td>{row.humidity == null ? '—' : `${fmtMetric(row.humidity,0)}%`}</td><td>{row.ammonia == null ? '—' : `${fmtMetric(row.ammonia)} ppm`}</td><td>{row.animal_observation || Object.keys(row.measurements || {}).join(', ') || '—'}</td><td><span className={`health-pill ${row.is_night ? 'watch-pill' : 'good-pill'}`}>{row.status}</span></td></tr>)}</tbody></table>{!filteredReadings.length && <EmptyState title="No readings match" copy={readings.length ? 'Try another zone or search term.' : 'No telemetry rows have been recorded for this farm yet.'}/>}</div><div className="table-footer"><span>Showing <strong>{filteredReadings.length}</strong> of <strong>{readings.length}</strong> records</span><span>Farm-scoped query</span></div></section>}
        {page === 'Records' && <section className="panel data-panel"><div className="records-heading"><div><h2>Farm alerts and events</h2><p>Recent alerts and telemetry received from your devices.</p></div><span className="health-pill good-pill">{openAlerts.length} open alerts</span></div><div className="record-list">{alerts.map(alert => <div className="record-item" key={`alert-${alert.id}`}><span className={`record-icon ${alert.severity === 'critical' ? 'alert-rec-icon' : 'temp-icon'}`}><AlertTriangle size={17}/></span><div className="record-copy"><strong>{alert.title}</strong><p>{alert.message}</p></div><time>{fmtTime(alert.occurred_at)}</time></div>)}{readings.slice(0,10).map(row => <div className="record-item" key={`reading-${row.id}`}><span className="record-icon temp-icon"><Activity size={17}/></span><div className="record-copy"><strong>Reading received · {row.zone}</strong><p>{row.temp == null ? '' : `Temperature ${fmtMetric(row.temp)}°C · `}{row.humidity == null ? '' : `Humidity ${fmtMetric(row.humidity,0)}% · `}{row.ammonia == null ? '' : `Ammonia ${fmtMetric(row.ammonia)} ppm`}{row.animal_observation ? ` · ${row.animal_observation}` : ''}</p></div><time>{fmtTime(row.captured_at)}</time></div>)}{!alerts.length && !readings.length && <EmptyState title="No farm records yet" copy="Alerts and telemetry will show here when your devices begin sending data."/>}</div><h3 className="subsection-heading">Reports</h3><div className="record-list">{reports.map(report => <div className="record-item" key={`report-${report.id}`}><span className="record-icon cam-rec-icon"><Clock3 size={17}/></span><div className="record-copy"><strong>{report.report_type} report · {report.status}</strong><p>{fmtTime(report.period_start)} – {fmtTime(report.period_end)}</p></div><time>{report.generated_at ? fmtTime(report.generated_at) : 'Not generated'}</time></div>)}{!reports.length && <p className="small-muted">No reports have been generated for this farm yet.</p>}</div></section>}
        {page === 'Photos' && <section className="panel photos-page-panel"><div className="panel-header"><div><h2>Camera snapshots</h2><p>{showingSampleSnapshots ? 'Demo image references · real ESP32 images appear after upload.' : 'Images loaded from the farm’s private Storage bucket.'}</p></div><span className="select-button"><Camera size={14}/> {visibleSnapshots.length} {showingSampleSnapshots ? 'examples' : 'images'}</span></div>{showingSampleSnapshots && <div className="snapshot-demo-note">Demo only: reference photos and readings are illustrative, not captured by this farm’s ESP32. Real camera snapshots are private to your farm.</div>}<div className="photos-page-grid">{visibleSnapshots.map(photo => <button className="photo-card" key={photo.id} onClick={() => setSelectedPhoto(photo)}><div className="photo-image-wrap"><img src={photo.src} alt={`${photo.zone} ${photo.isDemo ? 'sample' : 'camera'} snapshot`}/><span className="photo-cam"><Camera size={12}/>{photo.zone}</span><span className="photo-mood"><Check size={11}/>{photo.isDemo ? 'Sample' : photo.is_night ? 'Night' : 'Snapshot'}</span></div><div className="photo-meta"><strong>{photo.zone}</strong><span>{photo.time}</span></div></button>)}</div></section>}
        {page === 'Packages' && <section className="packages-page"><div className="packages-page-intro"><span className="eyebrow">FARM MONITORING & INSTALLATION</span><h2>Plans for every kind of farm.</h2><p>Proposed monthly plans for poultry, cattle, horses, and free-roaming ranches. Hardware and installation are confirmed after a farm assessment.</p></div><div className="package-grid package-grid-full">{plans.map(plan => <article key={plan.name} className={`package-card ${plan.featured ? 'featured' : ''}`}>{plan.featured && <span className="popular-tag">POPULAR</span>}<span className="package-cameras">{plan.cameras} {plan.cameras === 1 ? 'camera' : 'cameras'}</span><h3>{plan.name}</h3><p className="package-detail">{plan.description}</p><div className="package-price"><strong>KES {plan.price}</strong><span>/ month</span></div><ul>{plan.features.map(feature => <li key={feature}><Check size={13}/>{feature}</li>)}</ul><a className={`package-cta ${plan.featured ? 'primary-package-cta' : ''}`} href={`mailto:hello@kagua.co.ke?subject=${encodeURIComponent(`Farm installation enquiry - ${plan.name}`)}&body=${encodeURIComponent(`Hello Kagua Livestock,\n\nI am interested in the ${plan.name} plan (${plan.cameras} cameras).\nFarm location:\nAnimal types:\nPhone number:`)}`}>Connect your farm <ArrowRight size={14}/></a></article>)}</div><div className="package-disclaimer">Proposed rates only; reports, connectivity, equipment, installation, and final pricing are agreed after a farm assessment.</div></section>}
        {page === 'Settings' && <section className="panel settings-panel"><div className="records-heading"><div><h2>Notifications</h2><p>Choose how this account receives farm alerts.</p></div></div><div className="settings-row"><span className="settings-icon"><Bell size={18}/></span><div><strong>Browser notifications</strong><p>{phonePermission === 'granted' ? 'Enabled on this device while the app is open.' : phonePermission === 'denied' ? 'Blocked by browser settings.' : 'Allow this device to show new-reading alerts while the app is open.'}</p></div><button className="outline-button" onClick={requestPhonePermission} disabled={phonePermission === 'granted' || phonePermission === 'unsupported'}>{phonePermission === 'granted' ? 'Enabled' : 'Enable'}</button></div><div className="settings-row whatsapp-settings"><span className="settings-icon"><Bell size={18}/></span><div><strong>WhatsApp opt-in</strong><p>Consent is saved to this farm account. Delivery needs Kagua’s WhatsApp service to be configured.</p><form onSubmit={saveWhatsAppOptIn} className="whatsapp-form"><input type="tel" value={whatsAppPhone} onChange={event => setWhatsAppPhone(event.target.value)} placeholder="+254 7XX XXX XXX" aria-label="WhatsApp number" required/><label className="consent-check"><input type="checkbox" checked={whatsAppConsent} onChange={event => setWhatsAppConsent(event.target.checked)} required/><span>I agree to receive farm alerts from Kagua Livestock on WhatsApp.</span></label><button className="primary-button compact-button" disabled={!whatsAppConsent}>Save WhatsApp consent</button></form>{notice && <p className="notice-text">{notice}</p>}</div></div><div className="settings-row"><span className="settings-icon"><ShieldCheck size={18}/></span><div><strong>Farm access</strong><p>{activeMembership.role} · {activeFarm.name}</p></div><span className="small-muted">Membership controlled by farm administrator</span></div></section>}
        <footer className="page-footer"><span>© 2026 Kagua Livestock</span><span><span className="live-dot"/> Supabase · {dataLoading ? 'Syncing' : 'Connected'}</span><span>{activeMembership.role} access</span></footer>
      </div>
    </main>
    {selectedPhoto && <div className="modal-backdrop" role="presentation" onClick={() => setSelectedPhoto(null)}><div className="photo-modal" role="dialog" aria-modal="true" aria-label={`${selectedPhoto.zone} photo`} onClick={event => event.stopPropagation()}><div className="modal-top"><div><strong>{selectedPhoto.zone}</strong><span>Farm camera · {selectedPhoto.time}</span></div><IconButton label="Close photo" onClick={() => setSelectedPhoto(null)}><X size={19}/></IconButton></div><img src={selectedPhoto.src} alt={`${selectedPhoto.zone} farm camera snapshot`}/><div className="modal-bottom"><span>{selectedPhoto.note}</span><span>{selectedPhoto.is_night ? 'Night capture' : 'Camera snapshot'}</span></div></div></div>}
  </div>;
}

function MetricCard({ icon, tone, label, value, unit, detail }) { return <article className="stat-card"><div className="stat-heading"><span className={`stat-icon ${tone}`}>{icon}</span><span className="stat-name">{label}</span></div><div className="stat-value">{value}<span>{unit}</span></div><div className="stat-bottom"><span className="range-note">{detail}</span></div></article>; }
function EmptyState({ title, copy }) { return <div className="empty-state"><strong>{title}</strong><span>{copy}</span></div>; }
function SnapshotPanel({ snapshots, isDemo, onOpen, onAll }) { return <section className="panel photo-panel"><div className="panel-header"><div><h2>From the farm</h2><p>{isDemo ? 'Sample gallery · ESP32 snapshots will appear here.' : 'Recent snapshots from this farm’s private camera storage'}</p></div><button className="text-action" onClick={onAll}>See all photos <ArrowRight size={14}/></button></div>{isDemo && <div className="snapshot-demo-note">Example photos only — no camera has uploaded to this farm yet.</div>}<div className="photo-grid">{snapshots.slice(0,3).map(photo => <button className="photo-card" key={photo.id} onClick={() => onOpen(photo)}><div className="photo-image-wrap"><img src={photo.src} alt={`${photo.zone} ${photo.isDemo ? 'sample' : 'farm camera'} snapshot`} loading="lazy"/><span className="photo-cam"><Camera size={12}/>{photo.zone}</span><span className="photo-mood"><Check size={11}/>{photo.isDemo ? 'Sample' : photo.is_night ? 'Night' : 'Snapshot'}</span></div><div className="photo-meta"><strong>{photo.zone}</strong><span>{photo.time}</span></div></button>)}</div></section>; }

export default App;
