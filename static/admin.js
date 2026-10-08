const TOKEN_KEY = "gridcontrol_admin_token";
const MAX_HISTORY = 180; // samples kept for charts (~9 min at 3s)

function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
function setToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}
const $ = (id) => document.getElementById(id);

const app = {
  tab: "overview",
  timers: [],
  state: null,          // latest /api/state
  logEntries: [],
  feedbackEntries: [],
  history: [],          // chart samples
  logFilter: "all",
  agentRunning: null,   // true | false | null (unknown)
  agentSupported: true,
  anomalies: [],        // active injected anomalies
  settingsLoaded: false,
};

/* ───────────── views ───────────── */

function showOnly(view) {
  $("checkingView").hidden = view !== "checking";
  $("loginView").hidden = view !== "login";
  $("adminView").hidden = view !== "admin";
  $("agentPill").hidden = view !== "admin";
}

function showLoginView(message = "") {
  stopPolling();
  showOnly("login");
  $("loginError").textContent = message;
}

function showAdminView() {
  showOnly("admin");
  switchTab(app.tab);
  startPolling();
}

/* ───────────── auth ───────────── */

async function authedFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers, { Authorization: `Bearer ${getToken()}` });
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    clearToken();
    showLoginView("Session expired — please sign in again.");
    throw new Error("unauthorized");
  }
  return res;
}

// Confirm a stored token really works before showing any admin content.
async function checkExistingSession() {
  const token = getToken();
  if (!token) return showLoginView();
  try {
    const res = await fetch("/api/admin/donts", { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) showAdminView();
    else { clearToken(); showLoginView(); }
  } catch (e) {
    clearToken();
    showLoginView("Could not reach the server — please sign in again.");
  }
}

$("loginBtn").addEventListener("click", async () => {
  const username = $("username").value.trim();
  const password = $("password").value;
  const errBox = $("loginError");
  errBox.textContent = "";
  if (!username || !password) { errBox.textContent = "Enter both a user ID and password."; return; }
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) { errBox.textContent = "Invalid user ID or password."; return; }
    const data = await res.json();
    setToken(data.token);
    $("password").value = "";
    showAdminView();
  } catch (e) {
    errBox.textContent = "Could not reach the server.";
  }
});
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });

$("signOutBtn").addEventListener("click", () => {
  clearToken();
  app.history = [];
  app.settingsLoaded = false;
  showLoginView();
});

/* ───────────── tabs ───────────── */

function switchTab(name) {
  app.tab = name;
  document.querySelectorAll(".tab").forEach((el) => { el.hidden = el.id !== `tab-${name}`; });
  document.querySelectorAll(".nav-item[data-tab]").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === name);
  });
  renderActiveTab();
  if (name === "controls" && !app.settingsLoaded) loadSettings();
  if (name === "approvals") loadWarnings();
  if (name === "guardrails") { loadRules(); loadPolicies(); }
}

$("sideNav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item[data-tab]");
  if (btn) switchTab(btn.dataset.tab);
});

function renderActiveTab() {
  switch (app.tab) {
    case "overview": renderOverview(); break;
    case "log": renderLog(); break;
    case "outcomes": renderOutcomes(); break;
    case "hotspots": renderHotspots(); break;
    case "charts": renderCharts(); break;
    case "controls": renderAgentControls(); renderAnomalies(); break;
  }
}

/* ───────────── polling ───────────── */

function startPolling() {
  stopPolling();
  pollState(); pollLog(); pollFeedback(); pollAgent(); pollAnomalies(); loadWarnings();
  app.timers.push(setInterval(pollState, 3000));
  app.timers.push(setInterval(pollLog, 3000));
  app.timers.push(setInterval(pollFeedback, 5000));
  app.timers.push(setInterval(pollAgent, 3000));
  app.timers.push(setInterval(pollAnomalies, 2000));
  app.timers.push(setInterval(loadWarnings, 3000));
}
function stopPolling() {
  app.timers.forEach(clearInterval);
  app.timers = [];
}

async function pollState() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const data = await res.json();
    app.state = data;
    recordSample(data);
    renderActiveTab();
  } catch (e) { /* retry next tick */ }
}

async function pollLog() {
  try {
    const res = await fetch("/api/log", { cache: "no-store" });
    app.logEntries = (await res.json()).entries || [];
    if (app.tab === "log" || app.tab === "charts" || app.tab === "overview") renderActiveTab();
  } catch (e) {}
}

async function pollFeedback() {
  try {
    const res = await fetch("/api/feedback", { cache: "no-store" });
    app.feedbackEntries = (await res.json()).entries || [];
    if (app.tab === "outcomes") renderOutcomes();
  } catch (e) {}
}

/* ───────────── data helpers ───────────── */

function allChips(snapshot) {
  const out = [];
  for (const [rid, region] of Object.entries((snapshot && snapshot.regions) || {})) {
    for (const [sid, server] of Object.entries(region.servers || {})) {
      for (const [cid, chip] of Object.entries(server.chipsets || {})) {
        out.push({ rid, sid, cid, chip });
      }
    }
  }
  return out;
}
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const threshold = () => (app.state && app.state.temp_threshold_c) || 68;

function regionStats(rid, region) {
  const chips = [];
  for (const server of Object.values(region.servers || {})) chips.push(...Object.values(server.chipsets || {}));
  return {
    util: avg(chips.map((c) => c.utilization)) * 100,
    temp: avg(chips.map((c) => c.temperature_c)),
    tasks: chips.reduce((s, c) => s + c.active_tasks, 0),
  };
}

function recordSample(data) {
  const snapshot = data.snapshot || {};
  const chips = allChips(snapshot);
  if (!chips.length) return;
  const temps = chips.map((c) => c.chip.temperature_c);
  const regionUtil = {};
  for (const [rid, region] of Object.entries(snapshot.regions || {})) regionUtil[rid] = regionStats(rid, region).util;
  app.history.push({
    avgTemp: avg(temps),
    maxTemp: Math.max(...temps),
    tasks: chips.reduce((s, c) => s + c.chip.active_tasks, 0),
    regionUtil,
  });
  if (app.history.length > MAX_HISTORY) app.history.shift();
}

/* ───────────── 1. overview ───────────── */

function statCard(label, value, cls = "") {
  return `<div class="stat-card"><div class="lbl">${escapeHtml(label)}</div><div class="val ${cls}">${escapeHtml(value)}</div></div>`;
}

function renderOverview() {
  const data = app.state;
  if (!data) return;
  const snapshot = data.snapshot || {};
  const chips = allChips(snapshot);
  const temps = chips.map((c) => c.chip.temperature_c);
  const maxTemp = temps.length ? Math.max(...temps) : 0;
  const hotCount = chips.filter((c) => c.chip.temperature_c >= threshold()).length;
  const warnings = Number(data.open_warning_count || 0);

  const agentText = app.agentRunning === null ? "Unknown" : app.agentRunning ? "Running" : "Paused";
  const agentCls = app.agentRunning ? "good" : app.agentRunning === false ? "warn" : "";
  const next = app.agentRunning === false ? "Paused" : `${Math.max(0, data.next_decision_in || 0)}s`;

  $("ovStats").innerHTML = [
    statCard("Agent", agentText, agentCls),
    statCard("Next decision", next),
    statCard("Active tasks", chips.reduce((s, c) => s + c.chip.active_tasks, 0)),
    statCard("Avg temp", `${avg(temps).toFixed(1)}°C`),
    statCard("Hottest chip", `${maxTemp.toFixed(0)}°C`, maxTemp >= threshold() ? "bad" : ""),
    statCard("Chips over limit", hotCount, hotCount ? "bad" : "good"),
    statCard("Open warnings", warnings, warnings ? "warn" : "good"),
    statCard("Active anomalies", app.anomalies.length, app.anomalies.length ? "bad" : "good"),
    statCard("Decisions logged", app.logEntries.length),
  ].join("");

  const rows = Object.entries(snapshot.regions || {}).map(([rid, region]) => {
    const s = regionStats(rid, region);
    return `<tr>
      <td>${escapeHtml(rid)}</td>
      <td>${escapeHtml(region.energy_source)}</td>
      <td>$${escapeHtml(region.electricity_price)}</td>
      <td>${escapeHtml(region.carbon_g_per_kwh)}</td>
      <td>${s.util.toFixed(0)}%</td>
      <td>${s.temp.toFixed(1)}°C</td>
      <td>${s.tasks}</td>
    </tr>`;
  }).join("");
  $("ovRegions").innerHTML = `<thead><tr><th>Region</th><th>Energy</th><th>Price/kWh</th><th>gCO₂/kWh</th><th>Avg util</th><th>Avg temp</th><th>Tasks</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ───────────── 2. approvals ───────────── */

async function loadWarnings() {
  try {
    const res = await authedFetch("/api/admin/warnings");
    const data = await res.json();
    const count = data.warnings.length;
    $("navWarnBadge").hidden = count === 0;
    $("navWarnBadge").textContent = count;

    if (app.tab !== "approvals") return;
    const list = $("warningsList");
    if (!count) {
      list.innerHTML = '<p class="empty">No open warnings — the agent has stayed within its allowed bounds.</p>';
      return;
    }
    list.innerHTML = data.warnings.map((w) => `
      <div class="warn-card">
        <div class="warn-reason"><b>${escapeHtml(w.action)}</b> — ${escapeHtml(w.reason)}</div>
        <pre>${escapeHtml(JSON.stringify(w.payload, null, 2))}</pre>
        <div class="warn-actions">
          <button class="approve" data-id="${escapeHtml(w.id)}" data-decision="approved">Approve</button>
          <button class="deny" data-id="${escapeHtml(w.id)}" data-decision="denied">Deny</button>
        </div>
      </div>`).join("");
    list.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await authedFetch(`/api/admin/warnings/${btn.dataset.id}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: btn.dataset.decision }),
        });
        loadWarnings();
      });
    });
  } catch (e) { /* handled in authedFetch */ }
}

/* ───────────── 3. guardrails ───────────── */

async function loadRules() {
  try {
    const res = await authedFetch("/api/admin/donts");
    const data = await res.json();
    const list = $("rulesList");
    if (!data.rules.length) {
      list.innerHTML = '<p class="empty">No rules set yet.</p>';
      return;
    }
    list.innerHTML = data.rules.map((r) => `
      <div class="rule-row">
        <span>${escapeHtml(r)}</span>
        <button data-rule="${escapeHtml(r)}">Remove</button>
      </div>`).join("");
    list.querySelectorAll("button[data-rule]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await authedFetch("/api/admin/donts", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rule: btn.dataset.rule }),
        });
        loadRules();
      });
    });
  } catch (e) {}
}

async function addRule() {
  const input = $("newRule");
  const rule = input.value.trim();
  if (!rule) return;
  await authedFetch("/api/admin/donts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rule }),
  });
  input.value = "";
  loadRules();
}
$("addRuleBtn").addEventListener("click", addRule);
$("newRule").addEventListener("keydown", (e) => { if (e.key === "Enter") addRule(); });

async function loadPolicies() {
  try {
    const res = await authedFetch("/api/admin/policies");
    if (res.status === 404 || res.status === 405) { showNotice("policiesNotice", MISSING); return; }
    const data = await res.json();
    showNotice("policiesNotice", "");
    const list = $("policiesList");
    list.innerHTML = data.policies.map((p) => `
      <div class="policy-row">
        <div>
          <div class="policy-name">${escapeHtml(p.action)}</div>
          <div class="hint">${escapeHtml(p.description || "")}</div>
        </div>
        ${p.locked
          ? '<span class="lock-tag">🔒 Always needs approval</span>'
          : `<select class="${escapeHtml(p.mode)}" data-action="${escapeHtml(p.action)}">
               <option value="autonomous" ${p.mode === "autonomous" ? "selected" : ""}>Agent can run it</option>
               <option value="approval" ${p.mode === "approval" ? "selected" : ""}>Needs admin approval</option>
             </select>`}
      </div>`).join("");
    list.querySelectorAll("select[data-action]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        sel.className = sel.value;
        const res2 = await authedFetch("/api/admin/policies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: sel.dataset.action, mode: sel.value }),
        });
        if (!res2.ok) showNotice("policiesNotice", `Could not save (HTTP ${res2.status}).`);
        loadPolicies();
      });
    });
  } catch (e) {}
}

/* ───────────── 4. decision log ───────────── */

function entryStatus(entry) {
  return entry.error ? "error" : (entry.result && entry.result.status) || "unknown";
}
function tagFor(status) {
  if (status === "executed" || status === "executed_by_admin") return ["tag-executed", "executed"];
  if (status === "passed") return ["tag-passed", "passed"];
  if (status === "blocked_for_admin") return ["tag-blocked", "blocked"];
  return ["tag-error", "error"];
}

$("logFilters").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  app.logFilter = btn.dataset.filter;
  document.querySelectorAll("#logFilters .chip-btn").forEach((b) => b.classList.toggle("active", b === btn));
  renderLog();
});
$("logSearch").addEventListener("input", renderLog);

function renderLog() {
  const q = $("logSearch").value.trim().toLowerCase();
  const filter = app.logFilter;
  const entries = app.logEntries.filter((entry) => {
    const status = entryStatus(entry);
    if (filter !== "all") {
      const ok = filter === "executed" ? (status === "executed" || status === "executed_by_admin") : status === filter;
      if (!ok) return false;
    }
    if (!q) return true;
    const hay = JSON.stringify([entry.error, entry.decision]).toLowerCase();
    return hay.includes(q);
  });

  $("logCount").textContent = `${entries.length} of ${app.logEntries.length} entries`;
  const list = $("logList");
  if (!entries.length) {
    list.innerHTML = '<div class="log-empty">No matching entries.</div>';
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const status = entryStatus(entry);
    const [tagCls, tagLabel] = tagFor(status);
    const time = new Date(entry.timestamp * 1000).toLocaleTimeString();
    if (entry.error) {
      return `<div class="log-entry error">
        <div class="log-meta"><span class="log-time">${time}</span><span class="log-action-tag tag-error">ERROR</span></div>
        <div class="log-reasoning">${escapeHtml(entry.error)}</div></div>`;
    }
    const d = entry.decision || {};
    const params = d.params && Object.keys(d.params).length ? `<div class="log-params">${escapeHtml(JSON.stringify(d.params))}</div>` : "";
    const entryCls = tagLabel === "executed" ? "executed" : tagLabel === "passed" ? "passed" : tagLabel === "blocked" ? "blocked" : "error";
    return `<div class="log-entry ${entryCls}">
      <div class="log-meta">
        <span class="log-time">${time} · ${escapeHtml(d.action || "—")}</span>
        <span class="log-action-tag ${tagCls}">${tagLabel}</span>
      </div>
      <div class="log-reasoning">${escapeHtml(d.reasoning || "")}</div>${params}
    </div>`;
  }).join("");
}

/* ───────────── 5. outcomes ───────────── */

const LOWER_IS_BETTER = ["temperature_c", "utilization", "carbon_g_per_kwh", "electricity_price"];
function deltaClass(key, value) {
  if (value === 0 || value === null) return "delta-neutral";
  const good = LOWER_IS_BETTER.includes(key) ? value < 0 : value > 0;
  return good ? "delta-good" : "delta-bad";
}

function renderOutcomes() {
  const entries = app.feedbackEntries;
  let helped = 0, hurt = 0;
  for (const e of entries) {
    const deltas = Object.entries(e.delta || {});
    const score = deltas.reduce((s, [k, v]) => s + (v === 0 ? 0 : deltaClass(k, v) === "delta-good" ? 1 : -1), 0);
    if (score > 0) helped++; else if (score < 0) hurt++;
  }
  $("outSummary").innerHTML = [
    statCard("Measured actions", entries.length),
    statCard("Mostly helped", helped, helped ? "good" : ""),
    statCard("Mostly hurt", hurt, hurt ? "bad" : ""),
  ].join("");

  const list = $("feedbackList");
  if (!entries.length) {
    list.innerHTML = '<div class="log-empty">Outcomes appear about 30s after executed actions.</div>';
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const chips = Object.entries(entry.delta || {}).map(([k, v]) =>
      `<span class="delta-chip ${deltaClass(k, v)}">${escapeHtml(k)} ${v > 0 ? "+" : ""}${escapeHtml(v)}</span>`).join("");
    return `<div class="feedback-entry">
      <div class="feedback-action">${escapeHtml(entry.action)} → ${escapeHtml(entry.target || "—")}</div>
      <div class="feedback-deltas">${chips}</div></div>`;
  }).join("");
}

/* ───────────── 6. hot spots ───────────── */

function hotRow(name, sub, temp) {
  const isAnomaly = app.anomalies.some((a) => a.chipset_id === name);
  const limit = threshold();
  const cls = temp >= limit ? "hot" : temp >= limit - 8 ? "warm" : "";
  const pct = Math.max(4, Math.min(100, (temp / (limit + 12)) * 100));
  return `<div class="hot-row ${cls}">
    <span class="hot-name">${escapeHtml(name)}${isAnomaly ? '<span class="anom-tag">ANOMALY</span>' : ""} <small>${escapeHtml(sub)}</small></span>
    <span class="hot-temp">${temp.toFixed(0)}°C</span>
    <div class="hot-bar"><i style="width:${pct}%"></i></div></div>`;
}

function renderHotspots() {
  if (!app.state) return;
  const snapshot = app.state.snapshot || {};
  const chips = allChips(snapshot).sort((a, b) => b.chip.temperature_c - a.chip.temperature_c).slice(0, 10);
  $("hotChips").innerHTML = chips.length
    ? chips.map((c) => hotRow(c.cid, `${c.sid} · ${c.chip.active_tasks} tasks`, c.chip.temperature_c)).join("")
    : '<p class="empty">No data yet.</p>';

  const servers = [];
  const regions = [];
  for (const [rid, region] of Object.entries(snapshot.regions || {})) {
    for (const [sid, server] of Object.entries(region.servers || {})) {
      servers.push({ sid, rid, temp: avg(Object.values(server.chipsets || {}).map((c) => c.temperature_c)) });
    }
    regions.push({ rid, temp: regionStats(rid, region).temp });
  }
  servers.sort((a, b) => b.temp - a.temp);
  regions.sort((a, b) => b.temp - a.temp);
  $("hotServers").innerHTML = servers.slice(0, 6).map((s) => hotRow(s.sid, s.rid, s.temp)).join("") || '<p class="empty">No data yet.</p>';
  $("hotRegions").innerHTML = regions.map((r) => hotRow(r.rid, "", r.temp)).join("") || '<p class="empty">No data yet.</p>';
}

/* ───────────── 7. charts (plain SVG, no libraries) ───────────── */

const PALETTE = ["#00d9ff", "#10b981", "#f59e0b", "#a78bfa", "#ef4444", "#3b82f6"];

function lineChart(series, opts = {}) {
  const W = 560, H = 190, L = 38, R = 10, T = 10, B = 18;
  const n = Math.max(...series.map((s) => s.values.length), 0);
  if (n < 2) return '<p class="empty">Collecting data…</p>';

  const all = series.flatMap((s) => s.values);
  if (opts.threshold != null) all.push(opts.threshold);
  let lo = opts.min != null ? opts.min : Math.min(...all);
  let hi = opts.max != null ? opts.max : Math.max(...all);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const pad = (hi - lo) * 0.1;
  if (opts.min == null) lo -= pad;
  if (opts.max == null) hi += pad;

  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  let g = "";
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--border)" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" style="fill:var(--text-3)">${v.toFixed(opts.decimals ?? 0)}</text>`;
  }
  if (opts.threshold != null) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(opts.threshold)}" y2="${y(opts.threshold)}" stroke="#ef4444" stroke-dasharray="4 4" stroke-width="1"/>`;
  }
  const lines = series.map((s, idx) => {
    const color = s.color || PALETTE[idx % PALETTE.length];
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  }).join("");
  const legend = series.length > 1 || opts.threshold != null
    ? `<div class="chart-legend">${series.map((s, idx) => `<span><i style="background:${s.color || PALETTE[idx % PALETTE.length]}"></i>${escapeHtml(s.name)}</span>`).join("")}${opts.threshold != null ? '<span><i style="background:#ef4444"></i>limit</span>' : ""}</div>`
    : "";
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">${g}${lines}</svg>${legend}`;
}

function barList(counts, color) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="empty">No decisions yet.</p>';
  const max = Math.max(...entries.map((e) => e[1]));
  return entries.map(([k, v]) => `<div class="bar-row"><span>${escapeHtml(k)}</span><div class="bar"><i style="width:${(v / max) * 100}%;${color ? `background:${color}` : ""}"></i></div><span>${v}</span></div>`).join("");
}

function renderCharts() {
  const h = app.history;
  $("chTemp").innerHTML = lineChart(
    [{ name: "Average", values: h.map((s) => s.avgTemp), color: "#00d9ff" },
     { name: "Hottest chip", values: h.map((s) => s.maxTemp), color: "#f59e0b" }],
    { threshold: threshold(), decimals: 0 });
  $("chTasks").innerHTML = lineChart([{ name: "Tasks", values: h.map((s) => s.tasks), color: "#10b981" }], { min: 0, decimals: 0 });

  const rids = h.length ? Object.keys(h[h.length - 1].regionUtil) : [];
  $("chUtil").innerHTML = lineChart(
    rids.map((rid, i) => ({ name: rid, values: h.map((s) => s.regionUtil[rid] ?? 0), color: PALETTE[i % PALETTE.length] })),
    { min: 0, max: 100, decimals: 0 });

  const results = {}, actions = {};
  for (const e of app.logEntries) {
    const [, label] = tagFor(entryStatus(e));
    results[label] = (results[label] || 0) + 1;
    if (e.decision && e.decision.action) actions[e.decision.action] = (actions[e.decision.action] || 0) + 1;
  }
  $("chResults").innerHTML = barList(results);
  $("chActions").innerHTML = barList(actions, "#a78bfa");
}

/* ───────────── 8. agent control & settings ───────────── */

function showNotice(id, text) {
  const el = $(id);
  el.hidden = !text;
  el.textContent = text || "";
}
const MISSING = "The backend endpoint for this isn't added yet — see the setup notes for the routes to add to your server.";

async function pollAgent() {
  try {
    const res = await authedFetch("/api/admin/agent");
    if (res.status === 404 || res.status === 405) { app.agentSupported = false; app.agentRunning = null; }
    else {
      const data = await res.json();
      app.agentSupported = true;
      app.agentRunning = !!data.running;
    }
  } catch (e) { return; }
  renderAgentPill();
  if (app.tab === "controls") renderAgentControls();
}

function renderAgentPill() {
  const label = app.agentRunning === null ? "Agent: unknown" : app.agentRunning ? "Agent running" : "Agent paused";
  const cls = app.agentRunning === null ? "" : app.agentRunning ? "running" : "paused";
  for (const id of ["agentPill", "agentPillBig"]) {
    const el = $(id);
    el.textContent = label;
    el.className = `agent-pill ${id === "agentPillBig" ? "big " : ""}${cls}`;
  }
}

function renderAgentControls() {
  renderAgentPill();
  $("pauseBtn").disabled = !app.agentSupported || app.agentRunning !== true;
  $("resumeBtn").disabled = !app.agentSupported || app.agentRunning !== false;
  showNotice("agentNotice", app.agentSupported ? "" : MISSING);
}

async function setAgent(action) {
  $("pauseBtn").disabled = true;
  $("resumeBtn").disabled = true;
  try {
    const res = await authedFetch(`/api/admin/agent/${action}`, { method: "POST" });
    if (!res.ok) showNotice("agentNotice", `Could not ${action} the agent (HTTP ${res.status}).`);
    else showNotice("agentNotice", "");
  } catch (e) {}
  pollAgent();
}
$("pauseBtn").addEventListener("click", () => setAgent("pause"));
$("resumeBtn").addEventListener("click", () => setAgent("resume"));

async function loadSettings() {
  try {
    const res = await authedFetch("/api/admin/settings");
    if (res.status === 404 || res.status === 405) { showNotice("settingsNotice", MISSING); $("saveSettingsBtn").disabled = true; return; }
    const s = await res.json();
    $("setTemp").value = s.temp_threshold_c;
    $("setImb").value = s.util_imbalance_threshold;
    $("setProfit").value = s.min_net_profit;
    $("setInterval").value = s.decision_interval_seconds;
    $("saveSettingsBtn").disabled = false;
    showNotice("settingsNotice", "");
    app.settingsLoaded = true;
  } catch (e) {}
}

$("saveSettingsBtn").addEventListener("click", async () => {
  const msg = $("settingsMsg");
  msg.className = "save-msg";
  msg.textContent = "";
  const body = {
    temp_threshold_c: Number($("setTemp").value),
    util_imbalance_threshold: Number($("setImb").value),
    min_net_profit: Number($("setProfit").value),
    decision_interval_seconds: Number($("setInterval").value),
  };
  if (Object.values(body).some((v) => Number.isNaN(v))) {
    msg.className = "save-msg err";
    msg.textContent = "Fill in every field with a number.";
    return;
  }
  try {
    const res = await authedFetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try { const d = await res.json(); detail = d.detail || d.error || ""; } catch (e) {}
      msg.className = "save-msg err";
      msg.textContent = `Not saved${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ` (HTTP ${res.status})`}`;
      return;
    }
    msg.textContent = "Saved.";
    app.settingsLoaded = false;
    loadSettings();
    setTimeout(() => { msg.textContent = ""; }, 3000);
  } catch (e) {}
});

/* ───────────── anomaly test ───────────── */

async function pollAnomalies() {
  try {
    const res = await authedFetch("/api/admin/anomalies");
    if (res.status === 404 || res.status === 405) { showNotice("anomalyNotice", MISSING); $("anomalyBtn").disabled = true; return; }
    app.anomalies = (await res.json()).anomalies || [];
    if (app.tab === "controls" || app.tab === "overview" || app.tab === "hotspots") {
      renderAnomalies();
      if (app.tab !== "controls") renderActiveTab();
    }
  } catch (e) {}
}

function renderAnomalies() {
  $("anomalyList").innerHTML = app.anomalies.map((a) => `
    <div class="anomaly-row">
      <span><b>${a.temperature_c.toFixed(0)}°C</b> ${escapeHtml(a.chipset_id)} <small>${escapeHtml(a.region_id)}</small></span>
      <small>clears in ${a.seconds_left}s or when the agent moves a task off it</small>
    </div>`).join("");
  $("anomalyClearBtn").disabled = app.anomalies.length === 0;
}

$("anomalyBtn").addEventListener("click", async () => {
  const msg = $("anomalyMsg");
  msg.className = "save-msg";
  msg.textContent = "";
  $("anomalyBtn").disabled = true;
  try {
    const res = await authedFetch("/api/admin/anomaly", { method: "POST" });
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    msg.textContent = `Injected on ${d.chipset_id}.` + (d.agent_running ? "" : " Agent is paused — resume it to let it respond.");
    if (!d.agent_running) msg.className = "save-msg err";
    pollAnomalies();
  } catch (e) {
    msg.className = "save-msg err";
    msg.textContent = "Could not inject an anomaly.";
  }
  $("anomalyBtn").disabled = false;
});

$("anomalyClearBtn").addEventListener("click", async () => {
  await authedFetch("/api/admin/anomaly/clear", { method: "POST" });
  $("anomalyMsg").textContent = "";
  pollAnomalies();
});

/* ───────────── start ───────────── */

showOnly("checking");
checkExistingSession();
