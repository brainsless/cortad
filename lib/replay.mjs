// The other half of lib/trace.cjs: the command's side. It hands the hook to the app it starts,
// reads what the hook wrote, keeps the sign-in that request carried on this machine, and tells the
// cloud only what it needs to ask again: the route, the method and the body.
import { copyFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "trace.cjs");
const PYHOOK = join(HERE, "pyhook");
export const CAPTURED = "captured";
// Never replayed: they describe one connection, not the caller.
const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as|x-cortad-turn)$/i;

export function makeCapture({ work, keepSecret, onDoor }) {
  const file = join(work, "trace.jsonl");
  let read = 0;
  let held = null;
  let alive = false;
  // The ports a hooked process listens on. Loading is not listening: turbo's own Node launcher loads
  // the hook, and one app was told we would see its messages while its API on Bun carried none.
  const ports = new Set();
  // Bun reads BUN_OPTIONS and splits it on spaces, quotes included, and only the `--preload=` form
  // leaves `bun run <script>` working. A hook path with a space in it is copied to one without.
  const bunHook = /\s/.test(HOOK) ? (() => { const at = join(mkdtempSync(join(tmpdir(), "cortad-")), "trace.cjs"); copyFileSync(HOOK, at); return at; })() : HOOK;
  // The hooks are handed to whatever is started: a Node app loads the first, a Bun app the same file
  // through its own variable, a Python app the second, and each ignores the others' variables.
  // ponytail: Node, Bun and Python. Go, Ruby, Java and PHP apps are asked for their route on the screen.
  const env = (base) => ({
    CORTAD_TRACE_FILE: file,
    // The run writes the customer's rule sentences here (the engine's /tmp/rules.json lands in this
    // folder), and the hook reads which of them each model call's prompt carried.
    CORTAD_RULES_FILE: join(work, "rules.json"),
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require ${JSON.stringify(HOOK)}`.trim(),
    BUN_OPTIONS: `${base.BUN_OPTIONS ?? ""} --preload=${bunHook}`.trim(),
    PYTHONPATH: [PYHOOK, base.PYTHONPATH].filter(Boolean).join(":"),
  });

  function poll() {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size <= read) return;
    // Bytes, not characters: a reply in Arabic put the next read in the middle of a line.
    const fresh = readFileSync(file).subarray(read, size).toString("utf8");
    read = size;
    for (const line of fresh.split("\n").filter(Boolean)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.hello) { alive = true; continue; }
      if (Number.isInteger(row.listen)) { ports.add(row.listen); continue; }
      if (row.call) { meter.add(row.call); continue; }
      if (row.dep) { meter.dep(row.dep); continue; }
      let body; try { body = JSON.parse(row.body); } catch { continue; }
      if (!body || typeof body !== "object" || typeof row.path !== "string" || !row.path.startsWith("/")) continue;
      const headers = Object.fromEntries(Object.entries(row.headers ?? {}).filter(([k, v]) => !HOP.test(k) && typeof v === "string"));
      for (const [k, v] of Object.entries(headers)) if (/authorization|cookie|token|secret|session|csrf|api-?key/i.test(k)) keepSecret(String(v).replace(/^Bearer\s+/i, ""));
      held = { headers, at: Date.now() };
      onDoor({ method: String(row.method || "POST").toUpperCase(), path: row.path, body, headerNames: Object.keys(headers).sort() });
    }
  }
  const timer = setInterval(poll, 700);
  timer.unref();
  return {
    env,
    headers: () => held?.headers ?? null,
    // A message sent to the app on `port` can be seen arriving. A hook that has not said where it
    // listens (Django under runserver) is taken at its hello, as before.
    watching: (port) => { poll(); return ports.has(port) || (alive && ports.size === 0); },
    alive: () => { poll(); return alive; },
    // What your app spent on its model providers since it started, as the hook saw each call. Null
    // when no hook is in your app (an app this command did not start): absent, never zero.
    usage: () => { poll(); return alive ? meter.report() : null; },
  };
}

// Every model call the hook wrote down, kept here: totals per host and model, and the newest rows.
const ROWS = 5000;
// The turn a row was pinned to by the run's own tag, and the rule ids the call's prompt carried.
const TURN = /^[A-Za-z0-9:_.-]{1,80}$/;
const RULE_ID = /^[\w:-]{1,64}$/;
const turnOf = (v) => (typeof v === "string" && TURN.test(v) ? { turn: v } : {});
const rulesOf = (v) => (Array.isArray(v) ? { rules: v.filter((id) => typeof id === "string" && RULE_ID.test(id)).slice(0, 300) } : {});
// What the app's tools answered behind a call, as the hook read them off the next prompt.
const toolsOf = (v) => (Array.isArray(v) && v.length
  ? { tools: v.filter((t) => t && typeof t.text === "string" && t.text.trim()).slice(0, 12).map((t) => ({ name: String(t.name ?? "").slice(0, 80), text: t.text.slice(0, 3000) })) }
  : {});
const meter = (() => {
  const rows = [];
  const deps = [];
  const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  return {
    add(call) {
      if (!call || typeof call.host !== "string" || !call.host) return;
      rows.push({
        at: count(call.at), host: call.host.slice(0, 253), model: String(call.model ?? "").slice(0, 160), status: count(call.status),
        promptTokens: count(call.promptTokens), cachedTokens: count(call.cachedTokens), completionTokens: count(call.completionTokens),
        usage: call.usage === true, ...turnOf(call.turn), ...rulesOf(call.rules), ...toolsOf(call.tools),
      });
      if (rows.length > ROWS) rows.splice(0, rows.length - ROWS);
    },
    // A service their settings name: only its setting, host and status travel, never a byte of it.
    dep(d) {
      if (!d || typeof d.host !== "string" || !d.host) return;
      const env = typeof d.env === "string" && /^[A-Z_][A-Z0-9_]*$/.test(d.env) ? d.env : undefined;
      deps.push({ at: count(d.at), ...(env ? { env } : {}), host: d.host.slice(0, 253), status: count(d.status), ...(typeof d.code === "string" ? { code: d.code.slice(0, 40) } : {}), ...turnOf(d.turn) });
      if (deps.length > ROWS) deps.splice(0, deps.length - ROWS);
    },
    report() {
      const totals = new Map();
      for (const r of rows) {
        const key = `${r.host}|${r.model}`;
        const t = totals.get(key) ?? { host: r.host, model: r.model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, unmetered: 0 };
        t.calls += 1;
        t.promptTokens += r.promptTokens;
        t.cachedTokens += r.cachedTokens;
        t.completionTokens += r.completionTokens;
        // An answered call the provider sent no counts for: it was spent, and what it cost is not known.
        if (!r.usage && r.status > 0 && r.status < 400) t.unmetered += 1;
        totals.set(key, t);
      }
      return {
        totals: [...totals.values()].sort((a, b) => b.calls - a.calls),
        rows: rows.slice(-400).reverse().map(({ at, host, model, status, turn, rules, tools }) => ({ at, host, model, status, ...(turn ? { turn } : {}), ...(rules ? { rules } : {}), ...(tools ? { tools } : {}) })),
        deps: deps.slice(-400).reverse(),
      };
    },
  };
})();
