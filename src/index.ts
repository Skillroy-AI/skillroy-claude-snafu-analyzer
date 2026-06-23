#!/usr/bin/env node
/** CLI bootstrap: start the local SNAFU analyzer web server. */
import { Store } from "./store.js";
import { createServer } from "./server.js";
import { projectsRoot } from "./discover.js";

function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const port = Number(arg("port") || process.env.PORT || 4999);
const root = arg("projects-dir") || projectsRoot();

const store = new Store(root);
const app = createServer(store);

const projects = store.projects();
const sessions = projects.reduce((n, p) => n + p.sessionCount, 0);

app.listen(port, () => {
  console.log(`\n  SNAFU analyzer`);
  console.log(`  ──────────────`);
  console.log(`  transcripts : ${root}`);
  console.log(`  indexed     : ${sessions} sessions across ${projects.length} projects`);
  console.log(`  open        : http://localhost:${port}\n`);
});
