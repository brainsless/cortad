import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

// What the server told this machine while no agent was listening (a run ending), kept until the
// hook hands it to the agent on its next prompt or edit, or the agent reads that run itself. Each
// line is said once. Where no hook ever takes it, only the latest lines stay.
const NEWS_KEPT = 20;
const newsFile = (project, base) => join(homeOf(project, base), "news.txt");
const newsOf = (file) => (read(file) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const keepNews = (project, lines, base) => write(homeOf(project, base), "news.txt", `${lines.join("\n")}\n`);
export function addNews(project, line, base) {
  const file = newsFile(project, base);
  mkdirSync(homeOf(project, base), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${line}\n`, { mode: 0o600 });
  const lines = newsOf(file);
  if (lines.length > NEWS_KEPT) keepNews(project, lines.slice(-NEWS_KEPT), base);
}
// Renamed before it is read: two hooks firing together say each line once between them.
export function takeNews(project, base) {
  const taken = `${newsFile(project, base)}.${process.pid}`;
  try { renameSync(newsFile(project, base), taken); } catch { return []; }
  const lines = newsOf(taken);
  rmSync(taken, { force: true });
  return lines;
}
/** The agent has read this run itself: the line kept to tell it of that run is dropped. */
export function dropNews(project, runId, base) {
  const lines = newsOf(newsFile(project, base));
  const kept = lines.filter((l) => !l.includes(runId));
  if (kept.length === lines.length) return;
  if (kept.length) keepNews(project, kept, base);
  else rmSync(newsFile(project, base), { force: true });
}
