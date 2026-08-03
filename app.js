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
  selectMode: false,
  selection: new Set(),
};

// ---------------------------------------------------------------------------
// Bootstrapping / config
// ---------------------------------------------------------------------------
function boot() {
  // Show which build is running and where it's pointed. This makes stale
  // browser or CDN caches obvious at a glance instead of a guessing game.
  const stamp = document.getElementById('buildStamp');
  if (stamp) stamp.textContent = `Build 13 · ${CLEAN_URL.replace('https://', '')}`;
  startSupabase(CLEAN_URL, SUPABASE_KEY);
}

function startSupabase(url, key) {
  state.supabase = window.supabase.createClient(url, key);

  state.supabase.auth.onAuthStateChange((event, session) => {
    state.session = session;
    if (event === 'SIGNED_OUT') {
      location.reload();
    }
  });

  state.supabase.auth.getSession().then(({ data }) => {
    if (data.session) {
      state.session = data.session;
      afterLogin();
    } else {
      document.getElementById('loginScreen').classList.remove('hidden');
    }
  });
}

function showOnly(id) {
  ['loginScreen', 'recoverScreen', 'forceChangeScreen', 'app'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
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

// ===========================================================================
// FORGOT PASSWORD — 6-digit code by email
// Three steps: ask for the email, verify the code, then set a new password.
// ===========================================================================
const recovery = { email: '' };

function recShowStep(step) {
  ['recStepEmail', 'recStepCode', 'recStepPassword'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', id !== step);
  });
  document.getElementById('recError').classList.add('hidden');
}

function recError(msg) {
  const el = document.getElementById('recError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

document.getElementById('forgotBtn').addEventListener('click', () => {
  recovery.email = document.getElementById('loginEmail').value.trim();
  document.getElementById('recEmail').value = recovery.email;
  recShowStep('recStepEmail');
  showOnly('recoverScreen');
});

document.getElementById('recBackBtn').addEventListener('click', () => {
  showOnly('loginScreen');
});

async function sendRecoveryCode(email, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const { error } = await state.supabase.auth.resetPasswordForEmail(email);
  btn.disabled = false;
  btn.textContent = original;
  return error;
}

document.getElementById('recEmailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('recEmail').value.trim();
  const error = await sendRecoveryCode(email, document.getElementById('recEmailBtn'));
  if (error) return recError(error.message);

  recovery.email = email;
  document.getElementById('recEmailEcho').textContent = email;
  recShowStep('recStepCode');
  document.getElementById('recCode').focus();
});

document.getElementById('recResend').addEventListener('click', async () => {
  const error = await sendRecoveryCode(recovery.email, document.getElementById('recResend'));
  if (error) return recError(error.message);
  showToast('A new code is on its way.');
});

document.getElementById('recCodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('recCode').value.trim();
  const btn = document.getElementById('recCodeBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  // A correct code signs them in briefly, which is what lets them set a
  // new password. It does not let them into the app — the screen below
  // is the only thing shown until the password is saved.
  const { error } = await state.supabase.auth.verifyOtp({
    email: recovery.email,
    token,
    type: 'recovery',
  });

  btn.disabled = false;
  btn.textContent = 'Verify code';

  if (error) {
    return recError(
      /expired|invalid/i.test(error.message)
        ? 'That code is wrong or has expired. Request a new one.'
        : error.message
    );
  }
  recShowStep('recStepPassword');
  document.getElementById('recPassword').focus();
});

document.getElementById('recPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = document.getElementById('recPassword').value;
  const p2 = document.getElementById('recPassword2').value;
  const btn = document.getElementById('recPwBtn');

  const problem = passwordProblem(p1, p2);
  if (problem) return recError(problem);

  btn.disabled = true;
  btn.textContent = 'Saving…';
  const { error } = await state.supabase.auth.updateUser({ password: p1 });
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Save new password';
    return recError(error.message);
  }

  // They have just chosen their own password, so the first-sign-in
  // requirement no longer applies.
  const { data: u } = await state.supabase.auth.getUser();
  if (u?.user) {
    await state.supabase.from('profiles')
      .update({ must_change_password: false }).eq('id', u.user.id);
  }

  await state.supabase.auth.signOut();
  showToast('Password updated. Sign in with your new password.');
});

// Shared password rules for every place a password is set.
function passwordProblem(p1, p2) {
  if (p1 !== p2) return "Those two passwords don't match.";
  if (p1.length < 8) return 'Use at least 8 characters.';
  return null;
}

// ===========================================================================
// FIRST SIGN-IN — must set your own password before using the app
// ===========================================================================
document.getElementById('fcSignOut').addEventListener('click', async () => {
  await state.supabase.auth.signOut();
});

document.getElementById('forceChangeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = document.getElementById('fcPassword').value;
  const p2 = document.getElementById('fcPassword2').value;
  const errEl = document.getElementById('fcError');
  const btn = document.getElementById('fcSubmit');
  errEl.classList.add('hidden');

  const problem = passwordProblem(p1, p2);
  if (problem) {
    errEl.textContent = problem;
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await state.supabase.auth.updateUser({ password: p1 });
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Save and continue';
    errEl.textContent = error.message;
    errEl.classList.remove('hidden');
    return;
  }

  const { error: flagErr } = await state.supabase.from('profiles')
    .update({ must_change_password: false }).eq('id', state.profile.id);

  btn.disabled = false;
  btn.textContent = 'Save and continue';

  if (flagErr) {
    errEl.textContent = flagErr.message;
    errEl.classList.remove('hidden');
    return;
  }

  state.profile.must_change_password = false;
  document.getElementById('fcPassword').value = '';
  document.getElementById('fcPassword2').value = '';
  showToast('Password set.');
  enterApp();
});

// --- Account menu (change name, change password, sign out) ------------------
document.getElementById('accountBtn').addEventListener('click', openAccountModal);
document.getElementById('accountBtnMobile').addEventListener('click', openAccountModal);

function openAccountModal() {
  const p = state.profile;
  openModal(`
    <h2>Your account</h2>
    <p class="modal-sub">${escapeHtml(state.session?.user?.email || '')} · ${escapeHtml(p.role)}</p>

    <label class="field"><span>Display name</span>
      <input id="acctName" type="text" value="${escapeHtml(p.full_name)}">
    </label>
    <button type="button" class="btn btn-ghost btn-block" id="saveNameBtn">Save name</button>

    <p class="acct-note">To change your password, sign out and use <strong>Forgot your password?</strong> on the sign-in screen. A 6-digit code will be emailed to you.</p>

    <div class="modal-actions" style="margin-top:22px;justify-content:space-between;">
      <button type="button" class="btn btn-danger" id="acctSignOut">Sign out</button>
      <button type="button" class="btn btn-ghost" id="modalCancel">Close</button>
    </div>
  `);

  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('acctSignOut').addEventListener('click', async () => {
    await state.supabase.auth.signOut();
  });

  document.getElementById('saveNameBtn').addEventListener('click', async () => {
    const name = document.getElementById('acctName').value.trim();
    if (!name) return showToast('Name cannot be empty.');
    const { error } = await state.supabase.from('profiles').update({ full_name: name }).eq('id', state.profile.id);
    if (error) return showToast(error.message);
    state.profile.full_name = name;
    document.getElementById('userName').textContent = name;
    document.getElementById('userInitials').textContent = initialsOf(name);
    showToast('Name updated.');
  });
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

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

  // First sign-in: nothing else loads until they replace the temporary
  // password they were given.
  if (profile.must_change_password) {
    showOnly('forceChangeScreen');
    return;
  }

  enterApp();
}

async function enterApp() {
  const profile = state.profile;
  showOnly('app');
  document.body.classList.toggle('role-admin', profile.role === 'admin');

  document.getElementById('userName').textContent = profile.full_name;
  document.getElementById('userRole').textContent = profile.role;
  document.getElementById('userInitials').textContent = initialsOf(profile.full_name);

  await loadWorkshops();

  // Managers work at exactly one site, so a selector would be misleading.
  // Show their workshop as plain text instead.
  const sel = document.getElementById('workshopFilter');
  const lbl = document.getElementById('workshopLabel');
  if (profile.role === 'manager') {
    const home = state.workshops.find(w => w.id === profile.home_workshop_id);
    sel.classList.add('hidden');
    lbl.classList.remove('hidden');
    if (home) {
      lbl.textContent = home.name;
    } else {
      lbl.textContent = 'No workshop assigned';
      lbl.classList.add('workshop-label-warn');
      showToast('No workshop is assigned to you yet — ask an admin to set one.');
    }
  }

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
    state.selectMode = false;
    state.selection.clear();
    const bar = document.getElementById('selectionBar');
    if (bar) bar.remove();
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

  // Managers only have visibility of their own site, so listing every
  // workshop would show rows of zeros they can't act on.
  const visibleWorkshops = state.profile.role === 'manager'
    ? state.workshops.filter(w => w.id === state.profile.home_workshop_id)
    : state.workshops;

  const perWorkshop = visibleWorkshops.map(w => ({
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
        ${canWrite ? `<button class="btn btn-ghost" id="selectModeBtn">Select</button>` : ''}
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
    document.getElementById('selectModeBtn').addEventListener('click', toggleSelectMode);
  }

  renderToolResults();
}

function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  state.selection.clear();
  renderTools();
}

function renderToolResults() {
  const canWrite = state.profile.role === 'admin' || state.profile.role === 'manager';
  const tools = filteredTools();
  const total = workshopScopedTools().length;
  const isFiltered = state.toolSearch || state.toolStatusFilter;

  const btn = document.getElementById('selectModeBtn');
  if (btn) {
    btn.textContent = state.selectMode ? 'Cancel' : 'Select';
    btn.classList.toggle('btn-accent', state.selectMode);
    btn.classList.toggle('btn-ghost', !state.selectMode);
  }

  document.getElementById('resultCount').textContent =
    isFiltered ? `${tools.length} of ${total} tools` : `${total} tools`;

  document.getElementById('toolResults').innerHTML = tools.length
    ? `<div class="tool-grid">${tools.map(toolCard).join('')}</div>`
    : `<div class="empty-state"><h3>No tools match</h3><p>Try clearing the search or status filter${canWrite ? ', or add a new tool.' : '.'}</p></div>`;

  document.querySelectorAll('.tool-tag').forEach(card => {
    card.addEventListener('click', () => {
      if (state.selectMode) {
        toggleSelection(card.dataset.id);
      } else {
        openToolDetail(card.dataset.id);
      }
    });
  });

  renderSelectionBar(tools);
}

function toolCard(t) {
  const selected = state.selection.has(t.id);
  return `
    <div class="tool-tag ${state.selectMode ? 'selectable' : ''} ${selected ? 'selected' : ''}" data-id="${t.id}">
      ${state.selectMode ? `<span class="tool-check" aria-hidden="true">${selected ? '✓' : ''}</span>` : ''}
      <span class="status-pill status-${t.status}">${STATUS_LABEL[t.status]}</span>
      <div class="tool-tag-body">
        <p class="tool-name">${escapeHtml(t.name)}</p>
        <div class="tool-meta">${escapeHtml(t.serial_number || 'no serial')}${t.category ? ' · ' + escapeHtml(t.category) : ''}</div>
        <div class="tool-loc">📍 ${escapeHtml(t.workshop?.name || 'Unknown')}</div>
      </div>
    </div>`;
}

function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  renderToolResults();
}

function renderSelectionBar(visibleTools) {
  let bar = document.getElementById('selectionBar');
  if (!state.selectMode) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selectionBar';
    bar.className = 'selection-bar';
    document.body.appendChild(bar);
  }

  const n = state.selection.size;
  const allVisibleSelected = visibleTools.length > 0 && visibleTools.every(t => state.selection.has(t.id));

  bar.innerHTML = `
    <span class="sel-count">${n} selected</span>
    <div class="sel-actions">
      <button class="btn btn-ghost btn-sm" id="selAllBtn">${allVisibleSelected ? 'Clear all' : `Select all ${visibleTools.length}`}</button>
      <button class="btn btn-accent btn-sm" id="selTransferBtn" ${n ? '' : 'disabled'}>Transfer ${n || ''}</button>
    </div>
  `;

  document.getElementById('selAllBtn').addEventListener('click', () => {
    if (allVisibleSelected) state.selection.clear();
    else visibleTools.forEach(t => state.selection.add(t.id));
    renderToolResults();
  });
  document.getElementById('selTransferBtn').addEventListener('click', openBulkTransferModal);
}

function openAddToolModal() {
  // A manager can only add tools at their own site, so show where it's going
  // rather than offering a choice the database would reject.
  const isManager = state.profile.role === 'manager';
  const home = state.workshops.find(w => w.id === state.profile.home_workshop_id);

  if (isManager && !home) {
    return showToast('No workshop assigned to you — ask an admin to set one first.');
  }

  const workshopField = isManager
    ? `<div class="field">
         <span>Workshop</span>
         <p class="static-value">${escapeHtml(home.name)}</p>
       </div>`
    : `<label class="field"><span>Workshop</span>
         <select name="current_workshop_id" required>
           ${state.workshops.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')}
         </select>
       </label>`;

  openModal(`
    <h2>Add a tool</h2>
    <p class="modal-sub">${isManager ? 'It will be added at your workshop.' : "It'll be added at the workshop you choose below."}</p>
    <form id="toolForm">
      <label class="field"><span>Name</span><input name="name" required></label>
      <label class="field"><span>Category</span><input name="category" placeholder="e.g. Power tool"></label>
      <label class="field"><span>Serial number</span><input name="serial_number"></label>
      <label class="field"><span>Description</span><textarea name="description"></textarea></label>
      ${workshopField}
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
    if (isManager) payload.current_workshop_id = state.profile.home_workshop_id;
    if (!payload.current_workshop_id) return showToast('No workshop available.');
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

function openBulkTransferModal() {
  const tools = state.tools.filter(t => state.selection.has(t.id));
  if (!tools.length) return;

  // Tools may sit at different sites (an admin viewing everything), so list
  // the origins and offer every workshop that isn't the only origin.
  const origins = [...new Set(tools.map(t => t.current_workshop_id))];
  const originNames = origins
    .map(id => state.workshops.find(w => w.id === id)?.name || 'Unknown')
    .join(', ');
  const destinations = origins.length === 1
    ? state.workshops.filter(w => w.id !== origins[0])
    : state.workshops;

  if (!destinations.length) {
    return showToast('There is no other workshop to send these to.');
  }

  openModal(`
    <h2>Transfer ${tools.length} tool${tools.length > 1 ? 's' : ''}</h2>
    <p class="modal-sub">Currently at <strong>${escapeHtml(originNames)}</strong>. Each tool gets its own permanent log entry.</p>

    <div class="sel-list">
      ${tools.map(t => `<div class="sel-list-item">${escapeHtml(t.name)}<span class="mono">${escapeHtml(t.serial_number || '')}</span></div>`).join('')}
    </div>

    <form id="bulkTransferForm" style="margin-top:18px;">
      <label class="field"><span>Send all to</span>
        <select name="to_workshop_id" required>
          ${destinations.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Note (optional)</span>
        <textarea name="note" placeholder="Reason, job reference, condition…"></textarea>
      </label>
      <p id="bulkError" class="form-error hidden"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button>
        <button type="submit" class="btn btn-accent" id="bulkSubmit">Confirm transfer</button>
      </div>
    </form>
  `);

  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('bulkTransferForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const to = fd.get('to_workshop_id');
    const note = fd.get('note') || null;
    const btn = document.getElementById('bulkSubmit');
    const errEl = document.getElementById('bulkError');
    errEl.classList.add('hidden');

    // Skip anything already at the destination rather than logging a no-op.
    const moving = tools.filter(t => t.current_workshop_id !== to);
    const skipped = tools.length - moving.length;

    if (!moving.length) {
      errEl.textContent = 'Those tools are already at that workshop.';
      errEl.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Transferring…';

    const rows = moving.map(t => ({
      tool_id: t.id,
      from_workshop_id: t.current_workshop_id,
      to_workshop_id: to,
      note,
      transferred_by: state.profile.id,
    }));

    const { error } = await state.supabase.from('transfers').insert(rows);

    btn.disabled = false;
    btn.textContent = 'Confirm transfer';

    if (error) {
      errEl.textContent = error.message;
      errEl.classList.remove('hidden');
      return;
    }

    closeModal();
    state.selection.clear();
    state.selectMode = false;
    showToast(
      `${moving.length} tool${moving.length > 1 ? 's' : ''} transferred.` +
      (skipped ? ` ${skipped} already there, skipped.` : '')
    );
    await Promise.all([loadTools(), loadTransfers()]);
    renderTools();
  });
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
              <td>${escapeHtml(p.workshop?.name || '—')}${
                p.role === 'manager' && !p.home_workshop_id && p.active
                  ? ' <span class="warn-flag" title="A manager with no workshop sees no tools at all">needs a workshop</span>'
                  : ''
              }</td>
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
    <p class="modal-sub">Creates their login straight away. Give them the temporary password and ask them to change it from the account menu.</p>
    <form id="inviteForm">
      <label class="field"><span>Full name</span>
        <input name="full_name" type="text" required placeholder="Ahmed Saleem">
      </label>
      <label class="field"><span>Email</span>
        <input name="email" type="email" required placeholder="name@company.com" autocomplete="off">
      </label>
      <label class="field"><span>Temporary password</span>
        <div class="pw-row">
          <input name="password" id="invitePw" type="text" required minlength="8" autocomplete="off">
          <button type="button" class="btn btn-ghost btn-sm" id="genPwBtn">Generate</button>
        </div>
      </label>
      <label class="field"><span>Role</span>
        <select name="role">
          <option value="manager" selected>Manager — add tools, record transfers</option>
          <option value="viewer">Viewer — read only</option>
          <option value="admin">Admin — full control</option>
        </select>
      </label>
      <label class="field"><span>Home workshop</span>
        <select name="home_workshop_id">
          <option value="">—</option>
          ${state.workshops.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')}
        </select>
      </label>
      <p id="inviteError" class="form-error hidden"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="modalCancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="inviteSubmit">Create login</button>
      </div>
    </form>
  `);

  document.getElementById('modalCancel').addEventListener('click', closeModal);

  const genPw = () => {
    // Readable temporary password: easy to pass along verbally or by SMS.
    const words = ['Anchor','Bolt','Cable','Drill','Ember','Forge','Girder','Hammer',
                   'Ingot','Joint','Kettle','Lever','Mallet','Nozzle','Piston','Rivet'];
    const w = words[Math.floor(Math.random() * words.length)];
    const n = Math.floor(1000 + Math.random() * 9000);
    return `${w}-${n}`;
  };
  document.getElementById('invitePw').value = genPw();
  document.getElementById('genPwBtn').addEventListener('click', () => {
    document.getElementById('invitePw').value = genPw();
  });

  document.getElementById('inviteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('inviteError');
    const btn = document.getElementById('inviteSubmit');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    const fd = new FormData(e.target);
    const payload = {
      full_name: (fd.get('full_name') || '').trim(),
      email: (fd.get('email') || '').trim(),
      password: fd.get('password'),
      role: fd.get('role'),
      home_workshop_id: fd.get('home_workshop_id') || null,
      active: true,
    };

    const { data, error } = await state.supabase.functions.invoke('create-user', { body: payload });

    btn.disabled = false;
    btn.textContent = 'Create login';

    // An error from the function comes back in two possible shapes.
    const message = error
      ? (await readFunctionError(error)) || error.message
      : (data && data.error) || null;

    if (message) {
      errEl.textContent = message;
      errEl.classList.remove('hidden');
      return;
    }

    closeModal();
    showToast(`${payload.full_name} can now sign in.`);
    await loadProfiles();
    renderUsers();
    showCredentialsModal(payload);
  });
}

// Supabase wraps non-2xx responses; dig out the readable message inside.
async function readFunctionError(error) {
  try {
    if (error.context && typeof error.context.json === 'function') {
      const body = await error.context.json();
      if (body && body.error) return body.error;
    }
  } catch (_) { /* fall back to the generic message */ }
  return null;
}

function showCredentialsModal(p) {
  openModal(`
    <h2>Login created</h2>
    <p class="modal-sub">Pass these on to ${escapeHtml(p.full_name)}. This is the only time the password is shown.</p>
    <div class="cred-box">
      <div><span class="cred-label">Site</span><span class="cred-value">${escapeHtml(window.location.origin + window.location.pathname)}</span></div>
      <div><span class="cred-label">Email</span><span class="cred-value">${escapeHtml(p.email)}</span></div>
      <div><span class="cred-label">Password</span><span class="cred-value">${escapeHtml(p.password)}</span></div>
    </div>
    <p style="font-size:13px;color:var(--ink-muted);margin:14px 0 0;">Ask them to change it from the account menu after signing in.</p>
    <div class="modal-actions" style="margin-top:18px;">
      <button type="button" class="btn btn-ghost" id="copyCredsBtn">Copy details</button>
      <button type="button" class="btn btn-primary" id="modalCancel">Done</button>
    </div>
  `);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('copyCredsBtn').addEventListener('click', async () => {
    const text = `Tools Management System\n${window.location.origin + window.location.pathname}\nEmail: ${p.email}\nPassword: ${p.password}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied.');
    } catch (_) {
      showToast('Copy failed — select the text manually.');
    }
  });
}

function openEditUserModal(id) {
  const p = state.profiles.find(x => x.id === id);
  if (!p) return;
  const isSelf = p.id === state.profile.id;
  openModal(`
    <h2>${escapeHtml(p.full_name)}</h2>
    <form id="userForm">
      <label class="field"><span>Display name</span>
        <input name="full_name" type="text" value="${escapeHtml(p.full_name)}" required>
      </label>
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
    const name = (fd.get('full_name') || '').trim();
    if (!name) return showToast('Display name cannot be empty.');
    const payload = {
      full_name: name,
      home_workshop_id: fd.get('home_workshop_id') || null,
    };
    if (!isSelf) {
      payload.role = fd.get('role');
      payload.active = fd.get('active') === 'true';
    }
    const { error } = await state.supabase.from('profiles').update(payload).eq('id', id);
    if (error) return showToast(error.message);
    if (isSelf) {
      state.profile.full_name = name;
      document.getElementById('userName').textContent = name;
      document.getElementById('userInitials').textContent = initialsOf(name);
    }
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
