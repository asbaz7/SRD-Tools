// ============================================================================
// Toolroom — app.js
// Vanilla JS single-page app talking directly to Supabase (Postgres + Auth).
// No build step required — open index.html or deploy the folder as-is.
// ============================================================================

// ---------------------------------------------------------------------------
// PROJECT CONNECTION
// These two values are safe to publish. The key only grants what the Row Level
// Security rules in schema.sql allow — it is not a password. Never replace it
// with a "secret" or "service_role" key.
// ---------------------------------------------------------------------------
const SUPABASE_URL = 'https://uesbnjymwfuhfximhdam.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlc2Juanltd2Z1aGZ4aW1oZGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2Mzc1NDMsImV4cCI6MjEwMTIxMzU0M30.Uzb53q7cZYj_wu0_261XcUijcj3AsyB5L2WHN8t_TR8';

// Clear settings saved by earlier versions of this app, which could otherwise
// override the values above.
try {
  localStorage.removeItem('toolroom_url');
  localStorage.removeItem('toolroom_key');
} catch (e) { /* storage unavailable — fine, nothing to clear */ }

// Guard against a URL pasted with a path on the end (e.g. .../rest/v1/).
// The client library appends its own paths and fails if one is already there.
const CLEAN_URL = SUPABASE_URL.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/auth\/v1$/, '');

const STATUS_LABEL = {
  available: 'Available',
  checked_out: 'Checked out',
  in_maintenance: 'In maintenance',
  retired: 'Retired',
};

const state = {
  supabase: null,
  session: null,
  profile: null,       // { id, full_name, role, home_workshop_id, active }
  workshops: [],
  tools: [],
  transfers: [],
  profiles: [],
  view: 'dashboard',
  workshopFilter: '',
  toolSearch: '',
  toolStatusFilter: '',
};

// ---------------------------------------------------------------------------
// Bootstrapping / config
// ---------------------------------------------------------------------------
function boot() {
  // Show which build is running and where it's pointed. This makes stale
  // browser or CDN caches obvious at a glance instead of a guessing game.
  const stamp = document.getElementById('buildStamp');
  if (stamp) stamp.textContent = `Build 6 · ${CLEAN_URL.replace('https://', '')}`;
  startSupabase(CLEAN_URL, SUPABASE_KEY);
}

function startSupabase(url, key) {
  state.supabase = window.supabase.createClient(url, key);
  state.supabase.auth.getSession().then(({ data }) => {
    if (data.session) {
      state.session = data.session;
      afterLogin();
    } else {
      document.getElementById('loginScreen').classList.remove('hidden');
    }
  });
  state.supabase.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === 'SIGNED_OUT') {
      location.reload();
    }
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message;
    errEl.classList.remove('hidden');
    return;
  }
  state.session = data.session;
  await afterLogin();
});

document.getElementById('signOutBtn').addEventListener('click', async () => {
  await state.supabase.auth.signOut();
});

async function afterLogin() {
  const userId = state.session.user.id;
  const { data: profile, error } = await state.supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    showToast("Couldn't load your profile. Ask an admin to check your account.");
    return;
  }
  if (!profile.active) {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    const errEl = document.getElementById('loginError');
    errEl.textContent = 'Your account is not active yet. Ask an admin to activate it.';
    errEl.classList.remove('hidden');
    await state.supabase.auth.signOut();
    return;
  }

  state.profile = profile;
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.body.classList.toggle('role-admin', profile.role === 'admin');

  document.getElementById('userName').textContent = profile.full_name;
  document.getElementById('userRole').textContent = profile.role;

  await loadWorkshops();
  wireNav();
  wireWorkshopFilter();
  setView('dashboard');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadWorkshops() {
  const { data, error } = await state.supabase.from('workshops').select('*').order('name');
  if (error) return showToast(error.message);
  state.workshops = data || [];
  const sel = document.getElementById('workshopFilter');
  sel.innerHTML = '<option value="">All workshops</option>' +
    state.workshops.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
}

async function loadTools() {
  const { data, error } = await state.supabase
    .from('tools')
    .select('*, workshop:current_workshop_id(id,name)')
    .order('name');
  if (error) return showToast(error.message);
  state.tools = data || [];
}

async function loadTransfers() {
  const { data, error } = await state.supabase
    .from('transfers')
    .select('*, tool:tool_id(id,name,serial_number), from_ws:from_workshop_id(id,name), to_ws:to_workshop_id(id,name), by:transferred_by(full_name)')
    .order('transferred_at', { ascending: false })
    .limit(200);
  if (error) return showToast(error.message);
  state.transfers = data || [];
}

async function loadProfiles() {
  const { data, error } = await state.supabase
    .from('profiles')
    .select('*, workshop:home_workshop_id(id,name)')
    .order('full_name');
  if (error) return showToast(error.message);
  state.profiles = data || [];
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function wireNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
}

function wireWorkshopFilter() {
  document.getElementById('workshopFilter').addEventListener('change', (e) => {
    state.workshopFilter = e.target.value;
    renderView();
  });
}

async function setView(view) {
  if (view === 'users' || view === 'workshops') {
    if (state.profile.role !== 'admin') view = 'dashboard';
  }
  // Leaving the Tools page clears its search and status filters, so they
  // don't silently persist when you come back later.
  if (view !== 'tools') {
    state.toolSearch = '';
    state.toolStatusFilter = '';
  }
  state.view = view;
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  const container = document.getElementById('viewContainer');
  container.innerHTML = '<p style="color:var(--ink-faint);padding:40px 0;text-align:center;">Loading…</p>';

  if (view === 'dashboard') await Promise.all([loadTools(), loadTransfers()]);
  if (view === 'tools') await loadTools();
  if (view === 'log') await loadTransfers();
  if (view === 'workshops') { /* uses state.workshops already loaded */ }
  if (view === 'users') await loadProfiles();

  renderView();
}

function renderView() {
  const map = { dashboard: renderDashboard, tools: renderTools, log: renderLog, workshops: renderWorkshops, users: renderUsers };
  (map[state.view] || renderDashboard)();
}

// Tools limited by the top-bar workshop selector only. The dashboard uses
// this, so its totals are never affected by the Tools page search box.
function workshopScopedTools() {
  return state.tools.filter(t =>
    !state.workshopFilter || t.current_workshop_id === state.workshopFilter);
}

// Tools limited by the workshop selector AND the Tools page search/status
// filters. Only the Tools list uses this.
function filteredTools() {
  return workshopScopedTools().filter(t => {
    if (state.toolStatusFilter && t.status !== state.toolStatusFilter) return false;
    if (state.toolSearch) {
      const q = state.toolSearch.toLowerCase();
      const hay = `${t.name} ${t.category || ''} ${t.serial_number || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function filteredTransfers() {
  return state.transfers.filter(t => {
    if (!state.workshopFilter) return true;
    return t.from_workshop_id === state.workshopFilter || t.to_workshop_id === state.workshopFilter;
  });
}

// ---------------------------------------------------------------------------
// Dashboard view
// ---------------------------------------------------------------------------
function renderDashboard() {
  const tools = workshopScopedTools();
  const counts = { available: 0, checked_out: 0, in_maintenance: 0, retired: 0 };
  tools.forEach(t => counts[t.status]++);

  const perWorkshop = state.workshops.map(w => ({
    name: w.name,
    total: state.tools.filter(t => t.current_workshop_id === w.id).length,
  }));

  const recent = filteredTransfers().slice(0, 6);

  const el = document.getElementById('viewContainer');
  el.innerHTML = `
    <div class="view-header">
      <h1 class="view-title">Dashboard</h1>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-num">${tools.length}</div><div class="kpi-label">Total tools</div></div>
      <div class="kpi-card"><div class="kpi-num">${counts.available}</div><div class="kpi-label">Available</div></div>
      <div class="kpi-card"><div class="kpi-num">${counts.checked_out}</div><div class="kpi-label">Checked out</div></div>
      <div class="kpi-card"><div class="kpi-num">${counts.in_maintenance}</div><div class="kpi-label">In maintenance</div></div>
      <div class="kpi-card"><div class="kpi-num">${counts.retired}</div><div class="kpi-label">Retired</div></div>
    </div>

    <div class="section-title">Tools per workshop</div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Workshop</th><th>Tools on site</th></tr></thead>
        <tbody>
          ${perWorkshop.map(w => `<tr><td>${escapeHtml(w.name)}</td><td>${w.total}</td></tr>`).join('') ||
            `<tr><td colspan="2" style="color:var(--ink-faint)">No workshops yet</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="section-title">Recent transfers</div>
    <div class="timeline">
      ${recent.length ? recent.map(transferTimelineItem).join('') :
        `<p style="color:var(--ink-faint);font-size:14px;">No transfers recorded yet.</p>`}
    </div>
  `;
}

function transferTimelineItem(t) {
  return `
    <div class="timeline-item">
      <span class="timeline-dot"></span>
      <div>
        <div class="timeline-text">
          <strong>${escapeHtml(t.tool?.name || 'Tool')}</strong> moved
          ${t.from_ws ? `from <strong>${escapeHtml(t.from_ws.name)}</strong> ` : ''}to
          <strong>${escapeHtml(t.to_ws?.name || '—')}</strong>
          — by ${escapeHtml(t.by?.full_name || 'someone')}
        </div>
        <div class="timeline-time">${formatDateTime(t.transferred_at)}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tools view
// ---------------------------------------------------------------------------
function renderTools() {
  const canWrite = state.profile.role === 'admin' || state.profile.role === 'manager';
  const el = document.getElementById('viewContainer');
  el.innerHTML = `
    <div class="view-header">
      <h1 class="view-title">Tools</h1>
      <div class="view-actions">
        ${canWrite ? `<button class="btn btn-primary" id="addToolBtn">+ Add tool</button>` : ''}
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="toolSearchInput" placeholder="Search by name, category, or serial…" value="${escapeHtml(state.toolSearch)}">
      <select id="toolStatusSelect">
        <option value="">Any status</option>
        ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${state.toolStatusFilter === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <p class="result-count" id="resultCount"></p>
    <div id="toolResults"></div>
  `;

  // Typing only refreshes the results area below, so the cursor and the
  // rest of the page stay exactly where they are.
  document.getElementById('toolSearchInput').addEventListener('input', (e) => {
    state.toolSearch = e.target.value;
    renderToolResults();
  });
  document.getElementById('toolStatusSelect').addEventListener('change', (e) => {
    state.toolStatusFilter = e.target.value;
    renderToolResults();
  });
  if (canWrite) {
    document.getElementById('addToolBtn').addEventListener('click', openAddToolModal);
  }

  renderToolResults();
}

function renderToolResults() {
  const canWrite = state.profile.role === 'admin' || state.profile.role === 'manager';
  const tools = filteredTools();
  const total = workshopScopedTools().length;
  const isFiltered = state.toolSearch || state.toolStatusFilter;

  document.getElementById('resultCount').textContent =
    isFiltered ? `${tools.length} of ${total} tools` : `${total} tools`;

  document.getElementById('toolResults').innerHTML = tools.length
    ? `<div class="tool-grid">${tools.map(toolCard).join('')}</div>`
    : `<div class="empty-state"><h3>No tools match</h3><p>Try clearing the search or status filter${canWrite ? ', or add a new tool.' : '.'}</p></div>`;

  document.querySelectorAll('.tool-tag').forEach(card => {
    card.addEventListener('click', () => openToolDetail(card.dataset.id));
  });
}

function toolCard(t) {
  return `
    <div class="tool-tag" data-id="${t.id}">
      <span class="status-pill status-${t.status}">${STATUS_LABEL[t.status]}</span>
      <div class="tool-tag-body">
        <p class="tool-name">${escapeHtml(t.name)}</p>
        <div class="tool-meta">${escapeHtml(t.serial_number || 'no serial')}${t.category ? ' · ' + escapeHtml(t.category) : ''}</div>
        <div class="tool-loc">📍 ${escapeHtml(t.workshop?.name || 'Unknown')}</div>
      </div>
    </div>`;
}

function openAddToolModal() {
  openModal(`
    <h2>Add a tool</h2>
    <p class="modal-sub">It'll be added at the workshop you choose below.</p>
    <form id="toolForm">
      <label class="field"><span>Name</span><input name="name" required></label>
      <label class="field"><span>Category</span><input name="category" placeholder="e.g. Power tool"></label>
      <label class="field"><span>Serial number</span><input name="serial_number"></label>
      <label class="field"><span>Description</span><textarea name="description"></textarea></label>
      <label class="field"><span>Workshop</span>
        <select name="current_workshop_id" required>
          ${state.workshops.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')}
        </select>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Add tool</button>
      </div>
    </form>
  `);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('toolForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (!payload.current_workshop_id) return showToast('Add a workshop first.');
    const { error } = await state.supabase.from('tools').insert(payload);
    if (error) return showToast(error.message);
    closeModal();
    showToast('Tool added.');
    await loadTools();
    renderTools();
  });
}

async function openToolDetail(id) {
  const t = state.tools.find(x => x.id === id);
  if (!t) return;
  const canWrite = state.profile.role === 'admin' || state.profile.role === 'manager';
  const canDelete = state.profile.role === 'admin';

  openModal(`
    <h2>${escapeHtml(t.name)}</h2>
    <p class="modal-sub">${escapeHtml(t.serial_number || 'No serial')}${t.category ? ' · ' + escapeHtml(t.category) : ''}</p>
    <p style="font-size:13.5px;color:var(--ink-muted);margin:-10px 0 16px;">📍 Currently at <strong>${escapeHtml(t.workshop?.name || '—')}</strong></p>
    ${t.description ? `<p style="font-size:14px;margin-bottom:16px;">${escapeHtml(t.description)}</p>` : ''}
    ${canWrite ? `
      <label class="field"><span>Status</span>
        <select id="statusSelect">
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
    ` : ''}
    <div class="section-title" style="margin-top:18px;">History</div>
    <div class="timeline" id="toolHistory"><p style="color:var(--ink-faint);font-size:13.5px;">Loading…</p></div>
    <div class="modal-actions" style="margin-top:20px;">
      ${canDelete ? `<button type="button" class="btn btn-danger" id="deleteToolBtn">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:10px;">
        <button type="button" class="btn btn-ghost" id="modalCancel">Close</button>
        ${canWrite ? `<button type="button" class="btn btn-accent" id="transferBtn">Transfer…</button>` : ''}
        ${canWrite ? `<button type="button" class="btn btn-primary" id="saveStatusBtn">Save</button>` : ''}
      </div>
    </div>
  `);

  document.getElementById('modalCancel').addEventListener('click', closeModal);

  const hist = state.transfers.filter(tr => tr.tool_id === id);
  const histWrap = document.getElementById('toolHistory');
  if (hist.length === 0 && state.transfers.length === 0) {
    await loadTransfers();
  }
  const finalHist = state.transfers.filter(tr => tr.tool_id === id);
  histWrap.innerHTML = finalHist.length
    ? finalHist.map(transferTimelineItem).join('')
    : `<p style="color:var(--ink-faint);font-size:13.5px;">No transfers yet.</p>`;

  if (canWrite) {
    document.getElementById('saveStatusBtn').addEventListener('click', async () => {
      const status = document.getElementById('statusSelect').value;
      const { error } = await state.supabase.from('tools').update({ status }).eq('id', id);
      if (error) return showToast(error.message);
      closeModal();
      showToast('Tool updated.');
      await loadTools();
      renderTools();
    });
    document.getElementById('transferBtn').addEventListener('click', () => openTransferModal(t));
  }
  if (canDelete) {
    document.getElementById('deleteToolBtn').addEventListener('click', async () => {
      if (!confirm(`Delete "${t.name}"? This can't be undone.`)) return;
      const { error } = await state.supabase.from('tools').delete().eq('id', id);
      if (error) return showToast(error.message);
      closeModal();
      showToast('Tool deleted.');
      await loadTools();
      renderTools();
    });
  }
}

function openTransferModal(t) {
  const options = state.workshops.filter(w => w.id !== t.current_workshop_id);
  openModal(`
    <h2>Transfer ${escapeHtml(t.name)}</h2>
    <p class="modal-sub">Currently at <strong>${escapeHtml(t.workshop?.name || '—')}</strong>. This is recorded permanently in the transfer log.</p>
    <form id="transferForm">
      <label class="field"><span>Send to</span>
        <select name="to_workshop_id" required>
          ${options.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Note (optional)</span><textarea name="note" placeholder="Reason, job reference, condition…"></textarea></label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button>
        <button type="submit" class="btn btn-accent">Confirm transfer</button>
      </div>
    </form>
  `);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('transferForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      tool_id: t.id,
      from_workshop_id: t.current_workshop_id,
      to_workshop_id: fd.get('to_workshop_id'),
      note: fd.get('note') || null,
      transferred_by: state.profile.id,
    };
    const { error } = await state.supabase.from('transfers').insert(payload);
    if (error) return showToast(error.message);
    closeModal();
    showToast('Transfer recorded.');
    await Promise.all([loadTools(), loadTransfers()]);
    renderView();
  });
}

// ---------------------------------------------------------------------------
// Transfer log view
// ---------------------------------------------------------------------------
function renderLog() {
  const rows = filteredTransfers();
  const el = document.getElementById('viewContainer');
  el.innerHTML = `
    <div class="view-header"><h1 class="view-title">Transfer log</h1></div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Tool</th><th>From</th><th>To</th><th>By</th><th>When</th><th>Note</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(t => `
            <tr>
              <td>${escapeHtml(t.tool?.name || '—')} <span class="mono">${escapeHtml(t.tool?.serial_number || '')}</span></td>
              <td>${escapeHtml(t.from_ws?.name || '—')}</td>
              <td>${escapeHtml(t.to_ws?.name || '—')}</td>
              <td>${escapeHtml(t.by?.full_name || '—')}</td>
              <td class="mono">${formatDateTime(t.transferred_at)}</td>
              <td>${escapeHtml(t.note || '')}</td>
            </tr>`).join('') : `<tr><td colspan="6" style="color:var(--ink-faint)">No transfers recorded yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Workshops view (admin)
// ---------------------------------------------------------------------------
function renderWorkshops() {
  const el = document.getElementById('viewContainer');
  el.innerHTML = `
    <div class="view-header">
      <h1 class="view-title">Workshops</h1>
      <div class="view-actions"><button class="btn btn-primary" id="addWorkshopBtn">+ Add workshop</button></div>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Name</th><th>Address</th><th>Tools on site</th></tr></thead>
        <tbody>
          ${state.workshops.map(w => `
            <tr>
              <td>${escapeHtml(w.name)}</td>
              <td>${escapeHtml(w.address || '—')}</td>
              <td>${state.tools.filter(t => t.current_workshop_id === w.id).length}</td>
            </tr>`).join('') || `<tr><td colspan="3" style="color:var(--ink-faint)">No workshops yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('addWorkshopBtn').addEventListener('click', () => {
    openModal(`
      <h2>Add a workshop</h2>
      <form id="wsForm">
        <label class="field"><span>Name</span><input name="name" required></label>
        <label class="field"><span>Address</span><input name="address"></label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
    `);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    document.getElementById('wsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const { error } = await state.supabase.from('workshops').insert(Object.fromEntries(fd.entries()));
      if (error) return showToast(error.message);
      closeModal();
      showToast('Workshop added.');
      await loadWorkshops();
      await loadTools();
      renderWorkshops();
    });
  });
}

// ---------------------------------------------------------------------------
// People view (admin)
// ---------------------------------------------------------------------------
function renderUsers() {
  const el = document.getElementById('viewContainer');
  el.innerHTML = `
    <div class="view-header">
      <h1 class="view-title">People</h1>
      <div class="view-actions"><button class="btn btn-primary" id="inviteBtn">+ Add teammate</button></div>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Name</th><th>Role</th><th>Home workshop</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${state.profiles.map(p => `
            <tr>
              <td>${escapeHtml(p.full_name)}</td>
              <td><span class="badge-role ${p.role}">${p.role}</span></td>
              <td>${escapeHtml(p.workshop?.name || '—')}</td>
              <td>${p.active ? 'Active' : '<span class="badge-inactive">Inactive</span>'}</td>
              <td><button class="btn btn-ghost btn-sm" data-edit="${p.id}">Edit</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('inviteBtn').addEventListener('click', openInviteInstructions);
  document.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditUserModal(btn.dataset.edit));
  });
}

function openInviteInstructions() {
  openModal(`
    <h2>Add a teammate</h2>
    <p class="modal-sub">For security, new logins are created directly in Supabase — never from the browser app.</p>
    <ol style="font-size:14px;line-height:1.7;padding-left:20px;margin:0 0 18px;">
      <li>Open your Supabase project → <strong>Authentication → Users</strong></li>
      <li>Click <strong>Add user</strong>, enter their email and a temporary password</li>
      <li>They'll appear here automatically as an inactive Viewer</li>
      <li>Come back to this page and set their role, home workshop, and mark them Active</li>
    </ol>
    <div class="modal-actions"><button type="button" class="btn btn-primary" id="modalCancel">Got it</button></div>
  `);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
}

function openEditUserModal(id) {
  const p = state.profiles.find(x => x.id === id);
  if (!p) return;
  const isSelf = p.id === state.profile.id;
  openModal(`
    <h2>${escapeHtml(p.full_name)}</h2>
    <form id="userForm">
      <label class="field"><span>Role</span>
        <select name="role" ${isSelf ? 'disabled' : ''}>
          ${['admin', 'manager', 'viewer'].map(r => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Home workshop</span>
        <select name="home_workshop_id">
          <option value="">—</option>
          ${state.workshops.map(w => `<option value="${w.id}" ${p.home_workshop_id === w.id ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Status</span>
        <select name="active" ${isSelf ? 'disabled' : ''}>
          <option value="true" ${p.active ? 'selected' : ''}>Active</option>
          <option value="false" ${!p.active ? 'selected' : ''}>Inactive</option>
        </select>
      </label>
      ${isSelf ? `<p style="font-size:12.5px;color:var(--ink-faint);margin-top:-8px;">You can't change your own role or status.</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { home_workshop_id: fd.get('home_workshop_id') || null };
    if (!isSelf) {
      payload.role = fd.get('role');
      payload.active = fd.get('active') === 'true';
    }
    const { error } = await state.supabase.from('profiles').update(payload).eq('id', id);
    if (error) return showToast(error.message);
    closeModal();
    showToast('Saved.');
    await loadProfiles();
    renderUsers();
  });
}

// ---------------------------------------------------------------------------
// Modal / toast helpers
// ---------------------------------------------------------------------------
function openModal(html) {
  document.getElementById('modalBox').innerHTML = `<button class="modal-close" id="modalX" aria-label="Close">×</button>${html}`;
  document.getElementById('modalRoot').classList.remove('hidden');
  document.getElementById('modalX').addEventListener('click', closeModal);
  document.getElementById('modalBackdrop').addEventListener('click', closeModal);
}
function closeModal() {
  document.getElementById('modalRoot').classList.add('hidden');
  document.getElementById('modalBox').innerHTML = '';
}
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

boot();
