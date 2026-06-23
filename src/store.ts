/** Discovers buckets, parses sessions (cached by file mtime), and answers scoped queries. */
import fs from "node:fs";
import os from "node:os";
import { listBuckets, projectsRoot, type BucketInfo } from "./discover.js";
import { parseSessionFile } from "./parse.js";
import { readMemory } from "./memory.js";
import type { MemoryBundle, SessionDetail, SessionSummary } from "./types.js";

export interface Scope {
  from?: string;
  to?: string;
  project?: string;
  q?: string;
}

function normalizeTo(to?: string): string | undefined {
  if (!to) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? to + "T23:59:59.999Z" : to;
}

export class Store {
  root: string;
  private buckets: BucketInfo[] = [];
  private cache = new Map<string, { mtimeMs: number; session: SessionDetail }>();
  private memoryByBucket = new Map<string, MemoryBundle>();
  private fileToBucket = new Map<string, string>();

  constructor(root = projectsRoot()) {
    this.root = root;
    this.refresh();
  }

  refresh(): void {
    this.buckets = listBuckets(this.root);
    this.memoryByBucket.clear();
    this.fileToBucket.clear();
    for (const b of this.buckets) {
      this.memoryByBucket.set(b.bucket, readMemory(b.bucket, b.memoryDir));
      for (const f of b.sessionFiles) this.fileToBucket.set(f, b.bucket);
    }
  }

  private parse(file: string, bucket: string): SessionDetail | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.session;
    try {
      const session = parseSessionFile(file, bucket);
      this.cache.set(file, { mtimeMs: st.mtimeMs, session });
      return session;
    } catch {
      return null;
    }
  }

  // The OS temp dir, in both the plain and realpath'd forms (macOS reports /var/... but records
  // /private/var/...). Used to hide the analyzer's OWN `claude -p` sub-runs, which log transcripts
  // under the temp dir and would otherwise show up as a junk "project".
  private tempPrefixes: string[] = (() => {
    const set = new Set<string>([os.tmpdir()]);
    try {
      set.add(fs.realpathSync(os.tmpdir()));
    } catch {
      /* ignore */
    }
    return [...set];
  })();

  private isTempCwd(cwd: string): boolean {
    return this.tempPrefixes.some((p) => cwd === p || cwd.startsWith(p + "/"));
  }

  /** A session is hidden if every cwd it ran in is under the OS temp dir (i.e. a sub-Claude run). */
  private hidden(s: SessionDetail): boolean {
    return s.cwds.length > 0 && s.cwds.every((c) => this.isTempCwd(c.cwd));
  }

  allSessions(project?: string): SessionDetail[] {
    const out: SessionDetail[] = [];
    for (const b of this.buckets) {
      if (project && b.bucket !== project) continue;
      for (const f of b.sessionFiles) {
        const s = this.parse(f, b.bucket);
        if (s && !this.hidden(s)) out.push(s);
      }
    }
    return out;
  }

  scoped(scope: Scope): SessionDetail[] {
    const to = normalizeTo(scope.to);
    const from = scope.from;
    const q = scope.q?.toLowerCase();
    return this.allSessions(scope.project)
      .filter((s) => {
        if (from && (s.lastTs || "") < from) return false;
        if (to && (s.firstTs || "") > to) return false;
        if (q) {
          const hay = [s.title, s.firstUserPrompt, s.lastAssistantSummary, s.primaryCwd, s.id].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (a.firstTs || "").localeCompare(b.firstTs || ""));
  }

  private overlaps(s: SessionDetail, from?: string, to?: string): boolean {
    const toN = normalizeTo(to);
    if (from && (s.lastTs || "") < from) return false;
    if (toN && (s.firstTs || "") > toN) return false;
    return true;
  }

  /** Projects (buckets) that have at least one session overlapping [from,to]. */
  projectsInRange(from?: string, to?: string) {
    const out: {
      bucket: string;
      label: string;
      sessionCount: number;
      cwdCount: number;
      firstTs?: string;
      lastTs?: string;
      hasMemory: boolean;
    }[] = [];
    for (const b of this.buckets) {
      const inr = b.sessionFiles
        .map((f) => this.parse(f, b.bucket))
        .filter((s): s is SessionDetail => !!s && !this.hidden(s) && this.overlaps(s, from, to));
      if (inr.length === 0) continue;
      const cwds = new Map<string, number>();
      let firstTs: string | undefined;
      let lastTs: string | undefined;
      for (const s of inr) {
        for (const c of s.cwds) cwds.set(c.cwd, (cwds.get(c.cwd) || 0) + c.count);
        if (s.firstTs && (!firstTs || s.firstTs < firstTs)) firstTs = s.firstTs;
        if (s.lastTs && (!lastTs || s.lastTs > lastTs)) lastTs = s.lastTs;
      }
      out.push({
        bucket: b.bucket,
        label: [...cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || b.bucket,
        sessionCount: inr.length,
        cwdCount: cwds.size,
        firstTs,
        lastTs,
        hasMemory: (this.memoryByBucket.get(b.bucket)?.files.length || 0) > 0,
      });
    }
    return out.sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
  }

  /** All sessions across the given buckets that overlap [from,to], chronological. */
  sessionsForProjects(projects: string[], from?: string, to?: string): SessionDetail[] {
    const set = new Set(projects);
    const out: SessionDetail[] = [];
    for (const b of this.buckets) {
      if (!set.has(b.bucket)) continue;
      for (const f of b.sessionFiles) {
        const s = this.parse(f, b.bucket);
        if (s && !this.hidden(s) && this.overlaps(s, from, to)) out.push(s);
      }
    }
    return out.sort((a, b) => (a.firstTs || "").localeCompare(b.firstTs || ""));
  }

  sessionById(id: string): SessionDetail | null {
    for (const [file, bucket] of this.fileToBucket) {
      if (file.endsWith(`/${id}.jsonl`)) return this.parse(file, bucket);
    }
    return null;
  }

  memory(project?: string): MemoryBundle[] {
    const out: MemoryBundle[] = [];
    for (const [bucket, m] of this.memoryByBucket) {
      if (project && bucket !== project) continue;
      out.push(m);
    }
    return out;
  }

  memoryMap(): Map<string, MemoryBundle> {
    return this.memoryByBucket;
  }

  /** Project list with a friendly label = the dominant real cwd across the bucket's sessions. */
  projects(): {
    bucket: string;
    label: string;
    sessionCount: number;
    cwdCount: number;
    firstTs?: string;
    lastTs?: string;
    hasMemory: boolean;
  }[] {
    return this.buckets
      .map((b) => {
        const sessions = (b.sessionFiles.map((f) => this.parse(f, b.bucket)).filter(Boolean) as SessionDetail[]).filter(
          (s) => !this.hidden(s),
        );
        const cwds = new Map<string, number>();
        let firstTs: string | undefined;
        let lastTs: string | undefined;
        for (const s of sessions) {
          for (const c of s.cwds) cwds.set(c.cwd, (cwds.get(c.cwd) || 0) + c.count);
          if (s.firstTs && (!firstTs || s.firstTs < firstTs)) firstTs = s.firstTs;
          if (s.lastTs && (!lastTs || s.lastTs > lastTs)) lastTs = s.lastTs;
        }
        const label = [...cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || b.bucket;
        return {
          bucket: b.bucket,
          label,
          sessionCount: sessions.length,
          cwdCount: cwds.size,
          firstTs,
          lastTs,
          hasMemory: (this.memoryByBucket.get(b.bucket)?.files.length || 0) > 0,
        };
      })
      .filter((p) => p.sessionCount > 0)
      .sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
  }
}

export function toSummary(s: SessionDetail, snafuFlags: string[]): SessionSummary {
  const { rounds, signals, cwdTimeline, ...summary } = s;
  return { ...summary, snafuFlags };
}
