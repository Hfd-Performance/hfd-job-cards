// =====================================================================
// HFD Job Cards — web app (phones, tablets, desktop)
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { CONFIG } from './config.js';

const $app = document.getElementById('app');

if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR-PROJECT')) {
  $app.innerHTML = `<div class="login card"><h2>Setup needed</h2>
    <p>Open <b>web/config.js</b> and paste your Supabase project URL and anon key, then reload.</p></div>`;
  throw new Error('config.js not filled in');
}

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

let me = null;          // my profile
let profiles = [];      // all staff
let settings = null;    // app_settings row
let cleanup = [];       // run when leaving a view

// ------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const q = (sel, root = document) => root.querySelector(sel);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-AU') : '');
const fmtTime = (d) => (d ? new Date(d).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const nameOf = (id) => profiles.find((p) => p.id === id)?.display_name ?? '';
const normRego = (r) => String(r ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const STATUS = { open: 'Open', in_progress: 'In progress', waiting_parts: 'Waiting parts', complete: 'Complete' };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  q('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function flashSaved(el) {
  if (!el) return;
  el.classList.remove('saved'); void el.offsetWidth; el.classList.add('saved');
  setTimeout(() => el.classList.remove('saved'), 1200);
}
const fail = (e) => { console.error(e); toast(e?.message ?? String(e), 'error', 5000); };

// call an edge function
async function fn(name, path = '', { method = 'GET', body, query } = {}, retried = false) {
  const { data: { session } } = await sb.auth.getSession();
  const url = new URL(`${CONFIG.SUPABASE_URL}/functions/v1/${name}${path}`);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ''}`,
      apikey: CONFIG.SUPABASE_ANON_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // stale login: refresh once, otherwise go back to the sign-in screen
    if (!retried) {
      const { data, error } = await sb.auth.refreshSession();
      if (!error && data.session) return fn(name, path, { method, body, query }, true);
    }
    toast('Your login has expired. Please sign in again.', 'error', 6000);
    await sb.auth.signOut();
    throw new Error('Please sign in again');
  }
  if (!res.ok) throw new Error(out.error || `Error ${res.status}`);
  return out;
}

// --- VIN sanity check + make hint from the manufacturer code (WMI)
const WMI = {
  JT: 'Toyota', MR0: 'Toyota (Thailand)', AHT: 'Toyota (South Africa)', '6T1': 'Toyota (Australia)',
  JAA: 'Isuzu', MPA: 'Isuzu (Thailand)', JN: 'Nissan', MNT: 'Nissan (Thailand)', VSK: 'Nissan (Spain)',
  MNA: 'Ford (Thailand)', MPB: 'Ford (Thailand)', '1FT': 'Ford (USA)', MMA: 'Mitsubishi (Thailand)',
  MMB: 'Mitsubishi (Thailand)', JMF: 'Mitsubishi', JMY: 'Mitsubishi', JMZ: 'Mazda', KPT: 'SsangYong',
  LGW: 'GWM', WDB: 'Mercedes-Benz', WDD: 'Mercedes-Benz', WV1: 'Volkswagen', WV2: 'Volkswagen',
  WVW: 'Volkswagen', '1C6': 'Ram (USA)', '3C6': 'Ram (Mexico)', '1GC': 'Chevrolet (USA)', KMH: 'Hyundai', KNA: 'Kia',
};
function vinInfo(vin) {
  const v = normRego(vin);
  if (!v) return '';
  const bad = /[IOQ]/.test(v);
  const make = WMI[v.slice(0, 3)] || WMI[v.slice(0, 2)];
  if (v.length !== 17) return `⚠ ${v.length} characters (modern VINs are 17)${make ? ` · looks like ${make}` : ''}`;
  if (bad) return '⚠ VINs never contain I, O or Q, check for typos';
  return `✓ 17 characters${make ? ` · looks like ${make}` : ''}`;
}

// --- shrink photos before upload (keeps storage + upload time down)
async function compressImage(file) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file);
    const max = 1800;
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.82));
  } catch { return file; }
}

// ------------------------------------------------------------ shell & router
function shell(title, inner, { back } = {}) {
  $app.innerHTML = `
    <header class="top">
      ${back ? `<a class="back" href="${back}" aria-label="Back">‹</a>` : ''}
      <a href="#/" class="brand">${esc(settings?.business_name || 'Job Cards')}</a>
      <span class="title">${esc(title)}</span>
      <nav><a href="#/">Jobs</a><a href="#/calendar" aria-label="Calendar">📅</a><a href="#/settings" aria-label="Settings">⚙</a></nav>
    </header>
    <main id="main">${inner}</main>`;
  return q('#main');
}

async function loadMe(user) {
  const [{ data: p }, { data: all }, { data: s }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    sb.from('profiles').select('*').order('display_name'),
    sb.from('app_settings').select('*').eq('id', 1).maybeSingle(),
  ]);
  me = p ?? { id: user.id, display_name: user.email, is_admin: false };
  profiles = all ?? [];
  settings = s ?? { business_name: 'Job Cards', rego_to_xero_reference: true };
}

async function route() {
  cleanup.forEach((f) => { try { f(); } catch { /* ignore */ } });
  cleanup = [];
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return viewLogin();
  if (!me || me.id !== session.user.id) await loadMe(session.user);

  const [path, qs] = (location.hash || '#/').slice(1).split('?');
  const parts = path.split('/').filter(Boolean);
  if (me.must_change_password) return viewChangePassword(true);
  try {
    if (parts[0] === 'password') return viewChangePassword(false);
    if (parts[0] === 'job' && parts[1]) return await viewJob(parts[1]);
    if (parts[0] === 'print' && parts[1]) return await viewPrint(parts[1]);
    if (parts[0] === 'settings') return await viewSettings(new URLSearchParams(qs || ''));
    if (parts[0] === 'calendar') return await viewCalendar(new URLSearchParams(qs || ''));
    return await viewHome();
  } catch (e) { fail(e); }
}
window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { me = null; route(); return; }
  // someone signed in as a different person in another tab of this browser: switch to match
  if (me && session?.user && session.user.id !== me.id) {
    me = null;
    toast(`Now signed in as ${session.user.email}`, 'info', 5000);
    setTimeout(route, 0);
  }
});

// ------------------------------------------------------------ login
function viewLogin() {
  $app.innerHTML = `
    <form class="login card" id="loginForm">
      <h2>Sign in</h2>
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password"></label>
      <button>Sign in</button>
      <button type="button" class="ghost" id="magic">Email me a sign-in link instead</button>
    </form>`;
  const f = q('#loginForm');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) return fail(error);
    location.hash = '#/';
    route();
  };
  q('#magic').onclick = async () => {
    if (!f.email.value) return toast('Enter your email first');
    const { error } = await sb.auth.signInWithOtp({
      email: f.email.value.trim(),
      options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false },
    });
    if (error) return fail(error);
    toast('Check your email for the sign-in link', 'ok', 6000);
  };
}

// ------------------------------------------------------------ choose / change password
function viewChangePassword(forced) {
  const form = `<form class="login card" id="pwForm" style="margin-top:${forced ? '10vh' : '0'}">
      <h2>${forced ? `Welcome${me.display_name ? `, ${esc(me.display_name)}` : ''}` : 'Change my password'}</h2>
      ${forced ? '<p class="muted" style="margin:0">Before you start, please choose your own password. You\'ll use it to sign in from now on.</p>' : ''}
      <label>New password<input name="p1" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>Type it again<input name="p2" type="password" autocomplete="new-password" minlength="8" required></label>
      <p class="small muted" style="margin:0">At least 8 characters.</p>
      <button>Save password</button>
      ${forced ? '<button type="button" class="ghost" id="pwOut">Sign out</button>' : '<a href="#/settings"><button type="button" class="ghost" style="width:100%">Cancel</button></a>'}
    </form>`;
  if (forced) $app.innerHTML = form; else shell('Change password', form, { back: '#/settings' });
  const f = q('#pwForm');
  if (q('#pwOut')) q('#pwOut').onclick = () => sb.auth.signOut();
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.p1.value !== f.p2.value) return toast('The two passwords don\'t match', 'error');
    const btn = f.querySelector('button'); btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: f.p1.value });
    if (error) { btn.disabled = false; return fail(error.message.includes('different') ? new Error('Choose a password different from the temporary one') : error); }
    await sb.rpc('password_changed');
    me.must_change_password = false;
    toast('Password saved', 'ok');
    location.hash = '#/';
    route();
  };
}

// --- login email: automatic if Resend is set up, otherwise a ready-to-send email in the admin's own mail app
function loginEmailParts({ to, name, password, kind }) {
  const biz = settings?.business_name || 'Workshop';
  const url = location.origin + location.pathname;
  const subject = kind === 'new' ? `Your ${biz} job card login` : `Your ${biz} job card password was reset`;
  const body = `Hi ${name || ''},\n\n${kind === 'new' ? `A login has been set up for you on the ${biz} job card app.` : `Your password for the ${biz} job card app has been reset.`}`
    + `\n\nWeb address: ${url}\nEmail: ${to}\nTemporary password: ${password}`
    + `\n\nYou'll be asked to choose your own password the first time you sign in.`
    + `\n\nTip: open the link on your phone and choose "Add to Home Screen" so it opens like an app.\n\n${biz}`;
  return { subject, body, href: `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
}
function loginResultCard(res, info) {
  const m = loginEmailParts(info);
  if (res.emailed) {
    return `<div class="card" style="border-color:var(--ok)"><b>✓ ${info.kind === 'new' ? 'Login created' : 'Password reset'} for ${esc(info.name)}.</b><br>
      A login email has been sent to <b>${esc(info.to)}</b>. They'll choose their own password when they first sign in.</div>`;
  }
  const why = res.email_error && res.email_error !== 'not_configured' ? `<div class="small" style="color:var(--bad)">Automatic email failed: ${esc(res.email_error)}</div>` : '';
  return `<div class="card" style="border-color:var(--ok)"><b>✓ ${info.kind === 'new' ? 'Login created' : 'Password reset'} for ${esc(info.name)}.</b>
    <div style="margin:8px 0">Email: <b>${esc(info.to)}</b><br>Temporary password: <b class="mono">${esc(info.password)}</b></div>
    ${why}
    <div class="actions"><a class="ghost-btn" href="${esc(m.href)}">📧 Send login email</a><button type="button" class="ghost" data-copy>Copy details</button></div>
    <p class="small muted" style="margin:8px 0 0">This opens your email app with the message written. They'll choose their own password when they first sign in.</p></div>`;
}
function wireLoginResult(el, info) {
  const b = el.querySelector('[data-copy]');
  if (b) b.onclick = async () => {
    const m = loginEmailParts(info);
    try { await navigator.clipboard.writeText(`${m.subject}\n\n${m.body}`); toast('Copied', 'ok', 1500); } catch { toast('Copy not allowed here', 'error'); }
  };
}

// ------------------------------------------------------------ home
async function viewHome() {
  const main = shell('Jobs', `
    <section class="card">
      <h2>New job card from a Xero invoice</h2>
      <div class="row">
        <input id="invSearch" placeholder="Search invoice # or customer…" enterkeyhint="search">
        <button id="invReload" class="ghost" title="Reload from Xero">↻</button>
      </div>
      <div style="margin-top:8px"><select id="invSelect"><option>Loading invoices from Xero…</option></select></div>
      <p class="muted small" id="invMsg"></p>
    </section>
    <section class="card">
      <div class="tabs" id="tabs">
        <button data-f="active" class="on">Active</button><button data-f="complete">Complete</button><button data-f="all">All</button>
      </div>
      <input id="jobFilter" placeholder="Filter by job #, customer or rego">
      <div id="jobList" class="list"><p class="muted">Loading…</p></div>
    </section>`);

  // --- invoices dropdown
  let invoices = [];
  const sel = q('#invSelect', main);
  const msg = q('#invMsg', main);
  async function loadInvoices() {
    sel.innerHTML = '<option>Loading invoices from Xero…</option>';
    msg.textContent = '';
    try {
      invoices = (await fn('xero', '/invoices', { query: { search: q('#invSearch', main).value } })).invoices;
      sel.innerHTML = `<option value="">Select an invoice (${invoices.length} open)</option>` +
        invoices.map((i, n) => `<option value="${n}">${esc(i.number)} · ${esc(i.customer)}${i.date ? ` · ${fmtDate(i.date)}` : ''}${i.status === 'DRAFT' ? ' · draft' : ''}${i.job_id ? ' · ✓ has job card' : ''}</option>`).join('');
    } catch (e) {
      sel.innerHTML = '<option value="">Xero unavailable</option>';
      msg.innerHTML = `${esc(e.message)} ${me.is_admin ? '<a href="#/settings">Open settings</a>' : ''}`;
    }
  }
  sel.onchange = async () => {
    const inv = invoices[sel.value];
    if (!inv) return;
    if (inv.job_id) { location.hash = `#/job/${inv.job_id}`; return; }
    sel.disabled = true;
    msg.textContent = `Creating job card for ${inv.number}…`;
    try {
      const r = await fn('xero', '/sync', { method: 'POST', body: { invoice_id: inv.invoice_id } });
      location.hash = `#/job/${r.job_id}`;
    } catch (e) { fail(e); sel.disabled = false; msg.textContent = ''; }
  };
  q('#invReload', main).onclick = loadInvoices;
  q('#invSearch', main).addEventListener('input', debounce(loadInvoices, 600));
  loadInvoices();

  // --- job list
  let jobs = [];
  let filter = 'active';
  async function loadJobs() {
    const { data, error } = await sb.from('jobs')
      .select('id, job_number, customer_name, status, change_acknowledged, updated_at, assigned_to, booked_date, booked_time, vehicle:vehicles(rego, make, model), job_tasks(done, removed_from_invoice)')
      .order('updated_at', { ascending: false }).limit(300);
    if (error) return fail(error);
    jobs = data;
    renderJobs();
  }
  function renderJobs() {
    const term = q('#jobFilter', main).value.trim().toLowerCase();
    const list = jobs.filter((j) =>
      (filter === 'all' || (filter === 'complete' ? j.status === 'complete' : j.status !== 'complete')) &&
      (!term || [j.job_number, j.customer_name, j.vehicle?.rego, j.vehicle?.model].join(' ').toLowerCase().includes(term)));
    q('#jobList', main).innerHTML = list.length ? list.map((j) => {
      const t = (j.job_tasks || []).filter((x) => !x.removed_from_invoice);
      const done = t.filter((x) => x.done).length;
      const veh = j.vehicle ? [j.vehicle.rego, [j.vehicle.make, j.vehicle.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : 'No vehicle yet';
      return `<a class="job-row" href="#/job/${j.id}">
        <div><div class="num">${esc(j.job_number)}</div><div class="sub">${esc(j.customer_name)}</div><div class="sub">${esc(veh)}</div>${j.booked_date ? `<div class="sub booked">${esc(bookedLabel(j))}</div>` : ''}</div>
        <div class="right">
          <span class="badge ${j.status}">${STATUS[j.status]}</span>
          ${j.change_acknowledged ? '' : '<span class="badge alert">Invoice changed</span>'}
          <span class="small muted">${done}/${t.length}</span>
          <div class="mini-progress"><div style="width:${t.length ? (done / t.length) * 100 : 0}%"></div></div>
          ${j.assigned_to ? `<span class="small muted">${esc(nameOf(j.assigned_to))}</span>` : ''}
        </div></a>`;
    }).join('') : '<p class="muted">No jobs here.</p>';
  }
  q('#tabs', main).onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.f;
    main.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderJobs();
  };
  q('#jobFilter', main).oninput = renderJobs;
  await loadJobs();

  const ch = sb.channel('jobs-list')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, debounce(loadJobs, 500))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'job_tasks' }, debounce(loadJobs, 800))
    .subscribe();
  cleanup.push(() => sb.removeChannel(ch));
}

// ------------------------------------------------------------ calendar
const isoDay = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const fmtTimeOfDay = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
};
const bookedLabel = (j) => j.booked_date
  ? `📅 ${parseDay(j.booked_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}${j.booked_time ? ` ${fmtTimeOfDay(j.booked_time)}` : ''}`
  : '';
const initials = (id) => (nameOf(id) || '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

async function viewCalendar(params) {
  const anchor = params.get('d') ? parseDay(params.get('d')) : new Date();
  const start = mondayOf(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const todayIso = isoDay(new Date());
  let techFilter = '';
  try { techFilter = localStorage.getItem('cal_tech') || ''; } catch { /* storage off */ }

  const main = shell('Calendar', `
    <section class="card cal-head">
      <div class="cal-nav">
        <button class="ghost" id="calPrev" aria-label="Previous week">‹</button>
        <button class="ghost" id="calToday">Today</button>
        <button class="ghost" id="calNext" aria-label="Next week">›</button>
        <h2 class="cal-title">${days[0].toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</h2>
        <select id="calTech"><option value="">All techs</option>${profiles.map((p) => `<option value="${p.id}" ${techFilter === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}</select>
      </div>
    </section>
    <div class="cal-week" id="calWeek"></div>
    <section class="card cal-unbooked" id="calUnbooked" data-day=""></section>`);

  const go = (d) => { location.hash = `#/calendar?d=${isoDay(d)}`; };
  q('#calPrev').onclick = () => go(addDays(start, -7));
  q('#calNext').onclick = () => go(addDays(start, 7));
  q('#calToday').onclick = () => go(new Date());
  q('#calTech').onchange = (e) => { techFilter = e.target.value; try { localStorage.setItem('cal_tech', techFilter); } catch { /* */ } render(); };

  let booked = [], unbooked = [];
  const cols = 'id, job_number, customer_name, status, assigned_to, booked_date, booked_time, vehicle:vehicles(rego, make, model), job_tasks(done, removed_from_invoice)';
  async function load() {
    const [a, b] = await Promise.all([
      sb.from('jobs').select(cols).gte('booked_date', isoDay(days[0])).lte('booked_date', isoDay(days[6])).order('booked_time', { nullsFirst: true }),
      sb.from('jobs').select(cols).is('booked_date', null).neq('status', 'complete').order('updated_at', { ascending: false }).limit(60),
    ]);
    if (a.error) return fail(a.error);
    booked = a.data ?? []; unbooked = b.data ?? [];
    render();
  }

  const chip = (j) => {
    const t = (j.job_tasks || []).filter((x) => !x.removed_from_invoice);
    const done = t.filter((x) => x.done).length;
    const veh = j.vehicle ? [j.vehicle.rego, j.vehicle.model].filter(Boolean).join(' · ') : '';
    return `<a class="cal-job st-${j.status}" href="#/job/${j.id}" draggable="true" data-id="${j.id}">
      <div class="cj-top"><b>${esc(j.job_number)}</b>${j.booked_time ? `<span class="cj-time">${fmtTimeOfDay(j.booked_time)}</span>` : ''}</div>
      <div class="cj-sub">${esc(j.customer_name || '')}</div>
      ${veh ? `<div class="cj-sub">${esc(veh)}</div>` : ''}
      <div class="cj-foot">${j.assigned_to ? `<span class="cj-tech" title="${esc(nameOf(j.assigned_to))}">${esc(initials(j.assigned_to))}</span>` : '<span class="cj-tech none">–</span>'}
        <span class="mini-progress"><span style="width:${t.length ? (done / t.length) * 100 : 0}%"></span></span><span class="cj-count">${done}/${t.length}</span></div>
    </a>`;
  };

  function render() {
    const show = (j) => !techFilter || j.assigned_to === techFilter;
    q('#calWeek').innerHTML = days.map((d) => {
      const iso = isoDay(d);
      const list = booked.filter((j) => j.booked_date === iso && show(j));
      return `<div class="cal-day ${iso === todayIso ? 'today' : ''} ${d.getDay() === 0 && !list.length ? 'quiet' : ''}" data-day="${iso}">
        <div class="cal-dhead"><span>${d.toLocaleDateString('en-AU', { weekday: 'short' })} <b>${d.getDate()}</b></span>
          <span class="muted small">${list.length ? `${list.length} job${list.length > 1 ? 's' : ''}` : ''}</span></div>
        <div class="cal-list">${list.map(chip).join('')}</div>
        <button class="cal-add" data-add="${iso}">+ Book</button>
      </div>`;
    }).join('');
    const ub = unbooked.filter(show);
    q('#calUnbooked').innerHTML = `<h3>Not booked yet <span class="muted small">(${ub.length})</span></h3>
      <p class="small muted" style="margin:-6px 0 8px">Drag onto a day (computer/tablet), or open the job and set its booking date.</p>
      <div class="cal-unbooked-list">${ub.map(chip).join('') || '<span class="muted small">Every open job is booked in.</span>'}</div>`;
    q('#calWeek').querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => openBookModal(b.dataset.add); });
  }

  // --- drag to reschedule (mouse / tablet with drag support)
  main.addEventListener('dragstart', (e) => {
    const c = e.target.closest('.cal-job'); if (!c) return;
    e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move';
    c.classList.add('dragging');
  });
  main.addEventListener('dragend', (e) => { e.target.closest?.('.cal-job')?.classList.remove('dragging'); });
  main.addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-day]'); if (!zone) return;
    e.preventDefault(); main.querySelectorAll('.drop-hover').forEach((z) => z !== zone && z.classList.remove('drop-hover')); zone.classList.add('drop-hover');
  });
  main.addEventListener('dragleave', (e) => { const zone = e.target.closest('[data-day]'); if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-hover'); });
  main.addEventListener('drop', async (e) => {
    const zone = e.target.closest('[data-day]'); if (!zone) return;
    e.preventDefault(); zone.classList.remove('drop-hover');
    const id = e.dataTransfer.getData('text/plain'); if (!id) return;
    const day = zone.dataset.day || null;
    const patch = day ? { booked_date: day } : { booked_date: null, booked_time: null };
    const { error } = await sb.from('jobs').update(patch).eq('id', id);
    if (error) return fail(error);
    toast(day ? `Moved to ${parseDay(day).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}` : 'Removed from the calendar', 'ok', 1800);
    load();
  });

  // --- book a job onto a day
  async function openBookModal(dayIso) {
    const ov = document.createElement('div');
    ov.className = 'modal';
    const dayLabel = parseDay(dayIso).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
    ov.innerHTML = `<form class="modal-card" id="bookForm">
      <h3>Book a job: ${esc(dayLabel)}</h3>
      <label>Job<select name="pick" required><option value="">Loading…</option></select></label>
      <div class="grid2">
        <label>Time (optional)<input name="time" type="time" step="900"></label>
        <label>Tech<select name="tech"><option value="">Unassigned</option>${profiles.map((p) => `<option value="${p.id}" ${techFilter === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}</select></label>
      </div>
      <p class="small muted" id="bookMsg" style="margin:4px 0 0"></p>
      <div class="actions" style="margin-top:10px"><button id="bookSave">Book it</button><button type="button" class="ghost" data-x>Cancel</button></div>
    </form>`;
    document.body.appendChild(ov);
    const f = q('#bookForm', ov);
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.dataset.x !== undefined) ov.remove(); });
    let invoices = [];
    const fill = () => {
      const unb = unbooked.map((j) => `<option value="job:${j.id}">${esc(j.job_number)} · ${esc(j.customer_name || '')}</option>`).join('');
      const inv = invoices.filter((i) => !i.job_id).map((i, n) => `<option value="inv:${n}">${esc(i.number)} · ${esc(i.customer)}</option>`).join('');
      f.pick.innerHTML = `<option value="">Choose a job or invoice…</option>`
        + (unb ? `<optgroup label="Job cards not booked yet">${unb}</optgroup>` : '')
        + (inv ? `<optgroup label="Xero invoices (creates the job card)">${inv}</optgroup>` : '');
    };
    fill();
    fn('xero', '/invoices', { query: { search: '' } })
      .then((r) => {
        invoices = r.invoices.map((i) => ({ ...i }));
        const keep = f.pick.value; fill(); f.pick.value = keep;
      })
      .catch((e) => { q('#bookMsg', ov).textContent = `Xero invoices unavailable (${e.message}); existing job cards are listed.`; });

    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = f.pick.value; if (!v) return;
      const btn = q('#bookSave', ov); btn.disabled = true; btn.textContent = 'Booking…';
      try {
        let jobId;
        if (v.startsWith('job:')) jobId = v.slice(4);
        else {
          const inv = invoices[Number(v.slice(4))];
          jobId = (await fn('xero', '/sync', { method: 'POST', body: { invoice_id: inv.invoice_id } })).job_id;
        }
        const patch = { booked_date: dayIso, booked_time: f.time.value || null };
        if (f.tech.value) patch.assigned_to = f.tech.value;
        const { error } = await sb.from('jobs').update(patch).eq('id', jobId);
        if (error) throw error;
        ov.remove(); toast('Booked in', 'ok'); load();
      } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Book it'; }
    };
  }

  await load();
  // on phones the week is a long list: jump to today
  if (window.innerWidth < 900) q('.cal-day.today')?.scrollIntoView({ block: 'start' });
  const ch = sb.channel('calendar').on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, debounce(load, 500)).subscribe();
  cleanup.push(() => sb.removeChannel(ch));
}

// ------------------------------------------------------------ job card
async function viewJob(id) {
  const main = shell('Job card', '<p class="muted">Loading…</p>', { back: '#/' });
  let job, tasks = [], docs = [], photos = [], custVehicles = [], library = [];

  const loadJob = async () => {
    const { data, error } = await sb.from('jobs').select('*, vehicle:vehicles(*)').eq('id', id).single();
    if (error) throw error;
    job = data;
    custVehicles = job.xero_contact_id
      ? ((await sb.from('vehicles').select('*').eq('xero_contact_id', job.xero_contact_id).order('updated_at', { ascending: false })).data ?? [])
      : [];
  };
  const loadTasks = async () => {
    tasks = (await sb.from('job_tasks').select('*').eq('job_id', id).order('sort').order('created_at')).data ?? [];
  };
  const loadDocs = async () => {
    const rows = (await sb.from('job_docs').select('rule_id, doc:tech_docs(*)').eq('job_id', id)).data ?? [];
    const paths = rows.map((r) => r.doc?.storage_path).filter(Boolean);
    const urls = paths.length ? (await sb.storage.from('tech-docs').createSignedUrls(paths, 4 * 3600)).data ?? [] : [];
    docs = rows.filter((r) => r.doc).map((r) => ({ ...r.doc, rule_id: r.rule_id, url: urls.find((u) => u.path === r.doc.storage_path)?.signedUrl }));
  };
  const loadPhotos = async () => {
    const rows = (await sb.from('job_photos').select('*').eq('job_id', id).order('created_at')).data ?? [];
    const urls = rows.length ? (await sb.storage.from('job-photos').createSignedUrls(rows.map((r) => r.storage_path), 4 * 3600)).data ?? [] : [];
    photos = rows.map((r) => ({ ...r, url: urls.find((u) => u.path === r.storage_path)?.signedUrl }));
  };

  await Promise.all([loadJob(), loadTasks(), loadDocs(), loadPhotos()]);
  library = (await sb.from('tech_docs').select('id, title').order('title')).data ?? [];

  main.innerHTML = `
    <section id="banner"></section>
    <section class="card" id="head"></section>
    <section class="card"><h2>Vehicle</h2><div id="vehicle"></div></section>
    <section class="card"><h2>Checklist</h2><div id="tasks"></div></section>
    <section class="card"><h2>Tech documents</h2><div id="docs"></div></section>
    <section class="card"><h2>Photos</h2><div id="photos"></div></section>
    <section class="card"><h2>Tech notes</h2>
      <textarea id="notes" placeholder="Findings, measurements, parts used, anything the next person should know…"></textarea>
      <p class="small muted" id="notesState"></p>
    </section>
    <section class="actions">
      <a href="#/print/${id}"><button class="ghost" type="button">🖨 Print job card</button></a>
      <button class="ghost" id="resync" type="button">↻ Refresh from Xero</button>
      ${me.is_admin ? '<button class="danger" id="deleteJob" type="button">🗑 Delete job card</button>' : ''}
    </section>`;

  // ---------------- banner (invoice changed)
  function renderBanner() {
    const c = job.last_change_summary;
    if (job.change_acknowledged || !c) { q('#banner').innerHTML = ''; return; }
    const li = (arr, label) => arr?.length ? `<li><b>${label}:</b> ${arr.map(esc).join(', ')}</li>` : '';
    q('#banner').innerHTML = `<div class="card warn changes">
      <h3>⚠ The invoice changed in Xero (${fmtTime(c.at)})</h3>
      <ul>${li(c.added, 'Added')}${li(c.changed, 'Updated')}${li(c.removed, 'Removed')}${li(c.details, 'Details')}</ul>
      <button id="ack">Got it</button></div>`;
    q('#ack').onclick = async () => {
      const { error } = await sb.from('jobs').update({ change_acknowledged: true }).eq('id', id);
      if (error) return fail(error);
      job.change_acknowledged = true;
      await sb.from('job_tasks').update({ changed_on_sync: false }).eq('job_id', id);
      await loadTasks(); renderBanner(); renderTasks();
    };
  }

  // ---------------- header
  function renderHead() {
    q('#head').innerHTML = `
      <div class="job-head">
        <div>
          <div class="num">${esc(job.job_number)}</div>
          <div>${esc(job.customer_name)}</div>
          ${job.customer_phone ? `<a class="phone" href="tel:${esc(job.customer_phone.replace(/\s/g, ''))}">📞 ${esc(job.customer_phone)}</a>` : ''}
        </div>
        <div style="text-align:right">
          <span class="badge ${job.status}">${STATUS[job.status]}</span>
          <div class="sync" id="syncState">Invoice ${esc(job.invoice_status ?? '')}${job.invoice_date ? ` · ${fmtDate(job.invoice_date)}` : ''}</div>
        </div>
      </div>
      <div class="grid2" style="margin-top:12px">
        <label>Status<select id="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${job.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Tech<select id="assigned"><option value="">Unassigned</option>${profiles.map((p) => `<option value="${p.id}" ${job.assigned_to === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}</select></label>
        <label>Booked in (date)<input id="bookDate" type="date" value="${job.booked_date ?? ''}"></label>
        <label>Time<input id="bookTime" type="time" step="900" value="${(job.booked_time ?? '').slice(0, 5)}"></label>
        <label class="span2">Odometer (km)<input id="odoIn" type="number" inputmode="numeric" value="${job.odometer_in ?? ''}"></label>
      </div>`;
    const save = async (patch, el) => {
      const { error } = await sb.from('jobs').update(patch).eq('id', id);
      if (error) return fail(error);
      Object.assign(job, patch);
      flashSaved(el);
    };
    q('#status').onchange = (e) => save({ status: e.target.value }, e.target).then(updateBadge);
    q('#assigned').onchange = (e) => save({ assigned_to: e.target.value || null }, e.target);
    const odo = (v) => (v === '' ? null : Math.max(0, parseInt(v, 10) || 0));
    q('#odoIn').onchange = (e) => save({ odometer_in: odo(e.target.value) }, e.target);
    q('#bookDate').onchange = (e) => save(e.target.value ? { booked_date: e.target.value } : { booked_date: null, booked_time: null }, e.target)
      .then(() => { if (!e.target.value) q('#bookTime').value = ''; });
    q('#bookTime').onchange = (e) => save({ booked_time: e.target.value || null }, e.target);
  }
  function updateBadge() {
    const b = q('#head .badge');
    if (b) { b.className = `badge ${job.status}`; b.textContent = STATUS[job.status]; }
  }
  // Put fresh values into fields the user isn't currently in (never redraws, so focus is never lost)
  function setIfIdle(el, val) {
    if (!el || el === document.activeElement) return;
    const v = val ?? '';
    if (String(el.value) !== String(v)) el.value = v;
  }

  // ---------------- vehicle
  function renderVehicle() {
    const v = job.vehicle || {};
    const others = custVehicles.filter((x) => x.id !== v.id);
    q('#vehicle').innerHTML = `
      <div class="row">
        <label>Rego (QLD)<input id="vRego" class="big mono" data-vid="${esc(v.id ?? '')}" value="${esc(v.rego ?? '')}" autocapitalize="characters" autocomplete="off" enterkeyhint="search"></label>
        <button id="vFind" style="align-self:end">Find</button>
      </div>
      <div class="grid2" style="margin-top:10px">
        <label class="span2">VIN<input id="vVin" class="mono" value="${esc(v.vin ?? '')}" autocapitalize="characters" autocomplete="off" maxlength="20"></label>
        <p class="small muted span2" id="vinHint" style="margin:-4px 0 0">${esc(vinInfo(v.vin))}</p>
        <label>Make<input data-f="make" value="${esc(v.make ?? '')}"></label>
        <label>Model<input data-f="model" value="${esc(v.model ?? '')}" placeholder="e.g. LandCruiser 79 GXL"></label>
        <label>Year<input data-f="year" type="number" inputmode="numeric" value="${v.year ?? ''}"></label>
        <label>Engine<input data-f="engine" value="${esc(v.engine ?? '')}" placeholder="e.g. 1VD-FTV"></label>
        <label class="span2">Colour<input data-f="colour" value="${esc(v.colour ?? '')}"></label>
      </div>
      ${others.length ? `<p class="small muted" style="margin:12px 0 0">This customer's other vehicles:</p>
        <div class="chips">${others.map((o) => `<button class="chip" data-vid="${o.id}">${esc(o.rego || 'no rego')} · ${esc([o.make, o.model].filter(Boolean).join(' ') || 'unknown')}</button>`).join('')}</div>` : ''}`;

    q('#vFind').onclick = () => findRego(q('#vRego').value);
    q('#vRego').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); findRego(e.target.value); } };
    q('#vVin').oninput = (e) => { q('#vinHint').textContent = vinInfo(e.target.value); };
    q('#vVin').onchange = (e) => saveVehicle({ vin: normRego(e.target.value) || null }, e.target);
    q('#vehicle').querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        const f = inp.dataset.f;
        saveVehicle({ [f]: f === 'year' ? (parseInt(inp.value, 10) || null) : (inp.value.trim() || null) }, inp);
      };
    });
    q('#vehicle').querySelectorAll('[data-vid]').forEach((b) => { b.onclick = () => linkVehicle(b.dataset.vid); });
  }

  async function linkVehicle(vehicleId) {
    const { error } = await sb.from('jobs').update({ vehicle_id: vehicleId }).eq('id', id);
    if (error) return fail(error);
    await afterVehicleChange(true);
  }

  async function findRego(input) {
    const rego = normRego(input);
    if (!rego) return toast('Enter a rego');
    if (rego === job.vehicle?.rego) return;
    const btn = q('#vFind'); btn.disabled = true; btn.textContent = '…';
    try {
      // 1. seen this car before?
      let { data: veh } = await sb.from('vehicles').select('*').eq('rego', rego).maybeSingle();
      // 2. otherwise try the lookup service (off until a provider is set up)
      if (!veh) {
        let found = null;
        try {
          const r = await fn('rego-lookup', '', { method: 'POST', body: { rego, state: 'QLD' } });
          if (r.ok) found = r;
          else if (r.reason === 'not_found') toast('Rego not found by lookup service, enter VIN manually');
        } catch (e) { console.warn('rego lookup failed', e); }
        const v = found?.vehicle ?? {};
        const ins = await sb.from('vehicles').insert({
          rego, state: 'QLD', vin: v.vin ?? null, make: v.make ?? null, model: v.model ?? null,
          year: v.year ?? null, engine: v.engine ?? null, colour: v.colour ?? null,
          xero_contact_id: job.xero_contact_id, lookup_source: found ? found.source : 'manual', lookup_raw: found?.raw ?? null,
        }).select('*').single();
        if (ins.error) throw ins.error;
        veh = ins.data;
        if (found) toast(`Found ${[v.make, v.model].filter(Boolean).join(' ')}`, 'ok');
      } else if (!veh.xero_contact_id && job.xero_contact_id) {
        await sb.from('vehicles').update({ xero_contact_id: job.xero_contact_id }).eq('id', veh.id);
      }
      await linkVehicle(veh.id);
    } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = 'Find'; }
  }

  // Saves one vehicle field in the background. Deliberately does NOT redraw the form.
  async function saveVehicle(patch, el) {
    if (!job.vehicle) {
      // no vehicle yet → create one without a rego
      const ins = await sb.from('vehicles').insert({ ...patch, xero_contact_id: job.xero_contact_id, lookup_source: 'manual' }).select('*').single();
      if (ins.error) return fail(ins.error);
      const { error } = await sb.from('jobs').update({ vehicle_id: ins.data.id }).eq('id', id);
      if (error) return fail(error);
      job.vehicle = ins.data; job.vehicle_id = ins.data.id;
    } else {
      const { error } = await sb.from('vehicles').update(patch).eq('id', job.vehicle.id);
      if (error) return fail(error);
      Object.assign(job.vehicle, patch);
    }
    flashSaved(el);
    if (['make', 'model', 'year', 'engine'].some((k) => k in patch)) applyRules();
  }

  async function applyRules() {
    const { data: n } = await sb.rpc('apply_doc_rules', { p_job: id });
    if (n > 0) { await Promise.all([loadDocs(), loadTasks()]); renderDocs(); renderTasks(); toast('Tech docs / checks added for this job', 'ok'); }
  }

  // Only runs when a different vehicle is linked (Find / tapping a customer's car)
  async function afterVehicleChange(regoChanged) {
    await loadJob();
    renderVehicle();
    // carry on to the next empty field
    const next = ['#vVin', 'input[data-f=make]', 'input[data-f=model]', 'input[data-f=year]', 'input[data-f=engine]']
      .map((sel) => q(sel)).find((el) => el && !el.value);
    if (next) next.focus();
    await applyRules();
    if (regoChanged && job.vehicle?.rego && settings?.rego_to_xero_reference) {
      fn('xero', '/reference', { method: 'POST', body: { job_id: id } })
        .then((r) => { if (r.reference && !r.unchanged) toast(`Xero reference set: ${r.reference}`, 'ok'); else if (r.skipped) toast(`Rego not written to Xero: ${r.skipped}`); })
        .catch((e) => toast(`Couldn't write rego to Xero: ${e.message}`, 'error', 5000));
    }
  }

  // ---------------- checklist
  function renderTasks() {
    const live = tasks.filter((t) => !t.removed_from_invoice);
    const done = live.filter((t) => t.done).length;
    q('#tasks').innerHTML = `
      <div class="progress"><div style="width:${live.length ? (done / live.length) * 100 : 0}%"></div></div>
      <p class="small muted">${done} of ${live.length} done</p>
      <ul class="tasks">${tasks.map((t) => {
        const tags = [
          t.source === 'rule' ? '<span class="tag rule">auto</span>' : '',
          t.source === 'manual' ? '<span class="tag manual">added</span>' : '',
          t.removed_from_invoice ? '<span class="tag removed">removed from invoice</span>' : (t.changed_on_sync ? '<span class="tag changed">updated</span>' : ''),
        ].join('');
        const qty = t.quantity != null && Number(t.quantity) !== 1 ? ` <b>×${esc(Number(t.quantity))}</b>` : '';
        return `<li class="task ${t.done ? 'done' : ''} ${t.removed_from_invoice ? 'removed' : ''}" data-id="${t.id}">
          <label><input type="checkbox" ${t.done ? 'checked' : ''} ${t.removed_from_invoice ? 'disabled' : ''}><span class="desc">${esc(t.description)}${qty}</span></label>
          <button class="icon" data-act="note" title="Add a note">📝</button>
          ${t.source !== 'invoice' || t.removed_from_invoice ? '<button class="icon" data-act="del" title="Remove">✕</button>' : '<span></span>'}
          <div class="meta">${tags}${t.done ? `<span>✓ ${esc(nameOf(t.done_by) || 'done')} · ${fmtTime(t.done_at)}</span>` : ''}${t.note ? `<div class="note">📝 ${esc(t.note)}</div>` : ''}</div>
        </li>`;
      }).join('')}</ul>
      <form id="addTask" class="row"><input name="d" placeholder="Add a check item…" autocomplete="off"><button>Add</button></form>`;
  }
  q('#tasks').addEventListener('change', async (e) => {
    if (e.target.type !== 'checkbox') return;
    const tid = e.target.closest('.task').dataset.id;
    const t = tasks.find((x) => x.id === tid);
    t.done = e.target.checked; t.done_by = t.done ? me.id : null; t.done_at = t.done ? new Date().toISOString() : null;
    renderTasks();
    const { error } = await sb.from('job_tasks').update({ done: t.done }).eq('id', tid);
    if (error) { fail(error); await loadTasks(); renderTasks(); }
    else if (job.status === 'open' && t.done) { await sb.from('jobs').update({ status: 'in_progress' }).eq('id', id); job.status = 'in_progress'; renderHead(); }
  });
  q('#tasks').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const tid = b.closest('.task').dataset.id;
    const t = tasks.find((x) => x.id === tid);
    if (b.dataset.act === 'note') {
      const note = prompt('Note for this item (torque, measurement, part no…)', t.note ?? '');
      if (note === null) return;
      const { error } = await sb.from('job_tasks').update({ note: note.trim() || null }).eq('id', tid);
      if (error) return fail(error);
    } else if (b.dataset.act === 'del') {
      if (!confirm(`Remove "${t.description}"?`)) return;
      const { error } = await sb.from('job_tasks').delete().eq('id', tid);
      if (error) return fail(error);
    }
    await loadTasks(); renderTasks();
  });
  q('#tasks').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = e.target.d.value.trim(); if (!d) return;
    const sort = Math.max(0, ...tasks.map((t) => t.sort)) + 1;
    const { error } = await sb.from('job_tasks').insert({ job_id: id, source: 'manual', description: d, sort });
    if (error) return fail(error);
    await loadTasks(); renderTasks();
    q('#addTask input').focus();
  });

  // ---------------- docs
  function renderDocs() {
    const attached = new Set(docs.map((d) => d.id));
    const avail = library.filter((d) => !attached.has(d.id));
    q('#docs').innerHTML = `
      <div class="docs">${docs.length ? docs.map((d) => `
        <div class="doc">
          <a class="doc-link" href="${esc(d.url ?? '#')}" target="_blank" rel="noopener">
            <span class="ico">📄</span><span class="t">${esc(d.title)}<div class="s">${d.rule_id ? 'Added automatically' : 'Added manually'}${d.description ? ` · ${esc(d.description)}` : ''}</div></span>
          </a>
          <button class="icon" data-unlink="${d.id}" title="Remove from this job">✕</button>
        </div>`).join('') : '<p class="muted small">No documents for this job yet. Rules add them automatically once the vehicle is set.</p>'}</div>
      <div class="row" style="margin-top:8px">
        <label class="ghost-btn shrink">📎 Add document<input type="file" id="docFile" accept="application/pdf,image/*" hidden></label>
        ${avail.length ? `<select id="docAdd"><option value="">…or attach from library</option>${avail.map((d) => `<option value="${d.id}">${esc(d.title)}</option>`).join('')}</select>` : ''}
      </div>`;
    const s = q('#docAdd');
    if (s) s.onchange = async () => {
      if (!s.value) return;
      const { error } = await sb.from('job_docs').insert({ job_id: id, doc_id: s.value, added_by: me.id });
      if (error) return fail(error);
      await loadDocs(); renderDocs();
    };
    q('#docFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openDocModal(f); };
    q('#docs').querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => {
      const d = docs.find((x) => x.id === b.dataset.unlink);
      if (!confirm(`Remove "${d.title}" from this job? (It stays in the document library.)`)) return;
      const { error } = await sb.from('job_docs').delete().eq('job_id', id).eq('doc_id', d.id);
      if (error) return fail(error);
      await loadDocs(); renderDocs();
    });
  }

  // Suggest a vehicle match like "landcruiser&79" from "LandCruiser 79 GXL"
  function suggestVehicleMatch(v) {
    const model = (v?.model || '').toLowerCase().trim();
    if (!model) return (v?.make || '').toLowerCase();
    const words = model.split(/\s+/);
    const num = words.find((w) => /\d/.test(w));
    return num && words[0] !== num ? `${words[0]}&${num}` : words[0];
  }
  // Keyword chips from the invoice lines ("clutch", "injectors", …)
  function workKeywords() {
    const stop = new Set(['supply', 'fit', 'fitted', 'fitting', 'labour', 'labor', 'and', 'the', 'with', 'for', 'replace', 'replacement', 'install', 'kit', 'new', 'service', 'parts', 'part', 'hours', 'hour', 'remove', 'check', 'from', 'heavy', 'duty']);
    const seen = new Map();
    tasks.filter((t) => t.source !== 'rule' && !t.removed_from_invoice).forEach((t) =>
      t.description.toLowerCase().split(/[^a-z0-9]+/).forEach((w) => {
        if (w.length >= 4 && !stop.has(w) && !/^\d+$/.test(w)) seen.set(w, (seen.get(w) || 0) + 1);
      }));
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  }

  function openDocModal(file) {
    const v = job.vehicle || {};
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    const chips = workKeywords();
    const ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = `<form class="modal-card" id="docForm">
      <h3>Add document to ${esc(job.job_number)}</h3>
      <p class="small muted" style="margin:0 0 10px">📄 ${esc(file.name)} · ${(file.size / 1048576).toFixed(1)} MB</p>
      <div class="grid2">
        <label class="span2">Title<input name="title" required value="${esc(title)}"></label>
        <label class="span2">Description (optional)<input name="description" placeholder="e.g. Flywheel 120 Nm, pressure plate 19 Nm"></label>
      </div>
      ${me.is_admin ? `
      <label class="check-row"><input type="checkbox" name="mkrule"> Attach automatically to future jobs (make a rule)</label>
      <div class="rule-fields" hidden>
        <div class="grid2">
          <label>Vehicle contains<input name="vehicle_match" value="${esc(suggestVehicleMatch(v))}" placeholder="e.g. 79 series, lc79, vdj79"></label>
          <label>Work contains<input name="job_match" placeholder="e.g. clutch"></label>
        </div>
        ${chips.length ? `<div class="chips">${chips.map((c) => `<button type="button" class="chip" data-kw="${esc(c)}">+ ${esc(c)}</button>`).join('')}</div>` : ''}
        <label style="margin-top:8px">Also add these check items (one per line, optional)<textarea name="extra_tasks" placeholder="Torque flywheel bolts to spec&#10;Torque pressure plate bolts to spec"></textarea></label>
        <p class="small muted" style="margin:6px 0 0">Matching is "contains", not case sensitive. Commas mean OR, <b>&amp;</b> means AND.
          This vehicle is <b>${esc([v.make, v.model].filter(Boolean).join(' ') || 'not set yet')}</b>.</p>
      </div>` : ''}
      <div class="actions" style="margin-top:12px"><button id="docSave">Save document</button><button type="button" class="ghost" data-x>Cancel</button></div>
    </form>`;
    document.body.appendChild(ov);
    const f = q('#docForm', ov);
    const close = () => ov.remove();
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.dataset.x !== undefined) close(); });
    if (f.mkrule) f.mkrule.onchange = () => { q('.rule-fields', ov).hidden = !f.mkrule.checked; };
    ov.querySelectorAll('[data-kw]').forEach((b) => b.onclick = () => {
      const cur = f.job_match.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (!cur.includes(b.dataset.kw)) cur.push(b.dataset.kw);
      f.job_match.value = cur.join(', ');
    });

    f.onsubmit = async (e) => {
      e.preventDefault();
      const mkRule = !!f.mkrule?.checked;
      const rule = mkRule ? {
        vehicle_match: f.vehicle_match.value.trim() || null,
        job_match: f.job_match.value.trim() || null,
        extra_tasks: f.extra_tasks.value.split('\n').map((x) => x.trim()).filter(Boolean),
      } : null;
      if (rule && !rule.vehicle_match && !rule.job_match) return toast('Give the rule a vehicle or work condition', 'error');
      const btn = q('#docSave', ov); btn.disabled = true; btn.textContent = 'Uploading…';
      try {
        const ext = (file.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
        const path = `${crypto.randomUUID()}.${ext}`;
        const up = await sb.storage.from('tech-docs').upload(path, file, { contentType: file.type || 'application/pdf' });
        if (up.error) throw up.error;
        const ins = await sb.from('tech_docs').insert({
          title: f.title.value.trim(), description: f.description.value.trim() || null, storage_path: path, uploaded_by: me.id,
        }).select('id').single();
        if (ins.error) throw ins.error;
        const docId = ins.data.id;
        const link = await sb.from('job_docs').insert({ job_id: id, doc_id: docId, added_by: me.id });
        if (link.error) throw link.error;

        let msg = 'Document added';
        if (rule) {
          const r = await sb.from('doc_rules').insert({
            name: f.title.value.trim(), vehicle_match: rule.vehicle_match, job_match: rule.job_match,
            doc_id: docId, extra_tasks: rule.extra_tasks.length ? rule.extra_tasks : null,
          });
          if (r.error) throw r.error;
          // run it on every open job (adds this job's check items + catches other matching jobs)
          const { data: open } = await sb.from('jobs').select('id').neq('status', 'complete');
          let others = 0;
          for (const j of open ?? []) {
            const { data: n } = await sb.rpc('apply_doc_rules', { p_job: j.id });
            if (j.id !== id && n > 0) others++;
          }
          msg = `Document added and rule saved${others ? `, also attached to ${others} other open job${others > 1 ? 's' : ''}` : ''}`;
        }
        library = (await sb.from('tech_docs').select('id, title').order('title')).data ?? [];
        await Promise.all([loadDocs(), loadTasks()]);
        renderDocs(); renderTasks();
        toast(msg, 'ok', 5000);
        close();
      } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Save document'; }
    };
  }

  // ---------------- photos
  function renderPhotos() {
    q('#photos').innerHTML = `<div class="photos">
      ${photos.map((p, i) => `<div class="ph">
        <img src="${esc(p.url ?? '')}" data-i="${i}" alt="${esc(p.caption ?? 'photo')}" loading="lazy">
        ${canDeletePhoto(p) ? `<button class="ph-del" data-del="${i}" title="Delete photo" aria-label="Delete photo">🗑</button>` : ''}
      </div>`).join('')}
      <label class="add-photo">📷<br>Add photos<input type="file" id="photoIn" accept="image/*" multiple></label>
    </div>`;
    q('#photoIn').onchange = (e) => uploadPhotos([...e.target.files]);
    q('#photos').querySelectorAll('img').forEach((img) => { img.onclick = () => lightbox(photos[img.dataset.i]); });
    q('#photos').querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => deletePhoto(photos[b.dataset.del]); });
  }
  const canDeletePhoto = (p) => me.is_admin || p.uploaded_by === me.id;
  async function deletePhoto(p, box) {
    if (!confirm('Delete this photo? This can\'t be undone.')) return false;
    const { data, error } = await sb.from('job_photos').delete().eq('id', p.id).select('id');
    if (error) { fail(error); return false; }
    if (!data?.length) { toast('Only an admin or the person who took it can delete this photo', 'error'); return false; }
    await sb.storage.from('job-photos').remove([p.storage_path]);
    box?.remove();
    toast('Photo deleted', 'ok', 1500);
    await loadPhotos(); renderPhotos();
    return true;
  }
  async function uploadPhotos(files) {
    if (!files.length) return;
    toast(`Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`);
    let ok = 0;
    for (const f of files) {
      try {
        const blob = await compressImage(f);
        const path = `${id}/${crypto.randomUUID()}.jpg`;
        const up = await sb.storage.from('job-photos').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw up.error;
        const { error } = await sb.from('job_photos').insert({ job_id: id, storage_path: path, uploaded_by: me.id });
        if (error) throw error;
        ok++;
      } catch (e) { fail(e); }
    }
    if (ok) toast(`${ok} photo${ok > 1 ? 's' : ''} added`, 'ok');
    await loadPhotos(); renderPhotos();
  }
  function lightbox(p) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${esc(p.url)}" alt="">
      <div class="bar"><span class="small muted">${esc(nameOf(p.uploaded_by))} · ${fmtTime(p.created_at)}</span>
      <span class="actions"><button class="ghost" data-a="cap">Caption</button>${canDeletePhoto(p) ? '<button class="danger" data-a="del">Delete</button>' : ''}<button data-a="x">Close</button></span></div>`;
    document.body.appendChild(box);
    box.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'x' || e.target === box) box.remove();
      if (a === 'cap') {
        const c = prompt('Caption', p.caption ?? ''); if (c === null) return;
        await sb.from('job_photos').update({ caption: c.trim() || null }).eq('id', p.id);
        p.caption = c.trim(); toast('Saved', 'ok', 1200);
      }
      if (a === 'del') await deletePhoto(p, box);
    };
  }

  // ---------------- notes (autosave)
  const notes = q('#notes');
  notes.value = job.tech_notes ?? '';
  const saveNotes = debounce(async () => {
    const { error } = await sb.from('jobs').update({ tech_notes: notes.value }).eq('id', id);
    q('#notesState').textContent = error ? `Not saved: ${error.message}` : `Saved ${fmtTime(new Date())}`;
  }, 800);
  notes.oninput = () => { q('#notesState').textContent = 'Saving…'; saveNotes(); };

  // ---------------- sync with Xero
  async function syncNow(manual) {
    const el = q('#syncState');
    try {
      if (el) el.textContent = 'Checking Xero…';
      const r = await fn('xero', '/sync', { method: 'POST', body: { invoice_id: job.xero_invoice_id } });
      await Promise.all([loadJob(), loadTasks(), loadDocs()]);
      renderBanner(); renderHead(); renderTasks(); renderDocs();
      const e2 = q('#syncState'); if (e2) e2.textContent = `Invoice ${job.invoice_status} · synced ${fmtTime(new Date())}`;
      if (r.changes) toast('Invoice changed in Xero, checklist updated', 'info', 5000);
      else if (manual) toast('Up to date with Xero', 'ok');
    } catch (e) {
      const e2 = q('#syncState'); if (e2) e2.textContent = `Couldn't reach Xero (${e.message})`;
      if (manual) fail(e);
    }
  }
  q('#resync').onclick = () => syncNow(true);

  // ---------------- delete (admin only; the Xero invoice is not touched)
  const delBtn = q('#deleteJob');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`Delete job card ${job.job_number}?\n\nThis removes its checklist, notes and ${photos.length} photo(s). The Xero invoice is NOT changed, and you can make a fresh job card from it later.`)) return;
    delBtn.disabled = true;
    try {
      if (photos.length) await sb.storage.from('job-photos').remove(photos.map((p) => p.storage_path));
      const { data, error } = await sb.from('jobs').delete().eq('id', id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('Only an admin can delete job cards');
      toast(`Job card ${job.job_number} deleted`, 'ok');
      location.hash = '#/';
    } catch (e) { fail(e); delBtn.disabled = false; }
  };

  renderBanner(); renderHead(); renderVehicle(); renderTasks(); renderDocs(); renderPhotos();
  syncNow(false);

  const FIELD_ORDER = ['#odoIn', '#vRego', '#vVin', 'input[data-f=make]', 'input[data-f=model]', 'input[data-f=year]', 'input[data-f=engine]', 'input[data-f=colour]'];
  main.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.id === 'vRego') return;
    const order = FIELD_ORDER.map((sel) => q(sel)).filter(Boolean);
    const i = order.indexOf(e.target);
    if (i === -1) return;
    e.preventDefault();
    const nxt = order[i + 1];
    if (nxt) nxt.focus(); else e.target.blur();
  });
  main.addEventListener('focusin', (e) => {
    if (e.target.tagName === 'INPUT' && FIELD_ORDER.some((sel) => e.target.matches(sel)) && e.target.id !== 'vRego') e.target.setAttribute('enterkeyhint', 'next');
  });

  // ---------------- live updates from other tablets
  const ch = sb.channel(`job-${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'job_tasks', filter: `job_id=eq.${id}` },
      debounce(async () => { await loadTasks(); renderTasks(); }, 400))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'job_photos', filter: `job_id=eq.${id}` },
      debounce(async () => { await loadPhotos(); renderPhotos(); }, 600))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${id}` },
      debounce(async () => {
        const prevVehicle = q('#vRego')?.dataset.vid;
        await loadJob();
        renderBanner(); updateBadge();
        setIfIdle(q('#status'), job.status);
        setIfIdle(q('#assigned'), job.assigned_to);
        setIfIdle(q('#odoIn'), job.odometer_in);
        setIfIdle(q('#bookDate'), job.booked_date);
        setIfIdle(q('#bookTime'), (job.booked_time ?? '').slice(0, 5));
        setIfIdle(notes, job.tech_notes);
        const v = job.vehicle || {};
        const inVehicleForm = q('#vehicle').contains(document.activeElement);
        if ((v.id ?? '') !== (prevVehicle ?? '') && !inVehicleForm) renderVehicle();   // another tablet linked a different car
        else {
          setIfIdle(q('#vRego'), v.rego); setIfIdle(q('#vVin'), v.vin);
          q('#vehicle').querySelectorAll('input[data-f]').forEach((i) => setIfIdle(i, v[i.dataset.f]));
        }
      }, 600))
    .subscribe();
  cleanup.push(() => sb.removeChannel(ch));
}

// ------------------------------------------------------------ print view: dealership-style repair order (no prices)
const C39 = {"0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw","5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn","A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn","F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn","K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn","P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn","U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn","Z":"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","$":"nwnwnwnnn","/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn","*":"nwnnwnwnn"};
function code39Svg(text, height = 34) {
  const s = `*${String(text).toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '-')}*`;
  const N = 1.2, W = 3;                       // narrow / wide module widths
  let x = 0, bars = '';
  for (const ch of s) {
    const p = C39[ch];
    for (let i = 0; i < 9; i++) {
      const w = p[i] === 'w' ? W : N;
      if (i % 2 === 0) bars += `<rect x="${x.toFixed(1)}" y="0" width="${w}" height="${height}"/>`;
      x += w;
    }
    x += N;                                   // gap between characters
  }
  return `<svg class="ro-barcode" viewBox="0 0 ${x.toFixed(1)} ${height}" width="${(x * 0.9).toFixed(0)}" height="${height}" preserveAspectRatio="none" aria-label="${esc(text)}">${bars}</svg>`;
}

const DEFAULT_TERMS = 'I authorise the work listed above to be carried out, along with any road testing required. '
  + 'The workshop is not responsible for loss or damage to vehicles or articles left in vehicles in case of fire, theft or any cause beyond our control.';

async function viewPrint(id) {
  const [{ data: job, error }, { data: tasks }, { data: jd }, { data: photoRows }] = await Promise.all([
    sb.from('jobs').select('*, vehicle:vehicles(*)').eq('id', id).single(),
    sb.from('job_tasks').select('*').eq('job_id', id).eq('removed_from_invoice', false).order('sort').order('created_at'),
    sb.from('job_docs').select('doc:tech_docs(title)').eq('job_id', id),
    sb.from('job_photos').select('*').eq('job_id', id).order('created_at'),
  ]);
  if (error) throw error;
  const s = settings || {};
  const v = job.vehicle || {};
  const ops = tasks ?? [];
  const photos = photoRows ?? [];
  const [logoRes, photoRes] = await Promise.all([
    s.logo_path ? sb.storage.from('tech-docs').createSignedUrl(s.logo_path, 3600) : Promise.resolve({ data: null }),
    photos.length ? sb.storage.from('job-photos').createSignedUrls(photos.map((p) => p.storage_path), 3600) : Promise.resolve({ data: [] }),
  ]);
  const logoUrl = logoRes.data?.signedUrl;
  const photoUrl = (p) => (photoRes.data ?? []).find((u) => u.path === p.storage_path)?.signedUrl;

  const kv = (label, value, cls = '') => `<div class="kv ${cls}"><span>${label}</span><b>${value ? esc(value) : '&nbsp;'}</b></div>`;
  const km = (n) => (n != null ? `${Number(n).toLocaleString('en-AU')} km` : '');
  const day = (d) => (d ? new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
  const contact = [s.business_address, s.business_phone ? `Ph ${s.business_phone}` : '', s.business_email, s.business_abn ? `ABN ${s.business_abn}` : ''].filter(Boolean);
  const done = ops.filter((t) => t.done).length;
  const docs = (jd ?? []).map((d) => d.doc?.title).filter(Boolean);

  const main = shell(`Repair order ${job.job_number}`, '', { back: `#/job/${id}` });
  main.innerHTML = `
    <div class="print-tools">
      <button onclick="window.print()">🖨 Print / save PDF</button>
      <label class="pt-opt"><input type="checkbox" id="optTicks" checked> Show completed ticks</label>
      <label class="pt-opt"><input type="checkbox" id="optPhotos" ${photos.length ? '' : 'disabled'}> Include photos (${photos.length})</label>
      <a href="#/job/${id}"><button class="ghost" type="button">Back to job</button></a>
    </div>
    <div class="ro-wrap"><article class="ro" id="ro">
      <header class="ro-head">
        <div class="ro-biz">
          ${logoUrl ? `<img class="ro-logo" src="${esc(logoUrl)}" alt="">` : ''}
          <div>
            <div class="ro-bizname">${esc(s.business_name || '')}</div>
            ${contact.map((c) => `<div class="ro-contact">${esc(c)}</div>`).join('')}
          </div>
        </div>
        <div class="ro-id">
          <div class="ro-title">REPAIR ORDER</div>
          <div class="ro-num">${esc(job.job_number)}</div>
          ${code39Svg(job.job_number)}
        </div>
      </header>

      <section class="ro-cols">
        <div class="ro-box">
          <div class="ro-label">Customer</div>
          ${kv('Name', job.customer_name, 'wide')}
          ${kv('Phone', job.customer_phone)}
          ${kv('Email', job.customer_email)}
        </div>
        <div class="ro-box">
          <div class="ro-label">Vehicle</div>
          <div class="kv-row">${kv('Rego', v.rego, 'big')}${kv('Year', v.year)}</div>
          ${kv('Make / model', [v.make, v.model].filter(Boolean).join(' '), 'wide')}
          ${kv('VIN', v.vin, 'mono wide')}
          <div class="kv-row">${kv('Engine', v.engine)}${kv('Colour', v.colour)}</div>
        </div>
      </section>

      <table class="ro-strip">
        <tr><th>Date in</th><th>Odometer</th><th>Technician</th><th>Status</th><th>Printed</th></tr>
        <tr><td>${esc(day(job.booked_date || job.invoice_date || job.created_at))}</td><td>${esc(km(job.odometer_in))}</td>
          <td>${esc(nameOf(job.assigned_to))}</td><td>${STATUS[job.status]}</td><td>${esc(day(new Date()))}</td></tr>
      </table>

      <table class="ro-ops">
        <thead><tr><th class="c-no">Op</th><th>Work to be performed</th><th class="c-qty">Qty</th><th class="c-chk">Done</th><th class="c-tech">Tech / completed</th></tr></thead>
        <tbody>
          ${ops.map((t, i) => `<tr class="${t.done ? 'is-done' : ''}">
            <td class="c-no">${String(i + 1).padStart(2, '0')}</td>
            <td><div class="op-desc">${esc(t.description)}</div>${t.source === 'rule' ? '<div class="op-tag">Required check</div>' : ''}${t.note ? `<div class="op-note">${esc(t.note)}</div>` : ''}</td>
            <td class="c-qty">${t.quantity != null ? esc(Number(t.quantity)) : ''}</td>
            <td class="c-chk"><span class="box">${t.done ? '✓' : ''}</span></td>
            <td class="c-tech"><span class="tick-info">${t.done ? `${esc(nameOf(t.done_by))}<br>${esc(fmtTime(t.done_at))}` : ''}</span></td>
          </tr>`).join('')}
          ${Array.from({ length: Math.max(0, 3 - ops.length) }, () => '<tr class="blank"><td class="c-no"></td><td></td><td></td><td class="c-chk"><span class="box"></span></td><td></td></tr>').join('')}
        </tbody>
      </table>
      <div class="ro-summary"><span class="tick-info">${done} of ${ops.length} operations completed</span></div>

      <section class="ro-box ro-notes-box">
        <div class="ro-label">Technician findings / notes</div>
        <div class="ro-notes ${job.tech_notes ? '' : 'empty'}">${esc(job.tech_notes ?? '')}</div>
      </section>

      ${docs.length || photos.length ? `<section class="ro-refs">
        ${docs.length ? `<div><b>Reference documents:</b> ${docs.map(esc).join(' · ')}</div>` : ''}
        ${photos.length ? `<div><b>Photos on file:</b> ${photos.length}</div>` : ''}
      </section>` : ''}

      <section class="ro-sigs">
        <div class="sig sig-cust">
          <div class="ro-label">Customer authorisation</div>
          <p>${esc(s.print_terms || DEFAULT_TERMS)}</p>
          <div class="sig-line"><span>Signature</span><span>Date</span></div>
        </div>
        <div class="sig"><div class="ro-label">Technician</div><div class="sig-space"></div><div class="sig-line"><span>Signature</span><span>Date</span></div></div>
        <div class="sig"><div class="ro-label">Quality check / road test</div><div class="sig-space"></div><div class="sig-line"><span>Signature</span><span>Date</span></div></div>
      </section>
      <footer class="ro-foot">${esc(s.business_name || '')} · Repair order ${esc(job.job_number)} · This document does not show pricing. Refer to your tax invoice.</footer>

      <section class="ro-photos" id="roPhotos" hidden>
        <div class="ro-head ro-head-sm"><div class="ro-bizname">${esc(s.business_name || '')}</div><div class="ro-num">${esc(job.job_number)} · Photos</div></div>
        <div class="ro-photo-grid">${photos.map((p) => `<figure><img src="${esc(photoUrl(p) ?? '')}" alt=""><figcaption>${esc(p.caption || '')} ${esc(fmtTime(p.created_at))}</figcaption></figure>`).join('')}</div>
      </section>
    </article></div>`;

  q('#optTicks').onchange = (e) => q('#ro').classList.toggle('no-ticks', !e.target.checked);
  q('#optPhotos').onchange = (e) => { q('#roPhotos').hidden = !e.target.checked; };
}

// ------------------------------------------------------------ settings
async function viewSettings(params) {
  const main = shell('Settings', '<p class="muted">Loading…</p>', { back: '#/' });
  if (params.get('xero') === 'connected') toast('Xero connected', 'ok');
  else if (params.get('xero')) toast(`Xero connection: ${params.get('xero')}`, 'error', 5000);

  const signOut = `<section class="card"><h2>${esc(me.display_name)}</h2>
    <p class="muted small">${me.is_admin ? 'Admin' : 'Technician'}</p>
    <div class="actions"><a href="#/password"><button class="ghost" type="button">Change my password</button></a><button class="ghost" id="signout">Sign out</button></div></section>`;

  if (!me.is_admin) {
    main.innerHTML = signOut;
    q('#signout').onclick = () => sb.auth.signOut();
    return;
  }

  main.innerHTML = `
    <section class="card"><h2>Xero</h2><div id="xero"><p class="muted">Checking…</p></div></section>
    <section class="card"><h2>General</h2>
      <div class="grid2">
        <label class="span2">Business name (shown on job cards)<input id="bizName" value="${esc(settings.business_name)}"></label>
        <label class="span2">Address<input data-set="business_address" value="${esc(settings.business_address ?? '')}" placeholder="Street, suburb QLD postcode"></label>
        <label>Phone<input data-set="business_phone" value="${esc(settings.business_phone ?? '')}" inputmode="tel"></label>
        <label>ABN<input data-set="business_abn" value="${esc(settings.business_abn ?? '')}" inputmode="numeric"></label>
        <label class="span2">Email<input data-set="business_email" value="${esc(settings.business_email ?? '')}" type="email"></label>
        <div class="span2">
          <label>Logo for the printed repair order</label>
          <div class="row" style="margin-top:4px"><div id="logoPrev" class="logo-prev muted small">No logo yet</div>
            <label class="ghost-btn shrink">Upload logo<input type="file" id="logoIn" accept="image/*" hidden></label></div>
        </div>
        <label class="span2">Customer authorisation text (printed above the customer signature)
          <textarea data-set="print_terms" placeholder="${esc(DEFAULT_TERMS)}">${esc(settings.print_terms ?? '')}</textarea></label>
        <label class="span2" style="display:flex;gap:10px;align-items:center;color:var(--text)">
          <input type="checkbox" id="regoRef" style="width:24px;min-height:0" ${settings.rego_to_xero_reference ? 'checked' : ''}>
          Write the rego into the Xero invoice Reference (e.g. "REGO: 123ABC")</label>
      </div>
    </section>
    <section class="card"><h2>Tech document library (PDFs)</h2><div id="lib"></div></section>
    <section class="card"><h2>Automation rules</h2>
      <p class="small muted">When a job's vehicle matches <b>and</b> its work matches, the document is attached and the check items are added.
      Matching is "contains", not case sensitive. Commas mean OR, <b>&</b> means AND. Leave one side blank to match anything.</p>
      <div id="rules"></div>
    </section>
    <section class="card"><h2>Staff logins</h2><div id="staff"></div>
      <form id="staffForm" class="grid2" style="margin-top:14px">
        <label class="span2">Generic starting password <span class="muted">(filled in for every new login; they must change it at first sign-in)</span>
          <input id="genericPw" class="mono" autocomplete="off" placeholder="e.g. HFDwelcome2026"></label>
        <h3 class="span2" style="margin:6px 0 0">Add a staff member</h3>
        <label>Name<input name="display_name" required placeholder="e.g. Jake"></label>
        <label>Email (their login)<input name="email" type="email" required autocomplete="off"></label>
        <p class="span2" id="pwNote" style="margin:0"></p>
        <label class="span2" id="pwRow">Password for this person<div class="row"><input name="password" minlength="8" autocomplete="new-password" class="mono"><button type="button" class="ghost" id="genPw">Generate</button></div></label>
        <label class="span2 check-row" style="margin-top:0"><input type="checkbox" name="is_admin"> Admin (can change settings, rules, delete jobs and any photo)</label>
        <p class="span2 small muted" style="margin:0">They'll get an email with the web address and this password, and must choose their own password the first time they sign in.</p>
        <button class="span2">Create login</button>
        <div class="span2" id="newLogin"></div>
      </form>
    </section>
    ${signOut}`;
  q('#signout').onclick = () => sb.auth.signOut();

  // ---- xero
  async function renderXero() {
    try {
      const s = await fn('xero', '/status');
      q('#xero').innerHTML = s.connected
        ? `<p>✓ Connected to <b>${esc(s.tenant_name)}</b></p><div class="actions"><button class="ghost" id="xReconnect">Reconnect</button><button class="danger" id="xDisconnect">Disconnect</button></div>`
        : `<p class="muted">Not connected.</p><button id="xConnect">Connect to Xero</button>`;
    } catch (e) {
      q('#xero').innerHTML = `<p class="muted">Xero function not reachable: ${esc(e.message)}. Is the <b>xero</b> function deployed?</p>`;
      return;
    }
    const go = async () => { try { location.href = (await fn('xero', '/connect', { method: 'POST' })).url; } catch (e) { fail(e); } };
    if (q('#xConnect')) q('#xConnect').onclick = go;
    if (q('#xReconnect')) q('#xReconnect').onclick = go;
    if (q('#xDisconnect')) q('#xDisconnect').onclick = async () => {
      if (!confirm('Disconnect Xero? Job cards stay; you just can\'t pull invoices until reconnected.')) return;
      await fn('xero', '/disconnect', { method: 'POST' }).catch(fail); renderXero();
    };
  }
  renderXero();

  // ---- general
  const saveSettings = async (patch) => {
    const { error } = await sb.from('app_settings').update(patch).eq('id', 1);
    if (error) return fail(error);
    Object.assign(settings, patch); toast('Saved', 'ok', 1200);
  };
  q('#bizName').onchange = (e) => saveSettings({ business_name: e.target.value.trim() || 'Job Cards' });
  q('#regoRef').onchange = (e) => saveSettings({ rego_to_xero_reference: e.target.checked });
  main.querySelectorAll('[data-set]').forEach((el) => {
    el.onchange = () => saveSettings({ [el.dataset.set]: el.value.trim() || null });
  });
  async function showLogo() {
    if (!settings.logo_path) return;
    const { data } = await sb.storage.from('tech-docs').createSignedUrl(settings.logo_path, 3600);
    if (data?.signedUrl) q('#logoPrev').innerHTML = `<img src="${esc(data.signedUrl)}" alt="logo">`;
  }
  showLogo();
  q('#logoIn').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `branding/logo-${Date.now()}.${ext}`;
    const up = await sb.storage.from('tech-docs').upload(path, file, { contentType: file.type || 'image/png' });
    if (up.error) return fail(up.error);
    const old = settings.logo_path;
    await saveSettings({ logo_path: path });
    if (old) sb.storage.from('tech-docs').remove([old]);
    showLogo();
  };

  // ---- library
  let library = [];
  async function renderLib() {
    library = (await sb.from('tech_docs').select('*').order('title')).data ?? [];
    q('#lib').innerHTML = `
      <table class="tbl">${library.map((d) => `<tr><td><b>${esc(d.title)}</b>${d.description ? `<div class="small muted">${esc(d.description)}</div>` : ''}</td>
        <td style="text-align:right;white-space:nowrap"><button class="ghost" data-open="${d.id}">Open</button> <button class="danger" data-del="${d.id}">Delete</button></td></tr>`).join('') || '<tr><td class="muted">No documents yet.</td></tr>'}</table>
      <form id="docForm" class="grid2" style="margin-top:12px">
        <label class="span2">Title<input name="title" placeholder="e.g. 79 Series clutch & flywheel torque specs" required></label>
        <label class="span2">Description (optional)<input name="description"></label>
        <label class="span2">PDF<input name="file" type="file" accept="application/pdf,image/*" required></label>
        <button class="span2">Upload document</button>
      </form>`;
    q('#docForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target; const file = f.file.files[0]; if (!file) return;
      const ext = (file.name.split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${crypto.randomUUID()}.${ext}`;
      const up = await sb.storage.from('tech-docs').upload(path, file, { contentType: file.type || 'application/pdf' });
      if (up.error) return fail(up.error);
      const { error } = await sb.from('tech_docs').insert({ title: f.title.value.trim(), description: f.description.value.trim() || null, storage_path: path, uploaded_by: me.id });
      if (error) return fail(error);
      toast('Document uploaded', 'ok'); renderLib(); renderRules();
    };
    q('#lib').querySelectorAll('[data-open]').forEach((b) => b.onclick = async () => {
      const d = library.find((x) => x.id === b.dataset.open);
      const w = window.open('', '_blank');
      const { data, error } = await sb.storage.from('tech-docs').createSignedUrl(d.storage_path, 3600);
      if (error) { w?.close(); return fail(error); }
      if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
    });
    q('#lib').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      const d = library.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete "${d.title}"? It will be removed from all jobs and rules.`)) return;
      await sb.storage.from('tech-docs').remove([d.storage_path]);
      const { error } = await sb.from('tech_docs').delete().eq('id', d.id);
      if (error) return fail(error);
      renderLib(); renderRules();
    });
  }

  // ---- rules
  async function renderRules(editing = null) {
    const rules = (await sb.from('doc_rules').select('*').order('created_at')).data ?? [];
    const docTitle = (did) => library.find((d) => d.id === did)?.title ?? '';
    const r = editing ?? {};
    q('#rules').innerHTML = `
      <table class="tbl">${rules.map((x) => `<tr style="${x.active ? '' : 'opacity:.5'}">
        <td><b>${esc(x.name)}</b><div class="small muted">Vehicle: ${esc(x.vehicle_match || 'any')} · Work: ${esc(x.job_match || 'any')}</div>
          <div class="small">${x.doc_id ? `📄 ${esc(docTitle(x.doc_id))}` : ''}${(x.extra_tasks ?? []).length ? ` ☑ ${x.extra_tasks.length} check item(s)` : ''}</div></td>
        <td style="text-align:right;white-space:nowrap"><button class="ghost" data-edit="${x.id}">Edit</button> <button class="danger" data-del="${x.id}">✕</button></td></tr>`).join('') || '<tr><td class="muted">No rules yet.</td></tr>'}</table>
      <form id="ruleForm" class="grid2" style="margin-top:12px">
        <h3 class="span2">${r.id ? 'Edit rule' : 'New rule'}</h3>
        <label class="span2">Rule name<input name="name" value="${esc(r.name ?? '')}" placeholder="79 Series clutch" required></label>
        <label>Vehicle contains<input name="vehicle_match" value="${esc(r.vehicle_match ?? '')}" placeholder="79 series, lc79, vdj79, landcruiser&79"></label>
        <label>Work contains<input name="job_match" value="${esc(r.job_match ?? '')}" placeholder="clutch"></label>
        <label class="span2">Attach document<select name="doc_id"><option value="">None</option>${library.map((d) => `<option value="${d.id}" ${r.doc_id === d.id ? 'selected' : ''}>${esc(d.title)}</option>`).join('')}</select></label>
        <label class="span2">Add these check items (one per line)<textarea name="extra_tasks" placeholder="Torque flywheel bolts to spec&#10;Torque pressure plate bolts to spec&#10;Bleed clutch hydraulics">${esc((r.extra_tasks ?? []).join('\n'))}</textarea></label>
        <label class="span2" style="display:flex;gap:10px;align-items:center;color:var(--text)"><input type="checkbox" name="active" style="width:24px;min-height:0" ${r.active === false ? '' : 'checked'}> Active</label>
        <button>${r.id ? 'Save rule' : 'Add rule'}</button>
        ${r.id ? '<button type="button" class="ghost" id="cancelEdit">Cancel</button>' : '<span></span>'}
        <button type="button" class="ghost span2" id="applyAll">Apply rules to all open jobs now</button>
      </form>`;
    const f = q('#ruleForm');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const row = {
        name: f.name.value.trim(),
        vehicle_match: f.vehicle_match.value.trim() || null,
        job_match: f.job_match.value.trim() || null,
        doc_id: f.doc_id.value || null,
        extra_tasks: f.extra_tasks.value.split('\n').map((s) => s.trim()).filter(Boolean),
        active: f.active.checked,
      };
      if (!row.vehicle_match && !row.job_match) return toast('Give the rule a vehicle or work condition', 'error');
      if (!row.doc_id && !row.extra_tasks.length) return toast('Pick a document or add check items', 'error');
      if (!row.extra_tasks.length) row.extra_tasks = null;
      const { error } = r.id ? await sb.from('doc_rules').update(row).eq('id', r.id) : await sb.from('doc_rules').insert(row);
      if (error) return fail(error);
      toast('Rule saved', 'ok'); renderRules();
    };
    if (q('#cancelEdit')) q('#cancelEdit').onclick = () => renderRules();
    q('#applyAll').onclick = async (e) => {
      e.target.disabled = true;
      const { data: open } = await sb.from('jobs').select('id').neq('status', 'complete');
      let n = 0;
      for (const j of open ?? []) { const { data } = await sb.rpc('apply_doc_rules', { p_job: j.id }); n += data || 0; }
      e.target.disabled = false;
      toast(`Checked ${open?.length ?? 0} open jobs, ${n} doc/check item(s) added`, 'ok', 5000);
    };
    q('#rules').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => renderRules(rules.find((x) => x.id === b.dataset.edit)));
    q('#rules').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this rule? Docs already attached to jobs stay.')) return;
      const { error } = await sb.from('doc_rules').delete().eq('id', b.dataset.del);
      if (error) return fail(error);
      renderRules();
    });
  }

  // ---- staff
  const genPassword = () => {
    const words = ['diesel', 'turbo', 'boost', 'torque', 'piston', 'clutch', 'gasket', 'nozzle', 'intake', 'spanner'];
    const a = new Uint32Array(3); crypto.getRandomValues(a);
    return `${words[a[0] % words.length]}-${words[a[1] % words.length]}-${1000 + (a[2] % 9000)}`;
  };
  async function renderStaff() {
    profiles = (await sb.from('profiles').select('*').order('display_name')).data ?? [];
    let emails = {};
    try { (await fn('staff', '/list')).users.forEach((x) => { emails[x.id] = x; }); } catch (e) { console.warn(e); }
    q('#staff').innerHTML = `<table class="tbl">${profiles.map((p) => `<tr>
      <td style="min-width:140px"><input data-name="${p.id}" value="${esc(p.display_name ?? '')}">
        <div class="small muted" style="margin-top:4px">${esc(emails[p.id]?.email ?? '')}${emails[p.id] ? ` · ${emails[p.id].last_sign_in_at ? `last in ${fmtTime(emails[p.id].last_sign_in_at)}` : 'never signed in'}` : ''}</div></td>
      <td style="white-space:nowrap">
        <label style="display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:6px"><input type="checkbox" data-admin="${p.id}" style="width:22px;min-height:0" ${p.is_admin ? 'checked' : ''} ${p.id === me.id ? 'disabled' : ''}> Admin</label>
        <button type="button" class="ghost" data-pw="${p.id}" style="min-height:36px">Reset password</button>
        ${p.id === me.id ? '' : `<button type="button" class="danger" data-rm="${p.id}" style="min-height:36px">Remove</button>`}
      </td></tr>`).join('')}</table>`;
    q('#staff').querySelectorAll('[data-name]').forEach((i) => i.onchange = async () => {
      const { error } = await sb.from('profiles').update({ display_name: i.value.trim() }).eq('id', i.dataset.name);
      if (error) return fail(error); flashSaved(i);
    });
    q('#staff').querySelectorAll('[data-admin]').forEach((i) => i.onchange = async () => {
      const { error } = await sb.from('profiles').update({ is_admin: i.checked }).eq('id', i.dataset.admin);
      if (error) return fail(error); toast('Saved', 'ok', 1200);
    });
    q('#staff').querySelectorAll('[data-pw]').forEach((b) => b.onclick = async () => {
      const p = profiles.find((x) => x.id === b.dataset.pw);
      const pw = prompt(`Temporary password for ${p.display_name} (8+ characters). They'll have to change it when they next sign in.`, genericPw || genPassword());
      if (!pw) return;
      try {
        const r = await fn('staff', '/password', { method: 'POST', body: { user_id: p.id, password: pw } });
        const info = { to: r.email || emails[p.id]?.email || '', name: p.display_name, password: pw, kind: 'reset' };
        const el = q('#newLogin'); el.innerHTML = loginResultCard(r, info); wireLoginResult(el, info);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) { fail(e); }
    });
    q('#staff').querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
      const p = profiles.find((x) => x.id === b.dataset.rm);
      if (!confirm(`Remove ${p.display_name}'s login? Their ticks and photos stay on the jobs.`)) return;
      try { await fn('staff', '/remove', { method: 'POST', body: { user_id: p.id } }); toast('Login removed', 'ok'); renderStaff(); }
      catch (e) { fail(e); }
    });
  }
  const sf = q('#staffForm');
  let genericPw = (await sb.from('admin_settings').select('default_staff_password').eq('id', 1).maybeSingle()).data?.default_staff_password || '';
  let useGeneric = true;     // false once the admin chooses a one-off password for this person
  const syncPw = () => {
    const generic = useGeneric && genericPw.length >= 8;
    q('#pwRow').hidden = generic;
    q('#pwNote').innerHTML = generic
      ? `Starting password: <b class="mono">${esc(genericPw)}</b> · <a href="#" id="pwCustom">use a different one for this person</a>`
      : (genericPw.length >= 8 ? '<a href="#" id="pwGeneric">use the generic password instead</a>' : '');
    if (q('#pwCustom')) q('#pwCustom').onclick = (e) => { e.preventDefault(); useGeneric = false; sf.password.value = ''; syncPw(); sf.password.focus(); };
    if (q('#pwGeneric')) q('#pwGeneric').onclick = (e) => { e.preventDefault(); useGeneric = true; syncPw(); };
  };
  q('#genericPw').value = genericPw;
  syncPw();
  q('#genericPw').oninput = (e) => { genericPw = e.target.value.trim(); syncPw(); };   // takes effect instantly
  q('#genericPw').onchange = async (e) => {
    const v = e.target.value.trim();
    if (v && v.length < 8) return toast('Make the generic password at least 8 characters', 'error');
    const { error } = await sb.from('admin_settings').update({ default_staff_password: v || null, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) return fail(error);
    flashSaved(e.target);
  };
  q('#genPw').onclick = () => { sf.password.value = genPassword(); };
  sf.onsubmit = async (e) => {
    e.preventDefault();
    const password = useGeneric && genericPw.length >= 8 ? genericPw : sf.password.value;
    if (password.length < 8) { toast(genericPw ? 'Enter a password for this person (8+ characters)' : 'Set a generic starting password above, or enter one for this person (8+ characters)', 'error'); (q('#pwRow').hidden ? q('#genericPw') : sf.password).focus(); return; }
    const body = { display_name: sf.display_name.value.trim(), email: sf.email.value.trim(), password, is_admin: sf.is_admin.checked };
    const btn = sf.querySelector('button:not([type])'); btn.disabled = true;
    try {
      const r = await fn('staff', '/create', { method: 'POST', body });
      const info = { to: body.email, name: body.display_name, password: body.password, kind: 'new' };
      const el = q('#newLogin'); el.innerHTML = loginResultCard(r, info); wireLoginResult(el, info);
      sf.display_name.value = ''; sf.email.value = ''; sf.is_admin.checked = false;
      sf.password.value = ''; useGeneric = true; syncPw();
      await renderStaff();
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  };

  await renderLib();
  await renderRules();
  await renderStaff();
}

// ------------------------------------------------------------ auto-update
// Phones keep old copies of the app; check for a newer version and reload when one is live.
const MY_VERSION = document.querySelector('meta[name=app-version]')?.content;
async function checkForUpdate() {
  try {
    const html = await (await fetch(`index.html?check=${Date.now()}`, { cache: 'no-store' })).text();
    const live = /name="app-version" content="([^"]+)"/.exec(html)?.[1];
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (live && MY_VERSION && live !== MY_VERSION && !typing && !document.querySelector('.modal, .lightbox')) location.reload();
  } catch { /* offline: try later */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
setInterval(checkForUpdate, 5 * 60 * 1000);

// ------------------------------------------------------------ go
route();
checkForUpdate();
