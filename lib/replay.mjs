// The other half of lib/trace.cjs: the command's side. It hands the hook to the app it starts,
// reads what the hook wrote, keeps the sign-in each request carried on this machine, and tells the
// cloud what each door is proven to do (lib/proof.mjs): the route, the method, the body, the header
// names and what the requests did inside the app. Header values never leave.
import { copyFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE, TEST } from "./data.mjs";
import { doorsOf, exchangesOf, proofOf } from "./proof.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "trace.cjs");
const PYHOOK = join(HERE, "pyhook");
export const CAPTURED = "captured";
// Never replayed: they describe one connection, not the caller.
const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as|x-cortad-turn)$/i;

// `files` lists the repository's source, relative to `root`, for placing a problem at its line;
// `appFolder` is the folder the app runs in, relative to `root`. `onProof` gets one payload per door,
// again whenever what it proves changes.
export function makeCapture({ work, keepSecret, onProof = () => {}, writes = null, root = null, files = () => [], appFolder = () => "" }) {
  const file = join(work, "trace.jsonl");
  let read = 0;
  let held = null;
  let alive = false;
  // The ports a hooked process listens on. Loading is not listening: turbo's own Node launcher loads
  // the hook, and one app was told we would see its messages while its API on Bun carried none.
  const ports = new Set();
  // The route table each listening process read off its own app, newest per port.
  const tables = new Map();
  let newestTable = null;
  // Each server a hooked process opened a connection to, by host and port.
  const conns = new Map();
  // Bun reads BUN_OPTIONS and splits it on spaces, quotes included, and only the `--preload=` form
  // leaves `bun run <script>` working. A hook path with a space in it is copied, with the file it
  // requires, to one without.
  const bunHook = /\s/.test(HOOK) ? (() => {
    const dir = mkdtempSync(join(tmpdir(), "cortad-"));
    for (const name of ["trace.cjs", "tied.cjs"]) copyFileSync(join(HERE, name), join(dir, name));
    return join(dir, "trace.cjs");
  })() : HOOK;
  // The hooks are handed to whatever is started: a Node app loads the first, a Bun app the same file
  // through its own variable, a Python app the second, and each ignores the others' variables.
  // ponytail: Node, Bun and Python. Go, Ruby, Java and PHP apps are asked for their route on the screen.
  const env = (base) => ({
    CORTAD_TRACE_FILE: file,
    // The run writes the customer's rule sentences here (the engine's /tmp/rules.json lands in this
    // folder), and the hook reads which of them each model call's prompt carried.
    CORTAD_RULES_FILE: join(work, "rules.json"),
    // The read's tools by name, file and function, written by the run the same way: the hook wraps
    // those functions so a tool your own code runs is seen even when no model named it.
    CORTAD_TOOLS_FILE: join(work, "tools.json"),
    // While a run is on, the hook records each file the app writes under its own folder, with a
    // copy from before the first write, and the run's end puts them back (lib/writes.mjs).
    ...(writes && root ? { CORTAD_WRITES_DIR: writes, CORTAD_APP_ROOT: root } : {}),
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require ${JSON.stringify(HOOK)}`.trim(),
    BUN_OPTIONS: `${base.BUN_OPTIONS ?? ""} --preload=${bunHook}`.trim(),
    PYTHONPATH: [PYHOOK, base.PYTHONPATH].filter(Boolean).join(":"),
  });

  // The cookies and headers that carry a proven door's conversation. Speaking as the person never
  // sends them: a trial that did would join the agent's own conversation instead of opening its own.
  const carriers = new Map();
  const sent = (payload) => {
    const s = payload?.proof?.session;
    if (s?.held && (s.carrier === "cookie" || s.carrier === "header") && s.key) carriers.set(`${payload.door.method} ${payload.door.path}`, { carrier: s.carrier, key: String(s.key).toLowerCase() });
    onProof(payload);
  };
  const contact = makeContact({ onProof: sent, appFolder, find: root ? sourceFinder(root, files) : () => null, routes: () => [...tables.values()].flatMap((t) => t.routes) });
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
      if (row.routes) { const t = routeTable(row.routes); if (t) { tables.set(t.port, t); newestTable = t; } continue; }
      if (row.conn) { const { host, port } = row.conn; if (typeof host === "string" && Number.isInteger(port)) conns.set(`${host}:${port}`, { host, port }); continue; }
      if (row.call) { meter.add(row.call); contact.add(row); continue; }
      if (row.dep) { meter.dep(row.dep); contact.add(row); continue; }
      if (typeof row.ex !== "string" || typeof row.method !== "string" || typeof row.path !== "string" || !row.path.startsWith("/")) continue;
      const headers = Object.fromEntries(Object.entries(row.headers ?? {}).filter(([k, v]) => !HOP.test(k) && typeof v === "string"));
      for (const [k, v] of Object.entries(headers)) if (/authorization|cookie|token|secret|session|csrf|api-?key/i.test(k)) keepSecret(String(v).replace(/^Bearer\s+/i, ""));
      // Speaking as the person means their own client's headers, never a trial's.
      if (typeof row.turn !== "string") held = { headers, at: Date.now() };
      contact.add(row);
    }
    contact.flush();
  }
  const timer = setInterval(poll, 700);
  timer.unref();
  return {
    env,
    headers: () => (held ? withoutCarriers(held.headers, [...carriers.values()]) : null),
    // A message sent to the app on `port` can be seen arriving. A hook that has not said where it
    // listens (Django under runserver) is taken at its hello, as before.
    watching: (port) => { poll(); return ports.has(port) || (alive && ports.size === 0); },
    alive: () => { poll(); return alive; },
    // What your app spent on its model providers since it started, as the hook saw each call. Null
    // when no hook is in your app (an app this command did not start): absent, never zero. With a
    // `turn`, the calls pinned to that turn also say what their model was told.
    usage: (turn) => { poll(); return alive ? meter.report(TURN.test(turn ?? "") ? turn : undefined) : null; },
    // The app's routes as its framework holds them: the table of the process on `port`, else the
    // newest any hooked process wrote. Empty when no hook read one.
    registry: (port) => { poll(); return tables.get(port) ?? newestTable ?? {}; },
    // The servers the app has connected to so far (lib/stores.mjs names the ones no setting does).
    connections: () => { poll(); return [...conns.values()]; },
  };
}

// The exchanges seen so far, joined with the model calls and tool rows made inside them, and the
// payload last sent for each door. A door is sent again only when what it proves changed. Call rows
// usually land before their exchange's own row, which is written once the app has answered.
const EXCHANGES_KEPT = 200, LOOSE_KEPT = 500, PER_DOOR = 8;
function makeContact({ onProof, find, appFolder, routes }) {
  const kept = new Map();
  const loose = new Map();
  const sent = new Map();
  const dirty = new Set();
  const bound = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };
  return {
    add(row) {
      const id = row.ex ?? row.call?.ex ?? row.dep?.ex;
      if (typeof id !== "string") return;
      if (typeof row.ex === "string") { kept.set(id, [row, ...(loose.get(id) ?? [])]); loose.delete(id); bound(kept, EXCHANGES_KEPT); dirty.add(id); }
      else if (kept.has(id)) { kept.get(id).push(row); dirty.add(id); }
      else { loose.set(id, [...(loose.get(id) ?? []), row]); bound(loose, LOOSE_KEPT); }
    },
    flush() {
      if (!dirty.size) return;
      for (const [key, { door, exchanges }] of doorsOf(exchangesOf([...kept.values()].flat()), routes())) {
        if (!exchanges.some((ex) => dirty.has(ex.id))) continue;
        const payload = proofOf(exchanges.slice(-PER_DOOR), door, { find, base: appFolder() });
        const json = JSON.stringify(payload);
        if (sent.get(key) === json) continue;
        sent.set(key, json);
        try { onProof(payload); } catch { /* sent again with the next change */ }
      }
      dirty.clear();
    },
  };
}

// Where the repository's own code holds a literal, as its file and line. The files the model call's
// own frames name are searched first; then every other code file, and a literal more than one of them
// holds names none (the caller falls back to the frame). Docs and tests never answer, and a frame
// file is read only when it is one of the repository's shareable files.
// ponytail: reads every code file per new literal; an index when problems per run grow past a few.
const DOCS = /(?:^|\/)docs?\//;
export function sourceFinder(root, files) {
  const found = new Map();
  const lineIn = (rel, literal) => {
    let text;
    try { text = readFileSync(join(root, rel), "utf8"); } catch { return null; }
    const i = text.indexOf(literal);
    return i < 0 ? null : { file: rel, line: text.slice(0, i).split("\n").length };
  };
  const search = (literal, near) => {
    const all = files();
    const shared = new Set(all);
    for (const rel of near) {
      const at = shared.has(rel) ? lineIn(rel, literal) : null;
      if (at) return at;
    }
    let only = null;
    for (const rel of all) {
      if (!CODE.test(rel) || TEST.test(rel) || DOCS.test(rel) || near.includes(rel)) continue;
      const at = lineIn(rel, literal);
      if (at && only) return null;
      only ??= at;
    }
    return only;
  };
  return (literal, near = []) => {
    if (typeof literal !== "string" || literal.trim().length < 3) return null;
    const key = `${near.join("\n")}\0${literal}`;
    if (!found.has(key)) found.set(key, search(literal, near));
    return found.get(key);
  };
}

const FRAMEWORKS = new Set(["fastapi", "starlette", "flask", "django", "quart", "litestar", "aiohttp", "express", "fastify", "hono", "koa", "elysia", "nest", "unknown"]);
const OPENAPI_MAX = 8 * 1024 * 1024;
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
// The row comes from inside a process this command does not control: every field is checked.
const routeTable = (r) => {
  if (!r || typeof r !== "object" || !Array.isArray(r.routes)) return null;
  const openapi = r.openapi && typeof r.openapi === "object" && !Array.isArray(r.openapi) && JSON.stringify(r.openapi).length <= OPENAPI_MAX ? r.openapi : null;
  return {
    framework: FRAMEWORKS.has(r.framework) ? r.framework : "unknown",
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : null,
    routes: r.routes
      .filter((x) => x && /^[A-Za-z]{1,10}$/.test(x.method) && typeof x.path === "string" && x.path.startsWith("/"))
      .slice(0, 400)
      .map((x) => ({ method: x.method.toUpperCase(), path: x.path.slice(0, 1024), file: text(x.file, 512), handler: text(x.handler, 200) })),
    openapi,
  };
};

// Every model call the hook wrote down, kept here: totals per host and model, and the newest rows.
// What a call's model was told is kept only while its row is among those a report hands on.
const ROWS = 5000, REPORTED = 400;
// The turn a row was pinned to by the run's own tag, and the rule ids the call's prompt carried.
const TURN = /^[A-Za-z0-9:_.-]{1,80}$/;
const RULE_ID = /^[\w:-]{1,64}$/;
const turnOf = (v) => (typeof v === "string" && TURN.test(v) ? { turn: v } : {});
const rulesOf = (v) => (Array.isArray(v) ? { rules: v.filter((id) => typeof id === "string" && RULE_ID.test(id)).slice(0, 300) } : {});
// What the app's tools answered behind a call, as the hook read them off the next prompt, and what
// the tools the model's provider ran answered (`provider`), off the model's reply.
// `kind: "data"`: the app's own record of the person (a profile, an account), not a retrieval.
const texts = (v) => (Array.isArray(v) ? v.filter((t) => t && typeof t.text === "string" && t.text.trim()).slice(0, 12).map((t) => ({ name: String(t.name ?? "").slice(0, 80), text: t.text.slice(0, 3000), ...(t.kind === "data" ? { kind: "data" } : {}), ...(t.provider === true ? { provider: true } : {}) })) : []);
const toolsOf = (v) => (texts(v).length ? { tools: texts(v) } : {});
// The tools the model asked for behind a call, names and clipped arguments, what the tool's declared
// schema refused in them (`refused`), and the passages its prompt was handed as retrieved context, or
// a retrieval call answered with.
const calledOf = (v) => {
  const called = Array.isArray(v) ? v.filter((c) => c && typeof c.name === "string" && c.name && typeof c.arguments === "string").slice(0, 12).map((c) => ({ name: c.name.slice(0, 80), arguments: c.arguments.slice(0, 1200), ...(typeof c.refused === "string" && c.refused ? { refused: c.refused.slice(0, 300) } : {}) })) : [];
  return called.length ? { called } : {};
};
const passagesOf = (v) => (texts(v).length ? { passages: texts(v).slice(0, 6) } : {});
// Which of the app's own lines made the call, nearest first, as "path:line".
const AT = /^[^\n\r\t]{1,300}:\d{1,7}$/;
const CALLERS_MAX = 5;
const callerOf = (v) => { const caller = Array.isArray(v) ? v.filter((c) => typeof c === "string" && AT.test(c)).slice(0, CALLERS_MAX) : []; return caller.length ? { caller } : {}; };
// What the call's model was told, as the hook read it off the prompt: the app's instructions ("" when
// it carried none), the tools offered by name, and the declared ones as their schemas say.
const NAME = /^[\w.:-]{1,80}$/;
const names = (v, max) => (Array.isArray(v) ? v.filter((n) => typeof n === "string" && NAME.test(n)).slice(0, max) : []);
const toldOf = (call) => {
  const offered = names(call.offered, 60);
  const declared = (Array.isArray(call.declared) ? call.declared : []).filter((d) => d && typeof d.name === "string" && NAME.test(d.name)).slice(0, 60)
    .map((d) => ({ name: d.name, ...(typeof d.does === "string" && d.does.trim() ? { does: d.does.trim().slice(0, 300) } : {}), requires: names(d.requires, 12) }));
  return { ...(typeof call.instructions === "string" ? { instructions: call.instructions.slice(0, 12_000) } : {}), ...(offered.length ? { offered } : {}), ...(declared.length ? { declared } : {}) };
};
const meter = (() => {
  const rows = [];
  const deps = [];
  const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  return {
    add(call) {
      if (!call || typeof call.host !== "string" || !call.host) return;
      rows.push({
        at: count(call.at), ms: count(call.ms), host: call.host.slice(0, 253), model: String(call.model ?? "").slice(0, 160), status: count(call.status),
        promptTokens: count(call.promptTokens), cachedTokens: count(call.cachedTokens), completionTokens: count(call.completionTokens),
        usage: call.usage === true, ...turnOf(call.turn), ...rulesOf(call.rules), ...toolsOf(call.tools), ...calledOf(call.called), ...passagesOf(call.passages), ...callerOf(call.caller),
        told: toldOf(call),
      });
      if (rows.length > REPORTED) delete rows[rows.length - REPORTED - 1].told;
      if (rows.length > ROWS) rows.splice(0, rows.length - ROWS);
    },
    // A service their settings name: only its setting, host and status travel, never a byte of it.
    // A tool function of the app's own ("in-app") carries its call and what it returned, as a
    // model call's row does.
    dep(d) {
      if (!d || typeof d.host !== "string" || !d.host) return;
      const env = typeof d.env === "string" && /^[A-Z_][A-Z0-9_]*$/.test(d.env) ? d.env : undefined;
      deps.push({ at: count(d.at), ...(env ? { env } : {}), host: d.host.slice(0, 253), status: count(d.status), ...(typeof d.code === "string" ? { code: d.code.slice(0, 40) } : {}), ...turnOf(d.turn), ...passagesOf(d.passages), ...toolsOf(d.tools), ...calledOf(d.called) });
      if (deps.length > ROWS) deps.splice(0, deps.length - ROWS);
    },
    // `turn`: the rows pinned to it carry what their model was told. The instructions go out with the
    // reply they are read with, never with every call of the run at every turn.
    report(turn) {
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
        rows: rows.slice(-REPORTED).reverse().map(({ at, ms, host, model, status, turn: pinned, rules, tools, called, passages, caller, told }) => ({ at, ms, host, model, status, ...(pinned ? { turn: pinned } : {}), ...(rules ? { rules } : {}), ...(tools ? { tools } : {}), ...(called ? { called } : {}), ...(passages ? { passages } : {}), ...(caller ? { caller } : {}), ...(turn !== undefined && pinned === turn ? told : {}) })),
        deps: deps.slice(-REPORTED).reverse(),
      };
    },
  };
})();

// The person's headers minus what carries a conversation: the header itself, or the one cookie inside
// the Cookie header.
export function withoutCarriers(headers, carriers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (carriers.some((c) => c.carrier === "header" && c.key === lower)) continue;
    if (lower === "cookie") {
      const kept = String(value).split(/;\s*/).filter((pair) => !carriers.some((c) => c.carrier === "cookie" && pair.split("=")[0].trim().toLowerCase() === c.key));
      if (kept.length) out[name] = kept.join("; ");
      continue;
    }
    out[name] = value;
  }
  return out;
}
