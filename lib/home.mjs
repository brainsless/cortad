import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// What this machine keeps between sessions, per project, under ~/.cortad/<project>/: the key the
// first connect left behind, the digest of the tree last uploaded, which process is holding the app
// up, and the run this machine asked for last. The folder's path never leaves the machine; the
// project is a hash of it.
export const projectOf = (root) => createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
export const homeOf = (project, base = join(homedir(), ".cortad")) => join(base, project);

const read = (file) => { try { return readFileSync(file, "utf8").trim() || null; } catch { return null; } };
const write = (dir, name, text) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, name), text, { mode: 0o600 }); };

export const readToken = (project, base) => read(join(homeOf(project, base), "token"));
export const writeToken = (project, token, base) => write(homeOf(project, base), "token", token);

export const readDigest = (project, base) => read(join(homeOf(project, base), "digest"));
export const writeDigest = (project, digest, base) => write(homeOf(project, base), "digest", digest);

// The process holding this project's app up for runs, if one is alive. A pid that no longer answers
// is a stale file, not a runner.
export function readRunner(project, base) {
  const raw = read(join(homeOf(project, base), "runner.json"));
  if (!raw) return null;
  let runner;
  try { runner = JSON.parse(raw); } catch { return null; }
  if (!Number.isInteger(runner?.pid)) return null;
  try { process.kill(runner.pid, 0); return runner; } catch { return null; }
}
export const writeRunner = (project, runner, base) => write(homeOf(project, base), "runner.json", JSON.stringify(runner));
export const clearRunner = (project, base) => { try { rmSync(join(homeOf(project, base), "runner.json")); } catch { /* gone */ } };

export function readPending(project, base) {
  const raw = read(join(homeOf(project, base), "pending.json"));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export const writePending = (project, pending, base) => write(homeOf(project, base), "pending.json", JSON.stringify(pending));

export const hasHome = (base = join(homedir(), ".cortad")) => existsSync(base);
