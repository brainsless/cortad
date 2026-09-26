import { openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf, readRunner, readToken, writeRunner } from "./home.mjs";
import { serveMcp } from "./mcp.mjs";
import { makeVerbs } from "./verbs.mjs";

// `npx cortad mcp` and `npx cortad <verb>`: the two faces a coding agent uses after the first
// connect. Neither uploads, starts or edits anything by itself. When a run needs the app up and
// nothing on this machine is holding it, the runner (local.mjs with the stored key) is started.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
const OURS = ["cortad.com", "brainsless.com", "brainsless-frontend.pages.dev"];
export const VERBS = ["status", "run", "run_status", "findings", "verify", "dispute", "field_connect", "field"];
export const COMMANDS = new Set(["mcp", ...VERBS, "run-status", "field-connect"]);

export async function main(argv, { root = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const origin = new URL(env.CORTAD_ORIGIN || "https://cortad.com");
  const trusted = (origin.protocol === "https:" && OURS.some((host) => origin.hostname === host || origin.hostname.endsWith(`.${host}`)))
    || origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (!trusted) { stderr.write(`cortad  refusing: ${origin.host} is not Cortad.\n`); return 1; }
  const api = `${origin.origin}/api`;
  const project = projectOf(root);
  const [command, ...rest] = argv;
  const mcp = command === "mcp";
  const children = [];
  // The key is read at every call: the MCP process outlives a connect that writes it after the process started.
  const verbs = makeVerbs({ api, token: () => readToken(project), ensureRunner: () => ensureRunner({ root, project, env, keep: mcp, children, say: (line) => stderr.write(`cortad  ${line}\n`) }) });

  if (mcp) {
    const code = await serveMcp({ verbs, version: VERSION, log: (line) => stderr.write(`${line}\n`) });
    for (const child of children) try { child.kill("SIGTERM"); } catch { /* gone */ }
    return code;
  }
  const verb = verbs[command.replace(/-/g, "_")];
  const out = await verb(argsOf(command, rest));
  stdout.write(`${out.text}\n`);
  return out.isError ? 1 : 0;
}

// Positional arguments for the shell face: `verify f1`, `run_status <jobId>`, `dispute f1 "why"`.
function argsOf(command, rest) {
  switch (command.replace(/-/g, "_")) {
    case "run_status": return { jobId: rest[0] };
    case "findings": return rest[0] ? { jobId: rest[0] } : {};
    case "verify": return { findingId: rest[0], ...(rest[1] ? { jobId: rest[1] } : {}) };
    case "dispute": return { findingId: rest[0], why: rest.slice(1).join(" ") };
    case "field": return rest[0] ? { days: rest[0] } : {};
    default: return {};
  }
}

// The app has to be up on this machine for a run. A connect session in another terminal is holding
// it; failing that, local.mjs is started here with the stored key and does what the first connect
// did: attach, upload if the tree changed, start the app, announce it, answer the knocks. From the
// MCP it lives as long as the MCP does; from a shell command it stays until the runs stop for a
// while, then leaves (--until-idle).
const READY_MS = 240_000;
export async function ensureRunner({ root, project, env, keep, children, say, poll = statusOf }) {
  if (!readRunner(project)) {
    const log = openSync(join(homeOf(project), "runner.log"), "a");
    const child = spawn(process.execPath, [LOCAL, "--token", ...(keep ? [] : ["--until-idle"])], {
      cwd: root, env, stdio: ["ignore", log, log], detached: !keep,
    });
    if (!keep) child.unref(); else children.push(child);
    writeRunner(project, { pid: child.pid, startedAt: new Date().toISOString(), by: keep ? "mcp" : "cli" });
    say("starting your app for the run");
  }
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    const state = await poll(env, project);
    if (state === "ready-to-test") return { ok: true };
    if (!readRunner(project)) return { ok: false, why: `Your app did not come up. The runner's output is in ${join(homeOf(project), "runner.log")}.` };
  }
  return { ok: false, why: "Your app did not come up within four minutes. Run the command from the connect screen in a terminal to see why." };
}

async function statusOf(env, project) {
  const token = readToken(project);
  if (!token) return null;
  try {
    const res = await fetch(`${new URL(env.CORTAD_ORIGIN || "https://cortad.com").origin}/api/mcp/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? (await res.json()).app?.state ?? null : null;
  } catch { return null; }
}
