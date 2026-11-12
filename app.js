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
const fail = (e) => { console.error(e); toast(e?.message ?? String(e), 'error', 5000); };

// call an edge function
async function fn(name, path = '', { method = 'GET', body, query } = {}) {
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
      <nav><a href="#/">Jobs</a><a href="#/settings" aria-label="Settings">⚙</a></nav>
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
  try {
    if (parts[0] === 'job' && parts[1]) return await viewJob(parts[1]);
    if (parts[0] === 'print' && parts[1]) return await viewPrint(parts[1]);
    if (parts[0] === 'settings') return await viewSettings(new URLSearchParams(qs || ''));
    return await viewHome();
  } catch (e) { fail(e); }
}
window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { me = null; route(); } });

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
      .select('id, job_number, customer_name, status, change_acknowledged, updated_at, assigned_to, vehicle:vehicles(rego, make, model), job_tasks(done, removed_from_invoice)')
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
        <div><div class="num">${esc(j.job_number)}</div><div class="sub">${esc(j.customer_name)}</div><div class="sub">${esc(veh)}</div></div>
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
        <label>Odometer in (km)<input id="odoIn" type="number" inputmode="numeric" value="${job.odometer_in ?? ''}"></label>
        <label>Odometer out (km)<input id="odoOut" type="number" inputmode="numeric" value="${job.odometer_out ?? ''}"></label>
      </div>`;
    const save = async (patch) => {
      const { error } = await sb.from('jobs').update(patch).eq('id', id);
      if (error) return fail(error);
      Object.assign(job, patch);
      toast('Saved', 'ok', 1200);
    };
    q('#status').onchange = (e) => save({ status: e.target.value }).then(renderHead);
    q('#assigned').onchange = (e) => save({ assigned_to: e.target.value || null });
    const odo = (v) => (v === '' ? null : Math.max(0, parseInt(v, 10) || 0));
    q('#odoIn').onchange = (e) => save({ odometer_in: odo(e.target.value) });
    q('#odoOut').onchange = (e) => save({ odometer_out: odo(e.target.value) });
  }

  // ---------------- vehicle
  function renderVehicle() {
    const v = job.vehicle || {};
    const others = custVehicles.filter((x) => x.id !== v.id);
    q('#vehicle').innerHTML = `
      <div class="row">
        <label>Rego (QLD)<input id="vRego" class="big mono" value="${esc(v.rego ?? '')}" autocapitalize="characters" autocomplete="off" enterkeyhint="go"></label>
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
    q('#vVin').onchange = (e) => saveVehicle({ vin: normRego(e.target.value) || null });
    q('#vehicle').querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        const f = inp.dataset.f;
        saveVehicle({ [f]: f === 'year' ? (parseInt(inp.value, 10) || null) : (inp.value.trim() || null) });
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

  async function saveVehicle(patch) {
    if (!job.vehicle) {
      // no vehicle yet → create one without a rego
      const ins = await sb.from('vehicles').insert({ ...patch, xero_contact_id: job.xero_contact_id, lookup_source: 'manual' }).select('*').single();
      if (ins.error) return fail(ins.error);
      const { error } = await sb.from('jobs').update({ vehicle_id: ins.data.id }).eq('id', id);
      if (error) return fail(error);
    } else {
      const { error } = await sb.from('vehicles').update(patch).eq('id', job.vehicle.id);
      if (error) return fail(error);
    }
    toast('Vehicle saved', 'ok', 1200);
    await afterVehicleChange(false);
  }

  async function afterVehicleChange(regoChanged) {
    await loadJob();
    renderVehicle();
    const { data: n } = await sb.rpc('apply_doc_rules', { p_job: id });
    if (n > 0) { await Promise.all([loadDocs(), loadTasks()]); renderDocs(); renderTasks(); toast('Tech docs / checks added for this job', 'ok'); }
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
        <a class="doc" href="${esc(d.url ?? '#')}" target="_blank" rel="noopener">
          <span class="ico">📄</span><span class="t">${esc(d.title)}<div class="s">${d.rule_id ? 'Added automatically' : 'Added manually'}${d.description ? ` · ${esc(d.description)}` : ''}</div></span><span>›</span>
        </a>`).join('') : '<p class="muted small">No documents for this job yet. Rules add them automatically once the vehicle is set.</p>'}</div>
      ${avail.length ? `<div class="row" style="margin-top:8px"><select id="docAdd"><option value="">Attach a document…</option>${avail.map((d) => `<option value="${d.id}">${esc(d.title)}</option>`).join('')}</select></div>` : ''}`;
    const s = q('#docAdd');
    if (s) s.onchange = async () => {
      if (!s.value) return;
      const { error } = await sb.from('job_docs').insert({ job_id: id, doc_id: s.value, added_by: me.id });
      if (error) return fail(error);
      await loadDocs(); renderDocs();
    };
  }

  // ---------------- photos
  function renderPhotos() {
    q('#photos').innerHTML = `<div class="photos">
      ${photos.map((p, i) => `<img src="${esc(p.url ?? '')}" data-i="${i}" alt="${esc(p.caption ?? 'photo')}" loading="lazy">`).join('')}
      <label class="add-photo">📷<br>Add photos<input type="file" id="photoIn" accept="image/*" multiple></label>
    </div>`;
    q('#photoIn').onchange = (e) => uploadPhotos([...e.target.files]);
    q('#photos').querySelectorAll('img').forEach((img) => { img.onclick = () => lightbox(photos[img.dataset.i]); });
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
      <span class="actions"><button class="ghost" data-a="cap">Caption</button><button class="danger" data-a="del">Delete</button><button data-a="x">Close</button></span></div>`;
    document.body.appendChild(box);
    box.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'x' || e.target === box) box.remove();
      if (a === 'cap') {
        const c = prompt('Caption', p.caption ?? ''); if (c === null) return;
        await sb.from('job_photos').update({ caption: c.trim() || null }).eq('id', p.id);
        p.caption = c.trim(); toast('Saved', 'ok', 1200);
      }
      if (a === 'del' && confirm('Delete this photo?')) {
        await sb.storage.from('job-photos').remove([p.storage_path]);
        const { error } = await sb.from('job_photos').delete().eq('id', p.id);
        if (error) return fail(error);
        box.remove(); await loadPhotos(); renderPhotos();
      }
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

  // ---------------- live updates from other tablets
  const ch = sb.channel(`job-${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'job_tasks', filter: `job_id=eq.${id}` },
      debounce(async () => { await loadTasks(); renderTasks(); }, 400))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'job_photos', filter: `job_id=eq.${id}` },
      debounce(async () => { await loadPhotos(); renderPhotos(); }, 600))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${id}` },
      debounce(async () => {
        const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
        await loadJob();
        renderBanner();
        if (!typing) { renderHead(); renderVehicle(); if (notes.value !== (job.tech_notes ?? '')) notes.value = job.tech_notes ?? ''; }
      }, 600))
    .subscribe();
  cleanup.push(() => sb.removeChannel(ch));
}

// ------------------------------------------------------------ print view (no prices)
async function viewPrint(id) {
  const [{ data: job, error }, { data: tasks }, { data: jd }, { count: photoCount }] = await Promise.all([
    sb.from('jobs').select('*, vehicle:vehicles(*)').eq('id', id).single(),
    sb.from('job_tasks').select('*').eq('job_id', id).eq('removed_from_invoice', false).order('sort').order('created_at'),
    sb.from('job_docs').select('doc:tech_docs(title)').eq('job_id', id),
    sb.from('job_photos').select('id', { count: 'exact', head: true }).eq('job_id', id),
  ]);
  if (error) throw error;
  const v = job.vehicle || {};
  const main = shell(`Print ${job.job_number}`, '', { back: `#/job/${id}` });
  main.innerHTML = `
    <div class="print-tools"><button onclick="window.print()">🖨 Print</button><a href="#/job/${id}"><button class="ghost">Back to job</button></a></div>
    <div class="print-page">
      <div class="ph">
        <div><h1>${esc(settings?.business_name ?? '')}</h1><div>JOB CARD</div></div>
        <div><div class="jn">${esc(job.job_number)}</div><div style="text-align:right">${fmtDate(job.invoice_date || job.created_at)}</div></div>
      </div>
      <table>
        <tr><th>Customer</th><td>${esc(job.customer_name)}</td><th>Phone</th><td>${esc(job.customer_phone ?? '')}</td></tr>
        <tr><th>Rego</th><td><b>${esc(v.rego ?? '')}</b></td><th>VIN</th><td class="mono">${esc(v.vin ?? '')}</td></tr>
        <tr><th>Vehicle</th><td>${esc([v.year, v.make, v.model].filter(Boolean).join(' '))}</td><th>Engine</th><td>${esc(v.engine ?? '')}</td></tr>
        <tr><th>Odo in</th><td>${job.odometer_in != null ? `${job.odometer_in.toLocaleString('en-AU')} km` : ''}</td><th>Odo out</th><td>${job.odometer_out != null ? `${job.odometer_out.toLocaleString('en-AU')} km` : ''}</td></tr>
        <tr><th>Tech</th><td>${esc(nameOf(job.assigned_to))}</td><th>Status</th><td>${STATUS[job.status]}</td></tr>
      </table>
      <h3>Work to be done</h3>
      <table>${(tasks ?? []).map((t) => `<tr><td style="width:70%"><span class="box">${t.done ? '✓' : ''}</span>${esc(t.description)}${t.quantity != null && Number(t.quantity) !== 1 ? ` ×${esc(Number(t.quantity))}` : ''}${t.note ? `<div style="margin:4px 0 0 26px;color:#444">${esc(t.note)}</div>` : ''}</td><td>${t.done ? `${esc(nameOf(t.done_by))} ${fmtTime(t.done_at)}` : ''}</td></tr>`).join('')}</table>
      ${(jd ?? []).length ? `<p><b>Reference docs:</b> ${(jd ?? []).map((d) => esc(d.doc?.title)).join(', ')}</p>` : ''}
      <h3>Tech notes</h3>
      <div class="lines">${esc(job.tech_notes ?? '')}</div>
      ${photoCount ? `<p class="small">${photoCount} photo(s) on file in the job card app.</p>` : ''}
      <div class="sig"><div>Technician</div><div>Date</div></div>
    </div>`;
}

// ------------------------------------------------------------ settings
async function viewSettings(params) {
  const main = shell('Settings', '<p class="muted">Loading…</p>', { back: '#/' });
  if (params.get('xero') === 'connected') toast('Xero connected', 'ok');
  else if (params.get('xero')) toast(`Xero connection: ${params.get('xero')}`, 'error', 5000);

  const signOut = `<section class="card"><h2>${esc(me.display_name)}</h2>
    <p class="muted small">${me.is_admin ? 'Admin' : 'Technician'}</p><button class="ghost" id="signout">Sign out</button></section>`;

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
    <section class="card"><h2>Staff</h2><div id="staff"></div>
      <p class="small muted">To add a tech: Supabase dashboard → Authentication → Users → <b>Invite user</b>. They show up here after accepting.</p>
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
  async function renderStaff() {
    profiles = (await sb.from('profiles').select('*').order('display_name')).data ?? [];
    q('#staff').innerHTML = `<table class="tbl">${profiles.map((p) => `<tr>
      <td><input data-name="${p.id}" value="${esc(p.display_name ?? '')}"></td>
      <td style="white-space:nowrap"><label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" data-admin="${p.id}" style="width:22px;min-height:0" ${p.is_admin ? 'checked' : ''} ${p.id === me.id ? 'disabled' : ''}> Admin</label></td></tr>`).join('')}</table>`;
    q('#staff').querySelectorAll('[data-name]').forEach((i) => i.onchange = async () => {
      const { error } = await sb.from('profiles').update({ display_name: i.value.trim() }).eq('id', i.dataset.name);
      if (error) return fail(error); toast('Saved', 'ok', 1200);
    });
    q('#staff').querySelectorAll('[data-admin]').forEach((i) => i.onchange = async () => {
      const { error } = await sb.from('profiles').update({ is_admin: i.checked }).eq('id', i.dataset.admin);
      if (error) return fail(error); toast('Saved', 'ok', 1200);
    });
  }

  await renderLib();
  await renderRules();
  await renderStaff();
}

// ------------------------------------------------------------ go
route();
