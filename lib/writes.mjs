// What your app writes into its own folder during a run is put back when the run ends. A run
// creates carts, tickets and uploads by the hundred; an app that keeps them in files beside its
// code kept every one after the run, and the developer's own tests read them. The hook the app
// was started with records each file the app writes while a run is on, with a copy from before
// its first write, and the command that reads the run's end puts every one back and says which.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const writesDirOf = (home) => join(home, "writes");

// A run has started: from now until it ends, the hook records what the app writes.
export function markRun(dir, jobId) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fresh */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "run"), String(jobId), { mode: 0o600 });
}

// The run has ended: every file it wrote is put back, and the line says which. Nothing happens
// for a run that is not the one marked, so an old id read late never undoes a newer run's work.
export function putBack(dir, root, jobId) {
  let rows = [];
  try {
    if (readFileSync(join(dir, "run"), "utf8").trim() !== String(jobId)) return "";
    rows = readFileSync(join(dir, "written.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { /* the run wrote nothing */ }
  const base = resolve(root);
  const done = [];
  for (const row of rows) {
    if (typeof row.path !== "string" || done.includes(row.path)) continue;
    const abs = resolve(base, row.path);
    if (!abs.startsWith(base + sep)) continue;
    try {
      if (row.before) { if (!existsSync(row.before)) continue; mkdirSync(dirname(abs), { recursive: true }); copyFileSync(row.before, abs); }
      else if (existsSync(abs)) unlinkSync(abs);
      done.push(row.path);
    } catch { /* left as the run left it, and not named as put back */ }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  return saidOf(done);
}

export function saidOf(paths) {
  if (!paths.length) return "";
  const named = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  return paths.length === 1
    ? `Your app wrote to ${named} during this run; it was put back to what it was before it.`
    : `Your app wrote to ${named} during this run; all were put back to what they were before it.`;
}
