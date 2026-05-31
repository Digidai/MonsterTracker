export function renderDashboard(appName = "MonsterTracker"): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(html(appName, nonce), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "object-src 'none'"
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=()"
    }
  });
}

function html(appName: string, nonce = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(appName)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7faf9;
      --panel: #ffffff;
      --panel-soft: #f1f7f6;
      --line: #dce7e5;
      --line-strong: #b7ccca;
      --text: #172322;
      --muted: #637371;
      --faint: #8fa09d;
      --teal: #0f9f96;
      --teal-strong: #087c75;
      --amber: #d58a00;
      --red: #d93636;
      --green: #20a652;
      --shadow: 0 18px 45px rgba(24, 45, 42, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.45;
    }
    button, input, select, textarea {
      font: inherit;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr) 392px;
    }
    .sidebar {
      background: var(--panel);
      border-right: 1px solid var(--line);
      padding: 22px 16px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 44px;
    }
    .mark {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      background: linear-gradient(135deg, #0f9f96, #173a37);
      display: grid;
      place-items: center;
      color: white;
      font-weight: 800;
      letter-spacing: 0;
    }
    .brand strong { display: block; font-size: 18px; letter-spacing: 0; }
    .brand span { display: block; color: var(--muted); font-size: 12px; }
    .workspace {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fff;
    }
    .workspace strong { display: block; font-size: 13px; }
    .workspace span { color: var(--muted); font-size: 12px; }
    nav { display: grid; gap: 4px; }
    .nav-label {
      color: var(--faint);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
      margin: 16px 6px 6px;
    }
    .nav-item {
      border: 0;
      width: 100%;
      border-radius: 8px;
      padding: 9px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: transparent;
      color: #43504f;
      cursor: pointer;
      text-align: left;
    }
    .nav-item.active {
      background: #e8f5f3;
      color: var(--teal-strong);
      font-weight: 700;
    }
    .pill {
      min-width: 26px;
      border-radius: 999px;
      padding: 2px 7px;
      background: #dff1ef;
      color: var(--teal-strong);
      font-size: 12px;
      text-align: center;
      font-weight: 700;
    }
    .sidebar-foot {
      margin-top: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .main {
      min-width: 0;
      background: var(--panel);
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
    }
    .topbar {
      min-height: 88px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      gap: 18px;
    }
    .title {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .pulse {
      width: 30px;
      height: 30px;
      color: var(--teal);
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.1;
      letter-spacing: 0;
    }
    .subtitle { color: var(--muted); margin-top: 3px; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .statbox, .control {
      height: 42px;
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 8px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #273231;
    }
    .statbar {
      width: 108px;
      height: 5px;
      border-radius: 999px;
      background: #dfe9e7;
      overflow: hidden;
    }
    .statbar span { display: block; height: 100%; background: var(--teal); width: 0; }
    .filters {
      min-height: 72px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 24px;
    }
    .search {
      flex: 1 1 340px;
      max-width: 420px;
      position: relative;
    }
    .search input, .field input, .field select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      min-height: 40px;
      padding: 0 12px;
      background: #fff;
      color: var(--text);
      outline: none;
    }
    .search input:focus, .field input:focus, .field select:focus {
      border-color: var(--teal);
      box-shadow: 0 0 0 3px rgba(15, 159, 150, .12);
    }
    .btn {
      border: 1px solid var(--line);
      border-radius: 8px;
      min-height: 40px;
      padding: 0 13px;
      background: #fff;
      color: #263130;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-weight: 700;
      white-space: nowrap;
    }
    .btn.primary {
      background: var(--teal);
      border-color: var(--teal);
      color: #fff;
    }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .table-wrap {
      min-height: 0;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 880px;
    }
    th {
      color: #344240;
      font-size: 12px;
      text-align: left;
      font-weight: 800;
      padding: 17px 22px;
      border-bottom: 1px solid var(--line);
      background: #fff;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    td {
      padding: 15px 22px;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
    }
    tr.selected {
      background: #f0faf8;
      box-shadow: inset 3px 0 0 var(--teal);
    }
    .monitor-name {
      display: grid;
      gap: 2px;
    }
    .monitor-name strong { font-size: 14px; }
    .monitor-name span { color: var(--muted); font-size: 12px; }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
      background: var(--faint);
    }
    .dot.up { background: var(--green); }
    .dot.down { background: var(--red); }
    .dot.warn { background: var(--amber); }
    .spark {
      width: 74px;
      height: 24px;
      display: inline-block;
      background: linear-gradient(180deg, transparent 0, transparent 46%, rgba(15,159,150,.16) 47%, transparent 51%);
      border-bottom: 2px solid var(--teal);
      border-radius: 0 0 5px 5px;
    }
    .regions-mini {
      display: flex;
      gap: 3px;
      align-items: center;
      flex-wrap: wrap;
      max-width: 136px;
    }
    .block {
      width: 6px;
      height: 14px;
      border-radius: 2px;
      background: #dce7e5;
    }
    .block.on { background: var(--teal); }
    .progress {
      display: grid;
      grid-template-columns: 84px 40px;
      align-items: center;
      gap: 9px;
    }
    .progress-track {
      height: 7px;
      border-radius: 999px;
      background: #dde8e6;
      overflow: hidden;
    }
    .progress-track span {
      display: block;
      height: 100%;
      width: 0;
      background: var(--teal);
    }
    .detail {
      min-width: 0;
      background: #fbfdfc;
      display: flex;
      flex-direction: column;
      overflow: auto;
    }
    .detail-head {
      padding: 27px 24px 18px;
      border-bottom: 1px solid var(--line);
    }
    .detail-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .detail-title h2 {
      margin: 0;
      font-size: 20px;
      letter-spacing: 0;
    }
    .badge {
      border-radius: 999px;
      padding: 4px 9px;
      background: #dff4e8;
      color: #128244;
      font-size: 12px;
      font-weight: 800;
    }
    .badge.down {
      background: #ffe3e3;
      color: var(--red);
    }
    .muted { color: var(--muted); }
    .tabs {
      display: flex;
      gap: 20px;
      margin-top: 22px;
      border-bottom: 1px solid var(--line);
    }
    .tab {
      border: 0;
      background: transparent;
      padding: 0 0 11px;
      cursor: pointer;
      color: var(--muted);
      font-weight: 700;
    }
    .tab.active {
      color: var(--teal-strong);
      box-shadow: 0 2px 0 var(--teal);
    }
    .detail-body {
      padding: 20px 24px 28px;
      display: grid;
      gap: 22px;
    }
    .kv {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 13px 22px;
    }
    .kv div {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 13px;
    }
    .kv span:first-child { color: var(--muted); }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      font-weight: 800;
    }
    .region-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 7px;
    }
    .region-chip {
      min-width: 0;
      border-radius: 7px;
      border: 1px solid var(--line);
      background: #fff;
      padding: 6px 7px;
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      color: #344240;
    }
    .region-chip .dot { width: 7px; height: 7px; }
    .timeline {
      display: grid;
      gap: 12px;
    }
    .event {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }
    .event-icon {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1px solid var(--line-strong);
      display: grid;
      place-items: center;
      color: var(--teal);
      font-size: 12px;
    }
    .event strong { display: block; font-size: 13px; }
    .event span { color: var(--muted); font-size: 12px; }
    .form {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--line);
      padding-top: 18px;
    }
    .field label {
      display: block;
      margin: 0 0 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .two {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .notice {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 8px;
      padding: 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: 360px;
      background: #172322;
      color: #fff;
      border-radius: 8px;
      padding: 12px 14px;
      box-shadow: var(--shadow);
      display: none;
      z-index: 10;
    }
    @media (max-width: 1180px) {
      .shell { grid-template-columns: 82px minmax(0, 1fr); }
      .sidebar { padding: 18px 10px; }
      .brand div:not(.mark), .workspace, .nav-label, .nav-item span:first-child, .sidebar-foot { display: none; }
      .nav-item { justify-content: center; }
      .detail { display: none; }
    }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .topbar, .filters { padding: 16px; align-items: flex-start; flex-direction: column; }
      .toolbar { justify-content: flex-start; }
      .table-wrap { overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="mark">MT</div>
        <div>
          <strong>Monster<span style="color:var(--teal)">Tracker</span></strong>
          <span>Cloudflare-native Monitoring</span>
        </div>
      </div>
      <div class="workspace">
        <strong>Self-hosted</strong>
        <span>Worker control plane</span>
      </div>
      <nav>
        <button class="nav-item active"><span>Overview</span><span class="pill" id="navMonitors">0</span></button>
        <button class="nav-item"><span>Regions</span><span class="pill" id="navRegions">0</span></button>
        <button class="nav-item"><span>Incidents</span><span class="pill" id="navIncidents">0</span></button>
        <button class="nav-item"><span>Usage</span></button>
        <div class="nav-label">Configuration</div>
        <button class="nav-item"><span>Monitors</span></button>
        <button class="nav-item"><span>Placement</span></button>
        <button class="nav-item"><span>Tokens</span></button>
      </nav>
      <div class="sidebar-foot">
        <strong>Plan: Cloudflare Free</strong>
        <span id="freeFit">Waiting for usage...</span>
        <span>v0.1.0</span>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="title">
          <svg class="pulse" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 17h6l4-10 6 20 4-10h8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <div>
            <h1>Monitors</h1>
            <div class="subtitle"><span id="monitorCount">0</span> monitors across <span id="regionCount">0</span> placed regions</div>
          </div>
        </div>
        <div class="toolbar">
          <div class="statbox">
            <span>Probe Budget</span>
            <div class="statbar"><span id="budgetBar"></span></div>
            <strong id="budgetPct">0%</strong>
          </div>
          <button class="btn" id="refreshBtn" type="button">Refresh</button>
          <button class="btn primary" id="runBtn" type="button">Run Due Now</button>
        </div>
      </header>
      <section class="filters">
        <div class="search"><input id="search" type="search" placeholder="Search monitors..."></div>
        <select class="control" id="statusFilter">
          <option value="all">All status</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
        </select>
      </section>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Monitor</th>
              <th>Last Check</th>
              <th>Latency</th>
              <th>Regions</th>
              <th>Daily Budget</th>
            </tr>
          </thead>
          <tbody id="monitorRows"></tbody>
        </table>
      </div>
    </main>
    <aside class="detail">
      <div class="detail-head">
        <div class="detail-title">
          <h2 id="detailName">No monitor</h2>
          <span class="badge" id="detailStatus">Idle</span>
        </div>
        <div class="muted" id="detailUrl">Create a monitor to start collecting edge data.</div>
        <div class="tabs">
          <button class="tab active">Overview</button>
          <button class="tab">Regions</button>
          <button class="tab">Alerts</button>
          <button class="tab">Settings</button>
        </div>
      </div>
      <div class="detail-body">
        <section>
          <div class="kv" id="detailKv"></div>
        </section>
        <section>
          <div class="section-title">
            <span>Global Region Coverage</span>
            <span id="coverageText" style="color:var(--teal)">0 / 0</span>
          </div>
          <div class="region-grid" id="regionGrid"></div>
        </section>
        <section>
          <div class="section-title"><span>Incident Timeline</span></div>
          <div class="timeline" id="timeline"></div>
        </section>
        <form class="form" id="addForm">
          <div class="section-title"><span>Add Monitor</span></div>
          <input type="text" autocomplete="username" value="admin" hidden>
          <div class="field"><label>Admin token</label><input id="adminToken" type="password" autocomplete="current-password" placeholder="Bearer token for write actions"></div>
          <div class="field"><label>URL</label><input id="newUrl" type="url" placeholder="https://example.com/health"></div>
          <div class="two">
            <div class="field"><label>Name</label><input id="newName" placeholder="Example API"></div>
            <div class="field"><label>Daily budget</label><input id="newBudget" type="number" min="1" value="100"></div>
          </div>
          <button class="btn primary" id="addBtn" type="submit">Create Monitor</button>
          <div class="notice">Default probes use HEAD, follow no redirects, and distribute each monitor's daily budget across enabled regions.</div>
        </form>
      </div>
    </aside>
  </div>
  <div class="toast" id="toast"></div>
  <script nonce="${nonce}">
    const state = { summary: null, selected: null };
    const tokenInput = document.getElementById('adminToken');
    tokenInput.value = sessionStorage.getItem('monstertracker.adminToken') || '';
    tokenInput.addEventListener('input', () => sessionStorage.setItem('monstertracker.adminToken', tokenInput.value));

    document.getElementById('refreshBtn').addEventListener('click', loadSummary);
    document.getElementById('runBtn').addEventListener('click', runDueNow);
    document.getElementById('addForm').addEventListener('submit', (event) => {
      event.preventDefault();
      addMonitor();
    });
    document.getElementById('search').addEventListener('input', render);
    document.getElementById('statusFilter').addEventListener('change', render);

    async function loadSummary() {
      const token = tokenInput.value.trim();
      if (!token) return toast('Enter the admin token, then refresh.');
      const response = await fetch('/api/summary', {
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + token
        }
      });
      if (!response.ok) return toast('Failed to load summary: ' + response.status);
      state.summary = await response.json();
      if (!state.selected && state.summary.monitors.length) state.selected = state.summary.monitors[0].id;
      render();
    }

    async function addMonitor() {
      const token = tokenInput.value.trim();
      const payload = {
        url: document.getElementById('newUrl').value.trim(),
        name: document.getElementById('newName').value.trim(),
        dailyBudget: Number(document.getElementById('newBudget').value || 100)
      };
      const response = await fetch('/api/monitors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return toast(body.error || 'Create failed');
      state.selected = body.monitor.id;
      document.getElementById('newUrl').value = '';
      document.getElementById('newName').value = '';
      toast('Monitor created');
      await loadSummary();
    }

    async function runDueNow() {
      const token = tokenInput.value.trim();
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ mode: 'due' })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return toast(body.error || 'Run failed');
      toast('Dispatched ' + body.dispatchedJobs + ' jobs');
      setTimeout(loadSummary, 800);
    }

    function render() {
      const summary = state.summary;
      if (!summary) return;
      const monitors = filteredMonitors(summary);
      const latestByMonitor = groupLatest(summary.latest);
      document.getElementById('monitorCount').textContent = summary.monitors.length;
      document.getElementById('regionCount').textContent = summary.regions.length;
      document.getElementById('navMonitors').textContent = summary.monitors.length;
      document.getElementById('navRegions').textContent = summary.regions.filter(r => r.enabled).length;
      document.getElementById('navIncidents').textContent = summary.incidents.length;

      const todayBudget = summary.monitors.reduce((total, monitor) => total + monitor.dailyBudget, 0);
      const used = summary.usage.probeResults;
      const pct = todayBudget ? Math.min(100, Math.round((used / todayBudget) * 100)) : 0;
      document.getElementById('budgetBar').style.width = pct + '%';
      document.getElementById('budgetPct').textContent = pct + '%';
      document.getElementById('freeFit').textContent = used <= 100000 ? 'Fits Free daily quotas' : 'Workers Paid recommended';

      const rows = document.getElementById('monitorRows');
      rows.innerHTML = monitors.map((monitor) => rowHtml(monitor, latestByMonitor.get(monitor.id) || [], summary.regions.length)).join('');
      rows.querySelectorAll('tr[data-monitor]').forEach((row) => {
        row.addEventListener('click', () => {
          state.selected = row.getAttribute('data-monitor');
          render();
        });
      });
      renderDetail(summary, latestByMonitor);
    }

    function filteredMonitors(summary) {
      const query = document.getElementById('search').value.trim().toLowerCase();
      const filter = document.getElementById('statusFilter').value;
      const latestByMonitor = groupLatest(summary.latest);
      return summary.monitors.filter((monitor) => {
        const latest = latestByMonitor.get(monitor.id) || [];
        const isDown = latest.some((item) => !item.ok);
        if (filter === 'up' && isDown) return false;
        if (filter === 'down' && !isDown) return false;
        return !query || monitor.name.toLowerCase().includes(query) || monitor.url.toLowerCase().includes(query);
      });
    }

    function rowHtml(monitor, latest, regionCount) {
      const failing = latest.filter((item) => !item.ok).length;
      const checked = latest.length;
      const statusClass = failing ? 'down' : checked ? 'up' : 'warn';
      const last = latest[0]?.checkedAt ? relativeTime(latest[0].checkedAt) : 'never';
      const latency = median(latest.map((item) => item.latencyMs).filter(Number.isFinite));
      const coverageBlocks = Array.from({ length: Math.min(18, regionCount) }, (_, index) => '<span class="block ' + (index < checked ? 'on' : '') + '"></span>').join('');
      const budgetPct = Math.min(100, Math.round((checked / Math.max(1, monitor.dailyBudget)) * 100));
      return '<tr data-monitor="' + esc(monitor.id) + '" class="' + (state.selected === monitor.id ? 'selected' : '') + '">' +
        '<td><span class="dot ' + statusClass + '"></span></td>' +
        '<td><div class="monitor-name"><strong>' + esc(monitor.name) + '</strong><span>' + esc(monitor.method) + ' / ' + esc(monitor.url) + '</span></div></td>' +
        '<td>' + esc(last) + '</td>' +
        '<td><span class="spark"></span> <strong>' + (latency ? latency + ' ms' : '-') + '</strong></td>' +
        '<td><div>' + checked + ' / ' + regionCount + '</div><div class="regions-mini">' + coverageBlocks + '</div></td>' +
        '<td><div class="progress"><div class="progress-track"><span style="width:' + budgetPct + '%"></span></div><strong>' + esc(String(monitor.dailyBudget)) + '</strong></div></td>' +
      '</tr>';
    }

    function renderDetail(summary, latestByMonitor) {
      const monitor = summary.monitors.find((item) => item.id === state.selected) || summary.monitors[0];
      const grid = document.getElementById('regionGrid');
      const timeline = document.getElementById('timeline');
      if (!monitor) {
        document.getElementById('detailName').textContent = 'No monitor';
        document.getElementById('detailStatus').textContent = 'Idle';
        document.getElementById('detailUrl').textContent = 'Create a monitor to start collecting edge data.';
        document.getElementById('detailKv').innerHTML = '';
        grid.innerHTML = summary.regions.slice(0, 32).map((region) => '<div class="region-chip"><span class="dot warn"></span>' + esc(region.id.toUpperCase()) + '</div>').join('');
        timeline.innerHTML = '<div class="notice">No incidents yet.</div>';
        return;
      }
      const latest = latestByMonitor.get(monitor.id) || [];
      const failing = latest.filter((item) => !item.ok);
      document.getElementById('detailName').textContent = monitor.name;
      document.getElementById('detailUrl').textContent = monitor.url;
      const badge = document.getElementById('detailStatus');
      badge.textContent = failing.length ? 'Down' : latest.length ? 'Up' : 'Idle';
      badge.className = 'badge ' + (failing.length ? 'down' : '');
      document.getElementById('coverageText').textContent = latest.length + ' / ' + summary.regions.length;
      document.getElementById('detailKv').innerHTML = kv('Status', badge.textContent) + kv('Method', monitor.method) + kv('Last Check', latest[0] ? relativeTime(latest[0].checkedAt) : 'never') + kv('Timeout', monitor.timeoutMs + ' ms') + kv('Daily Budget', monitor.dailyBudget) + kv('Expected', monitor.expectedStatusMin + '-' + monitor.expectedStatusMax);
      const latestRegionIds = new Set(latest.map((item) => item.regionId));
      const failingRegionIds = new Set(failing.map((item) => item.regionId));
      grid.innerHTML = summary.regions.slice(0, 48).map((region) => {
        const cls = failingRegionIds.has(region.id) ? 'down' : latestRegionIds.has(region.id) ? 'up' : 'warn';
        return '<div class="region-chip"><span class="dot ' + cls + '"></span>' + esc(region.id.toUpperCase()) + '</div>';
      }).join('');
      const incidents = summary.incidents.filter((incident) => incident.monitorId === monitor.id);
      timeline.innerHTML = incidents.length ? incidents.map((incident) => '<div class="event"><div class="event-icon">!</div><div><strong>' + esc(incident.severity) + '</strong><span>' + esc(incident.summary) + ' / ' + relativeTime(incident.openedAt) + '</span></div></div>').join('') : '<div class="event"><div class="event-icon">OK</div><div><strong>No open incidents</strong><span>Latest region results look healthy.</span></div></div>';
    }

    function groupLatest(items) {
      const map = new Map();
      for (const item of items) {
        const list = map.get(item.monitorId) || [];
        list.push(item);
        list.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
        map.set(item.monitorId, list);
      }
      return map;
    }
    function kv(label, value) { return '<div><span>' + esc(label) + '</span><strong>' + esc(String(value)) + '</strong></div>'; }
    function median(values) {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return Math.round(sorted[Math.floor(sorted.length / 2)]);
    }
    function relativeTime(iso) {
      const delta = Date.now() - new Date(iso).getTime();
      if (delta < 60000) return Math.max(1, Math.round(delta / 1000)) + 's ago';
      if (delta < 3600000) return Math.round(delta / 60000) + 'm ago';
      if (delta < 86400000) return Math.round(delta / 3600000) + 'h ago';
      return Math.round(delta / 86400000) + 'd ago';
    }
    function esc(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function toast(message) {
      const node = document.getElementById('toast');
      node.textContent = message;
      node.style.display = 'block';
      setTimeout(() => { node.style.display = 'none'; }, 4200);
    }
    loadSummary().catch((error) => toast(error.message));
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char] ?? char;
  });
}
