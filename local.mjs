#!/usr/bin/env node
// Cortad on your own machine. Run from your repository's root with the code the connect screen
// showed:
//   npx cortad ABCD2345   [--port 3000] [--start "npm run dev"] [--proxy] [--verbose]
//
// What it does: signs in with the code, uploads your source files once (never .env, never
// node_modules) so your code can be read, starts your app the way you start it, then holds one
// outbound connection open and does what a run asks: a request to your app, a file read, a shell
// line. The shell is locked by the operating system (lib/lock.mjs) and cannot write your code;
// nothing here writes your files at all. It also makes Cortad known to the coding agents on this
// machine (lib/register.mjs): an MCP entry and a skill, so `npx cortad mcp` answers them from then
// on with the key this connect leaves in ~/.cortad. Nothing here touches git. Your environment
// never leaves this machine. Ctrl-C ends everything.

import { storesOf, withoutStoreSettings } from "./lib/stores.mjs";
import { notAnApp, withoutStores } from "./lib/app-port.mjs";
import { holdsKeys, secretEnvValues } from "./lib/keys.mjs";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { COMMANDS, main as face, unknownVerb, VERBS } from "./lib/cli.mjs";
import { addNews, homeOf, projectOf, readToken, writeApp, writeDigest, writeToken } from "./lib/home.mjs";
import { changesOf, commandText, RELOADER, sourceOf } from "./lib/fresh.mjs";
import { chainOf, elapsedMs, holderOf, listening, listenerOn, portInError, spawnTied, stopTree, supervisorOf } from "./lib/proc.mjs";
import { claimRunner, readRunner, releaseRunner, replaceRunner, startedAtOf, writeRunner } from "./lib/runner.mjs";
import { registerAll } from "./lib/register.mjs";
import { machineText } from "./lib/read-text.mjs";
import { VERSION } from "./lib/spec.mjs";
import { maskedLines, maskWith, secretValues } from "./lib/env-secrets.mjs";
import { finished, unseenText } from "./lib/text.mjs";
import { lockHolds, makeLock } from "./lib/lock.mjs";
import { AS_HEADER, makeIdentities } from "./lib/mint.mjs";
import { CAPTURED, makeCapture } from "./lib/replay.mjs";
import { sampleHere } from "./lib/sample.mjs";
import { mintAcross, originFor, servicePort, waitForPort } from "./lib/service.mjs";
import { listingUrl } from "./lib/listing.mjs";
import { hookable, installPlan, missingDependency, shownCommand, startPlan, workspaces } from "./lib/start.mjs";
import { openProxy } from "./lib/proxy.mjs";
import { liftedLimits, sessionLifts } from "./lib/switches.mjs";
import { makeKeeping } from "./lib/keeping.mjs";
import { downLine, makeHealth } from "./lib/health.mjs";
import { markRun, writesDirOf, writtenPaths } from "./lib/writes.mjs";
import { makeHeld } from "./lib/held.mjs";
import { answerAsk, ASK, makeAutoReach, takeAsk } from "./lib/auto-reach.mjs";

const argv = process.argv.slice(2);
// The two faces a coding agent uses after the first connect (lib/cli.mjs): the MCP server the
// client starts on every session, and the same verbs as shell commands. Neither runs the connect
// below, and `npx cortad findings` is a verb, never a code.
if (COMMANDS.has(argv[0] ?? "")) process.exit(await face(argv));
// A command word this version does not know is never taken for a connect code: `feedback`, read as
// the code FEEDBACK, signed the folder in again and ended the session it was typed in.
if (unknownVerb(argv[0])) {
  console.error(`cortad  ${argv[0]} is not a command of cortad ${VERSION}. Its commands are ${VERBS.slice(0, -1).join(", ")} and ${VERBS.at(-1)}; npx cortad@latest <command> runs the newest. A connect code is typed in capitals, as the connect screen shows it.`);
  process.exit(1);
}
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const verbose = argv.includes("--verbose");
// A code is eight characters from the connect screen's alphabet, which has no I, O, 0 or 1.
let code = (argv.find((a) => /^[A-HJ-NP-Za-hj-np-z2-9-]{8,9}$/.test(a) && !a.startsWith("-")) ?? "").toUpperCase().replace(/-/g, "");
const say = (line) => console.log(`cortad  ${line}`);
const fail = (line) => { console.error(`cortad  ${line}`); process.exit(1); };

const explain = argv.includes("--explain");
// The app is seen through a local proxy (lib/proxy.mjs) even where the hook could load into it.
const proxyAsked = argv.includes("--proxy");
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
// `npx cortad` alone connects too: with the key this folder kept from its last connect, or, with none,
// by one approval in the browser (pairing below). A word that is neither a code nor a flag is refused.
const words = argv.filter((a, i) => !a.startsWith("-") && !["--port", "--start"].includes(argv[i - 1] ?? ""));
if (!explain && !viaToken && words.length && !/^[A-Z0-9]{8}$/.test(code)) fail(`usage: npx cortad <code from the connect screen> [--port N] [--start \"cmd\"] [--proxy]   |   npx cortad --explain   |   npx cortad ${[...VERBS, "wait"].join(" | ")}`);
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
// Which project this is, as a hash of where it lives: the same folder coming back resumes the same
// connection, and the path itself never leaves this machine.
const project = projectOf(root);

// One process holds a project's app up (lib/runner.mjs), and its state is what every reader reports.
// `reach: "ask"`: an agent's reach is sent by this process (lib/auto-reach.mjs), signed in where it can.
const me = { pid: process.pid, startedAt: startedAtOf(), by: viaToken ? "token" : "connect", reach: "ask", version: VERSION };
// The last record written, so a fact learned while the app is up is added to it.
let became = null;
// What this command did on this machine, once the app answers: said at connect, and kept in the
// record for `status` with show machine (lib/read-text.mjs machineText).
let machineOf = () => null;
const become = (state, fields = {}) => { became = { state, fields }; const machine = machineOf(); writeRunner(project, { ...me, ...(machine ? { machine } : {}), state, at: new Date().toISOString(), ...fields }); };
process.on("exit", () => releaseRunner(project));
// Started for a run while another process already holds this project's app up: that one serves it.
// A connect from the screen is the person starting over, so the one before it is ended first.
async function holdProject() {
  for (let tries = 0; tries < 2; tries++) {
    const held = claimRunner(project, { ...me, state: "starting", at: new Date().toISOString() });
    if (!held) return;
    if (viaToken) { say(`pid ${held.pid} already holds this project's app up and serves the run`); process.exit(0); }
    say(`an earlier cortad (pid ${held.pid}) is holding this project's app up; stopping it so only this one runs`);
    await replaceRunner(held);
  }
  fail("another cortad process keeps holding this project's app up. Stop it and run this again.");
}
// A verb waits on this record from the moment it starts this process, so it is taken first.
if (viaToken) await holdProject();

// ---- what leaves the machine: the source git would commit, and nothing git is told to ignore
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|coverage|vendor|venv|\.venv|env|target|tmp|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.terraform|\.wrangler|\.svelte-kit|\.output|\.parcel-cache|\.idea|\.vscode|secrets?|\.secrets?)$/i;
// Env files by any name (scripts/books.env is one), keys, credentials, media and compiled output.
const SKIP_FILE = /^\.env(\..*)?$|^\.envrc$|\.env$|\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|log|lock|map|zip|tar|gz|tgz|7z|rar|png|jpe?g|gif|webp|ico|svg|mp3|mp4|wav|mov|pdf|woff2?|ttf|otf|eot|bin|exe|dll|so|dylib|wasm|onnx|pt|pth|safetensors|numbers|DS_Store)$/i;
const MAX_FILE = 25_000_000;
const MAX_TOTAL = 256_000_000;
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
// A run's request to an endpoint your app answers later carries the first (src/customer/endpoint.ts),
// with how long the run waits for this reply; a reply with no answer says in the second why none came.
// The wait here ends a few seconds before the run's own and the wire's hold, so the reason reaches it.
const LATER_HEADER = "x-cortad-answer", LATER_MISSED = "x-cortad-later", LATER_MARGIN_MS = 5_000;
// The cookies each trial's own turns were handed, newest trials kept.
const trialJars = new Map();
// Endpoints that refused a new visitor: their trials carry the person's own session.
const ownSession = new Set();
const TRIAL_JARS = 500;
let identities = null;
let capture = null;
// The local proxy an app is seen through when the hook cannot load into it (lib/proxy.mjs).
let proxy = null;
// The port the run and the agent send to: the proxy's front when there is one, else the app's own.
const doorPort = () => proxy?.port ?? app?.port;
// The request the app answered in words while no model call came through the proxy, as "POST /chat".
let unseen = "";
// The runner's record of where to send: the front, with the app's own port beside it, and the
// endpoints that took a message and answered at once with no model call tied to it (lib/replay.mjs).
// The front listens on 127.0.0.1; the app on whichever loopback address it answered on.
const upAt = (port = app?.port) => {
  const receipts = capture?.receipts() ?? [];
  return { ...(proxy ? { port: proxy.port, host: "127.0.0.1", proxied: port, ...(unseen && !proxy.seen() ? { unseen } : {}) } : { port, host: appHost }), ...(receipts.length ? { receipts } : {}) };
};
// The app's life, shared by the code that starts it, watches it and restarts it.
let closing = false;
let restarting = false;
let appGone = false;
let lastSaid = "";
let lastOutputAt = Date.now();
let forgetTold = null;
// The run's requests your app has not answered yet: a slow health probe while any are open is our
// load on it, not a hang.
let answering = 0;
const held = makeHeld({ rows: () => capture?.usage()?.rows ?? [], say: (line) => say(line) });
// Closed while a store the app reaches is brought up and copied, until the app runs on the copy: the
// run's requests wait at it rather than write into the original.
let gate = null;
const hold = () => { if (!gate) { let open; gate = new Promise((r) => { open = r; }); gate.open = () => { gate = null; open(); }; } };
const release = () => gate?.open();
const mask = (text) => maskWith(String(text ?? ""), secrets);

// ---- the wire
let box = "";
let key = "";
// The browser approves this computer: a link to open where the person is signed in, and four
// characters the page shows too. The terminal waits, and is handed a code once it is approved.
async function paired() {
  const machine = hostname().replace(/[^\w.-]/g, "-").slice(0, 80);
  const opened = await call("POST", "/local/pair", { name: basename(root).replace(/[^\w.-]/g, "-").slice(0, 80), machine }).catch(unreachable);
  if (!opened.ok) fail(opened.data?.error ?? `could not start connecting (${opened.status})`);
  const link = `${origin.origin}/approve/${opened.data.id}`;
  say(`approve this computer in your browser, where you are signed in to Cortad: ${link}`);
  say(`the page shows ${opened.data.words} and ${machine}; approve only if both match`);
  if (process.stdout.isTTY) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try { spawn(opener, [link], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* the link is printed */ }
  }
  for (const until = Date.now() + 10 * 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 2_000))) {
    const got = await call("POST", `/local/pair/${opened.data.id}/collect`, { secret: opened.data.secret }).catch(() => null);
    if (got?.ok && typeof got.data?.code === "string") { say("approved"); return got.data.code; }
    if (got && got.status === 410) break;
  }
  fail("the link was not approved within ten minutes. Run npx cortad again for a new one.");
}

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
// Where the hook reads the hosts a trial's writes may reach (lib/trace.cjs, lib/pyhook), and the
// yes they come from.
const outboundFile = join(work, "outbound.json");
let consent = {};
// The person's yes to raising their app's own limits and opening its sign-in switches for this
// session, from the browser. Until it arrives the app runs with its guards as they are.
let limitsYes = false;
mkdirSync(work, { recursive: true });
// What the app printed this session, beside the project's other records rather than in a temp folder
// the agent is never told of. Emptied once this process holds the project (holdProject), so a second
// command in the same folder never empties a live session's output. Masked once more at the end of
// the session, up to a size read whole, with the values learned while it ran.
const bootLog = join(homeOf(project), "app.log");
const MASKED_AT_END_MAX = 64 * 1024 * 1024;
// The same output in memory with when each piece came, so the lines printed during one request are
// its own (lib/proof.mjs). Masked before either keeps it, and never cut inside a value.
const printed = [];
const PRINTED = 2000;
const logTo = () => maskedLines(() => secrets, (text) => {
  try { appendFileSync(bootLog, text, { mode: 0o600 }); } catch { /* still kept in memory */ }
  printed.push({ at: Date.now(), text });
  if (printed.length > PRINTED) printed.splice(0, printed.length - PRINTED);
});
const printedBetween = (from, to) => printed.filter((p) => p.at >= from && p.at <= to).map((p) => p.text).join("");
// Files nobody may read through this program: keys, and git's own internals.
const SECRET_PATH = /(?:^|\/)(?:\.git|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa)[^/]*|[^/]*\.(?:pem|key|p12|pfx|jks|keystore))(?:\/|$)/;
// The engine's paths, as this machine has them. Its scratch files live in this program's own
// temp folder, never beside your code.
const translate = (s) => String(s ?? "").split("/workspace/repo").join(root).split("/tmp/bl-boot.log").join(bootLog).split("/tmp/boot.log").join(bootLog);
const scratch = (p) => { const r = resolve(translate(p)); return r.startsWith("/tmp/") ? join(work, r.slice(5)) : r.startsWith(work + sep) ? r : null; };
const readable = (p) => {
  const r = resolve(translate(p));
  if (r === bootLog || r.startsWith(work + sep)) return r;
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
      const port = Number(b.port) || doorPort();
      if (!app || (port !== app.port && port !== doorPort())) return { error: `refused: port ${port} is not your app` };
      const path = typeof b.path === "string" && b.path.startsWith("/") ? b.path : "/";
      const headers = {};
      for (const [k, v] of Object.entries(b.headers ?? {})) if (!/^(host|content-length|connection)$/i.test(k)) headers[k] = String(v);
      // Held from here, before anything is awaited, so a cancel from the run never arrives first.
      const turn = String(Object.entries(headers).find(([k]) => k.toLowerCase() === "x-cortad-turn")?.[1] ?? "");
      // Every request of ours is tagged, a knock or a revisit as much as a trial, so the hook never
      // takes one for the person's: it would become the request trials copy and the sign-in they carry.
      if (!turn) headers["x-cortad-turn"] = `cortad-${String(job.id).replace(/[^\w.-]/g, "").slice(0, 64)}`;
      const letGo = held.hold(job.id, turn || headers["x-cortad-turn"]);
      // An endpoint your app answers later: it takes the message and its model answers afterwards,
      // outside the request (a queue's worker). Its own reply only says it took the message.
      const laterAt = Object.keys(headers).find((k) => k.toLowerCase() === LATER_HEADER);
      const laterMs = laterAt === undefined ? NaN : Number(headers[laterAt]);
      const later = laterAt !== undefined && (headers[laterAt] === "later" || laterMs > 0);
      if (laterAt !== undefined) delete headers[laterAt];
      if (later) capture?.forget(turn || headers["x-cortad-turn"]);
      // A request that speaks as one of your app's own callers carries the role, not the token:
      // the token was issued on this machine and is put in here, so it never travels.
      const marker = Object.keys(headers).find((k) => k.toLowerCase() === AS_HEADER);
      let spokenAs = null;
      if (marker) {
        const role = headers[marker];
        delete headers[marker];
        if (role === CAPTURED || role.startsWith(`${CAPTURED}:`)) {
          spokenAs = role;
          // Speaking as one of the customers whose requests we watched: every header their own client sent.
          const theirs = capture?.headers(role);
          for (const [name, value] of Object.entries(theirs ?? {})) { for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k]; headers[name] = value; }
          // No request of theirs is held (a new connect): sent from the app's own address, as Cortad's
          // own test request is, so an app that lets visitors in by Origin lets this one in.
          const from = !theirs && app ? ownOrigin(app.port) : null;
          if (from && !Object.keys(headers).some((k) => k.toLowerCase() === "origin")) { headers.origin = from; headers.referer = `${from}/`; }
        } else {
          const held = await identities?.headerFor(role);
          if (held) { for (const k of Object.keys(headers)) if (k.toLowerCase() === held.name) delete headers[k]; headers[held.name] = held.value; }
        }
      }
      const method = String(b.method ?? "GET").toUpperCase();
      const init = { method, headers, redirect: "manual" };
      // Speaking as one of several customers, the ids in the body are that customer's own.
      const body = spokenAs ? capture?.bodyAs(spokenAs, `${method} ${path.split("?")[0]}`, b.body) ?? b.body : b.body;
      if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = typeof body === "string" ? body : JSON.stringify(body);
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
      // Through the proxy's front when there is one, which is where the request is seen.
      const url = proxy ? `http://127.0.0.1:${proxy.port}${path}` : hostUrl(port, path);
      // An address the app wrote from its own port, as an app that keeps its address in its settings
      // does, is followed through the front as well.
      const yours = (to) => { try { const u = new URL(to, url); return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(u.hostname) && [new URL(url).port, String(app.port)].includes(u.port) ? new URL(u.pathname + u.search, url).href : null; } catch { return null; } };
      // Each trial keeps the cookies your app set on its own earlier turns, so a conversation your app
      // holds in a cookie carries from one turn to the next and never into another trial.
      const trial = turn.replace(/:\d+$/, "");
      let jar = trial ? trialJars.get(trial) ?? "" : "";
      // Held as long as the run waits for this reply: a course generator that takes ninety seconds
      // a reply is waited on for three of them. A run that says nothing gets the old 170 seconds.
      const holdMs = Math.min(Math.max(Number(b.waitMs) || 170_000, 1_000), 630_000);
      const began = Date.now();
      // The trial's own cookies take the place of the captured ones of the same name: a session your
      // app keys its conversation on is this trial's, never the one every trial was handed at capture.
      const cookieAt = Object.keys(headers).find((k) => k.toLowerCase() === "cookie");
      const { [cookieAt ?? ""]: given = "", ...cookieless } = headers;
      const cookie = () => [...new Map([...given.split(/;\s*/), ...jar.split(/;\s*/)].filter(Boolean).map((pair) => [pair.split("=")[0].trim(), pair])).values()].join("; ");
      // A cookie your app hands any new visitor is that visitor's session: each trial asks for its own,
      // so one trial's answer in progress never holds another's (AI Answers answers one at a time per
      // visitor, and every trial carried the agent's one session). An endpoint that refuses a new
      // visitor keeps the person's session for this trial and every later one.
      const door = `${method} ${path.split("?")[0]}`;
      const fresh = Boolean(trial && given && !trialJars.has(trial) && !ownSession.has(door));
      const visitor = async () => {
        const res = await fetch(url, { method: "GET", headers: cookieless, redirect: "manual", signal: AbortSignal.any([letGo, AbortSignal.timeout(15_000)]) }).catch(() => null);
        await res?.arrayBuffer().catch(() => null);
        return (res?.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean).join("; ");
      };
      const sent = (at, over = {}) => fetch(at, {
        ...init, ...over,
        headers: { ...(jar ? cookieless : headers), ...(over.headers ?? {}), ...(jar ? { cookie: cookie() } : {}) },
        signal: AbortSignal.any([letGo, AbortSignal.timeout(holdMs)]),
      });
      const keep = (res) => {
        const set = res.headers.getSetCookie?.() ?? [];
        if (!set.length) return;
        const pairs = new Map([...jar.split(/;\s*/), ...set.map((c) => c.split(";")[0])].filter(Boolean).map((pair) => [pair.split("=")[0].trim(), pair]));
        jar = [...pairs.values()].join("; ");
        if (trial) { trialJars.delete(trial); trialJars.set(trial, jar); if (trialJars.size > TRIAL_JARS) trialJars.delete(trialJars.keys().next().value); }
      };
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
        if (fresh) { jar = await visitor(); if (jar) trialJars.set(trial, jar); }
        let res = await sent(url);
        keep(res);
        if (fresh && jar && (res.status === 401 || res.status === 403)) {
          ownSession.add(door);
          jar = "";
          trialJars.delete(trial);
          await res.arrayBuffer().catch(() => null);
          res = await sent(url);
          keep(res);
        }
        if (method !== "GET" && sentBack(res)) { await warm(); if (jar) res = await sent(url); }
        const buf = Buffer.from(await res.arrayBuffer());
        // An OpenAPI document can run to megabytes; the caller asks for it whole.
        const LIMIT = Number.isInteger(b.limit) && b.limit > 0 ? Math.min(b.limit, 8 * 1024 * 1024) : 262_144;
        // A session cookie your app sets is its business: it is dropped here, and every other header masked.
        const said = Object.fromEntries([...res.headers].filter(([k]) => !/^set-cookie2?$/i.test(k)).map(([k, v]) => [k, mask(v)]));
        return { status: res.status, headers: said, body: mask(buf.subarray(0, LIMIT).toString("utf8")), truncated: buf.length > LIMIT };
      };
      const counted = async () => { await gate; letGo.throwIfAborted(); answering += 1; try { return await ask(); } finally { answering -= 1; } };
      // The turn's answer on an endpoint your app answers later: the model's last words, once the hook
      // has seen its calls go quiet, within the time the run waits for this reply. None came: the
      // reply says the status of the model call that gave no words, or the seconds waited.
      const answered = async (got) => {
        if (!later || got.status < 200 || got.status >= 300) return got;
        const until = began + Math.min(holdMs, laterMs > 0 ? laterMs : Infinity) - LATER_MARGIN_MS;
        const said = capture ? await capture.answered(turn || headers["x-cortad-turn"], until, letGo) : null;
        if (letGo.aborted) return { error: "cancelled by the run" };
        if (!said?.reply.trim()) return { ...got, headers: { ...got.headers, [LATER_MISSED]: JSON.stringify(said ? { model: said.status } : { waited: Math.round((Date.now() - began) / 1000) }) } };
        return { ...got, headers: { "content-type": "application/json" }, body: mask(JSON.stringify({ reply: said.reply })), truncated: false };
      };
      try { return await answered(await counted()); }
      catch (e) {
        if (letGo.aborted) return { error: "cancelled by the run" };
        const code = String(e.cause?.code ?? e.code ?? "");
        if (!/ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) return { error: `nothing answered at port ${port}: ${code || e.message}` };
        // Held through a restart of ours however long it takes: a request it cut is sent again after it.
        for (let i = 0; (i < 45 || restarting) && !letGo.aborted && !(await answers(app.port)); i++) await new Promise((r) => setTimeout(r, 1000));
        try { return { ...(await answered(await counted())), heldForRestart: true }; }
        catch (again) { return { error: letGo.aborted ? "cancelled by the run" : `nothing answered at port ${port}: ${String(again.cause?.code ?? again.message)}` }; }
      } finally { held.done(job.id); }
    }
    // The run gave up on a request it asked for: its wait ran out, or the run ended.
    case "cancel": return { cancelled: held.letGo([String(b.id ?? "")]) };
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
      try {
        mkdirSync(dirname(mine), { recursive: true });
        if (b.append) appendFileSync(mine, bytes); else writeFileSync(mine, bytes);
        // The read's tools, kept for this project too: the next start hands them to the hook before
        // the app loads its code, which a Node app needs to have its tool functions wrapped.
        if (mine === join(work, "tools.json")) {
          try { mkdirSync(homeOf(project), { recursive: true, mode: 0o700 }); writeFileSync(join(homeOf(project), "tools.json"), bytes, { mode: 0o600 }); } catch { /* kept for this session only */ }
          void recordTools();
        }
        return { success: true, stderr: "" };
      }
      catch (e) { return { success: false, stderr: String(e.message) }; }
    }
    case "mint": return identities ? JSON.parse(mask(JSON.stringify(await mintAcross({
      recipes: b.recipes, root, appDir, onPath, appPort: app?.port, portFor: serviceUp,
      mint: (recipes, port, origin) => identities.mint({ ...b, recipes, headers: { ...(b.headers ?? {}), ...(origin ? { origin, referer: `${origin}/` } : {}) } }, port),
      originFor: (port) => originFor(port, envOrigins(envFiles)),
    })))) : { identities: [] };
    // The last of what your app printed, for a reply it failed: the traceback a developer reads.
    // Masked like everything else, and the folder named so its paths can be read as your files.
    case "log": {
      const want = Math.min(Math.max(Number(b.bytes) || 16_000, 1), 200_000);
      try {
        const all = readFileSync(bootLog);
        const text = mask(all.subarray(Math.max(0, all.length - want)).toString("utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
        // A JVM stack names a class, not a path: the source files it could be are sent with it.
        const jvm = /\bat\s+[\w$.]+\([\w$]+\.(?:java|kt|scala|groovy):\d+\)/.test(text);
        return { text, root, size: all.length, ...(jvm ? { files: files.filter((f) => /\.(?:java|kt|scala|groovy)$/.test(f)).slice(0, 20_000) } : {}) };
      } catch { return { text: "", root, size: 0 }; }
    }
    // The person changed what they said yes to while this command runs.
    case "consent": await allowOutbound(b); return { ok: true };
    // A line for the agent reading this terminal: the read of the code landing, said the moment it does.
    // One marked news (a run ending) is also kept for the hook, so an agent that was not listening
    // hears it on its next prompt or edit.
    case "say": {
      // Printed in a terminal and handed to a coding agent: no control characters, no direction overrides.
      const line = String(b.line ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
      if (line) say(line);
      if (line && b.news) { try { addNews(project, line); } catch { /* said in this terminal only */ } }
      return { ok: true };
    }
    case "restart": return restartApp();
    case "inventory": return inventoryOf(b.probe && typeof b.probe === "object" ? b.probe : {});
    // Your own pages, read here rather than in a world's shell: that shell is sealed away from
    // every env file and every host but this one, so inside it no store of yours has an address.
    case "sample": return { report: JSON.parse(mask(JSON.stringify(await sampleHere(b, envValues(envFiles), root)))) };
    case "lock": return { locked: Array.isArray(b.hosts) ? b.hosts.length : 0 };
    // What your app spent on its providers, from the hook inside it. An app this command did not
    // start has no hook, and the empty answer says the meter is absent rather than that nothing was spent.
    // Masked like every other reply: a tool's answer can carry a value from their env files. The
    // calls of the `turn` asked about also say what their model was told.
    // `toolsRecorded: false`: the app was started before the read's list of tools, so a tool that ran
    // was not seen; a run says "not recorded", never that none ran.
    case "usage": return capture ? { ...JSON.parse(mask(JSON.stringify(capture.usage(b.turn) ?? {}))), ...(launched && toolsKnown() ? { toolsRecorded: toolsRecorded() } : {}) } : {};
    // Every route your app holds, read by the hook off the app itself, masked like the meter.
    case "routes": return capture ? JSON.parse(mask(JSON.stringify(capture.registry(app?.port)))) : {};
    // A world is ended from this terminal, never from the cloud.
    case "destroy": return { ok: true };
    default: return { ok: true };
  }
}

const exec = promisify(execFile);

// ---- start or attach to the app
// The address the app answers on: 127.0.0.1, or [::1] when it bound IPv6 localhost alone, which a
// Vite dev server does and which a probe of 127.0.0.1 waited three minutes on.
let appHost = "127.0.0.1";
const hostUrl = (port, path = "/") => `http://${appHost === "::1" ? "[::1]" : appHost}:${port}${path}`;
const answers = async (port) => {
  for (const host of [appHost, appHost === "::1" ? "127.0.0.1" : "::1"]) {
    try {
      const res = await fetch(`http://${host === "::1" ? "[::1]" : host}:${port}/`, { method: "GET", signal: AbortSignal.timeout(2500), redirect: "manual" });
      const head = await res.text().then((t) => t.slice(0, 300), () => "");
      if (notAnApp(head)) return false;
      appHost = host;
      return true;
    } catch { /* the other family next */ }
  }
  return false;
};
// The values an env file beside the app declares, exported into its process the way `source .env`
// would: an app with no dotenv loader of its own crashed every route without them. Example files
// hold placeholders and are left out; the shell's own environment and the lifted limits win.
function envExports(envFiles) {
  return envValues(envFiles.filter((f) => !/\.(example|sample)$/.test(f)));
}
const onPath = (bin) => (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, bin)));
// Where their app lives inside this repository, and how it starts. Worked out in lib/start.mjs.
let appDir = root;

// ---- a sign-in mounted in another workspace
// One app served its AI from apps/api and mounted sign-in in apps/dashboard: a test account can
// only be made where the sign-in is, and posting a sign-up at the AI's own port is a 404.
const toldService = new Set();
const signedInAt = (dir, port) => { if (!toldService.has(dir)) { toldService.add(dir); say(`signed in a test account through ${dir}`); } return port; };
// Everything else this command started, stopped with it: each started the way the app is, on the
// same copies of its data.
const sidecars = [];
function sidecar(cmd, cwd) {
  const kid = spawnTied(cmd, { cwd, env: { ...process.env, ...(capture ? capture.env(process.env) : {}), FORCE_COLOR: "0", ...(pinned.bin ? { PATH: `${pinned.bin}:${process.env.PATH ?? ""}` } : {}), ...keeping.envNow() } });
  sidecars.push(kid);
  kid.stdout.on("data", logTo());
  kid.stderr.on("data", logTo());
  return kid;
}
// The port that workspace's sign-in answers on. One it is already serving on comes first: starting
// a second copy of a dashboard that is already up costs a minute and takes its port.
async function serviceUp(group) {
  const named = servicePort(group.cwd);
  if (named && named !== app?.port && (await answers(named))) return signedInAt(group.dir, named);
  // Its own port taken by the app leaves nothing to wait on: whatever answers there is the app.
  if (!named || named === app?.port || !group.plan?.cmd) return null;
  sidecar(group.plan.cmd, group.plan.cwd);
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
// An app this command did not start carries nothing that counts its model calls, and no run plays
// against it (the API holds Run): databuddy's free run played 39 conversations into a route that
// answers from code.
const UNSEEN = "your app was already running, so Cortad cannot see the calls it makes to its model, and no run can start.";
async function startApp() {
  const wanted = Number(flag("--port"));
  // "--port 8106 --start ..." is "start it, it will answer on 8106", not "it is already on 8106":
  // read as the latter it said nothing was answering and never ran the command it was given.
  if (wanted && !flag("--start")) {
    if (!(await answers(wanted))) return { port: null, said: "", why: `nothing is answering on port ${wanted}, so there is nothing to ask.`, noStart: true };
    const took = await takeOver(wanted);
    if (took) return took;
    if (proxyAsked) {
      await useProxy();
      say(`your app was already running, so Cortad cannot see the calls it makes to its model until it is started with: ${Object.entries(proxy.env({ ...envExports(envFiles), ...process.env })).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    } else say(`${UNSEEN} Stop it and run this again without --port: this command starts your app itself.`);
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
  const lifted = sessionLifts(limitsYes, envFiles, sourceFiles);
  const raised = Object.keys(lifted).filter((n) => /^\d+$/.test(lifted[n]));
  const opened = Object.keys(lifted).filter((n) => !raised.includes(n));
  if (raised.length) say(`higher request limits for this session: ${raised.join(", ")}`);
  // Said out loud, because it changes who their app lets in for as long as this command runs.
  if (opened.length) say(`for this session your app runs with ${opened.map((n) => `${n}=${lifted[n]}`).join(", ")}`);
  launched = { cmd, lifted };
  if (proxyAsked || !hookable(appDir)) await useProxy();
  step(`starting your app: ${cmd}`);
  const up = await launch(180_000);
  if (up.port) return { port: up.port, cmd: launched.cmd, lifted: Object.keys(lifted) };
  // Already running: a second start dies on the port the first one holds. Held by a process running
  // in this repository, started from the terminal the person was already working in, it is the app
  // and is used as it stands. "Another next dev server is already running" is the same fact in a
  // framework's own words, and the port it holds is not always the one asked for. A holder running
  // from any other folder is another program: it is named, never tested as this app.
  const ports = up.held ? [] : up.exited !== null && ALREADY.test(up.tail) ? [...new Set([...up.tail.matchAll(/(?::|port\s*[:=]?\s*)(\d{4,5})\b/gi)].map((m) => Number(m[1])))] : [];
  const holders = up.held ? [up.held] : (await Promise.all(ports.map(holderOf))).filter(Boolean);
  for (const held of holders) {
    if (!ownFolder(held.cwd)) return { port: null, said: up.tail, why: whyNot({ ...up, held }) };
    if (await answers(held.port)) {
      launched = null; child = null;
      await keeping.forget();
      const took = await takeOver(held.port);
      if (took) return took;
      say(`${UNSEEN} Stop the one on port ${held.port} and run this again: this command starts your app itself.`);
      return { port: held.port, cmd: null };
    }
  }
  if (up.tail) console.error(up.tail);
  return { port: null, said: up.tail, why: whyNot(up) };
}
// A start that failed because another process holds the port, in the words a framework uses.
const ALREADY = /EADDRINUSE|address already in use|port.{0,40}(?:in use|already used|is taken|unavailable)|another .{0,20}(?:dev )?server is already running|already running (?:on|at) (?:http|port)/i;
const rootReal = realpathSync(root);
const ownFolder = (dir) => { try { const at = realpathSync(dir); return at === rootReal || at.startsWith(rootReal + sep); } catch { return false; } };
// Why a start did not come up, in a sentence that stands without the terminal: the runner's state
// carries it to the verbs, and the screen gets the app's own words beside it.
function whyNot(up) {
  const h = up.held;
  if (h) return `port ${h.port} is in use by another program (pid ${h.pid}${h.command ? `, ${h.command}` : ""}), so your app cannot listen there${up.fixed ? "; your app sets that port in its own code, so it cannot be moved" : ""}. Stop that program, then save a file here: your app is started again by itself.`;
  const wrongNode = pinned.major && !pinned.bin ? ` This project pins Node ${pinned.major} and this shell runs Node ${shellNode}: switch to ${pinned.major}.` : "";
  return `${up.exited !== null ? "your app stopped before it answered" : "your app did not answer within three minutes"}.${wrongNode} Fix it and save a file here: your app is started again by itself.`;
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
  await stopTree(top);
  for (let i = 0; i < 50 && (await answers(port)); i++) await new Promise((r) => setTimeout(r, 200));
  if (await answers(port)) { say("your app did not stop, so it is used as it is"); return null; }
  appDir = plan.cwd ?? root;
  pinned = pinnedNode();
  if (plan.within) say(`your app is in ${plan.within}, started there with: ${plan.cmd}`);
  say(`higher request limits for this session: ${names.join(", ")}`);
  launched = { cmd: plan.cmd, lifted, byTerminal: true };
  step(`starting your app: ${plan.cmd}`);
  const up = await launch(180_000);
  if (up.port) return { port: up.port, cmd: launched.cmd, lifted: names };
  if (up.tail) console.error(up.tail);
  return { port: null, said: up.tail, why: "your app did not come back after the restart." };
}

// What the running app was started from, noted in app.json for the verbs, which run in another
// process (lib/fresh.mjs): when it started, whether this command started it, whether it reloads on
// save, and what each source file said then. An app found already running is noted by its own
// process's age and command line, with the file names alone.
let loaded = null;
const noteApp = () => writeApp(project, loaded?.at
  ? { runner: process.pid, own: loaded.own, startedAt: new Date(loaded.at).toISOString(), reloads: loaded.reloads, files: loaded.files }
  : { runner: process.pid });
async function noteAttached(port) {
  const pid = await listenerOn(port);
  const chain = pid ? await chainOf(pid).catch(() => []) : [];
  loaded = { own: false, at: chain.length ? Date.now() - elapsedMs(chain[0].etime) : null, reloads: RELOADER.test(chain.map((p) => p.args).join("\n")), files: sourceOf(root, files, false) };
  noteApp();
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
// app is started again. So is a store or service it reaches that nothing runs yet (backUp). Every
// way the app is started comes through here, so it is fixed in one place.
async function launch(waitMs) {
  let up = await start(waitMs);
  if (up.port && !proxy && !(await hookedAt(up.port))) up = await startProxied(up, waitMs);
  // Only an app that stopped: one still running has not failed to start, whatever it printed.
  if (up.port || up.exited === null) return up;
  if (await keeping.backUp(app?.port).finally(release)) {
    up = await start(waitMs);
    if (up.port || up.exited === null) return up;
  }
  const ok = await installOnce(up.tail);
  // An install that failed is the reason their app cannot start, and it goes where the app's own
  // output goes: the terminal, and the screen that is waiting for the app.
  const said = (tail) => (installSaid ? `${installSaid}\n${tail}` : tail);
  if (!ok) return installSaid ? { ...up, tail: said(up.tail) } : up;
  const back = await start(waitMs);
  return back.port ? back : { ...back, tail: said(back.tail) };
}
// Whether the hook loaded into the process answering on `port`. A machine that cannot name that
// process leaves the app as it is.
const hookedAt = async (port) => { const pid = await listenerOn(port); return !pid || capture.hookedAt(port, pid); };
// The proxy, opened once: the app's model calls are seen there from the next start on.
async function useProxy() {
  if (proxy) return;
  const noted = () => { if (became?.state === "up") become("up", { ...became.fields, ...upAt(became.fields.proxied) }); };
  // A first model call seen through it is said to the run, for an app this command did not start.
  proxy = await openProxy({
    file: capture.file, rulesFile: capture.rulesFile, target: () => ({ host: appHost, port: app?.port }),
    onSeen: () => { forgetTold?.(); noted(); },
    onUnseen: (door) => { unseen = door; noted(); say(unseenText(door)); },
  });
  say("your app's model calls are seen through a local proxy on this machine, so the line of code that made each call is not known. During a run, its calls to other services go out as they would for a real customer: a conversation that books, charges or emails does it for real");
}
// An app run in a container: the proxy's settings never reach it, and 127.0.0.1 inside it is not this machine.
const IN_CONTAINER = /^\s*(?:sudo\s+)?(?:docker|podman)(?:-compose)?\b/;
// The app answered, and the hook is not in it: it is started again with its model settings on the
// proxy. One in a container would come back the same, so it is left up, seen at the front alone.
async function startProxied(up, waitMs) {
  await useProxy();
  if (IN_CONTAINER.test(launched?.cmd ?? "")) return up;
  await stopTree(child.pid);
  for (let i = 0; i < 75 && (await listenerOn(up.port)); i++) await new Promise((r) => setTimeout(r, 200));
  return start(waitMs);
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
    const keep = (log) => (d) => { tail = (tail + d.toString()).slice(-4000); log(d); if (verbose) process.stdout.write(d.toString()); };
    child.stdout.on("data", keep(logTo()));
    child.stderr.on("data", keep(logTo()));
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
// Ports this program tried and lost: two connects on one machine can pick the same free port in
// the same second, and the one that binds second sees "address already in use".
const lost = new Set();
async function freePortAbove(port) {
  for (let next = port + 1; next < port + 30; next++) if (!lost.has(next) && !(await listenerOn(next))) return next;
  return null;
}
const PORT_FLAG = /(--port[= ]|-p |\bPORT=)(\d{4,5})\b/;
// The port a start names: its command's flag, or PORT as this command sets it or an env file does.
const namedPort = (cmd, lifted) => Number(PORT_FLAG.exec(cmd)?.[2] ?? lifted.PORT ?? envExports(envFiles).PORT ?? 0) || 0;
async function freed(cmd, lifted) {
  const m = PORT_FLAG.exec(cmd);
  // The app's own env file names its port too: yunqiao's PORT=8105 sat in .env, and a stale copy
  // on that port was reported as "your app stopped" instead of moved past.
  const named = m ? Number(m[2]) : Number(lifted.PORT) || Number(envExports(envFiles).PORT) || 0;
  if (!named || (!lost.has(named) && !(await listenerOn(named)))) return { cmd, lifted };
  const port = await freePortAbove(named);
  if (!port) return { cmd, lifted };
  say(`port ${named} is taken on this machine, so your app starts on ${port}`);
  // The same port their env file names, moved the same way.
  return m ? { cmd: cmd.replace(m[0], `${m[1]}${port}`), lifted } : { cmd, lifted: { ...lifted, PORT: String(port) } };
}

// Your app's data, read once per session: copies made before the first start, and every restart
// after it runs against the same copies, so a crash mid-run does not lose what the run made. What
// was copied, started, or left where trials write into it is told in the terminal here and to the
// run with the app (announce), so status says it beside Run and the report keeps it.
const keeping = makeKeeping({
  root, work, ledgerFile: join(homeOf(project), "made.json"), onPath, say, hold, typed: Boolean(flag("--start")),
  launch: (plan) => sidecar(plan.cmd, plan.cwd),
  connections: () => capture?.connections() ?? [],
  settings: () => {
    const from = {};
    for (const file of envFiles.filter((f) => !/\.(example|sample)$/.test(f))) {
      let text = "";
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line); if (m && !(m[1] in process.env)) from[m[1]] = file; }
    }
    return { values: { ...envExports(envFiles), ...process.env }, from, appDir, sources: files.map((f) => join(root, f)) };
  },
});

async function start(waitMs, tries = 3) {
  const { cmd, lifted } = await freed(launched.cmd, launched.lifted ?? {});
  // The record of what the app writes opens with the app: the first run starts itself on the
  // server's side, with no verb here to mark it, and a restart mid-run keeps the record open.
  try { markRun(writesDirOf(homeOf(projectOf(root))), "session", { keep: true }); } catch { /* the app's writes go unrecorded */ }
  toolsAtStart = toolsNow();
  // Taken before the app reads a file: a save after this moment is a change it has not loaded.
  const note = { own: true, at: Date.now(), reloads: RELOADER.test(commandText(cmd, appDir)), answered: false };
  // The settings files count as what it loaded: an env file is rarely tracked, and an agent's edit to
  // one left the app on the old settings until the command was started again (ulaim, 2026-10-01).
  note.files = { ...sourceOf(root, files), ...sourceOf(root, envFiles.filter((f) => !/\.(example|sample)$/.test(f)).map((f) => relative(root, f))) };
  storesAt ??= storesNamed();
  loaded = note;
  const copies = await keeping.env(true);
  await allowOutbound();
  // A start command the person typed says which databases the app uses: the store settings of their
  // settings files are left for the app to load, since handed over here they outrank the
  // environment that command chose, and no copy is pointed at.
  const base = flag("--start") ? { ...withoutStoreSettings(envExports(envFiles)), ...process.env, ...lifted } : { ...envExports(envFiles), ...process.env, ...lifted, ...copies };
  child = spawnTied(cmd, { cwd: appDir, env: { ...base, ...(proxy ? proxy.env(base) : capture ? capture.env(process.env) : {}), FORCE_COLOR: "0", ...(pinned.bin ? { PATH: `${pinned.bin}:${process.env.PATH ?? ""}` } : {}) } });
  const mine = child;
  become("starting", { app: mine.pid ?? null });
  let seen = "";
  const onData = (log) => (d) => {
    const s = d.toString(); log(d); seen = (seen + s).slice(-20_000); lastSaid = seen; lastOutputAt = Date.now(); if (verbose) process.stdout.write(s);
    if (!note.reloads && RELOADER.test(s)) { note.reloads = true; if (note.answered && loaded === note) noteApp(); }
  };
  mine.stdout.on("data", onData(logTo()));
  mine.stderr.on("data", onData(logTo()));
  let exited = null;
  appGone = false;
  mine.on("exit", (code) => { exited = code ?? 1; if (child === mine) appGone = true; });
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const tail = () => seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-25).join("\n");
    // The port was taken: the app says so and exits at once, so this is read before the exit code,
    // or a bed whose .env named a port another round still held printed "your app stopped" three times.
    const taken = /EADDRINUSE|address already in use/i.test(seen);
    if (exited !== null && !taken) return { port: null, exited, tail: tail() };
    // nodemon and its kind outlive the app they watch: the app is gone, the process is not, and
    // the wait ran its whole three minutes on one app with the reason sitting in the output.
    // Also: the port is taken, under a watcher that does not exit when its app cannot listen. The
    // holder is named, and startApp attaches to it only when it runs from this repository.
    if (taken || /app crashed - waiting for file changes|waiting for (?:file )?changes before restart|Failed running/i.test(seen)) {
      await stopTree(mine.pid);
      if (!taken) return { port: null, exited: 1, tail: tail() };
      // Taken between the check and the bind: a port this start names moves to the next free one, a
      // bounded number of times. A port the app sets in its own code does not follow it, and starting
      // the app again only meets the same holder, so the holder is named instead.
      const named = namedPort(cmd, lifted);
      const port = portInError(seen) || named;
      if (named && port === named && tries > 1) { lost.add(named); return start(waitMs, tries - 1); }
      return { port: null, exited: 1, tail: tail(), held: port ? await holderOf(port) : null, fixed: Boolean(port) && port !== named };
    }
    // The port is what the app's own process group listens on. Never a guess: a developer's
    // machine has other things on 3000 and 8080, and one of them answered for the app once.
    const ports = await listening(mine.pid);
    // The socket can open before the server answers; the log line is the tiebreak among several.
    const plain = withoutStores(seen.replace(/\x1b\[[0-9;]*m/g, ""));
    const said = [...plain.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b|\bport\s*[:=]?\s*(\d{4,5})\b/gi)].map((m) => Number(m[1] || m[2]));
    for (const port of [...new Set([...said.reverse().filter((p) => ports.includes(p)), ...ports])]) {
      if (await answers(port)) {
        note.answered = true;
        if (loaded === note) noteApp();
        return { port, exited: null, tail: "" };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // A start given up on is stopped: the next one never runs beside it.
  await stopTree(mine.pid);
  return { port: null, exited: null, tail: seen.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-12).join("\n") };
}

const COPIED = "starting your app again so it runs against the copies made for this session";
// A restart waits this long for the run's requests already at your app, then goes ahead: one it
// cuts is sent again once your app answers.
const DRAIN_MS = 20_000;
// One start of your app at a time, whoever asks for it: a save, a verb, the copies made for this
// session, or the health loop bringing back an app that stopped. One asked for while another is under
// way is that one, so a second file saved while a crashed app comes back never kills its start.
let restartDone = null;
// The read's list of tools as the app was started with it: the hook wraps a tool's function only when
// the list is there before the file holding it loads (lib/trace.cjs).
const toolsNow = () => { try { return readFileSync(join(work, "tools.json"), "utf8"); } catch { return ""; } };
let toolsAtStart = "";
const toolsKnown = () => toolsNow() !== "" && toolsNow() !== "[]";
const toolsRecorded = () => !toolsKnown() || toolsNow() === toolsAtStart;
// A list that arrives after the app started: the app is started again at once, behind the gate. The
// server writes it as a run starts, before its first conversation, and before Cortad's first test
// requests; any request already at the app is waited for, and one cut is sent again.
async function recordTools() {
  if (restartDone) await restartDone;
  if (!launched || !child || closing || toolsRecorded()) return;
  await restartApp("starting your app again so the tools your code gives its model are recorded");
}
function restartOnce(work) {
  restartDone ??= (async () => {
    restarting = true;
    try { return await work(); } finally { restarting = false; restartDone = null; }
  })();
  return restartDone;
}
// The same command again, for an app that does not reload on save. Only an app this program
// started: one you started yourself is yours to restart. New requests wait at the gate meanwhile.
function restartApp(why = "starting your app again so it runs the code you saved, since it does not reload by itself") {
  if (!launched || !child) return Promise.resolve({ error: "You started this app yourself, so restart it in your own terminal. Most dev servers reload on save." });
  return restartOnce(async () => {
    hold();
    say(why);
    try {
      for (const end = Date.now() + DRAIN_MS; answering > 0 && Date.now() < end;) await new Promise((r) => setTimeout(r, 250));
      return await restartNow();
    } finally { release(); }
  });
}
// Saved since your app started, in a file it runs: bytes written back as they were are not a change,
// and neither is a file the app wrote itself.
const savedSinceStart = () => Boolean(loaded?.files) && changesOf({
  root, app: { startedAt: new Date(loaded.at).toISOString(), files: loaded.files }, skip: writtenPaths(writesDirOf(homeOf(project))),
}).changed.length > 0;
// Every save that changes what your app runs starts it again, when it does not reload by itself: an
// agent that saved a fix and asked the app eight seconds later was answered by the old code. Looked
// at again after each restart, for a save made while it was under way.
// The stores the settings name, as copies are made of them: a change here is a change of what the app
// writes into, so its copies and holds are made again for the new settings, and said again.
const storesNamed = () => { try { return JSON.stringify(storesOf({ ...envExports(envFiles), ...process.env }).map((s) => [s.engine, s.host, s.port, s.db, s.names])); } catch { return ""; } };
let storesAt = null;
// Looked at before the first wait too: the app now starts while the code is uploaded, and a save made
// before this watch began was otherwise never seen.
async function restartOnSave() {
  while (!closing) {
    while (!closing && launched && child && !appGone && !loaded?.reloads && savedSinceStart()) {
      const named = storesNamed();
      const moved = storesAt !== null && named !== storesAt;
      storesAt = named;
      if (moved) await keeping.forget().catch(() => {});
      await restartApp(moved ? "starting your app again on the settings you changed, with its data copied again for them" : undefined);
      if (moved) await announce().catch(() => null);
    }
    await sourceChanged();
  }
}
async function restartNow() {
  const port = app.port;
  await stopTree(child.pid);
  // Until the port is free, not merely silent: a listener still closing does not answer and still
  // holds the bind, and the restarted app was moved to the next port while the run kept knocking on
  // this one (resumeforge's verify played seven trials against nothing).
  for (let i = 0; i < 75 && (await listenerOn(port)); i++) await new Promise((r) => setTimeout(r, 200));
  const up = await launch(90_000);
  if (!up.port) {
    const error = up.held ? sentence(whyNot(up)) : up.exited !== null ? `Your app exited ${up.exited} on restart.\n${up.tail}` : "Your app was restarted but did not answer within 90 seconds.";
    become("failed", { error: mask(error).slice(-600) });
    return { error };
  }
  become("up", { ...upAt(up.port), app: child?.pid ?? null });
  if (up.port !== port) {
    // It moved anyway: the world follows the app, never the other way round.
    app = up;
    const told = await announce().catch(() => null);
    if (!told?.ok) return { error: `Your app came back on port ${up.port}, not ${port}. Run the command again to reconnect.` };
    say(`your app came back on port ${up.port}; the run follows it there`);
  }
  return { restarted: true, port: up.port };
}
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// The last lines the app printed, masked: what the runner's state carries of its own words.
const lastLines = (said) => mask(String(said ?? "").split("\n").filter(Boolean).slice(-12).join("\n")).slice(-1500);
const failedWith = (why, said) => become("failed", { error: mask(why), ...(said ? { said: lastLines(said) } : {}) });
// ---- leaving: every way out stops the app this command started. This orderly path stops it and
// tells the server; a death no handler sees (SIGKILL) is covered by the watchdog lib/proc.mjs ties
// to the app, and the exit hook above releases the project either way.
async function close(code = 0) {
  if (closing) return;
  closing = true;
  try {
    if (child?.pid) await stopTree(child.pid);
    proxy?.close();
    // A copy lives on its store, and a store can be a service of the repository started beside the
    // app: the copies go first, while it still answers.
    await keeping.close();
    for (const kid of sidecars) if (kid.pid) await stopTree(kid.pid);
    // A sign-in the app printed before its request reached this command is masked now. Only by the
    // process that writes the file: another may still be appending to it.
    if (readRunner(project)?.pid === process.pid) {
      try { if (statSync(bootLog).size <= MASKED_AT_END_MAX) writeFileSync(bootLog, mask(readFileSync(bootLog, "utf8"))); } catch { /* left as it was written */ }
    }
    if (box) await call("DELETE", `/local/${box}`, undefined, { timeoutMs: 5000 }).catch(() => {});
    await exec("rm", ["-rf", work]).catch(() => {});
  } finally { process.exit(code); }
}
const quit = (line) => { try { console.error(`cortad  ${line}`); } catch { /* the terminal is gone */ } return close(1); };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => close(0));
process.on("uncaughtException", (e) => { void quit(e?.stack ?? String(e)); });

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
    ...(left.length ? [`also not sent   ${left.length} tracked media or lock file${left.length === 1 ? "" : "s"}: ${left.slice(0, 6).join(", ")}${left.length > 6 ? ", ..." : ""}`] : []),
    `not sent        anything git ignores, env files (${envFiles.length} here: ${envFiles.slice(0, 6).map(rel).join(", ") || "none"}), key files, node_modules, .git`,
    `env files       values read here only: to hide them in replies, to sign in a test account, and to ask your providers what your keys reach. Variable names and whether a switch is on or off go up; no value does`,
    `would start     ${flag("--port") ? `nothing: uses your app on port ${flag("--port")}` : plan?.cmd ? `${plan.cmd}   (in ${rel(plan.cwd)})` : plan?.noServer ? "nothing: this repository has no server to run" : "asks you how your app starts"}`,
    `would raise     ${flag("--port") ? "nothing: your app's own request limits stay as they are" : `${Object.keys(liftedLimits(envFiles, files.map((f) => join(root, f)))).join(", ") || "no request limits found"}   (only after your yes, for this session only)`}`,
    `loads into app  lib/trace.cjs (Node, Bun) or lib/pyhook/sitecustomize.py (Python): records each request during which your app calls a model, what it answered and the model calls on the way; header values stay here`,
    `other apps      a local proxy on 127.0.0.1 in front of your app's port and where its model settings point (OPENAI_BASE_URL and the others), recording the same; it passes each call on to the provider your settings name`,
    `your files      never written by this program; your own coding agent edits them`,
    `your database   a database file your env or code names is copied to this program's temp folder; a Postgres, Redis or MongoDB database or a Qdrant collection on this machine is copied on its own server under a name of ours and deleted at the end; your app is started on the copies. Any other store is named, not copied`,
    `your services   a store your compose file runs, or a second service of this repository, is started when your app reaches for it and nothing answers there, and stopped at the end`,
    `test shell      confined by the OS: your project and toolchains only, writes to temp and build folders, localhost only`,
    `for your agent  an MCP entry and a skill in each coding agent's own home folder (Claude Code, Codex, Cursor), and a key in ~/.cortad for later runs`,
    ``,
    `first files     ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", ..." : ""}`,
  ].join("\n"));
  process.exit(0);
}
if (kept.length) say(`not uploaded, left on this machine: ${kept.join(", ")}`);
const keepSecret = (v) => { if (v && v.length >= 12 && !secrets.includes(v)) secrets.push(v); };
identities = makeIdentities({ root, work, envFiles, sourceFiles: () => files, say, keepSecret, appDir: () => appDir });
// A real request that reached their model proves its door (lib/proof.mjs). What it proved goes up,
// masked like everything else, and nothing goes up that the mask could not read; the sign-in each
// request carried stays here.
capture = makeCapture({ work, keepSecret, signIns: join(homeOf(projectOf(root)), "sign-ins.json"), writes: join(homeOf(projectOf(root)), "writes"), root, files: () => files, appFolder: () => relative(root, appDir), printed: printedBetween, onProof: (proof) => {
  let masked;
  try { masked = JSON.parse(mask(JSON.stringify(proof))); } catch { return; }
  call("POST", `/local/${box}/proof`, masked).catch(() => {});
} });
if (!files.length) fail("no source files here to read.");

try { copyFileSync(join(homeOf(project), "tools.json"), join(work, "tools.json")); } catch { /* no run has read this project's tools yet */ }
// The key the last connect left for this project, if any: the token face signs in with it. A connect
// from the screen always asks for a fresh one, since the code may belong to another account or site.
let stored = readToken(project);
if (viaToken && !stored) fail("this project has no stored key. Run npx cortad in this folder once.");
// A network that drops while connecting ends here in a sentence, never a stack trace: running the
// command again starts a clean connection.
const unreachable = (err) => fail(`could not reach ${origin.host}: ${err?.name === "TimeoutError" ? "it did not answer in time" : "the connection failed"}. Check your connection and run the command again.`);
// The key goes up beside a code too: a code that has lapsed while this project's key still holds is
// the same person coming back, and the server signs them in by the key instead of refusing.
let attach = !code && !viaToken && !stored ? null : await call("POST", "/local/attach", { ...(viaToken ? {} : { code }), name: basename(root), project },
  stored ? { headers: { authorization: `Bearer ${stored}` } } : {}).catch(unreachable);
// No code and no key that still signs in: the person approves this computer in their browser.
if (!viaToken && !code && !attach?.ok) {
  if (attach && stored) { say("the key this folder kept no longer signs in, so this computer is connected again"); stored = null; }
  code = await paired();
  attach = await call("POST", "/local/attach", { code, name: basename(root), project }).catch(unreachable);
}
if (!attach.ok) fail(attach.data?.error ?? `could not sign in (${attach.status})`);
box = attach.data.box;
key = attach.data.key;
// Taken once the code is accepted: a mistyped one never ends a runner that was working.
if (!viaToken) await holdProject();
writeFileSync(bootLog, "", { mode: 0o600 });

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
// Started now, so it comes up while the code is packed and sent; told to the server once it has the code.
const firstStart = startApp();
firstStart.catch(() => { /* appLife reads the failure */ });
const archive = join(work, "tree.tgz");
step("connecting");
await exec("tar", ["-czf", archive, "-C", root, "-T", list]);
const bytes = readFileSync(archive);
const PART = 1_500_000;
let resumed = false;
let moved = false;
const parts = Math.max(1, Math.ceil(bytes.length / PART));
for (let off = 0; off < bytes.length; off += PART) {
  const last = off + PART >= bytes.length;
  step(parts > 1 ? `connecting, ${Math.floor(off / PART) + 1} of ${parts}` : "connecting");
  // The last part asks for this machine's key when none is stored yet: minted once the repository
  // row exists, kept in ~/.cortad for the runs a coding agent asks for on later days.
  const put = await call("PUT", `/local/${box}/tree?last=${last ? 1 : 0}${last ? `&digest=${treeDigest}${head ? `&head=${head}` : ""}` : ""}`, bytes.subarray(off, off + PART),
    { raw: true, timeoutMs: 120_000, ...(last && !viaToken && !stored ? { headers: { "x-cortad-machine": hostname().slice(0, 80) } } : {}) }).catch(unreachable);
  if (!put.ok) fail(put.data?.error ?? `upload failed (${put.status})`);
  if (last) {
    resumed = put.data?.resumed === true;
    moved = put.data?.moved === true;
    if (typeof put.data?.machineKey === "string" && put.data.machineKey) writeToken(project, put.data.machineKey);
    writeDigest(project, treeDigest);
  }
}
// Unchanged code has already been read: coming back says so instead of claiming a second read.
stepDone(moved ? "connected: your change is in, and what Cortad read before still stands" : resumed ? "connected: nothing changed since last time" : "connected");
// The coding agents on this machine learn about Cortad now, once: an MCP entry and a skill in each
// one's own home folder. A run started by an agent later comes back through lib/cli.mjs.
// CORTAD_NO_REGISTER=1 leaves the coding agents' global skill and MCP entries alone: a stack under
// test on this machine must never repoint the person's own agents at an unpublished build.
if (!viaToken && process.env.CORTAD_NO_REGISTER !== "1") {
  const got = await registerAll().catch((err) => { if (verbose) say(`could not register with your coding agents: ${err?.message ?? err}`); return { clients: [], changed: [] }; });
  const and = (list) => new Intl.ListFormat("en", { type: "conjunction" }).format(list);
  if (got.changed.length) say(`For the person: ${and(got.clients)} can now use Cortad: its MCP server and skill were added to ${got.changed.map((f) => `~/${f}`).join(", ")}. This repository was not changed.`);
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
// started carries the hook, and only a runtime the hook exists for. `proves`: each request seen
// reaching the model is posted as its door's proof, so the run waits for those.
// `blocked`: each store off this machine no copy could be made of, which holds Run until the person
// says yes in the browser. The answer carries that yes (setup.consent), and the hosts it names are
// written where the hook reads which outbound writes of a trial may leave.
const announce = async () => {
  // Through the proxy, a message is seen arriving at its front, and its model calls once the app was started with its settings on the proxy.
  const hooked = Boolean(proxy ? launched || proxy.seen() : launched && capture?.watching(app.port));
  const started = Boolean(launched);
  const told = await call("POST", `/local/${box}/app`, { port: doorPort(), cmd: shownCommand(app.cmd, mask), origins: envOrigins(envFiles), lifted: app.lifted ?? [], data: (await keeping.lines(started)).map(mask), blocked: await keeping.blocked(started), watching: hooked, metered: hooked, proves: hooked });
  if (told.ok) await allowOutbound(told.data?.consent);
  return told;
};

// What the person said yes to, as the hook reads it: the hosts a trial's writes may reach.
async function allowOutbound(given) {
  if (given && typeof given === "object") {
    const list = (v, re) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && re.test(x)).slice(0, 50) : []);
    consent = { hosts: list(given.hosts, /^[a-z0-9.-]{1,253}$/i).map((h) => h.toLowerCase()), stores: list(given.stores, /^[a-f0-9]{16}$/) };
    await liftWith(given.limits === true);
  }
  try { writeFileSync(outboundFile, JSON.stringify({ pass: await keeping.outbound(consent) }), { mode: 0o600 }); } catch { /* every write of a trial stays held */ }
}

// A yes given or taken back in the browser restarts an app this command started with its guards
// raised or restored; an app raised by the terminal's own yes keeps that.
async function liftWith(yes) {
  if (yes === limitsYes) return;
  limitsYes = yes;
  if (!launched || !child || launched.byTerminal) return;
  const lifted = sessionLifts(yes, envFiles, files.map((f) => join(root, f)));
  if (JSON.stringify(lifted) === JSON.stringify(launched.lifted ?? {})) return;
  launched = { ...launched, lifted };
  if (app) app.lifted = Object.keys(lifted);
  void restartApp(yes ? `starting your app again with its own limits raised for this session: ${Object.keys(lifted).join(", ")}` : "starting your app again with its own limits as they are");
}

// Your app's life beside this connection. It is started; if it stops, or never comes up, this stays
// and starts it again the moment you save a fix, and the browser is told each time it answers, so a
// world still looking for your chat asks again by itself. Nothing is ever rerun by hand.
async function appLife(firstStart) {
  for (let first = true; ; first = false) {
    const got = await (first ? firstStart : startApp());
    if (got.port) { app = got; if (!launched) await noteAttached(app.port); break; }
    failedWith(got.why, got.said);
    await call("POST", `/local/${box}/stopped`, { said: mask(got.said || got.why).slice(-2000) }).catch(() => {});
    say(got.why);
    // Said with the same words the agent prompt waits for, so an agent holding the terminal reports
    // the failure instead of waiting for a line that never comes.
    if (first) say("your app did not start. Go back to the browser; it says what stopped it. Ctrl-C disconnects.");
    await sourceChanged();
    become("starting");
    say("saw your change, starting your app again");
  }
  const told = await announce();
  clearStep();
  if (!told.ok) return quit(told.data?.error ?? `could not register your app (${told.status})`);
  machineOf = () => (app ? {
    cmd: shownCommand(app.cmd, mask) ?? "", dir: relative(root, appDir) || ".", port: app.port, started: Boolean(launched),
    hooked: Boolean(launched && !proxy && capture?.watching(app.port)), proxy: proxy?.port ?? null,
    changed: [...new Set([...(app.lifted ?? []), ...Object.keys(keeping.envNow())])],
    copies: Object.keys(keeping.envNow()).length ? "made" : "none",
  } : null);
  become("up", { ...upAt(), app: launched ? child?.pid ?? null : null });
  say(`your app is answering on port ${app.port}${app.cmd ? ` · ${app.cmd}` : ""}`);
  if (launched) say(`your app's output for this session is kept in ${bootLog}, with the values from your env files masked`);
  if (proxy) say(`send requests to port ${proxy.port}: it passes them to your app and Cortad sees each one. Requests sent straight to port ${app.port} are not seen`);
  for (const line of machineText(machineOf())) say(line);
  say("leave this open. Go back to the browser; Ctrl-C disconnects.");
  let downSince = 0;
  let toldDown = false;
  let appTold = true;
  // The stores and services its settings name, brought up once the app's own port is known; a
  // store copied only now is one the app was not started on.
  if (launched) {
    try {
      const got = await keeping.services(app.port).catch(() => ({}));
      if (got.copied && child) await restartApp(COPIED);
      if (got.changed) appTold = false;
    } finally { release(); }
  }
  // Only once the app runs on the copies made for this session.
  void reachLoop();
  forgetTold = () => { appTold = false; };
  void restartOnSave().catch((e) => say(`could not watch your files for a save: ${e?.message ?? e}`));
  const health = makeHealth({ host: () => appHost, gone: () => Boolean(launched && appGone), inFlight: () => answering });
  for (let up = true; !closing;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (closing || restarting) continue;
    const state = await health.check(app.port);
    if (state === "up") {
      downSince = 0; toldDown = false;
      // Said until it is heard. Said once, it was lost when their app came back while the network
      // was down, and the screen went on showing an app that had stopped while it answered turns.
      if (!up) become("up", { ...upAt(), app: launched ? child?.pid ?? null : null });
      else if (became?.state === "up") {
        const now = upAt();
        if (JSON.stringify(now.receipts) !== JSON.stringify(became.fields.receipts)) { const { receipts: _was, ...fields } = became.fields; become("up", { ...fields, ...now }); }
      }
      const reach = await keeping.watch(app.port).catch(() => ({}));
      try { if (reach.copied && launched && child) await restartApp(COPIED); } finally { release(); }
      if (reach.changed) appTold = false;
      if (!up || !appTold) { up = true; appTold = Boolean((await announce().catch(() => null))?.ok); }
      continue;
    }
    // Running, holding its port, and slow because it is answering the run's own requests: working,
    // not dead. Nothing is said and nothing restarts, and a silence after it is timed from here.
    if (state === "busy") { if (!up) downSince = Date.now(); continue; }
    if (up) { up = false; downSince = Date.now(); }
    appTold = false;
    const downFor = Date.now() - downSince;
    // Not answering. A dev server restarting on a save says so in its output: it is left alone,
    // however long its own startup takes.
    // A watcher that has said its app crashed is not reloading, it is waiting, and says so.
    const crashed = /app crashed - waiting|Failed running|waiting for (?:file )?changes before restart/i.test(lastSaid.slice(-600));
    const reloading = launched && !appGone && !crashed && Date.now() - lastOutputAt < 15_000;
    if (reloading || downFor < (crashed ? 4_000 : 10_000)) continue;
    // Down for real. The screen is told, so it never shows an app that is not there.
    // `exited`: the process this command started is gone or its watcher said it crashed, not a process
    // running and not answering. The run tells the two apart: one is their crash, the other may be our
    // load. An app it only attached to is not its to watch, so nothing is said either way.
    if (!toldDown) {
      // Started again below, except an app given by --port, which is picked up when it answers again.
      if (!launched && flag("--port")) failedWith(`your app stopped answering on port ${app.port}; it is picked up again when it answers`, lastSaid);
      else become("starting");
      toldDown = Boolean((await call("POST", `/local/${box}/stopped`, { said: mask(lastSaid || "your app stopped answering").slice(-2000), ...(launched ? { exited: Boolean(appGone || crashed) } : {}) }).catch(() => null))?.ok);
    }
    // An app that went quiet or exited did not stop because of a save (it was killed, it ran out
    // of memory, it crashed on a request), so waiting for a save would wait forever. It is started
    // here, whoever started it first: an app this command only attached to (yours, from another
    // terminal, or one left behind by a terminal that was killed) is gone now, and this command
    // knows how it starts. Only an app given by --port is left to you, and picked up when it returns.
    if (launched && !appGone && !crashed && downFor < 25_000) continue;
    if (!launched && flag("--port")) continue;
    await restartOnce(async () => {
      if (child?.pid) await stopTree(child.pid);
      say(downLine(state, { port: app.port, downMs: downFor, crashed }));
      let back = launched ? await launch(180_000) : await startApp();
      while (!back.port && !closing) {
        const why = back.why ?? whyNot(back);
        failedWith(why, back.tail || back.said);
        await call("POST", `/local/${box}/stopped`, { said: mask(back.tail || back.said || lastSaid).slice(-2000) }).catch(() => {});
        say(`your app did not come back: ${why}`);
        await sourceChanged();
        become("starting");
        say("saw your change, starting your app again");
        back = launched ? await launch(180_000) : await startApp();
      }
      if (!back.port) return { error: "This command is closing." };
      if (!launched) await noteAttached(back.port);
      app = { ...app, ...(back.cmd !== undefined ? back : {}), port: back.port };
      become("up", { ...upAt(), app: launched ? child?.pid ?? null : null });
      up = true; downSince = 0; toldDown = false;
      appTold = Boolean((await announce().catch(() => null))?.ok);
      say(`your app is answering again on port ${app.port}`);
      return { restarted: true, port: app.port };
    });
  }
}
void appLife(firstStart).catch((e) => quit(String(e?.message ?? e)));

// The page Cortad's test requests come from: one the env names on the app's port, else one on this
// machine (a local frontend in front of this API). A hosted address such as a Supabase URL is no page
// of the app's, so an app whose env names none is asked with no Origin, as a server would ask it.
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/;
function ownOrigin(port) {
  const local = envOrigins(envFiles).filter((o) => LOCAL_ORIGIN.test(o));
  return local.find((o) => new URL(o).port === String(port)) ?? local[0] ?? null;
}
// Counted with the run's own requests, so a restart drains them, and sent only through the open gate.
async function countedFetch(url, init) {
  while (gate) await gate;
  answering += 1;
  try {
    const res = await fetch(url, init);
    const body = await res.arrayBuffer();
    return new Response(body.byteLength ? body : null, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally { answering -= 1; }
}
// Cortad's own test request to each endpoint the read lists, sent from here as soon as status lists
// them (lib/auto-reach.mjs), and the agent's reach the same way. Status is asked every 5 seconds
// while the code is read, then every minute; an ask from the agent is taken within a second.
const autoReach = makeAutoReach({
  status: async () => {
    const token = readToken(project);
    const res = token ? await call("GET", "/mcp/status?quiet=1", undefined, { headers: { authorization: `Bearer ${token}` } }).catch(() => null) : null;
    return res?.ok ? res.data : null;
  },
  runner: () => (became?.state === "up" && !restarting ? { state: "up", ...became.fields } : null),
  // One test request per endpoint is what the person's own agent sends by hand, so it does not wait on
  // the yes a run's writes into an uncopied store need; it waits only while a copy is being made.
  waiting: async () => (gate ? "Your app's data is being copied for this session." : null),
  origin: () => (app ? ownOrigin(app.port) : null),
  signIn: async (m) => { const role = typeof m.as === "string" ? m.as : identities?.roles()[0]; return role ? identities.headerFor(role) : null; },
  stampOf: (m) => { try { return m.file ? String(statSync(join(root, m.file)).mtimeMs) : ""; } catch { return ""; } },
  asked: () => existsSync(join(homeOf(project), ASK)),
  report: async (answers) => {
    if (!answers.length && reachedBox === box) return;
    const to = box;
    if ((await call("POST", `/local/${to}/reached`, { answers }, { timeoutMs: 15_000 })).ok) reachedBox = to;
  },
  say,
  fetchImpl: countedFetch,
});
// The connection the server last heard sends its test requests itself; a reattach is a new one.
let reachedBox = "";
async function reachLoop() {
  for (let dueAt = 0; !closing; await new Promise((r) => setTimeout(r, 1000))) {
    const ask = takeAsk(homeOf(project));
    if (!ask && Date.now() < dueAt) continue;
    const out = await autoReach(ask).catch(() => null);
    if (ask) { try { answerAsk(homeOf(project), ask.id, out?.text ?? "Nothing was sent.\nnext: status"); } catch { /* the agent's wait runs out */ } }
    dueAt = Date.now() + (out?.wait ?? 30_000);
  }
}

// Keep the laptop awake while a world stands on it.
if (process.platform === "darwin") spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();

// Started by a shell verb rather than a person, this process leaves once no run has needed it for
// a while, so an app is not held up all night for a verify that finished at noon.
const IDLE_MS = 10 * 60_000;
if (argv.includes("--until-idle") && stored) {
  let idleSince = Date.now();
  setInterval(async () => {
    const res = await call("GET", "/mcp/status?quiet=1", undefined, { headers: { authorization: `Bearer ${stored}` } }).catch(() => null);
    if (res?.ok && res.data?.run && !finished(res.data.run)) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) { say("no run for ten minutes, leaving"); await close(0); }
  }, 60_000).unref();
}

// A verb in another process asks for the app to be started again before a run, because its code
// changed and nothing reloaded it (lib/fresh.mjs). The new start is noted as the app answers; one
// that fails is the runner's failed state, with its reason. A restart already under way answers the
// same way.
process.on("SIGUSR2", () => {
  if (restarting || !app) return;
  void restartApp();
});

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
    capture?.proveAgain();
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
