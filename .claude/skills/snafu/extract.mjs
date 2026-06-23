#!/usr/bin/env node
/*
 * Self-contained (zero-dependency) extractor for the `snafu` skill.
 * Mirrors the analyzer's narration logic so a one-off investigation needs no server.
 *
 *   node extract.mjs --list [--from ISO] [--to ISO]
 *       → JSON list of projects that have sessions (optionally within a range).
 *
 *   node extract.mjs --project <substr> [--last N | --from ISO --to ISO | --sessions id,id]
 *   node extract.mjs --bucket  <exact>  [--last N | --from ISO --to ISO | --sessions id,id]
 *       → a NARRATION PACK (human prompts + Claude's text, tool I/O stripped) for the
 *         selected sessions, followed by that project's current memory files.
 *
 * Groups sessions by their real cwd (the transcript-folder name is a lossy cwd encoding) and
 * hides the analyzer's own `claude -p` sub-runs (which log under the OS temp dir).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const ROOT = process.env.SNAFU_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
const TEMP = (() => {
  const s = new Set([os.tmpdir()]);
  try {
    s.add(fs.realpathSync(os.tmpdir()));
  } catch {}
  return [...s];
})();
const isTemp = (cwd) => TEMP.some((p) => cwd === p || cwd.startsWith(p + "/"));
const normTo = (to) => (to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to + "T23:59:59.999Z" : to);
const overlaps = (s, from, to) => {
  const toN = normTo(to);
  if (from && (s.lastTs || "") < from) return false;
  if (toN && (s.firstTs || "") > toN) return false;
  return true;
};
const dominant = (cwds) => [...cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

function listBuckets() {
  let ents = [];
  try {
    ents = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = path.join(ROOT, e.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const memDir = path.join(dir, "memory");
    out.push({ bucket: e.name, dir, files, memDir: fs.existsSync(memDir) ? memDir : null });
  }
  return out;
}

const WRAP =
  /<command-name>[\s\S]*?<\/command-name>|<command-message>[\s\S]*?<\/command-message>|<command-args>[\s\S]*?<\/command-args>|<local-command-stdout>[\s\S]*?<\/local-command-stdout>|<local-command-stdout>[\s\S]*$|<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<system-reminder>[\s\S]*?<\/system-reminder>/g;

function userText(content) {
  let text = "";
  let hasTR = false;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    for (const b of content) {
      if (b && b.type === "text" && typeof b.text === "string") text += (text ? "\n\n" : "") + b.text;
      else if (b && b.type === "tool_result") hasTR = true;
    }
  const cmd = (text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/) || [])[1];
  const residual = text.replace(WRAP, "").trim();
  if (hasTR && !residual) return null;
  if (cmd) return cmd.trim() + (residual ? `  —  ${residual}` : "");
  if (/^#{1,3}\s*Context Usage\b/.test(residual) || /^Caveat:/.test(residual)) return null;
  return residual || null;
}

function lightScan(file) {
  const raw = fs.readFileSync(file, "utf8");
  let firstTs, lastTs, title = "", firstUser = "";
  const cwds = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.timestamp) {
      if (!firstTs || d.timestamp < firstTs) firstTs = d.timestamp;
      if (!lastTs || d.timestamp > lastTs) lastTs = d.timestamp;
    }
    if (typeof d.cwd === "string") cwds.set(d.cwd, (cwds.get(d.cwd) || 0) + 1);
    if (d.type === "ai-title" && d.aiTitle) title = d.aiTitle;
    if (!firstUser && d.message && d.message.role === "user") {
      const t = userText(d.message.content);
      if (t) firstUser = t.slice(0, 200);
    }
  }
  const id = path.basename(file).replace(/\.jsonl$/, "");
  return { id, file, firstTs, lastTs, cwds, title: title || firstUser.slice(0, 70) || "(untitled)" };
}

function narration(file, perBlockCap = 3000) {
  const raw = fs.readFileSync(file, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = d.message;
    if (!msg) continue;
    if (msg.role === "user") {
      const t = userText(msg.content);
      if (t) out.push({ role: "user", text: t.slice(0, perBlockCap) });
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content)
        if (b && b.type === "text" && typeof b.text === "string" && b.text.trim())
          out.push({ role: "assistant", text: b.text.slice(0, perBlockCap) });
    }
  }
  return out;
}

function readMemory(memDir) {
  if (!memDir) return [];
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        try {
          let t = fs.readFileSync(p, "utf8");
          if (t.length > 64000) t = t.slice(0, 64000) + "\n…(truncated)";
          out.push({ name: path.relative(memDir, p), text: t });
        } catch {}
      }
    }
  };
  walk(memDir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function summarize(b) {
  const scans = b.files.map(lightScan).filter((s) => {
    const keys = [...s.cwds.keys()];
    return !(keys.length > 0 && keys.every(isTemp)); // hide temp-only sub-runs
  });
  const cwds = new Map();
  for (const s of scans) for (const [c, n] of s.cwds) if (!isTemp(c)) cwds.set(c, (cwds.get(c) || 0) + n);
  return { ...b, scans, cwds, label: dominant(cwds) || b.bucket };
}

// --- main ------------------------------------------------------------------

const from = opt("from");
const to = opt("to");
const buckets = listBuckets().map(summarize);

if (has("list") || args.length === 0) {
  const projects = [];
  for (const b of buckets) {
    const inr = b.scans.filter((s) => overlaps(s, from, to));
    if (!inr.length) continue;
    let f, l;
    for (const s of inr) {
      if (s.firstTs && (!f || s.firstTs < f)) f = s.firstTs;
      if (s.lastTs && (!l || s.lastTs > l)) l = s.lastTs;
    }
    projects.push({ bucket: b.bucket, label: b.label, sessionCount: inr.length, firstTs: f, lastTs: l, hasMemory: readMemory(b.memDir).length > 0 });
  }
  projects.sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
  console.log(JSON.stringify({ projects }, null, 2));
  process.exit(0);
}

// resolve target bucket(s)
let targets = [];
const bucketArg = opt("bucket");
const projArg = opt("project");
if (bucketArg) targets = buckets.filter((b) => b.bucket === bucketArg);
else if (projArg) {
  const q = projArg.toLowerCase();
  const matches = buckets.filter((b) => b.label.toLowerCase().includes(q) || b.bucket.toLowerCase().includes(q));
  if (matches.length === 0) {
    console.error(`No project matches "${projArg}". Run with --list to see options.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    const exact = matches.filter((b) => path.basename(b.label) === projArg);
    if (exact.length === 1) targets = exact;
    else {
      console.log(JSON.stringify({ ambiguous: true, candidates: matches.map((b) => ({ bucket: b.bucket, label: b.label, sessionCount: b.scans.length })) }, null, 2));
      process.exit(2);
    }
  } else targets = matches;
} else {
  console.error("Specify --list, --project <substr>, or --bucket <bucket>.");
  process.exit(1);
}

// gather + filter sessions
let sessions = targets.flatMap((b) => b.scans.map((s) => ({ ...s, memDir: b.memDir })));
const idsArg = opt("sessions");
if (idsArg) {
  const want = idsArg.split(",").map((x) => x.trim()).filter(Boolean);
  sessions = sessions.filter((s) => want.some((w) => s.id.startsWith(w)));
} else {
  sessions = sessions.filter((s) => overlaps(s, from, to));
}
sessions.sort((a, b) => (a.firstTs || "").localeCompare(b.firstTs || ""));
const lastN = opt("last");
if (lastN) sessions = sessions.slice(-Number(lastN));
if (!sessions.length) {
  console.error("No sessions matched that scope.");
  process.exit(1);
}

// emit narration pack
const lines = [`# NARRATION PACK — ${sessions.length} session(s), tool input/output removed\n`];
for (const s of sessions) {
  const cw = [...s.cwds.keys()].filter((c) => !isTemp(c)).join("  |  ") || dominant(s.cwds) || "?";
  lines.push(`### SESSION ${s.id.slice(0, 8)}  ${s.firstTs || "?"}  "${s.title}"`);
  lines.push(`cwd: ${cw}`);
  for (const it of narration(s.file)) lines.push(`${it.role === "user" ? "USER" : "CLAUDE"}: ${it.text}`);
  lines.push("");
}
const seen = new Set();
const mems = [];
for (const b of targets) for (const m of readMemory(b.memDir)) {
  const k = b.bucket + "/" + m.name;
  if (!seen.has(k)) {
    seen.add(k);
    mems.push(m);
  }
}
if (mems.length) {
  lines.push(`=== CURRENT MEMORY FILES (may have been corrected AFTER the sessions above) ===`);
  for (const m of mems) lines.push(`\n## ${m.name}\n${m.text}`);
}
console.log(lines.join("\n"));
