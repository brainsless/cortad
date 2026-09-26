import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf, readPending, readRunner, readToken, writePending, writeRunner } from "./home.mjs";
import { serveMcp } from "./mcp.mjs";
import { cliSpec, VERSION } from "./spec.mjs";
import { hookOutput, stick, unstick } from "./stick.mjs";
import { makeVerbs, READY_MS } from "./verbs.mjs";

// `npx cortad mcp`, `npx cortad <verb>` and `npx cortad stick`: what a coding agent uses after the
// first connect. None of them uploads or edits anything by itself. When a run needs the app up and
// nothing on this machine is holding it, the runner (local.mjs with the stored key) is started, and
// a second detached process posts the run once the app answers, so `run` returns at once from
// either face and the shell face exits after printing.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const OURS = ["cortad.com", "brainsless.com", "brainsless-frontend.pages.dev"];
const WAITER = "run-when-up";
export const VERBS = ["status", "run", "run_status", "findings", "verify", "dispute", "field_connect", "field"];
export const COMMANDS = new Set(["mcp", ...VERBS, "run-status", "field-connect", "stick", "unstick", WAITER]);

export async function main(argv, { root = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  if (command === "stick" || command === "unstick") {
    stdout.write(`${(command === "stick" ? stick : unstick)(root, { spec: cliSpec({ env }) }).join("\n")}\n`);
    return 0;
  }
  const origin = new URL(env.CORTAD_ORIGIN || "https://cortad.com");
  const trusted = (origin.protocol === "https:" && OURS.some((host) => origin.hostname === host || origin.hostname.endsWith(`.${host}`)))
    || origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (!trusted) { stderr.write(`cortad  refusing: ${origin.host} is not Cortad.\n`); return 1; }
  const project = projectOf(root);
  const mcp = command === "mcp";
  const children = [];
  const pending = { read: () => readPending(project), write: (p) => writePending(project, p) };
  // The key is read at every call: the MCP process outlives a connect that writes it after the process started.
  const verbs = makeVerbs({
    api: `${origin.origin}/api`,
    root,
    token: () => readToken(project),
    pending,
    startApp: (args, kind) => startApp({ root, project, env, keep: mcp, children, args, kind }),
  });

  if (command === WAITER) {
    await runWhenUp({ verbs, project, env, pending, request: requestOf(rest[0]) });
    return 0;
  }
  if (mcp) {
    const code = await serveMcp({ verbs, version: VERSION, log: (line) => stderr.write(`${line}\n`) });
    for (const child of children) try { child.kill("SIGTERM"); } catch { /* gone */ }
    return code;
  }
  // The hook face: one line or nothing, never an error on every edit in a folder that is not connected.
  if (command === "status" && rest.includes("--changed")) {
    const { text } = await verbs.changed();
    if (text) stdout.write(`${rest.includes("--hook") ? hookOutput(text) : text}\n`);
    return 0;
  }
  const out = await verbs[command.replace(/-/g, "_")](argsOf(command, rest));
  stdout.write(`${out.text}\n`);
  return out.isError ? 1 : 0;
}

// Positional arguments for the shell face: `verify f1`, `run_status <jobId>`, `findings 2`,
// `dispute f1 "why"`. In findings a bare number is a page and anything else a run id.
function argsOf(command, rest) {
  switch (command.replace(/-/g, "_")) {
    case "run_status": return rest[0] ? { jobId: rest[0] } : {};
    case "findings": {
      const page = rest.find((w) => /^\d+$/.test(w));
      const jobId = rest.find((w) => w !== "--page" && !/^\d+$/.test(w));
      return { ...(jobId ? { jobId } : {}), ...(page ? { page: Number(page) } : {}) };
    }
    case "verify": return { findingId: rest[0], ...(rest[1] ? { jobId: rest[1] } : {}) };
    case "dispute": return { findingId: rest[0], why: rest.slice(1).join(" ") };
    case "field": return rest[0] ? { days: rest[0] } : {};
    default: return {};
  }
}

// What the waiter was asked for, from its own command line: a run, or a verify of one finding.
function requestOf(raw) {
  let value = {};
  try { value = JSON.parse(raw ?? "{}"); } catch { /* a run */ }
  const pick = (v) => (typeof v === "string" && v.length <= 200 ? v : undefined);
  const findingId = pick(value.args?.findingId);
  const jobId = pick(value.args?.jobId);
  return findingId ? { kind: "verify", args: { findingId, ...(jobId ? { jobId } : {}) } } : { kind: "run", args: {} };
}

// Returns at once. The runner holds the app up: from the MCP it lives as long as the MCP does;
// from a shell command it stays until the runs stop for a while (--until-idle). The waiter is
// detached either way and ends once the run is posted or the app did not come up.
export function startApp({ root, project, env, keep, children, args, kind, spawnImpl = spawn }) {
  const log = openSync(join(homeOf(project), "runner.log"), "a");
  if (!readRunner(project)) {
    const child = spawnImpl(process.execPath, [LOCAL, "--token", ...(keep ? [] : ["--until-idle"])], { cwd: root, env, stdio: ["ignore", log, log], detached: !keep });
    if (keep) children.push(child); else child.unref();
    writeRunner(project, { pid: child.pid, startedAt: new Date().toISOString(), by: keep ? "mcp" : "cli" });
  }
  spawnImpl(process.execPath, [LOCAL, WAITER, JSON.stringify({ kind, args })], { cwd: root, env, stdio: ["ignore", log, log], detached: true }).unref();
  closeSync(log);
  return { ok: true };
}

// The waiter: posts the run once the app answers and leaves the outcome in pending.json.
export async function runWhenUp({ verbs, project, env, pending, request, poll = appOf, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), readyMs = READY_MS }) {
  const log = join(homeOf(project), "runner.log");
  const fail = (text) => pending.write({ ...pending.read(), error: text });
  const until = now() + readyMs;
  let said = "";
  while (now() < until) {
    await sleep(3000);
    const app = await poll(env, project);
    if (app?.state === "ready-to-test") {
      const out = await verbs.post(request.args, request.kind);
      if (!out.data?.jobId) fail(out.text);
      return;
    }
    if (app?.said) said = ` ${app.said}`;
    if (!readRunner(project)) return fail(`The process holding your app up ended before the app answered.${said} Its output is in ${log}.\nNothing ran.`);
  }
  fail(`Your app did not answer within ${Math.round(readyMs / 60_000)} minutes.${said} Its output is in ${log}.\nNothing ran.`);
}

async function appOf(env, project) {
  const token = readToken(project);
  if (!token) return null;
  try {
    const res = await fetch(`${new URL(env.CORTAD_ORIGIN || "https://cortad.com").origin}/api/mcp/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? (await res.json()).app ?? null : null;
  } catch { return null; }
}
