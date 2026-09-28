import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// What this machine keeps between sessions, per project, under ~/.cortad/<project>/: the key the
// first connect left behind, the digest of the tree last uploaded, the app as last started, and the
// run this machine asked for last. The process holding the app up keeps its own file there
// (lib/runner.mjs). The folder's path never leaves the machine; the project is a hash of it.
export const projectOf = (root) => createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
export const homeOf = (project, base = join(homedir(), ".cortad")) => join(base, project);

const read = (file) => { try { return readFileSync(file, "utf8").trim() || null; } catch { return null; } };
const readJson = (file) => { const raw = read(file); try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const write = (dir, name, text) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, name), text, { mode: 0o600 }); };

export const readToken = (project, base) => read(join(homeOf(project, base), "token"));
export const writeToken = (project, token, base) => write(homeOf(project, base), "token", token);

export const readDigest = (project, base) => read(join(homeOf(project, base), "digest"));
export const writeDigest = (project, digest, base) => write(homeOf(project, base), "digest", digest);

// The app that runner holds up, as it noted it last (lib/fresh.mjs): when it started, whether that
// runner started it, and what its source files said then.
export const readApp = (project, base) => readJson(join(homeOf(project, base), "app.json"));
export const writeApp = (project, app, base) => write(homeOf(project, base), "app.json", JSON.stringify(app));

export const readPending = (project, base) => readJson(join(homeOf(project, base), "pending.json"));
export const writePending = (project, pending, base) => write(homeOf(project, base), "pending.json", JSON.stringify(pending));

export const hasHome = (base = join(homedir(), ".cortad")) => existsSync(base);
