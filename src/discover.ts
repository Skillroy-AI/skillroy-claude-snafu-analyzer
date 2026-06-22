/** Locate Claude Code transcript "buckets" (per-project folders) and their session files. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BucketInfo {
  /** Encoded directory name, e.g. "-Users-me-Projects-foo". */
  bucket: string;
  dir: string;
  sessionFiles: string[];
  /** Absolute path to the bucket's memory/ dir, if present. */
  memoryDir: string | null;
}

/** Root that holds one sub-directory per project. Override with SNAFU_PROJECTS_DIR. */
export function projectsRoot(): string {
  return process.env.SNAFU_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
}

export function listBuckets(root = projectsRoot()): BucketInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const buckets: BucketInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(dir, f));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const memoryDir = path.join(dir, "memory");
    buckets.push({
      bucket: e.name,
      dir,
      sessionFiles: files,
      memoryDir: fs.existsSync(memoryDir) ? memoryDir : null,
    });
  }
  return buckets;
}
