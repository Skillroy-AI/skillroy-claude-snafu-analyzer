"use strict";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  sessions: [],
  findings: [],
  claudeFindings: [],
  selected: null,
  tab: "snafus",
  browseProject: null,
  browseProjects: [],
};

const fmtTime = (iso) => {
  if (!iso) return "?";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const fmtMs = (ms) => (ms ? fmtTime(new Date(ms).toISOString()) : "?");
const cssId = (s) => String(s).replace(/[^a-z0-9]/gi, "_");
const shortCwd = (p) => {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return (parts.length > 3 ? "…/" : "/") + parts.slice(-3).join("/");
};
const scope = () => {
  const u = new URLSearchParams();
  for (const k of ["project", "from", "to", "q"]) {
    const v = $(k).value.trim();
    if (v) u.set(k, v);
  }
  return u;
};

// --- loading ---------------------------------------------------------------

async function loadProjects() {
  const { projects } = await (await fetch("/api/projects")).json();
  const sel = $("project");
  for (const p of projects) {
    const o = el("option");
    o.value = p.bucket;
    o.textContent = `${shortCwd(p.label)}  (${p.sessionCount})${p.cwdCount > 1 ? "  ⚠︎" : ""}`;
    sel.appendChild(o);
  }
}

async function scan() {
  const q = scope().toString();
  $("count").textContent = "loading…";
  const [sessRes, snafuRes] = await Promise.all([
    fetch("/api/sessions?" + q).then((r) => r.json()),
    fetch("/api/snafus?" + q).then((r) => r.json()),
  ]);
  state.sessions = sessRes.sessions;
  state.findings = snafuRes.findings;
  state.claudeFindings = [];
  $("count").textContent = `${state.sessions.length} sessions`;
  renderSummary();
  renderList();
  renderSnafus();
  if (state.tab === "memory") renderMemory();
  if (state.tab === "browse") renderBrowse();
}

async function selectSession(id) {
  closeInvestigate(); // if an evidence link was clicked inside the modal, surface the session behind it
  state.selected = id;
  renderList();
  setTab("session");
  const panel = $("tab-session");
  panel.innerHTML = '<p class="muted">loading…</p>';
  const { session, findings } = await (await fetch("/api/sessions/" + id)).json();
  renderSession(session, findings);
}

async function analyze() {
  const btn = $("analyze");
  const avail = await (await fetch("/api/claude/available")).json();
  if (!avail.available) {
    alert("The `claude` CLI isn't available on this machine, so the semantic pass is disabled.\nDeterministic findings are still shown.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Analyzing… (can take a minute)";
  try {
    const res = await (await fetch("/api/analyze?" + scope().toString(), { method: "POST" })).json();
    if (res.error && (!res.findings || !res.findings.length)) alert("Claude pass: " + res.error);
    state.claudeFindings = res.findings || [];
    setTab("snafus");
    renderSummary();
    renderSnafus();
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze with Claude";
  }
}

// --- rendering -------------------------------------------------------------

function renderSummary() {
  const all = [...state.findings, ...state.claudeFindings];
  const by = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of all) by[f.severity] = (by[f.severity] || 0) + 1;
  const c = $("summary");
  c.innerHTML = "";
  if (!all.length) {
    c.appendChild(el("span", "muted", "No findings in scope yet — hit Scan."));
    return;
  }
  for (const sev of ["high", "medium", "low", "info"]) {
    if (!by[sev]) continue;
    const p = el("span", "pill " + sev, `${by[sev]} ${sev}`);
    p.style.cursor = "pointer";
    p.onclick = () => setTab("snafus");
    c.appendChild(p);
  }
  if (state.claudeFindings.length) c.appendChild(el("span", "pill claude", `${state.claudeFindings.length} from Claude`));
}

function renderList() {
  const c = $("sessions");
  c.innerHTML = "";
  if (!state.sessions.length) {
    c.appendChild(el("div", "empty", "No sessions match this scope."));
    return;
  }
  for (const s of state.sessions) {
    const row = el("div", "srow" + (s.id === state.selected ? " sel" : ""));
    const sigs = Object.entries(s.signalCounts || {})
      .map(([t, n]) => `<span class="chip">${t}:${n}</span>`)
      .join("");
    const flags = (s.snafuFlags || []).map((f) => `<span class="chip flag ${f}">${f}</span>`).join("");
    const warn = s.cwdDiverged
      ? ' <span title="cwd diverged mid-session (possible move/mis-start)">⚠︎</span>'
      : s.movedMidSession
        ? ' <span title="cd into subfolder during session">↳</span>'
        : "";
    row.innerHTML =
      `<div class="top"><span class="title">${esc(s.title)}</span><span class="when">${fmtTime(s.firstTs)}</span></div>` +
      `<div class="cwd" title="${esc((s.cwds || []).map((x) => x.cwd).join("  |  "))}">${esc(shortCwd(s.primaryCwd))}${warn}</div>` +
      `<div class="meta"><span class="chip">${s.roundCount} rounds</span><span class="chip">${s.assistantMsgCount} asst</span>${flags}${sigs}</div>`;
    row.onclick = () => selectSession(s.id);
    c.appendChild(row);
  }
}

function findingCard(f) {
  const card = el("div", "finding");
  card.innerHTML =
    `<h3><span class="sev ${f.severity}">${f.severity}</span> ${esc(f.title)} <span class="src">${f.source}</span></h3>` +
    `<div class="detail-text">${esc(f.detail)}</div>` +
    (f.suggestion ? `<div class="sugg">→ ${esc(f.suggestion)}</div>` : "");
  if (f.evidence && f.evidence.length) {
    const ev = el("div", "ev");
    for (const e of f.evidence) {
      const a = el("a", null, esc(e.snippet));
      a.onclick = () => selectSession(e.sessionId);
      ev.appendChild(el("div", null, `<span class="muted">[${e.sessionId.slice(0, 8)}${e.round != null ? " r" + e.round : ""}]</span> `));
      ev.lastChild.appendChild(a);
    }
    card.appendChild(ev);
  }
  return card;
}

function renderSnafus() {
  const c = $("tab-snafus");
  c.innerHTML = "";
  const all = [...state.claudeFindings, ...state.findings];
  if (!all.length) {
    c.appendChild(el("div", "empty", "Nothing flagged in this scope. Adjust dates/project and Scan, or run Analyze with Claude."));
    return;
  }
  for (const f of all) c.appendChild(findingCard(f));
}

function renderSession(s, findings) {
  const c = $("tab-session");
  c.innerHTML = "";
  const kv = el("div", "kv");
  kv.innerHTML =
    `<div class="k">title</div><div class="v">${esc(s.title)}</div>` +
    `<div class="k">session</div><div class="v">${esc(s.id)}</div>` +
    `<div class="k">when</div><div class="v">${fmtTime(s.firstTs)} → ${fmtTime(s.lastTs)} (${Math.round((s.durationMs || 0) / 60000)} min)</div>` +
    `<div class="k">cwd(s)</div><div class="v">${esc((s.cwds || []).map((x) => `${x.cwd} (${x.count})`).join("\n"))}</div>` +
    `<div class="k">branch</div><div class="v">${esc((s.gitBranches || []).join(", "))}</div>` +
    `<div class="k">tools</div><div class="v">${esc(Object.entries(s.toolCounts || {}).map(([t, n]) => `${t}:${n}`).join("  "))}</div>`;
  c.appendChild(kv);

  if (findings && findings.length) {
    c.appendChild(el("h3", null, "Findings for this session"));
    for (const f of findings) c.appendChild(findingCard(f));
  }

  c.appendChild(el("h3", null, "Rounds"));
  for (const r of s.rounds) {
    if (r.source === "meta" && !r.assistantSummary && !r.toolCalls.length) continue;
    const d = el("div", "round");
    const sigs = (r.signals || []).map((g) => `<span class="sig ${g.type}" title="${esc(g.text)}">${g.type}</span>`).join("");
    const tools = (r.toolCalls || []).map((t) => t.name + (t.target ? `(${t.target})` : "")).join("  ");
    d.innerHTML =
      `<div><span class="you">${r.source === "command" ? "⌘ command" : "You"}</span> <span class="ts">${fmtTime(r.userTs)}</span></div>` +
      `<div class="ask">${esc(r.userPrompt) || '<span class="muted">(no prompt text)</span>'}</div>` +
      (r.assistantSummary ? `<div class="sum">${esc(r.assistantSummary)}</div>` : "") +
      (tools ? `<div class="tools">⚙ ${esc(tools)}</div>` : "") +
      (sigs ? `<div class="sigs">${sigs}</div>` : "");
    c.appendChild(d);
  }
}

async function renderMemory() {
  const c = $("tab-memory");
  c.innerHTML = '<p class="muted">loading…</p>';
  const proj = $("project").value.trim();
  const { memory } = await (await fetch("/api/memory" + (proj ? "?project=" + encodeURIComponent(proj) : ""))).json();
  c.innerHTML = "";
  const files = memory
    .flatMap((m) => m.files.map((f) => ({ ...f, bucket: m.bucket })))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0)); // newest-modified first
  if (!files.length) {
    c.appendChild(el("div", "empty", "No memory files found for this project scope."));
    return;
  }
  for (const f of files) {
    const box = el("div", "memfile");
    box.appendChild(el("h4", null, `${esc(f.name)} <span class="b-mtime">${fmtMs(f.mtimeMs)}</span>`));
    box.appendChild(el("pre", null, esc(f.text)));
    c.appendChild(box);
  }
}

// --- browse (prompts + associated memory, back in time) --------------------

function rangeParams() {
  const u = new URLSearchParams();
  for (const k of ["from", "to"]) {
    const v = $(k).value.trim();
    if (v) u.set(k, v);
  }
  return u;
}

async function renderBrowse() {
  const c = $("tab-browse");
  c.innerHTML =
    '<div class="browse-pick"><span class="muted">Projects in range</span>' +
    '<div id="browse-chips" class="browse-chips"><span class="muted">loading…</span></div></div>' +
    '<div id="browse-body" class="browse-body"></div>';
  const { projects } = await (await fetch("/api/projects-in-range?" + rangeParams().toString())).json();
  state.browseProjects = projects || [];
  if (!state.browseProjects.length) {
    $("browse-chips").innerHTML = '<span class="muted">none</span>';
    $("browse-body").innerHTML = el(
      "div",
      "empty",
      "No projects had sessions in this date range. Widen the From / To dates above and reopen Browse.",
    ).outerHTML;
    return;
  }
  // keep current pick if still valid, else prefer the header's selected project, else the first.
  let sel = state.browseProject;
  if (!sel || !state.browseProjects.some((p) => p.bucket === sel)) {
    const g = $("project").value.trim();
    sel = state.browseProjects.some((p) => p.bucket === g) ? g : state.browseProjects[0].bucket;
  }
  state.browseProject = sel;
  renderBrowseChips();
  loadBrowseBody();
}

function renderBrowseChips() {
  const chips = $("browse-chips");
  chips.innerHTML = "";
  for (const p of state.browseProjects) {
    const b = el(
      "button",
      "browse-chip" + (p.bucket === state.browseProject ? " on" : ""),
      `${esc(shortCwd(p.label))} <span class="n">${p.sessionCount}</span>` +
        (p.cwdCount > 1 ? ' <span class="n warn">⚠</span>' : "") +
        (p.hasMemory ? ' <span class="n">mem</span>' : ""),
    );
    b.onclick = () => {
      state.browseProject = p.bucket;
      renderBrowseChips();
      loadBrowseBody();
    };
    chips.appendChild(b);
  }
}

async function loadBrowseBody() {
  const body = $("browse-body");
  body.innerHTML = '<p class="muted">loading…</p>';
  const u = rangeParams();
  u.set("project", state.browseProject);
  try {
    const data = await (await fetch("/api/browse?" + u.toString())).json();
    renderBrowseData(data);
  } catch (e) {
    body.innerHTML = `<div class="empty">Could not load: ${esc(String(e))}</div>`;
  }
}

function renderBrowseData(d) {
  const body = $("browse-body");
  body.innerHTML = "";
  const grid = el("div", "browse-grid");

  // Left column: prompts grouped by session, newest session first.
  const left = el("div", "browse-col");
  left.appendChild(el("h3", null, `Your prompts <span class="muted">(newest first)</span>`));
  const sessions = d.sessions || [];
  if (!sessions.length) left.appendChild(el("div", "empty", "No prompts from you in this range."));
  for (const s of sessions) {
    const sc = el("div", "b-session");
    const head = el("div", "b-shead");
    head.innerHTML =
      `<span class="b-title">${esc(s.title)}</span><span class="when">${fmtTime(s.firstTs)}</span>` +
      `<div class="b-cwd">${esc(shortCwd(s.primaryCwd))}${s.cwdDiverged ? " ⚠︎" : ""}</div>`;
    const open = el("a", "b-open", "open session →");
    open.onclick = () => selectSession(s.id);
    head.appendChild(open);
    sc.appendChild(head);
    for (const p of s.prompts || []) {
      const pr = el("div", "b-prompt");
      pr.innerHTML = `<div class="b-when">${fmtTime(p.ts)}</div><div class="b-text">${esc(p.text)}</div>`;
      if (p.memoryWrites && p.memoryWrites.length) {
        const mw = el("div", "b-mw");
        for (const name of p.memoryWrites) {
          const chip = el("button", "mw-chip", "📝 " + esc(name));
          chip.title = "Jump to this memory document";
          chip.onclick = () => focusMemory(name);
          mw.appendChild(chip);
        }
        pr.appendChild(mw);
      }
      sc.appendChild(pr);
    }
    left.appendChild(sc);
  }

  // Right column: the project's memory, newest-modified first, with backlinks to the writing prompt.
  const right = el("div", "browse-col");
  right.appendChild(el("h3", null, `Memory documents <span class="muted">(newest first)</span>`));
  const writers = {};
  for (const s of sessions)
    for (const p of s.prompts || [])
      for (const n of p.memoryWrites || []) (writers[n] = writers[n] || []).push(`${s.id.slice(0, 8)} r${p.round}`);
  const memory = d.memory || [];
  if (!memory.length) right.appendChild(el("div", "empty", "No memory documents for this project."));
  for (const m of memory) {
    const card = el("div", "memfile b-mem");
    card.id = "mem-" + cssId(m.name);
    const back = writers[m.name]
      ? `<span class="b-writers" title="written/edited by these prompts">↩ ${esc(writers[m.name].join(", "))}</span>`
      : "";
    card.innerHTML = `<h4>${esc(m.name)} <span class="b-mtime">${fmtMs(m.mtimeMs)}</span>${back}</h4><pre>${esc(m.text)}</pre>`;
    right.appendChild(card);
  }

  grid.appendChild(left);
  grid.appendChild(right);
  body.appendChild(grid);
}

function focusMemory(name) {
  const card = $("mem-" + cssId(name));
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1200);
}

// --- investigate modal -----------------------------------------------------

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// datetime-local is in the user's LOCAL zone; transcripts are UTC — convert before sending.
function isoOrUndef(localStr) {
  if (!localStr) return undefined;
  const d = new Date(localStr);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function openInvestigate() {
  const f = $("from").value;
  const t = $("to").value;
  $("inv-from").value = f ? f + "T00:00" : toLocalInput(new Date(Date.now() - 30 * 864e5));
  $("inv-to").value = t ? t + "T23:59" : toLocalInput(new Date());
  $("inv-results").innerHTML = "";
  $("inv-status").textContent = "";
  $("modal").classList.remove("hidden");
}
function closeInvestigate() {
  $("modal").classList.add("hidden");
}

function updateInvRun() {
  const anyProj = document.querySelectorAll("#inv-projects input:checked").length > 0;
  const hasIssue = $("inv-issue").value.trim().length > 0;
  $("inv-run").disabled = !(anyProj && hasIssue);
}

async function invFindProjects() {
  const c = $("inv-projects");
  c.className = "inv-projects muted";
  c.textContent = "Finding…";
  const u = new URLSearchParams();
  const f = isoOrUndef($("inv-from").value);
  const t = isoOrUndef($("inv-to").value);
  if (f) u.set("from", f);
  if (t) u.set("to", t);
  const { projects } = await (await fetch("/api/projects-in-range?" + u.toString())).json();
  c.innerHTML = "";
  if (!projects.length) {
    c.className = "inv-projects muted";
    c.textContent = "No projects had sessions in that range.";
    updateInvRun();
    return;
  }
  c.className = "inv-projects";
  for (const p of projects) {
    const lab = el("label", "proj");
    lab.innerHTML =
      `<input type="checkbox" value="${esc(p.bucket)}" />` +
      `<span class="pcwd">${esc(shortCwd(p.label))}</span>` +
      `<span class="pmeta">${p.sessionCount} sess${p.cwdCount > 1 ? " · ⚠ co-mingled" : ""}${p.hasMemory ? " · mem" : ""}</span>`;
    lab.querySelector("input").addEventListener("change", updateInvRun);
    c.appendChild(lab);
  }
  updateInvRun();
}

async function invRun() {
  const projects = [...document.querySelectorAll("#inv-projects input:checked")].map((i) => i.value);
  const issue = $("inv-issue").value.trim();
  if (!projects.length || !issue) return;
  const body = { from: isoOrUndef($("inv-from").value), to: isoOrUndef($("inv-to").value), projects, issue };
  const btn = $("inv-run");
  btn.disabled = true;
  $("inv-status").textContent = "Investigating… Claude is reading the selected sessions (can take a minute).";
  $("inv-results").innerHTML = "";
  try {
    const res = await (await fetch("/api/investigate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    renderInvResults(res);
  } catch (e) {
    $("inv-results").innerHTML = `<div class="empty">Request failed: ${esc(String(e))}</div>`;
  } finally {
    $("inv-status").textContent = "";
    updateInvRun();
  }
}

function renderInvResults(res) {
  const c = $("inv-results");
  c.innerHTML = "";
  if (!res.available) {
    c.appendChild(el("div", "empty", `The <code>claude</code> CLI isn't available, so investigation is disabled.<br>${esc(res.error || "")}`));
    return;
  }
  const findings = res.findings || [];
  if (res.error && !findings.length) {
    c.appendChild(el("div", "empty", esc(res.error)));
    if (res.raw) {
      const pre = el("pre");
      pre.textContent = res.raw;
      c.appendChild(pre);
    }
    return;
  }
  if (res.summary) c.appendChild(el("div", "inv-summary", esc(res.summary)));
  if (res.capped) c.appendChild(el("div", "muted", `Limited to the ${res.sessionCount} most recent sessions in range (${res.capped} older omitted).`));
  if (!findings.length) {
    c.appendChild(el("div", "muted", "Claude found no issue matching that description."));
    return;
  }
  for (const f of findings) c.appendChild(findingCard(f));
}

// --- tabs / wiring ---------------------------------------------------------

function setTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const t of ["snafus", "browse", "session", "memory"]) $("tab-" + t).classList.toggle("hidden", t !== name);
  if (name === "memory") renderMemory();
  if (name === "browse") renderBrowse();
}

function init() {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 864e5);
  $("to").value = to.toISOString().slice(0, 10);
  $("from").value = from.toISOString().slice(0, 10);
  $("scan").onclick = scan;
  $("analyze").onclick = analyze;
  $("project").addEventListener("change", () => {
    state.browseProject = $("project").value.trim() || null; // keep Browse in step with the header
    scan(); // changing project re-scans (SNAFUs + list) immediately
  });
  $("q").addEventListener("keydown", (e) => e.key === "Enter" && scan());
  for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => setTab(b.dataset.tab);

  // investigate modal
  $("investigate-open").onclick = openInvestigate;
  $("modal-close").onclick = closeInvestigate;
  $("inv-find").onclick = invFindProjects;
  $("inv-run").onclick = invRun;
  $("inv-issue").addEventListener("input", updateInvRun);
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeInvestigate(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInvestigate(); });

  loadProjects().then(scan);
}
init();
