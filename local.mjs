#!/usr/bin/env node
// Cortad on your own machine. Run from your repository's root with the code the connect screen
// showed:
//   npx cortad ABCD2345   [--port 3000] [--start "npm run dev"] [--verbose]
//
// What it does: signs in with the code, uploads your source files once (never .env, never
// node_modules) so your code can be read, starts your app the way you start it, then holds one
// outbound connection open and does what a run asks: a request to your app, a file read, a shell
// line. The shell is locked by the operating system (lib/lock.mjs) and cannot write your code;
// nothing here writes your files at all. It also makes Cortad known to the coding agents on this
// machine (lib/register.mjs): an MCP entry and a skill, so `npx cortad mcp` answers them from then
// on with the key this connect leaves in ~/.cortad. Nothing here touches git. Your environment
// never leaves this machine. Ctrl-C ends everything.

import { holdsKeys, secretEnvValues } from "./lib/keys.mjs";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { COMMANDS, main as face } from "./lib/cli.mjs";
import { clearRunner, projectOf, readToken, writeDigest, writeRunner, writeToken } from "./lib/home.mjs";
import { registerAll } from "./lib/register.mjs";
import { finished } from "./lib/text.mjs";
import { lockHolds, makeLock } from "./lib/lock.mjs";
import { AS_HEADER, makeIdentities } from "./lib/mint.mjs";
import { CAPTURED, makeCapture } from "./lib/replay.mjs";
import { sampleHere } from "./lib/sample.mjs";
import { mintAcross, originFor, waitForPort } from "./lib/service.mjs";
import { listingUrl } from "./lib/listing.mjs";
import { installPlan, missingDependency, startPlan, workspaces } from "./lib/start.mjs";
import { openSwitches } from "./lib/switches.mjs";

const argv = process.argv.slice(2);
// The two faces a coding agent uses after the first connect (lib/cli.mjs): the MCP server the
// client starts on every session, and the same verbs as shell commands. Neither runs the connect
// below, and `npx cortad findings` is a verb, never a code.
if (COMMANDS.has(argv[0] ?? "")) process.exit(await face(argv));
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const verbose = argv.includes("--verbose");
// A code is eight characters from the connect screen's alphabet, which has no I, O, 0 or 1.
const code = (argv.find((a) => /^[A-HJ-NP-Za-hj-np-z2-9-]{8,9}$/.test(a) && !a.startsWith("-")) ?? "").toUpperCase().replace(/-/g, "");
const say = (line) => console.log(`cortad  ${line}`);
const fail = (line) => { console.error(`cortad  ${line}`); process.exit(1); };

const explain = argv.includes("--explain");
// Started by lib/cli.mjs for a run on a later day: no code, the key the first connect left behind.
const viaToken = argv.includes("--token");
// What is happening right now, on one line that rewrites itself. npx spends its own seconds fetching
// this package before anything here runs, and the first thing we printed used to be after the whole
// upload: a minute or more of a cursor sitting still, which reads as nothing happening.
// Without a terminal (a coding agent's shell) each new step is its own line, so the agent reading
// the output sees the folder being looked at and the upload counting up, not a two-minute blank.
let lastStep = "";
const step = (line) => {
  if (process.stdout.isTTY) { process.stdout.write(`\rcortad  ${line}\x1b[K`); return; }
  if (line !== lastStep) { lastStep = line; say(line); }
};
const clearStep = () => { if (process.stdout.isTTY) process.stdout.write("\r\x1b[K"); };
const stepDone = (line) => { clearStep(); say(line); };
if (!explain && !viaToken && !/^[A-Z0-9]{8}$/.test(code)) fail("usage: npx cortad <code from the connect screen> [--port N] [--start \"cmd\"]   |   npx cortad --explain   |   npx cortad status | run | findings | verify <id>");
// Where Brainsless is. The host is not on the command line: a code cannot point at an impostor.
const origin = new URL(process.env.CORTAD_ORIGIN || "https://cortad.com");
// Ours, and only ours. brainsless.com is the same service under its earlier name and stays trusted
// while people still hold links to it.
// The last is our own Pages project: its subdomains are our branch deploys, staging among them.
const OURS = ["cortad.com", "brainsless.com", "brainsless-frontend.pages.dev"];
const trusted = (origin.protocol === "https:" && OURS.some((host) => origin.hostname === host || origin.hostname.endsWith(`.${host}`)))
  || origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
if (!trusted) fail(`refusing: ${origin.host} is not Cortad.`);
const api = `${origin.origin}/api`;

const root = process.cwd();
const MANIFEST = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "docker-compose.yml", "docker-compose.yaml", "Gemfile", "mix.exs"];
// A repository whose root carries no manifest of its own is still a repository: crewai-examples
// keeps one project per folder under crews/, and the whole of it was refused at the door. The root
// is accepted when a project lives below it.
if (!MANIFEST.some((f) => existsSync(join(root, f))) && !workspaces(root).length) {
  fail(`no project here: this folder has no package.json or pyproject.toml, and neither does any folder in it. Run it from your repository's root: ${root}`);
}

// ---- what leaves the machine: the source git would commit, and nothing git is told to ignore
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|coverage|vendor|venv|\.venv|env|target|tmp|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.terraform|\.wrangler|\.svelte-kit|\.output|\.parcel-cache|\.idea|\.vscode|secrets?|\.secrets?)$/i;
// Env files by any name (scripts/books.env is one), keys, and data rather than code.
const SKIP_FILE = /^\.env(\..*)?$|^\.envrc$|\.env$|\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|log|lock|map|zip|tar|gz|tgz|7z|rar|png|jpe?g|gif|webp|ico|svg|mp3|mp4|wav|mov|pdf|woff2?|ttf|otf|eot|bin|exe|dll|so|dylib|wasm|onnx|pt|pth|safetensors|parquet|csv|tsv|jsonl|ndjson|xlsx?|numbers|DS_Store)$/i;
const MAX_FILE = 1_000_000;
// A JSON or YAML file this large is a dataset (exports, catalogues, fixtures), not code or a prompt,
// and datasets are where projects keep what they would never paste into a chat.
const MAX_DATA = 200_000;
const DATA_FILE = /\.(json|ya?ml)$/i;
const MANIFEST_FILE = /^(package|tsconfig|composer|app|manifest)\.json$/i;
const MAX_TOTAL = 80_000_000;
const ENV_FILE = /^\.env(\.(local|staging|stage|development|dev|test|example|sample))?$/;

function walk(dir, depth, out, envs, total) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return total; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (depth < 12 && !SKIP_DIR.test(e.name)) total = walk(full, depth + 1, out, envs, total); continue; }
    if (ENV_FILE.test(e.name)) { envs.push(full); continue; }
    if (SKIP_FILE.test(e.name)) continue;
    let size;
    try { size = statSync(full).size; } catch { continue; }
    if (size > MAX_FILE || total + size > MAX_TOTAL) continue;
    if (size > MAX_DATA && DATA_FILE.test(e.name) && !MANIFEST_FILE.test(e.name)) continue;
    if (!shareable(relative(root, full), false)) continue;
    out.push(relative(root, full));
    total += size;
  }
  return total;
}

// What git lists here: tracked files and new ones it would pick up, never an ignored one. A folder
// that is not a git repository has no such list and is read by the rules above alone.
function gitListed() {
  if (!existsSync(join(root, ".git")) && !onPath("git")) return null;
  let inside = false;
  try { inside = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true"; } catch { /* not a repository */ }
  if (!inside) return null;
  // A repository whose list cannot be read is not read by guesswork: it stops here.
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.toString().split("\0").filter(Boolean));
  } catch (e) { fail(`could not list this repository's files with git: ${e.message}`); }
}
// One rule for every file that could leave: the upload, and a read the engine asks for later.
function shareable(rel, askGit = true) {
  const parts = rel.split(sep);
  if (parts.slice(0, -1).some((d) => SKIP_DIR.test(d)) || SKIP_FILE.test(parts.at(-1))) return false;
  if (listed === null || listed.has(rel)) return true;
  // Off the list git gave a moment ago: ignored, or inside a nested checkout. The walk takes git's
  // word for it; asking per file was one process each, two minutes on a repository with a worktree
  // inside it. A read asked later, of a file made after the list was taken (an agent edit), asks.
  if (!askGit) return false;
  try { execFileSync("git", ["-C", root, "check-ignore", "-q", rel], { stdio: "ignore" }); return false; } catch (e) { return e.status === 1; }
}
let listed = null;
// Read the same way for the upload and for any read the engine asks for later.
let envKeys = [];
function carriesKey(rel) {
  try { return holdsKeys(readFileSync(join(root, rel), "utf8"), envKeys); } catch { return false; }
}

// Values from your env files, read here and only here, so nothing a command prints can carry one.
function secretValues(envFiles) {
  const values = new Set();
  for (const file of envFiles) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[1].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (v.length >= 8 && !/^(true|false|localhost|development|production|\d+)$/i.test(v)) values.add(v);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}
// Origins your environment names (FRONTEND_URL, CORS_ORIGIN, ...): an app that trusts a browser
// Origin is asked as that browser. Sent as origins only, never the variable's full value.
function envOrigins(envFiles) {
  const out = new Set();
  for (const file of envFiles) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || !/ORIGIN|URL|HOST|DOMAIN|FRONTEND|CLIENT|SITE|WEB/i.test(m[1])) continue;
      // OPENAI_BASE_URL names where a key is sent, not a page a browser opens the app from.
      if (/(?:BASE_URL|API_BASE|ENDPOINT)$/i.test(m[1]) && !/ORIGIN|FRONTEND|CLIENT|SITE|WEB|PUBLIC|APP/i.test(m[1])) continue;
      for (const v of m[2].replace(/^(['"])(.*)\1$/, "$2").split(",")) {
        try { const u = new URL(v.trim()); if (/^https?:$/.test(u.protocol)) out.add(u.origin); } catch { /* not an origin */ }
      }
    }
  }
  return [...out].slice(0, 8);
}
// Your app's own request limits, raised for this session only, the way the sandbox raises them:
// a run asks in twenty minutes what a person asks in a month, and a limiter that fires answers
// instead of your AI. Numeric values under a limit-shaped name; switches and guards are left alone.
const THROUGHPUT = /(RATE_?LIMIT|DAILY_LIMIT|HOURLY_LIMIT|MINUTE_LIMIT|REQUESTS_PER|TOKEN_BUDGET|MAX_SSE|MAX_CONCURRENT|THROTTLE|_RPM$|_RPS$|_QPS$)/;
const GUARDED = /(AUTH|LOGIN|PASSWORD|BREAKER|LOCKOUT|ATTEMPT|FAIL|BAN|BLOCK)/;
const SWITCH = /_(?:ENABLED|DISABLED|ENABLE|DISABLE)$|^(?:ENABLE|DISABLE)_/;
// Limit-shaped names the code itself reads (process.env.GUEST_DAILY_LIMIT, os.environ.get("RATE_LIMIT_RPM"))
// count too: a limit with a default in code and no line in .env is the one that closes on a run.
const ENV_READ = /(?:process\.env(?:\.|\[\s*['"])|os\.(?:environ\.get|getenv)\(\s*['"]|os\.environ\[\s*['"]|\benv\(\s*['"]|Deno\.env\.get\(\s*['"])([A-Z][A-Z0-9_]*)/g;
const lifted = (name) => (/(TOKEN_BUDGET|TOKENS)/.test(name) ? "1000000000" : "1000000");
const liftable = (name) => THROUGHPUT.test(name) && !GUARDED.test(name) && !SWITCH.test(name);
function liftedLimits(envFiles, sources = []) {
  // Only a limit the code reads is raised: a line in .env that nothing reads is not a limit, and
  // naming it as one raised was the tell an engineer caught first.
  const read = new Set();
  for (const file of sources) {
    if (!/\.(?:[cm]?[jt]sx?|py|go|rb|php|rs)$/.test(file)) continue;
    let text = "";
    try { if (statSync(file).size > 512_000) continue; text = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(ENV_READ)) if (liftable(m[1])) read.add(m[1]);
  }
  const out = {};
  for (const file of envFiles) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, name, raw] = m;
      const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (liftable(name) && /^\d+$/.test(value) && (!sources.length || read.has(name))) out[name] = lifted(name);
    }
  }
  for (const name of read) if (!(name in out)) out[name] = lifted(name);
  return out;
}

// Every name your env files set, with its value, read here and used only here. An example file is
// read first so a real one's value wins: a placeholder key asked for a model listing comes back
// refused, and that would read as your own key being refused.
function envValues(envFiles) {
  const example = /\.(example|sample)$/;
  const out = {};
  for (const file of [...envFiles.filter((f) => example.test(f)), ...envFiles.filter((f) => !example.test(f))]) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return out;
}
// Switch-shaped names and the word each one reads as. The name and the word travel, never the value.
const SWITCH_NAME = /(?:_ENABLED|_DISABLED|_MODE|_ON|_OFF|_FLAG)$|^(?:ENABLE|USE|DISABLE|SKIP)_/;
const switchStates = (values) => Object.fromEntries(Object.entries(values)
  .filter(([name]) => SWITCH_NAME.test(name))
  .map(([name, value]) => [name, value === "" ? "unset" : /^(?:1|true|yes|on)$/i.test(value) ? "on" : /^(?:0|false|no|off)$/i.test(value) ? "off" : "set"]));

// What your app can actually reach: each provider key your env files set is asked that provider
// for its own model listing, from this machine. Your key stays here; what goes back is the name it
// is set under, the host, what the host answered, the model ids, and which switches are on.
const MODEL_ID = /^[\w./:@-]{1,160}$/;
async function inventoryOf(listings) {
  const values = envValues(envFiles);
  const providers = await Promise.all(Object.entries(listings)
    .filter(([name]) => values[name])
    .map(async ([name, canonical]) => {
      const url = listingUrl(name, canonical, values);
      let host = "";
      try { host = new URL(url).host; } catch { return null; }
      try {
        const res = await fetch(url, { headers: { authorization: `Bearer ${values[name]}` }, signal: AbortSignal.timeout(20_000) });
        const body = res.ok ? await res.json().catch(() => null) : null;
        const models = (Array.isArray(body?.data) ? body.data : [])
          .map((m) => String(m?.id ?? "")).filter((id) => MODEL_ID.test(id)).slice(0, 1500);
        return { env: name, host, status: res.status, models };
      } catch {
        return { env: name, host, status: 0, models: [] };
      }
    }));
  return { providers: providers.filter(Boolean), flags: switchStates(values) };
}
let secrets = [];
let identities = null;
let capture = null;
// The app's life, shared by the code that starts it, watches it and restarts it.
let closing = false;
let restarting = false;
let appGone = false;
let lastSaid = "";
let lastOutputAt = Date.now();
let forgetTold = null;
const mask = (text) => { let s = String(text ?? ""); for (const v of secrets) s = s.split(v).join("[masked]"); return s; };

// ---- the wire
let box = "";
let key = "";
async function call(method, path, body, { raw = false, timeoutMs = 60_000, headers = {} } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...(key ? { "x-local-key": key } : {}), "content-type": raw ? "application/octet-stream" : "application/json", ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, data };
}

// ---- the box on this machine: your folder, read where it stands
const work = join(tmpdir(), `cortad-${process.pid}`);
mkdirSync(work, { recursive: true });
const bootLog = join(work, "boot.log");
writeFileSync(bootLog, "");
// Files nobody may read through this program: keys, and git's own internals.
const SECRET_PATH = /(?:^|\/)(?:\.git|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa)[^/]*|[^/]*\.(?:pem|key|p12|pfx|jks|keystore))(?:\/|$)/;
// The engine's paths, as this machine has them. Its scratch files live in this program's own
// temp folder, never beside your code.
const translate = (s) => String(s ?? "").split("/workspace/repo").join(root).split("/tmp/bl-boot.log").join(bootLog).split("/tmp/boot.log").join(bootLog);
const scratch = (p) => { const r = resolve(translate(p)); return r.startsWith("/tmp/") ? join(work, r.slice(5)) : r.startsWith(work + sep) ? r : null; };
const readable = (p) => {
  const r = resolve(translate(p));
  if (r.startsWith(work + sep)) return r;
  let landed; try { landed = realpathSync(r); } catch { return null; }
  const home = realpathSync(root);
  if (!landed.startsWith(home + sep) || ENV_FILE.test(basename(landed)) || SECRET_PATH.test(landed)) return null;
  const rel = relative(home, landed);
  return shareable(rel) && !carriesKey(rel) ? landed : null;
};
// A shell line runs with a plain environment: the app's own process reads its .env itself, and
// nothing a world sends inherits this terminal's keys.
const plainEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: work, TERM: "dumb" };
let lock = null;

let app = null;
async function verb(job) {
  const b = job.body ?? {};
  switch (job.verb) {
    case "exec": {
      const cmd = translate(b.cmd);
      if (verbose) say(`$ ${cmd.slice(0, 160)}`);
      // No lock, no shell: a world never gets an unlocked one on this machine.
      if (!lock) return { success: false, exitCode: 126, stdout: "", stderr: "refused: this machine has no sandbox tool (sandbox-exec or bubblewrap), so no shell line is run here" };
      const { file, args } = lock.wrap(cmd);
      return new Promise((done) => {
        const child = spawn(file, args, { cwd: root, env: plainEnv, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const cap = (s, chunk) => (s.length < 20_000_000 ? s + chunk : s);
        child.stdout.on("data", (d) => { out = cap(out, d.toString()); });
        child.stderr.on("data", (d) => { err = cap(err, d.toString()); });
        const timer = setTimeout(() => child.kill("SIGKILL"), Math.min(Number(b.opts?.timeout) || 180_000, 280_000));
        child.on("close", (code) => { clearTimeout(timer); done({ success: code === 0, exitCode: code ?? 1, stdout: mask(out), stderr: mask(err) }); });
        child.on("error", (e) => { clearTimeout(timer); done({ success: false, exitCode: 127, stdout: "", stderr: String(e.message) }); });
      });
    }
    case "fetch": {
      // Only the app's own port: this machine's other services are not the world.
      const port = Number(b.port) || app?.port;
      if (!app || port !== app.port) return { error: `refused: port ${port} is not your app` };
      const path = typeof b.path === "string" && b.path.startsWith("/") ? b.path : "/";
      const headers = {};
      for (const [k, v] of Object.entries(b.headers ?? {})) if (!/^(host|content-length|connection)$/i.test(k)) headers[k] = String(v);
      // A request that speaks as one of your app's own callers carries the role, not the token:
      // the token was issued on this machine and is put in here, so it never travels.
      const marker = Object.keys(headers).find((k) => k.toLowerCase() === AS_HEADER);
      if (marker) {
        const role = headers[marker];
        delete headers[marker];
        if (role === CAPTURED) {
          // Speaking as the person who sent the message we watched: every header their own client sent.
          for (const [name, value] of Object.entries(capture?.headers() ?? {})) { for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k]; headers[name] = value; }
        } else {
          const held = await identities?.headerFor(role);
          if (held) { for (const k of Object.keys(headers)) if (k.toLowerCase() === held.name) delete headers[k]; headers[held.name] = held.value; }
        }
      }
      const method = String(b.method ?? "GET").toUpperCase();
      const init = { method, headers, redirect: "manual" };
      if (b.body !== undefined && method !== "GET" && method !== "HEAD") init.body = typeof b.body === "string" ? b.body : JSON.stringify(b.body);
      // A dev server restarts when a file is saved, and during a run files are saved: by the agent
      // working its plan, and by you. For those seconds nothing is listening. A turn that meets a
      // closed door is held until your app answers again and sent then, once, instead of being
      // counted against your app as a failure it never had.
      // A door behind a guest session answers the first request with a redirect that mints the
      // session and sends the browser back. A browser reaches it by loading a page first; the same
      // request pushed down that chain arrives at a page route as a POST and reads as "wrong
      // method", which is what your chat looked like from the outside. So the chain is walked the
      // way a browser walks it, one GET with redirects followed, and the request is sent again with
      // the session your app just handed out. The cookie is kept here and never leaves this machine.
      const url = `http://127.0.0.1:${port}${path}`;
      const yours = (to) => { try { const u = new URL(to, url); return u.hostname === "127.0.0.1" && u.port === String(port) ? u.href : null; } catch { return null; } };
      let jar = "";
      const sent = (at, over = {}) => fetch(at, {
        ...init, ...over,
        headers: { ...headers, ...(over.headers ?? {}), ...(jar ? { cookie: [headers.cookie, jar].filter(Boolean).join("; ") } : {}) },
        signal: AbortSignal.timeout(170_000),
      });
      const keep = (res) => { const set = res.headers.getSetCookie?.() ?? []; if (set.length) jar = [jar, ...set.map((c) => c.split(";")[0])].filter(Boolean).join("; "); };
      const sentBack = (res) => (res.status >= 300 && res.status < 400 ? yours(res.headers.get("location") ?? "") : null);
      const warm = async () => {
        let at = url;
        for (let hop = 0; hop < 4 && at; hop++) {
          const res = await sent(at, { method: "GET", body: undefined });
          keep(res);
          at = sentBack(res);
        }
      };
      const ask = async () => {
        let res = await sent(url);
        keep(res);
        if (method !== "GET" && sentBack(res)) { await warm(); if (jar) res = await sent(url); }
        const buf = Buffer.from(await res.arrayBuffer());
        const LIMIT = 262_144;
        // A session cookie your app sets is its business: it is dropped here, and every other header masked.
        const said = Object.fromEntries([...res.headers].filter(([k]) => !/^set-cookie2?$/i.test(k)).map(([k, v]) => [k, mask(v)]));
        return { status: res.status, headers: said, body: mask(buf.subarray(0, LIMIT).toString("utf8")), truncated: buf.length > LIMIT };
      };
      try { return await ask(); }
      catch (e) {
        const code = String(e.cause?.code ?? e.code ?? "");
        if (!/ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) return { error: `nothing answered at port ${port}: ${code || e.message}` };
        for (let i = 0; i < 45 && !(await answers(port)); i++) await new Promise((r) => setTimeout(r, 1000));
        try { return { ...(await ask()), heldForRestart: true }; }
        catch (again) { return { error: `nothing answered at port ${port}: ${String(again.cause?.code ?? again.message)}` }; }
      }
    }
    case "read": {
      const p = readable(b.path);
      if (!p) return { error: "bad path" };
      try { return { content: mask(readFileSync(p, "utf8")) }; } catch (e) { return { error: String(e.code ?? e.message) }; }
    }
    case "write": {
      const bytes = Buffer.from(String(b.b64 ?? ""), "base64");
      // The engine's own scratch file: this program's temp folder, never your code. Nothing on this
      // machine writes your files; the agent that edits them is your own.
      const mine = scratch(b.path);
      if (!mine) return { success: false, stderr: "this program does not write your files" };
      try { mkdirSync(dirname(mine), { recursive: true }); if (b.append) appendFileSync(mine, bytes); else writeFileSync(mine, bytes); return { success: true, stderr: "" }; }
      catch (e) { return { success: false, stderr: String(e.message) }; }
    }
    case "mint": return identities ? JSON.parse(mask(JSON.stringify(await mintAcross({
      recipes: b.recipes, root, appDir, onPath, appPort: app?.port, portFor: serviceUp,
      mint: (recipes, port, origin) => identities.mint({ ...b, recipes, headers: { ...(b.headers ?? {}), ...(origin ? { origin, referer: `${origin}/` } : {}) } }, port),
      originFor: (port) => originFor(port, envOrigins(envFiles)),
    })))) : { identities: [] };
    case "restart": return restartApp();
    case "inventory": return inventoryOf(b.probe && typeof b.probe === "object" ? b.probe : {});
    // Your own pages, read here rather than in a world's shell: that shell is sealed away from
    // every env file and every host but this one, so inside it no store of yours has an address.
    case "sample": return { report: JSON.parse(mask(JSON.stringify(await sampleHere(b, envValues(envFiles), root)))) };
    case "lock": return { locked: Array.isArray(b.hosts) ? b.hosts.length : 0 };
    // What your app spent on its providers, from the hook inside it. An app this command did not
    // start has no hook, and the empty answer says the meter is absent rather than that nothing was spent.
    // Masked like every other reply: a tool's answer can carry a value from their env files.
    case "usage": return capture ? JSON.parse(mask(JSON.stringify(capture.usage() ?? {}))) : {};
    // A world is ended from this terminal, never from the cloud.
    case "destroy": return { ok: true };
    default: return { ok: true };
  }
}

const exec = promisify(execFile);

// ---- start or attach to the app
const answers = async (port) => {
  try { await fetch(`http://127.0.0.1:${port}/`, { method: "GET", signal: AbortSignal.timeout(2500), redirect: "manual" }); return true; }
  catch { return false; }
};
const onPath = (bin) => (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, bin)));
// Where their app lives inside this repository, and how it starts. Worked out in lib/start.mjs.
let appDir = root;

// ---- a sign-in mounted in another workspace
// One app served its AI from apps/api and mounted sign-in in apps/dashboard: a test account can
// only be made where the sign-in is, and posting a sign-up at the AI's own port is a 404.
const PORT_IN_SCRIPT = /(?:^|\s)(?:PORT=|-p[ =]|--port[ =])(\d{2,5})\b/;
// The port a framework serves on when nobody names one. sveltekit and astro before vite: both bring
// vite with them and neither uses its port.
const FRAMEWORK_PORT = [["next", 3000], ["nuxt", 3000], ["@remix-run/serve", 3000], ["@remix-run/dev", 3000], ["@sveltejs/kit", 5173], ["astro", 4321], ["vite", 5173]];
// No scan of the usual ports: whatever answers on 3000 or 8080 on this machine is very often not
// this workspace, and a test account made against somebody else's service is the worst kind of
// wrong. Only the port this workspace itself names, and if nothing is there, it is started.

// What that workspace serves on: its own script says so, or the framework it is written in does.
function servicePort(cwd) {
  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); } catch { /* not a Node workspace */ }
  const script = ["dev", "develop", "start:dev", "serve", "start"].map((s) => pkg?.scripts?.[s]).find(Boolean) ?? "";
  const named = Number(PORT_IN_SCRIPT.exec(script)?.[1]);
  if (named) return named;
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  const framework = FRAMEWORK_PORT.find(([dep]) => deps.includes(dep))?.[1];
  if (framework) return framework;
  if (existsSync(join(cwd, "manage.py"))) return 8000;
  if (existsSync(join(cwd, "Gemfile"))) return 3000;
  const py = ["requirements.txt", "pyproject.toml"].map((f) => { try { return readFileSync(join(cwd, f), "utf8"); } catch { return ""; } }).join("\n");
  return /\bdjango\b/i.test(py) ? 8000 : /\bflask\b/i.test(py) ? 5000 : null;
}

const toldService = new Set();
const signedInAt = (dir, port) => { if (!toldService.has(dir)) { toldService.add(dir); say(`your sign-in lives in ${dir}, so I signed in there`); } return port; };
// Everything else this command started, stopped with it.
const sidecars = [];
// The port that workspace's sign-in answers on. One it is already serving on comes first: starting
// a second copy of a dashboard that is already up costs a minute and takes its port.
async function serviceUp(group) {
  const named = servicePort(group.cwd);
  if (named && named !== app?.port && (await answers(named))) return signedInAt(group.dir, named);
  // Its own port taken by the app leaves nothing to wait on: whatever answers there is the app.
  if (!named || named === app?.port || !group.plan?.cmd) return null;
  const kid = spawn("/bin/sh", ["-c", group.plan.cmd], {
    cwd: group.plan.cwd,
    env: { ...process.env, ...(capture ? capture.env(process.env) : {}), FORCE_COLOR: "0", ...(pinned.bin ? { PATH: `${pinned.bin}:${process.env.PATH ?? ""}` } : {}) },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  sidecars.push(kid);
  const keep = (d) => appendFileSync(bootLog, d.toString());
  kid.stdout.on("data", keep);
  kid.stderr.on("data", keep);
  return (await waitForPort(named, 90_000)) ? signedInAt(group.dir, named) : null;
}

async function ask(question) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const line = await new Promise((r) => rl.question(question, r));
  rl.close();
  return line.trim() || null;
}
let child = null;
async function startApp() {
  const wanted = Number(flag("--port"));
  if (wanted) {
    if (!(await answers(wanted))) return { port: null, said: "", why: `nothing is answering on port ${wanted}, so there is nothing to ask.`, noStart: true };
    const took = await takeOver(wanted);
    if (took) return took;
    say("your app was already running, so its request limits stay as they are; if it answers 429, stop it and run this without --port and they are raised for the session");
    return { port: wanted, cmd: null };
  }
  const plan = startPlan({ root, typed: flag("--start"), onPath });
  // A package is not a broken app, and asking its owner how it starts is the wrong question.
  const cmd = plan?.cmd ?? (plan?.noServer ? null : await ask("How do you start your app? (for example: npm run dev) "));
  // Your code is already here and already being read: quitting now would throw away what you have
  // paid for. This stays connected, the read finishes, and the browser says what is missing.
  if (!cmd) {
    return { port: null, said: "", noStart: true,
      why: plan?.noServer
        ? "this repository has no server to run; connect the app that serves it. If it does have one, run this again with --start \"how you start it\"."
        : "your code is being read, but I could not work out how your app starts, so nothing is running to ask. Run the command again with --start \"how you start it\", or start your app yourself and run it again with --port <the port it answers on>." };
  }
  appDir = plan?.cwd ?? root;
  pinned = pinnedNode();
  if (plan?.within) say(`your app is in ${plan.within}, started there with: ${cmd}`);
  const sourceFiles = files.map((f) => join(root, f));
  const lifted = { ...liftedLimits(envFiles, sourceFiles), ...openSwitches(envFiles, sourceFiles) };
  const raised = Object.keys(liftedLimits(envFiles, sourceFiles));
  const opened = Object.keys(openSwitches(envFiles, sourceFiles));
  if (raised.length) say(`higher request limits for this session: ${raised.join(", ")}`);
  // Said out loud, because it changes who their app lets in for as long as this command runs.
  if (opened.length) say(`your app's own sign-in switch, for this session only: ${opened.map((n) => `${n}=${lifted[n]}`).join(", ")}`);
  launched = { cmd, lifted };
  step(`starting your app: ${cmd}`);
  const up = await launch(180_000);
  if (up.port) return { port: up.port, cmd: launched.cmd, lifted: Object.keys(lifted) };
  // Already running: a second start dies on the port the first one holds. The one that is running
  // is the app, so it is used as it stands rather than treated as a failure.
  // "Another next dev server is already running" is the same fact in a framework's own words: their
  // app is up, started from the terminal they were already working in, and the port it holds is not
  // always the one we asked for. Their running app is the app.
  if (up.exited !== null && /EADDRINUSE|address already in use|port.{0,40}(?:in use|already used|is taken|unavailable)|another .{0,20}(?:dev )?server is already running|already running (?:on|at) (?:http|port)/i.test(up.tail)) {
    const ports = [...up.tail.matchAll(/(?::|port\s*[:=]?\s*)(\d{4,5})\b/gi)].map((m) => Number(m[1]));
    for (const port of new Set(ports)) {
      if (await answers(port)) {
        launched = null; child = null;
        const took = await takeOver(port);
        if (took) return took;
        say(`your app is already running on port ${port}, so that one is used; its request limits stay as they are`);
        return { port, cmd: null };
      }
    }
  }
  if (up.tail) console.error(up.tail);
  const wrongNode = pinned.major && !pinned.bin ? ` This project pins Node ${pinned.major} and this shell runs Node ${shellNode}: switch to ${pinned.major}.` : "";
  return { port: null, said: up.tail, why: `${up.exited !== null ? "your app stopped before it answered" : "your app did not answer within three minutes"}; what it said is above.${wrongNode}` };
}

// An app the person started keeps the limits it started with, and a run needs more than a person
// uses in a month. With their yes, the command stops that app and starts it the way it would have,
// limits raised for the session. Only in a terminal, only when the code reads a limit, and only
// when the command knows how to start the app.
async function takeOver(port) {
  const lifted = liftedLimits(envFiles, files.map((f) => join(root, f)));
  const names = Object.keys(lifted);
  if (!names.length || !process.stdin.isTTY) return null;
  const plan = startPlan({ root, typed: flag("--start"), onPath });
  if (!plan?.cmd) return null;
  const pid = await listenerOn(port);
  if (!pid) return null;
  const answer = await ask(`your app is running with its own request limits (${names.join(", ")}). Restart it with them raised for this session? [Y/n] `);
  if (answer && !/^y(?:es)?$/i.test(answer)) return null;
  const top = await supervisorOf(pid);
  step(`stopping your app (pid ${top}) to start it with higher limits`);
  await stopApp(top);
  for (let i = 0; i < 50 && (await answers(port)); i++) await new Promise((r) => setTimeout(r, 200));
  if (await answers(port)) { say("your app did not stop, so it is used as it is"); return null; }
  appDir = plan.cwd ?? root;
  pinned = pinnedNode();
  if (plan.within) say(`your app is in ${plan.within}, started there with: ${plan.cmd}`);
  say(`higher request limits for this session: ${names.join(", ")}`);
  launched = { cmd: plan.cmd, lifted };
  step(`starting your app: ${plan.cmd}`);
  const up = await launch(180_000);
  if (up.port) return { port: up.port, cmd: launched.cmd, lifted: names };
  if (up.tail) console.error(up.tail);
  return { port: null, said: up.tail, why: "your app did not come back after the restart." };
}
// The process listening on a port.
async function listenerOn(port) {
  try { return Number((await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).stdout.trim().split("\n")[0]) || null; } catch { return null; }
}
// The top of the chain that runs the app: nodemon, npm, the sh -c under it. Climbs from the listener
// while the parent is a runner, never into the person's own shell or terminal.
const RUNNER = /^(?:\S*\/)?(?:node|npm|npx|pnpm|yarn|bun|deno|python[\d.]*|uvicorn|gunicorn|flask|tsx|ts-node|nodemon|concurrently|pm2)(?:\s|$)|^(?:\/bin\/)?sh -c\b/;
async function supervisorOf(pid) {
  const rows = (await exec("ps", ["-axo", "pid=,ppid=,args="])).stdout.trim().split("\n").map((l) => l.trim());
  const table = new Map(rows.map((l) => { const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? [Number(m[1]), { ppid: Number(m[2]), args: m[3] }] : [0, null]; }));
  let top = pid;
  for (let i = 0; i < 8; i++) {
    const parent = table.get(table.get(top)?.ppid ?? 0);
    if (!parent || !RUNNER.test(parent.args)) break;
    top = table.get(top).ppid;
  }
  return top;
}

// Your app, started the way you start it, and watched until one of its own ports answers.
let launched = null;
// The Node this project pins, when the shell that ran this command has another. Strapi refuses
// Node 26 outright, and a version manager that never switched in this shell is the usual reason.
// ponytail: reads .nvmrc and .node-version only; engines ranges when a project pins no other way.
const shellNode = Number(process.versions.node.split(".")[0]);
function pinnedNode() {
  let want = "";
  for (const f of [".nvmrc", ".node-version"].flatMap((n) => [join(appDir, n), join(root, n)])) { try { want = readFileSync(f, "utf8").trim(); } catch { /* not pinned here */ } if (want) break; }
  const major = Number(/^v?(\d+)/.exec(want)?.[1]);
  if (!major || major === shellNode) return { major: null, bin: null };
  const under = (dir, tail = "bin") => { try { return readdirSync(dir).filter((v) => v.replace(/^v/, "").startsWith(`${major}.`)).sort().reverse().map((v) => join(dir, v, tail)); } catch { return []; } };
  const bins = [`/opt/homebrew/opt/node@${major}/bin`, `/usr/local/opt/node@${major}/bin`, ...under(join(homedir(), ".nvm/versions/node")), ...under(join(homedir(), ".local/share/fnm/node-versions"), "installation/bin"), ...under(join(homedir(), ".volta/tools/image/node"))];
  return { major, bin: bins.find((d) => existsSync(join(d, "node"))) ?? null };
}
let pinned = { major: null, bin: null };

// Their app could not start because its dependencies are not on this machine. That is an install
// nobody ran, not a broken app: it is installed once, with the manager the project locked, and the
// app is started again. Every way the app is started comes through here, so it is fixed in one place.
async function launch(waitMs) {
  const up = await start(waitMs);
  // Only an app that stopped: one still running has not failed to start, whatever it printed.
  if (up.port || up.exited === null) return up;
  const ok = await installOnce(up.tail);
  // An install that failed is the reason their app cannot start, and it goes where the app's own
  // output goes: the terminal, and the screen that is waiting for the app.
  const said = (tail) => (installSaid ? `${installSaid}\n${tail}` : tail);
  if (!ok) return installSaid ? { ...up, tail: said(up.tail) } : up;
  const back = await start(waitMs);
  return back.port ? back : { ...back, tail: said(back.tail) };
}
let installed = false;
let installSaid = "";
async function installOnce(said) {
  if (installed) return false;
  const name = missingDependency(said);
  const cmd = name && installPlan(appDir, onPath, root);
  if (!cmd) return false;
  installed = true;
  stepDone(`your app needs ${name}, which is not installed here`);
  const started = Date.now();
  const secondsSoFar = () => Math.round((Date.now() - started) / 1000);
  // A line that rewrites itself in a terminal, and every tenth second where there is none.
  const tick = () => { const n = secondsSoFar(); const line = `installing your app's dependencies, ${n} seconds so far`; if (process.stdout.isTTY) step(line); else if (n % 10 === 0) say(line); };
  tick();
  const ticking = setInterval(tick, 1000);
  const done = await new Promise((r) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd: appDir, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (d) => { tail = (tail + d.toString()).slice(-4000); appendFileSync(bootLog, d.toString()); if (verbose) process.stdout.write(d.toString()); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.on("close", (code) => { clearTimeout(timer); r({ ok: code === 0, tail }); });
    child.on("error", (e) => { clearTimeout(timer); r({ ok: false, tail: String(e.message) }); });
  });
  clearInterval(ticking);
  if (!done.ok) { installSaid = `installing your app's dependencies failed after ${secondsSoFar()} seconds:\n${done.tail.split("\n").filter(Boolean).slice(-12).join("\n")}`; lastSaid = done.tail; stepDone(`installing your app's dependencies failed after ${secondsSoFar()} seconds`); return false; }
  stepDone(`installed your app's dependencies in ${secondsSoFar()} seconds`);
  // A Python project that had no interpreter of its own has one now, and it is the one to start with.
  const again = startPlan({ root, typed: flag("--start"), onPath });
  if (again?.cmd && again.cmd !== launched.cmd) { launched = { ...launched, cmd: again.cmd }; say(`starting your app: ${again.cmd}`); }
  return true;
}

// The port their start command names, moved when something else already holds it: two apps on one
// laptop both said --port 8000, and the second attached to the first's server as its own.
async function freed(cmd) {
  const m = /(--port[= ]|-p |\bPORT=)(\d{4,5})\b/.exec(cmd);
  if (!m || !(await listenerOn(Number(m[2])))) return cmd;
  for (let port = Number(m[2]) + 1; port < Number(m[2]) + 30; port++) {
    if (await listenerOn(port)) continue;
    say(`port ${m[2]} is taken on this machine, so your app starts on ${port}`);
    return cmd.replace(m[0], `${m[1]}${port}`);
  }
  return cmd;
}

async function start(waitMs) {
  const { lifted } = launched;
  const cmd = await freed(launched.cmd);
  child = spawn("/bin/sh", ["-c", cmd], { cwd: appDir, env: { ...process.env, ...lifted, ...(capture ? capture.env(process.env) : {}), FORCE_COLOR: "0", ...(pinned.bin ? { PATH: `${pinned.bin}:${process.env.PATH ?? ""}` } : {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const mine = child;
  let seen = "";
  const onData = (d) => { const s = d.toString(); appendFileSync(bootLog, s); seen = (seen + s).slice(-20_000); lastSaid = seen; lastOutputAt = Date.now(); if (verbose) process.stdout.write(s); };
  mine.stdout.on("data", onData);
  mine.stderr.on("data", onData);
  let exited = null;
  appGone = false;
  mine.on("exit", (code) => { exited = code ?? 1; if (child === mine) appGone = true; });
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const tail = () => seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-25).join("\n");
    if (exited !== null) return { port: null, exited, tail: tail() };
    // nodemon and its kind outlive the app they watch: the app is gone, the process is not, and
    // the wait ran its whole three minutes on one app with the reason sitting in the output.
    // Also: the port is taken, under a watcher that does not exit when its app cannot listen. The app
    // that holds the port is theirs and already running, which startApp turns into attaching to it.
    if (/app crashed - waiting for file changes|waiting for (?:file )?changes before restart|Failed running|EADDRINUSE|address already in use/i.test(seen)) {
      await stopApp(mine.pid);
      return { port: null, exited: 1, tail: tail() };
    }
    // The port is what the app's own process group listens on. Never a guess: a developer's
    // machine has other things on 3000 and 8080, and one of them answered for the app once.
    const ports = await listening(mine.pid);
    // The socket can open before the server answers; the log line is the tiebreak among several.
    const plain = seen.replace(/\x1b\[[0-9;]*m/g, "");
    const said = [...plain.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b|\bport\s*[:=]?\s*(\d{4,5})\b/gi)].map((m) => Number(m[1] || m[2]));
    for (const port of [...new Set([...said.reverse().filter((p) => ports.includes(p)), ...ports])]) {
      if (await answers(port)) return { port, exited: null, tail: "" };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { port: null, exited: null, tail: seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-12).join("\n") };
}

// The same command again, for an app that does not reload on save. Only an app this program
// started: one you started yourself is yours to restart.
async function restartApp() {
  restarting = true;
  try { return await restartNow(); } finally { restarting = false; }
}
async function restartNow() {
  if (!launched || !child) return { error: "You started this app yourself, so restart it in your own terminal. Most dev servers reload on save." };
  const port = app.port;
  await stopApp(child.pid);
  for (let i = 0; i < 25 && (await answers(port)); i++) await new Promise((r) => setTimeout(r, 200));
  const up = await launch(90_000);
  if (!up.port) return { error: up.exited !== null ? `Your app exited ${up.exited} on restart.\n${up.tail}` : "Your app was restarted but did not answer within 90 seconds." };
  if (up.port !== port) return { error: `Your app came back on port ${up.port}, not ${port}. Run the command again to reconnect.` };
  return { restarted: true, port };
}
// TCP ports your app is listening on: every process descended from the one this program started.
// By descent, not by process group: nodemon, pm2 and concurrently put the real server in a group of
// its own, and an app started through one of them was never seen to open its port.
async function familyOf(pid) {
  const table = (await exec("ps", ["-axo", "pid=,ppid="])).stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const family = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const [p, parent] of table) if (family.has(parent) && !family.has(p)) { family.add(p); grew = true; } }
  return [...family];
}
async function listening(pid) {
  try {
    const { stdout } = await exec("lsof", ["-nP", "-a", "-p", (await familyOf(pid)).join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
    return [...new Set([...stdout.matchAll(/^n.*:(\d+)$/gm)].map((m) => Number(m[1])).filter((p) => p > 0))];
  } catch { return []; }
}
// Your app and everything it started, stopped for certain. A process group is not enough: nodemon
// gives the real server a group of its own, and one app's server outlived this command as an
// orphan still holding its port and its production connections. Asked first, then made to.
async function stopApp(pid) {
  const family = await familyOf(pid).catch(() => [pid]);
  const signal = (sig) => { for (const p of family) { try { process.kill(p, sig); } catch { /* already gone */ } } try { process.kill(-pid, sig); } catch { /* no group left */ } };
  const alive = () => family.some((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  signal("SIGTERM");
  for (let i = 0; i < 15 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
  if (alive()) signal("SIGKILL");
}

// ---- go
say("getting ready");
step("looking at this folder");
const envFiles = [];
const files = [];
listed = gitListed();
walk(root, 0, files, envFiles, 0);
secrets = secretValues(envFiles);
envKeys = secretEnvValues(envFiles, (f) => readFileSync(f, "utf8"));
const kept = [];
for (let i = files.length - 1; i >= 0; i -= 1) if (carriesKey(files[i])) kept.unshift(...files.splice(i, 1));
// --explain: what this would send and start, from this folder, and nothing else. No network, no
// app started, nothing written. For the person (or the agent) who reads before running.
if (explain) {
  const going = new Set([...files, ...kept]);
  const left = listed ? [...listed].filter((f) => !going.has(f) && !ENV_FILE.test(basename(f))).sort() : [];
  const bytes = files.reduce((n, f) => { try { return n + statSync(join(root, f)).size; } catch { return n; } }, 0);
  const plan = startPlan({ root, typed: flag("--start"), onPath });
  const rel = (f) => relative(root, f) || ".";
  console.log([
    `cortad --explain  (nothing is sent or started by this)`,
    ``,
    `talks to        ${origin.origin}, localhost (your app's port only), and your own model providers, to ask each which models your key can use`,
    `would send      ${files.length} source files, ${Math.round(bytes / 1024)} KB, once${listed ? " (what git would commit)" : ""}`,
    ...(kept.length ? [`kept here       ${kept.length} file${kept.length === 1 ? " that holds" : "s that hold"} keys: ${kept.slice(0, 6).join(", ")}${kept.length > 6 ? ", ..." : ""}`] : []),
    ...(left.length ? [`also not sent   ${left.length} tracked data, media or lock file${left.length === 1 ? "" : "s"}: ${left.slice(0, 6).join(", ")}${left.length > 6 ? ", ..." : ""}`] : []),
    `not sent        anything git ignores, env files (${envFiles.length} here: ${envFiles.slice(0, 6).map(rel).join(", ") || "none"}), key files, data files, node_modules, .git`,
    `env files       values read here only: to hide them in replies, to sign in a test account, and to ask your providers what your keys reach. Variable names and whether a switch is on or off go up; no value does`,
    `would start     ${flag("--port") ? `nothing: uses your app on port ${flag("--port")}` : plan?.cmd ? `${plan.cmd}   (in ${rel(plan.cwd)})` : plan?.noServer ? "nothing: this repository has no server to run" : "asks you how your app starts"}`,
    `would raise     ${flag("--port") ? "nothing: your app's own request limits stay as they are" : `${Object.keys(liftedLimits(envFiles, files.map((f) => join(root, f)))).join(", ") || "no request limits found"}   (for this session only)`}`,
    `loads into app  lib/trace.cjs (Node, Bun) or lib/pyhook/sitecustomize.py (Python): records the one request during which your app calls a model`,
    `your files      never written by this program; your own coding agent edits them`,
    `test shell      confined by the OS: your project and toolchains only, writes to temp and build folders, localhost only`,
    `for your agent  an MCP entry and a skill in each coding agent's own home folder (Claude Code, Codex, Cursor), and a key in ~/.cortad for later runs`,
    ``,
    `first files     ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", ..." : ""}`,
  ].join("\n"));
  process.exit(0);
}
if (kept.length) say(`kept on this machine, ${kept.length === 1 ? "it holds" : "they hold"} keys: ${kept.join(", ")}`);
const keepSecret = (v) => { if (v && v.length >= 12 && !secrets.includes(v)) secrets.push(v); };
identities = makeIdentities({ root, work, envFiles, sourceFiles: () => files, say, keepSecret, appDir: () => appDir });
// One message sent in their own app tells us the door for certain. The route and the body go up,
// masked like everything else; the sign-in that message carried stays here.
capture = makeCapture({ work, keepSecret, onDoor: (door) => {
  let body = door.body;
  try { body = JSON.parse(mask(JSON.stringify(door.body))); } catch { /* sent as it is */ }
  call("POST", `/local/${box}/captured`, { ...door, body }).catch(() => {});
} });
if (!files.length) fail("no source files here to read.");

// Which project this is, as a hash of where it lives: the same folder coming back resumes the same
// connection, and the path itself never leaves this machine.
const project = projectOf(root);
// The key the last connect left for this project, if any: the token face signs in with it. A connect
// from the screen always asks for a fresh one, since the code may belong to another account or site.
const stored = readToken(project);
if (viaToken && !stored) fail("this project has no stored key. Run the command from the connect screen once.");
// A network that drops while connecting ends here in a sentence, never a stack trace: running the
// command again starts a clean connection.
const unreachable = (err) => fail(`could not reach ${origin.host}: ${err?.name === "TimeoutError" ? "it did not answer in time" : "the connection failed"}. Check your connection and run the command again.`);
const attach = await call("POST", "/local/attach", { ...(viaToken ? {} : { code }), name: basename(root), project },
  viaToken ? { headers: { authorization: `Bearer ${stored}` } } : {}).catch(unreachable);
if (!attach.ok) fail(attach.data?.error ?? `could not sign in (${attach.status})`);
box = attach.data.box;
key = attach.data.key;
// This process is the one holding the app up for this project: lib/cli.mjs reads the file before
// starting another.
writeRunner(project, { pid: process.pid, startedAt: new Date().toISOString(), by: viaToken ? "token" : "connect" });

const list = join(work, "files.txt");
writeFileSync(list, files.join("\n") + "\n");
// Which code this is, from what the files say rather than from the archive: gzip stamps the time into
// every archive, so the same folder packed twice never matched and every reconnect bought a whole new
// read of code that had not changed, emptying the page's counts and its price while it ran.
const treeDigest = (() => {
  const h = createHash("sha256");
  for (const rel of [...files].sort()) {
    let body = Buffer.alloc(0);
    try { body = readFileSync(join(root, rel)); } catch { continue; }
    h.update(rel).update("\0").update(createHash("sha256").update(body).digest("hex")).update("\n");
  }
  return h.digest("hex");
})();
// The commit this tree is. Your .git is never uploaded -- nothing of your history leaves this
// machine -- so the one sha the report needs is read here and sent as forty characters. A folder
// that is not a checkout sends nothing, and the report says so rather than inventing one.
const head = (() => {
  try {
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return /^[a-f0-9]{40}$/.test(sha) ? sha : "";
  } catch { return ""; }
})();
const archive = join(work, "tree.tgz");
step("connecting");
await exec("tar", ["-czf", archive, "-C", root, "-T", list]);
const bytes = readFileSync(archive);
const PART = 1_500_000;
let resumed = false;
const parts = Math.max(1, Math.ceil(bytes.length / PART));
for (let off = 0; off < bytes.length; off += PART) {
  const last = off + PART >= bytes.length;
  step(parts > 1 ? `connecting, ${Math.floor(off / PART) + 1} of ${parts}` : "connecting");
  // The last part asks for this machine's key when none is stored yet: minted once the repository
  // row exists, kept in ~/.cortad for the runs a coding agent asks for on later days.
  const put = await call("PUT", `/local/${box}/tree?last=${last ? 1 : 0}${last ? `&digest=${treeDigest}${head ? `&head=${head}` : ""}` : ""}`, bytes.subarray(off, off + PART),
    { raw: true, timeoutMs: 120_000, ...(last && !viaToken ? { headers: { "x-cortad-machine": hostname().slice(0, 80) } } : {}) }).catch(unreachable);
  if (!put.ok) fail(put.data?.error ?? `upload failed (${put.status})`);
  if (last) {
    resumed = put.data?.resumed === true;
    if (typeof put.data?.machineKey === "string" && put.data.machineKey) writeToken(project, put.data.machineKey);
    writeDigest(project, treeDigest);
  }
}
// Unchanged code has already been read: coming back says so instead of claiming a second read.
stepDone(resumed ? "connected · nothing changed since last time" : "connected");
// The coding agents on this machine learn about Cortad now, once: an MCP entry and a skill in each
// one's own home folder. A run started by an agent later comes back through lib/cli.mjs.
if (!viaToken) {
  const added = await registerAll().catch((err) => { if (verbose) say(`could not register with your coding agents: ${err?.message ?? err}`); return []; });
  if (added.length) say(`added to ${added.join(", ")} · ask ${added.length === 1 ? "it" : "them"} for cortad any time`);
}

lock = await makeLock({ root, work });
if (lock && !lockHolds(lock, root)) lock = null;
if (!lock) say("shell commands are off on this machine (no sandbox-exec or bubblewrap). Everything else works.");

// A change to their own files, settled: what "I fixed it" looks like from here. Folders an app
// writes to by itself are not a fix.
const NOT_A_FIX = /(?:^|[\\/])(?:node_modules|\.git|\.next|\.nuxt|\.turbo|\.cache|dist|build|coverage|logs?|tmp|__pycache__|\.venv|venv)(?:[\\/]|$)|\.log$/;
function sourceChanged() {
  return new Promise((resolve) => {
    let timer = null;
    let watcher = null;
    const done = () => { try { watcher?.close(); } catch { /* closed */ } resolve(); };
    try {
      watcher = watch(root, { recursive: true }, (_event, file) => {
        if (!file || NOT_A_FIX.test(String(file))) return;
        clearTimeout(timer);
        timer = setTimeout(done, 1200);
      });
    } catch { setTimeout(done, 15_000); }
  });
}
// `watching` says whether a message sent to this app can be seen arriving: only an app this command
// started carries the hook, and only a runtime the hook exists for.
const announce = () => call("POST", `/local/${box}/app`, { port: app.port, cmd: app.cmd, origins: envOrigins(envFiles), lifted: app.lifted ?? [], watching: Boolean(launched && capture?.watching(app.port)), metered: Boolean(launched && capture?.watching(app.port)) });

// Your app's life beside this connection. It is started; if it stops, or never comes up, this stays
// and starts it again the moment you save a fix, and the browser is told each time it answers, so a
// world still looking for your chat asks again by itself. Nothing is ever rerun by hand.
async function appLife() {
  for (let first = true; ; first = false) {
    const got = await startApp();
    if (got.port) { app = got; break; }
    await call("POST", `/local/${box}/stopped`, { said: mask(got.said || got.why).slice(-2000) }).catch(() => {});
    say(got.noStart ? got.why : `${got.why} Fix it and save: it is started again by itself.`);
    // Said with the same words the agent prompt waits for, so an agent holding the terminal reports
    // the failure instead of waiting for a line that never comes.
    if (first) say("your app did not start. Go back to the browser; it says what stopped it. Ctrl-C disconnects.");
    await sourceChanged();
    say("saw your change, starting your app again");
  }
  const told = await announce();
  clearStep();
  if (!told.ok) fail(told.data?.error ?? `could not register your app (${told.status})`);
  say(`your app is answering on port ${app.port}${app.cmd ? ` · ${app.cmd}` : ""}`);
  say("leave this open. Go back to the browser; Ctrl-C disconnects.");
  let downSince = 0;
  let toldDown = false;
  let appTold = true;
  forgetTold = () => { appTold = false; };
  for (let up = true; !closing;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (closing || restarting) continue;
    const now = await answers(app.port);
    if (now) {
      downSince = 0; toldDown = false;
      // Said until it is heard. Said once, it was lost when their app came back while the network
      // was down, and the screen went on showing an app that had stopped while it answered turns.
      if (!up || !appTold) { up = true; appTold = Boolean((await announce().catch(() => null))?.ok); }
      continue;
    }
    if (up) { up = false; downSince = Date.now(); }
    appTold = false;
    const downFor = Date.now() - downSince;
    // Not answering. A dev server restarting on a save is busy and says so in its output: it is
    // left alone, however long its own startup takes.
    // A watcher that has said its app crashed is not busy, it is waiting, and says so.
    const crashed = /app crashed - waiting|Failed running|waiting for (?:file )?changes before restart/i.test(lastSaid.slice(-600));
    const busy = launched && !appGone && !crashed && Date.now() - lastOutputAt < 15_000;
    if (busy || downFor < (crashed ? 4_000 : 10_000)) continue;
    // Down for real. The screen is told, so it never shows an app that is not there.
    if (!toldDown) toldDown = Boolean((await call("POST", `/local/${box}/stopped`, { said: mask(lastSaid || "your app stopped answering").slice(-2000) }).catch(() => null))?.ok);
    // An app that went quiet or exited did not stop because of a save (it was killed, it ran out
    // of memory, it crashed on a request), so waiting for a save would wait forever. It is started
    // here, whoever started it first: an app this command only attached to (yours, from another
    // terminal, or one left behind by a terminal that was killed) is gone now, and this command
    // knows how it starts. Only an app given by --port is left to you, and picked up when it returns.
    if (launched && !appGone && !crashed && downFor < 25_000) continue;
    if (!launched && flag("--port")) continue;
    restarting = true;
    try {
      if (child?.pid) await stopApp(child.pid);
      say("your app stopped answering, starting it again");
      let back = launched ? await launch(180_000) : await startApp();
      while (!back.port && !closing) {
        await call("POST", `/local/${box}/stopped`, { said: mask(back.tail || back.said || lastSaid).slice(-2000) }).catch(() => {});
        say("your app did not come back. Fix it and save: it is started again by itself.");
        await sourceChanged();
        say("saw your change, starting your app again");
        back = launched ? await launch(180_000) : await startApp();
      }
      if (back.port) { app = { ...app, ...(back.cmd !== undefined ? back : {}), port: back.port }; up = true; downSince = 0; toldDown = false; appTold = Boolean((await announce().catch(() => null))?.ok); say(`your app is answering again on port ${app.port}`); }
    } finally { restarting = false; }
  }
}
void appLife().catch((e) => fail(String(e?.message ?? e)));

// Keep the laptop awake while a world stands on it.
if (process.platform === "darwin") spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();

// Started by a shell verb rather than a person, this process leaves once no run has needed it for
// a while, so an app is not held up all night for a verify that finished at noon.
const IDLE_MS = 10 * 60_000;
if (argv.includes("--until-idle") && stored) {
  let idleSince = Date.now();
  setInterval(async () => {
    const res = await call("GET", "/mcp/status", undefined, { headers: { authorization: `Bearer ${stored}` } }).catch(() => null);
    if (res?.ok && res.data?.run && !finished(res.data.run)) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) { say("no run for ten minutes, leaving"); await close(0); }
  }, 60_000).unref();
}

async function close(code = 0) {
  if (closing) return;
  closing = true;
  clearRunner(project);
  await call("DELETE", `/local/${box}`).catch(() => {});
  if (child?.pid) await stopApp(child.pid);
  for (const kid of sidecars) if (kid.pid) await stopApp(kid.pid);
  await exec("rm", ["-rf", work]).catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => close(0));
process.on("SIGTERM", () => close(0));

let quiet = 0;
// Each poll names the jobs the last one brought. A poll's answer can die on the way (the network
// drops, the lid closes): the server sends again whatever is not named, and a job seen twice is
// done once.
let got = [];
const seenJobs = new Set();
for (;;) {
  let res;
  try { res = await call("GET", `/local/${box}/jobs${got.length ? `?ack=${got.join(",")}` : ""}`, undefined, { timeoutMs: 40_000 }); }
  catch { quiet += 1; if (quiet === 3) say("reconnecting..."); await new Promise((r) => setTimeout(r, Math.min(quiet, 10) * 1000)); continue; }
  if (closing) break;
  if (res.status === 404) {
    // The server restarted and forgot this terminal. It is the same terminal: it proves so with the
    // key it was given, its box is opened again, and the app it is holding is announced again.
    const back = await call("POST", "/local/reattach", { box, name: basename(root), project }).catch(() => null);
    if (!back?.ok) { say("this session ended on the server. Run the command again for a new one."); await close(1); }
    if (app?.port) await announce().catch(() => {});
    forgetTold?.();
    continue;
  }
  if (!res.ok) { quiet += 1; await new Promise((r) => setTimeout(r, 2000)); continue; }
  if (quiet >= 3) say("connected again");
  quiet = 0;
  got = (res.data?.jobs ?? []).map((job) => job.id);
  for (const job of res.data?.jobs ?? []) {
    if (seenJobs.has(job.id)) continue;
    seenJobs.add(job.id);
    if (seenJobs.size > 2000) seenJobs.delete(seenJobs.values().next().value);
    verb(job).catch((e) => ({ error: String(e.message) })).then((out) => call("POST", `/local/${box}/jobs/${job.id}`, out).catch(() => {}));
  }
}
