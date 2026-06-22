/** Read a bucket's Claude memory (MEMORY.md + memory/*.md) for cross-checking against transcripts. */
import fs from "node:fs";
import path from "node:path";
import type { MemoryBundle, MemoryFile } from "./types.js";

const MAX_FILE = 64 * 1024;

export function readMemory(bucket: string, memoryDir: string | null): MemoryBundle {
  if (!memoryDir || !fs.existsSync(memoryDir)) return { bucket, dir: null, files: [] };
  const files: MemoryFile[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          let text = fs.readFileSync(p, "utf8");
          if (text.length > MAX_FILE) text = text.slice(0, MAX_FILE) + "\n…(truncated)";
          files.push({ name: path.relative(memoryDir, p), path: p, text });
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  };
  walk(memoryDir);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { bucket, dir: memoryDir, files };
}

/** Flattened lower-cased memory text for substring checks. */
export function memoryText(bundle: MemoryBundle): string {
  return bundle.files.map((f) => f.text).join("\n").toLowerCase();
}
