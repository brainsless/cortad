// Loaded into your app by the command that started it (node --require), and only then. It watches
// for two things. First, a request to your app during which your app called a model: an exchange,
// with the exact body it took, the sign-in it carried, what your app answered, the lines of your code
// that wrote it and the prompt it sent, so the door is proven by a message rather than guessed from
// code. The first few per route are kept, so two turns of one conversation are both seen. Second,
// every model call your app makes: the host, the model it asked for, the status, the seconds and the
// token counts the provider sent back, which tools it asked for (names and clipped arguments, never a
// secret) and the passages its prompt was handed; the model's words only for a call inside a kept
// exchange or a run's turn. Both go to a file only you can read, in the command's own folder on this
// machine. Nothing here talks to a network.
"use strict";
const FILE = process.env.CORTAD_TRACE_FILE;
if (FILE) {
  try {
    const { AsyncLocalStorage } = require("node:async_hooks");
    const fs = require("node:fs");
    const http = require("node:http");
    const https = require("node:https");
    const als = new AsyncLocalStorage();
    // Every value this file writes passes one mask, whichever path wrote it: a key inside a value
    // ("sk-...", a bearer token, a JWT) and what anyone wrote after "password is" or "token:". The
    // door row's sign-in headers are kept on purpose: the command replays them from this machine.
    const SECRET_TEXT = [
      /((?:pass(?:word|phrase|wd)|pwd|密码|口令)["']?\s*(?:is\b|was\b|[:=：]|是|为)\s*["']?)([^\s"'\\,;}，。；、]+)/gi,
      /((?:secret(?:[ _-]?key)?|api[ _-]?key|apikey|access[ _-]?key|private[ _-]?key|client[ _-]?secret|(?:auth|access|refresh)[ _-]?token|token)["']?\s*[:=：]\s*["']?)([^\s"'\\,;}，。；、]+)/gi,
    ];
    const SECRET_WORD = /\b(?:Bearer\s+(?=[\w.~+/=-]*\d)[\w.~+/=-]{16,}|[spr]k[-_](?=[\w-]*\d)[\w-]{8,}|gh[po]_\w{16,}|github_pat_\w{16,}|xox[abpr]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{4,}\.[\w-]*)/g;
    const maskText = (s) => SECRET_TEXT.reduce((t, re) => t.replace(re, "$1[secret]"), s).replace(SECRET_WORD, "[secret]");
    const scrub = (v, depth = 0) => (typeof v === "string" ? maskText(v)
      : Array.isArray(v) ? v.map((x) => scrub(x, depth + 1))
        : v && typeof v === "object" && depth < 12 ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "headers" && depth === 0 ? x : scrub(x, depth + 1)])) : v);
    // A door's body goes up to the run as JSON, so it is masked as JSON: its string values, never its shape.
    const bodyScrubbed = (text) => { try { const b = JSON.parse(text); return b && typeof b === "object" ? JSON.stringify(scrub(b)) : maskText(text); } catch { return maskText(text); } };
    // A reply is JSON, or a stream of JSON events: masked the same way, event by event, so a stream
    // whose events say {"token": "..."} keeps its words.
    const replyScrubbed = (text) => {
      try { const b = JSON.parse(text); if (b && typeof b === "object") return JSON.stringify(scrub(b)); } catch { /* a stream, or text */ }
      return text.split("\n").map((line) => { const m = /^(data:\s?)?([{[].*)$/.exec(line); return m ? (m[1] || "") + bodyScrubbed(m[2]) : maskText(line); }).join("\n");
    };
    const row = (value) => {
      try {
        const plain = value.hello || value.listen || value.routes || value.conn;
        const out = plain ? value : scrub(value);
        if (!plain && typeof value.body === "string") out.body = bodyScrubbed(value.body);
        if (!plain && typeof value.reply === "string") out.reply = replyScrubbed(value.reply);
        if (!plain && Array.isArray(value.sent)) out.sent = value.sent.map(bodyScrubbed);
        if (!plain && Array.isArray(value.after)) out.after = value.after.map((s, i) => ({ ...out.after[i], body: bodyScrubbed(s.body), reply: replyScrubbed(s.reply) }));
        fs.appendFileSync(FILE, JSON.stringify(out) + "\n", { mode: 0o600 });
      } catch { /* the command is gone */ }
    };
    // What the app writes into its own folder while a run is on: each file copied once before its
    // first write, so the command puts every one back when the run ends (lib/writes.mjs). Trials
    // wrote carts and tickets into an app's data/*.json and the developer's own tests read them.
    const WRITES_DIR = process.env.CORTAD_WRITES_DIR;
    const APP_ROOT = process.env.CORTAD_APP_ROOT;
    if (WRITES_DIR && APP_ROOT) {
      const p = require("node:path");
      const crypto = require("node:crypto");
      const { fileURLToPath } = require("node:url");
      // Not the app's data: what a build, a package manager or a log writes.
      const NOT_DATA = /(?:^|\/)(?:node_modules|\.git|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|dist|build|out|coverage|\.cortad)(?:\/|$)|\.(?:log|pyc|tmp|swp)$/;
      const raw = { copyFileSync: fs.copyFileSync, appendFileSync: fs.appendFileSync, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, statSync: fs.statSync, readFileSync: fs.readFileSync };
      const root = p.resolve(APP_ROOT);
      let run = null, runAt = -1;
      const seen = new Set();
      // The run marker names the run; a new one starts the record over, none stops it.
      const runNow = () => {
        try {
          const at = raw.statSync(p.join(WRITES_DIR, "run")).mtimeMs;
          if (at !== runAt) { runAt = at; run = raw.readFileSync(p.join(WRITES_DIR, "run"), "utf8").trim(); seen.clear(); }
          return run;
        } catch { run = null; runAt = -1; seen.clear(); return null; }
      };
      const note = (target) => {
        try {
          if (typeof target !== "string" && !Buffer.isBuffer(target) && !(target instanceof URL)) return;
          const abs = p.resolve(target instanceof URL ? fileURLToPath(target) : String(target));
          if (!abs.startsWith(root + p.sep)) return;
          const rel = p.relative(root, abs);
          if (NOT_DATA.test(rel)) return;
          const id = runNow();
          if (!id || seen.has(rel)) return;
          seen.add(rel);
          let before = null;
          if (raw.existsSync(abs) && raw.statSync(abs).isFile()) {
            before = p.join(WRITES_DIR, "before", crypto.createHash("sha1").update(rel).digest("hex"));
            raw.mkdirSync(p.dirname(before), { recursive: true, mode: 0o700 });
            raw.copyFileSync(abs, before);
          }
          raw.appendFileSync(p.join(WRITES_DIR, "written.jsonl"), JSON.stringify({ run: id, path: rel, before }) + "\n", { mode: 0o600 });
        } catch { /* the folder is gone or the path is not a file: the write goes on as it was */ }
      };
      const O = fs.constants;
      const opensForWrite = (flags) => typeof flags === "number" ? Boolean(flags & (O.O_WRONLY | O.O_RDWR | O.O_APPEND | O.O_TRUNC | O.O_CREAT))
        : typeof flags === "string" ? /[wax+]/.test(flags) : false;
      const wrap = (obj, name, at) => {
        const orig = obj?.[name];
        if (typeof orig !== "function") return;
        const wrapped = function (...args) { try { at(args); } catch { /* recorded or not, the write goes on */ } return orig.apply(this, args); };
        try { Object.defineProperty(wrapped, "name", { value: orig.name }); } catch { /* fine */ }
        obj[name] = wrapped;
      };
      const first = (args) => note(args[0]);
      const both = (args) => { note(args[0]); note(args[1]); };
      const opened = (args) => { if (opensForWrite(args[1] && typeof args[1] === "object" ? args[1].flags : args[1])) note(args[0]); };
      for (const name of ["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream", "unlinkSync", "unlink", "rmSync", "rm", "truncateSync", "truncate"]) wrap(fs, name, first);
      for (const name of ["renameSync", "rename", "copyFileSync", "copyFile"]) wrap(fs, name, both);
      for (const name of ["openSync", "open"]) wrap(fs, name, opened);
      for (const name of ["writeFile", "appendFile", "unlink", "rm", "truncate"]) wrap(fs.promises, name, first);
      for (const name of ["rename", "copyFile"]) wrap(fs.promises, name, both);
      wrap(fs.promises, "open", opened);
      // `import { writeFileSync } from "node:fs"` binds to the wrapped function too.
      try { require("node:module").syncBuiltinESMExports(); } catch { /* CommonJS only */ }
    }
    const isBun = typeof Bun !== "undefined" && typeof Bun.serve === "function";
    // Said once, so the command knows a message sent to this app can be seen arriving.
    row({ hello: isBun ? "bun" : "node", pid: process.pid });
    // Which port this process serves. Every process the start command spawns loads this file, turbo's
    // own launcher included, so "loaded" is not "watching your app": only a listener on the app's port is.
    const listening = (port) => { if (Number.isInteger(port) && port > 0) { row({ listen: port, pid: process.pid }); sayRoutes(port); } };

    // The app's own route table, so the run knows every door it has before a message is sent.
    // Express keeps no mount prefix once a router is built (Express 5 layers keep no path at all),
    // so its registrations are watched as they happen; the others are read off the app.
    const ROUTES_MAX = 400;
    const pathOf = (p) => String(p)
      .replace(/\{(\/?[:*][^{}]*)\}/g, "$1")
      .replace(/:(\w+)(?:\{[^{}]*\})?\??/g, "{$1}")
      .replace(/\*(\w+)/g, "{$1}");
    const joined = (a, b) => ("/" + [a, b].map((s) => String(s).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"));
    const nodePath = require("node:path");
    // The frames of the stack it is called from, nearest first, outside this hook and node_modules,
    // relative to the folder the app was started in. An awaited call keeps its awaiting frames in
    // the stack, and an SDK is deeper than the default ten frames.
    // A frame still inside a build folder is a bundle line no one edits: it is kept by its absolute
    // path and column, and the command places it through the chunk's source map (lib/replay.mjs), so
    // the app never reads a map on a request's path.
    const BUILT = /\/(?:\.next|\.nuxt|\.svelte-kit|\.output|\.turbo|\.vercel|dist|build|out)\//;
    // `typed`: each frame also carries the type of the object it was called on, read off the same
    // stack as it is formatted; none at all when a formatter of the app's own does not keep one line a
    // frame.
    const stackFrames = (typed) => {
      const limit = Error.stackTraceLimit, prepare = Error.prepareStackTrace;
      let types = null;
      Error.stackTraceLimit = 60;
      if (typed) Error.prepareStackTrace = (err, calls) => { types = calls.map((c) => c.getTypeName()); return typeof prepare === "function" ? prepare(err, calls) : [String(err), ...calls.map((c) => `    at ${c}`)].join("\n"); };
      let stack;
      try { stack = String(new Error().stack); } finally { Error.stackTraceLimit = limit; if (typed) Error.prepareStackTrace = prepare; }
      const lines = stack.split("\n").slice(1);
      if (typed && lines.length !== types?.length) return [];
      const out = [];
      lines.forEach((line, i) => {
        const m = /\(?(?:file:\/\/)?(\/[^()]+?):(\d+):(\d+)\)?$/.exec(line.trim());
        if (!m || m[1] === __filename || m[1].includes("/node_modules/")) return;
        const type = typed ? { type: types[i] } : {};
        if (BUILT.test(m[1])) out.push({ file: decodeURI(m[1]), line: Number(m[2]), column: Number(m[3]), built: true, ...type });
        else out.push({ file: nodePath.relative(process.cwd(), decodeURI(m[1])), line: Number(m[2]), ...type });
      });
      return out;
    };
    // The file that registered a route: the first frame outside this hook and outside node_modules.
    const callerFile = () => { const f = stackFrames().find((x) => !x.built); return f && !f.file.startsWith("..") ? f.file : ""; };
    // A built frame is written as its chunk's absolute path, line and column, which no app frame's
    // relative path can be mistaken for.
    const atOf = (f) => (f.built ? `${f.file}:${f.line}:${f.column}` : `${f.file}:${f.line}`);
    // Which of the app's own lines made a model call, nearest first: the run names the code path that
    // ran by it, where the read could only name the door. Five lines: a provider class's stream, post
    // and retry can be three lines of one file, and the line that says which path ran is past them.
    // Built frames are handed on past five, since the SDK bundled beside the app's code fills the
    // first of them; the command keeps five once its map has placed them.
    const CALLERS_MAX = 5, CALLERS_BUILT = 20;
    const callers = () => {
      const out = [];
      let own = 0;
      for (const f of stackFrames()) {
        const at = atOf(f);
        if (f.file.startsWith("..") || out.includes(at)) continue;
        out.push(at);
        if (!f.built) own++;
        if (own === CALLERS_MAX || out.length === CALLERS_BUILT) break;
      }
      return out.length ? out : undefined;
    };
    const seen = new Set();
    let nest = false;

    const expressRoutes = [];
    const expressMounts = [];
    const OWNER = Symbol("cortad.router");
    const isApp = (o) => typeof o === "function" && typeof o.set === "function" && typeof o.handle === "function";
    const isRouter = (o) => typeof o === "function" && Array.isArray(o.stack) && typeof o.handle === "function";
    const useArgs = (args) => {
      let first = args[0];
      while (Array.isArray(first) && first.length) first = first[0];
      const pathed = typeof first !== "function";
      return { paths: pathed ? [].concat(args[0]).filter((p) => typeof p === "string") : ["/"], fns: args.slice(pathed ? 1 : 0).flat(Infinity) };
    };
    const patchExpress = (express) => {
      seen.add("express");
      const routerProto = typeof express.Router.prototype.route === "function" ? express.Router.prototype : express.Router;
      const mounting = (proto, wanted) => {
        const use = proto.use;
        proto.use = function (...args) {
          try {
            const { paths, fns } = useArgs(args);
            for (const fn of fns) if (wanted(fn)) for (const path of paths) expressMounts.push({ parent: this, child: fn, path });
          } catch { /* not ours to fail */ }
          return use.apply(this, args);
        };
      };
      // Express 4 and 5 both pass a plain router through to the router's own use, and hide a
      // mounted sub-app behind a wrapper there, so each level records only what it can see.
      mounting(routerProto, isRouter);
      mounting(express.application, isApp);
      const route = routerProto.route;
      routerProto.route = function (...args) {
        const made = route.apply(this, args);
        try { made[OWNER] = this; } catch { /* frozen */ }
        return made;
      };
      for (const verb of ["get", "post", "put", "patch", "delete", "all"]) {
        const add = express.Route.prototype[verb];
        if (typeof add !== "function") continue;
        express.Route.prototype[verb] = function (...args) {
          try {
            if (expressRoutes.length < ROUTES_MAX * 4) {
              const fns = args.flat(Infinity);
              expressRoutes.push({ owner: this[OWNER], verb, paths: [].concat(this.path).filter((p) => typeof p === "string"), handler: fns[fns.length - 1], file: callerFile() });
            }
          } catch { /* not ours to fail */ }
          return add.apply(this, args);
        };
      }
    };
    const expressTable = (add) => {
      // An app is known by its router once it has one: routes are registered on the router.
      // Express 4's app.router getter throws; its router is _router, made on the first route.
      const own = (o) => {
        if (!isApp(o) || o._router) return (o && o._router) || o;
        try { return o.router || o; } catch { return o; }
      };
      const ups = new Map();
      for (const m of expressMounts) {
        const child = own(m.child);
        if (!ups.has(child)) ups.set(child, []);
        ups.get(child).push({ parent: own(m.parent), path: m.path });
      }
      const prefixes = (router, depth) => (!ups.has(router) || depth > 8 ? [""] : ups.get(router).flatMap((m) => prefixes(m.parent, depth + 1).map((p) => joined(p, m.path))));
      for (const r of expressRoutes) {
        for (const prefix of prefixes(own(r.owner), 0)) for (const path of r.paths) add(r.verb === "all" ? null : [r.verb], joined(prefix, path), r.handler, r.file);
      }
    };

    // Fastify says each instance it makes on a diagnostics channel, and a root onRoute hook sees
    // every route with its plugin prefix already applied.
    const fastifyRoutes = [];
    try {
      require("node:diagnostics_channel").subscribe("fastify.initialization", ({ fastify }) => {
        seen.add("fastify");
        try {
          fastify.addHook("onRoute", (o) => {
            if (fastifyRoutes.length < ROUTES_MAX * 2) fastifyRoutes.push({ methods: [].concat(o.method), path: o.url, handler: o.handler, file: callerFile() });
          });
        } catch { /* an instance that takes no hooks */ }
      });
    } catch { /* no diagnostics channel */ }

    // Hono and Koa keep their tables on the app, so their apps are held as they are made. Only
    // what is loaded through require is seen: Hono's ES module build never passes through here.
    const honoApps = new Set();
    const koaApps = new Set();
    const holding = new WeakMap();
    const heldHono = (exported) => {
      const d = Object.getOwnPropertyDescriptor(exported, "Hono");
      if (!d || ("value" in d && !d.writable && !d.configurable)) return exported;
      seen.add("hono");
      const Hono = new Proxy(exported.Hono, { construct(t, a, nt) { const app = Reflect.construct(t, a, nt); if (honoApps.size < 50) honoApps.add(app); return app; } });
      return new Proxy(exported, { get: (t, k, r) => (k === "Hono" ? Hono : Reflect.get(t, k, r)) });
    };
    const patchKoa = (Koa) => {
      seen.add("koa");
      const callback = Koa.prototype.callback;
      Koa.prototype.callback = function (...a) { if (koaApps.size < 50) koaApps.add(this); return callback.apply(this, a); };
    };
    const adopted = (request, exported) => {
      if (!exported || !/(?:^|node_modules\/)(?:express|koa|hono|@nestjs\/core)(?:\/index\.js)?$|\/lib\/(?:express|application)(?:\.js)?$/.test(request)) return exported;
      if (holding.has(exported)) return holding.get(exported);
      let out = exported;
      if (typeof exported === "function" && exported.application && typeof exported.Router === "function" && typeof exported.Route === "function") patchExpress(exported);
      else if (typeof exported === "function" && exported.prototype && typeof exported.prototype.callback === "function" && typeof exported.prototype.createContext === "function") patchKoa(exported);
      else if (typeof exported.Hono === "function") out = heldHono(exported);
      else if (exported.NestFactory) nest = true;
      holding.set(exported, out);
      return out;
    };
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function (request, ...rest) {
      const exported = load.call(this, request, ...rest);
      try { return adopted(String(request), exported); } catch { return exported; }
    };

    let bunRoutes = [];
    const table = () => {
      const out = new Map();
      const from = new Set();
      const add = (framework) => (methods, path, handler, file) => {
        if (typeof path !== "string") return;
        for (const m of methods || ["POST", "GET"]) {
          const method = String(m).toUpperCase();
          const at = pathOf(path.startsWith("/") ? path : "/" + path);
          if (method === "HEAD" || method === "OPTIONS" || out.size >= ROUTES_MAX || out.has(`${method} ${at}`)) continue;
          from.add(framework);
          out.set(`${method} ${at}`, { method, path: at.slice(0, 1024), file: String(file || "").slice(0, 512), handler: String((handler && handler.name) || "").slice(0, 200) });
        }
      };
      expressTable(add("express"));
      for (const r of fastifyRoutes) add("fastify")(r.methods, r.path, r.handler, r.file);
      // A sub-app's routes are copied into the app that mounts it, so the widest table is the app.
      const hono = [...honoApps].reduce((a, b) => (Array.isArray(b.routes) && b.routes.length > ((a && a.routes.length) || 0) ? b : a), null);
      for (const r of hono ? hono.routes : []) if (r.method !== "ALL" || !r.path.endsWith("*")) add("hono")(r.method === "ALL" ? null : [r.method], r.path, r.handler, "");
      for (const app of koaApps) for (const mw of app.middleware || []) for (const layer of (mw.router && mw.router.stack) || []) {
        if (layer.methods && layer.methods.length) add("koa")(layer.methods, layer.path, layer.stack && layer.stack[layer.stack.length - 1], "");
      }
      for (const r of bunRoutes) add(seen.has("elysia") ? "elysia" : "unknown")(r.methods, r.path, r.handler, "");
      const framework = nest ? "nest" : [...from][0] || [...seen][0] || "unknown";
      return { framework, routes: [...out.values()] };
    };
    let routesSaid = -1, lastPort = null;
    function sayRoutes(port) {
      try {
        lastPort = port;
        const { framework, routes } = table();
        routesSaid = routes.length;
        row({ routes: { framework, port, routes, openapi: null } });
      } catch { /* the table is a courtesy; the app is not */ }
    }
    // Routes an app adds after it starts listening are there by its first request.
    let recheck = true;
    const recheckRoutes = () => {
      if (!recheck || lastPort === null) return;
      recheck = false;
      setImmediate(() => { try { if (table().routes.length !== routesSaid) sayRoutes(lastPort); } catch { /* as above */ } });
    };
    const MAX = 65536;
    // The turn a message came in under, when the run tagged it: one opaque id per request, so a
    // model call and its prompt can be pinned to the reply they produced even while five turns are
    // in flight. It is read here and never shown to your app's own code path beyond the header.
    const TURN = /^[A-Za-z0-9:_.-]{1,80}$/;
    const turnOf = (headers) => {
      const t = headers && (typeof headers.get === "function" ? headers.get("x-cortad-turn") : headers["x-cortad-turn"]);
      return typeof t === "string" && TURN.test(t) ? t : undefined;
    };
    // The customer's own rule sentences, written beside the trace by the run, so each model call can
    // say which of them its prompt carried: a rule is then asked only of a reply whose call was told
    // it. Absent file, nothing is claimed either way. Reloaded when the file changes.
    const RULES = process.env.CORTAD_RULES_FILE;
    let rules = null, rulesAt = -1;
    const norm = (s) => String(s || "")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      .toLowerCase().replace(/\s+/g, " ").trim();
    // A sentence with a slot in it ("answer in {language}") is matched by its literal parts.
    const partsOf = (text) => text.split(/\{[^}]*\}|\$\{[^}]*\}|%[sd]|<[^>]{1,40}>/).map(norm).filter((p) => p.length >= 12);
    const rulesNow = () => {
      if (!RULES) return null;
      try {
        const at = fs.statSync(RULES).mtimeMs;
        if (at !== rulesAt) {
          rulesAt = at;
          const list = JSON.parse(fs.readFileSync(RULES, "utf8"));
          rules = Array.isArray(list)
            ? list.filter((r) => r && typeof r.id === "string" && typeof r.text === "string").map((r) => ({ id: r.id, parts: partsOf(r.text) })).filter((r) => r.parts.length)
            : [];
        }
      } catch { /* not written yet, or gone */ }
      return rules;
    };
    // What the app's tools answered, as the prompt of the next model call carries them: the tool
    // messages of a chat body, the function outputs of a responses body, the tool_result blocks of
    // an Anthropic one, the functionResponse parts of a Gemini one. They are the material a reply's
    // facts rest on, and without them a real ticket id read as invented. Bounded per call.
    const TOOL_TEXT = 3000, TOOLS_MAX = 12;
    const textOf = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (p && typeof p === "object" ? (p.text || p.content || "") : String(p || ""))).filter(Boolean).join("\n") : v && typeof v === "object" ? JSON.stringify(v) : "");
    // Only what came after the person's latest message belongs to this turn: a thread the app
    // resends whole carries every earlier turn's tool answers too.
    const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
    const since = (items, isPerson) => { let at = -1; items.forEach((m, i) => { if (isPerson(m)) at = i; }); return items.slice(at + 1); };
    // A user message that only hands a tool's answer back ("Observation: ...", <tool_response>) is
    // the agent loop talking, not the person.
    const HANDED_BACK = /^\s*(?:Observation\s*:|<(?:tool_response|tool_result|function_results?)>)/i;
    const personSaid = (m) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((c) => c && c.type === "tool_result")) && !HANDED_BACK.test(textOf(m.content));
    const personAsked = (c) => c.role === "user" && !list(c.parts).some((p) => p.functionResponse);
    const toolsIn = (sent) => {
      let body; try { body = JSON.parse(sent); } catch { return undefined; }
      if (!body || typeof body !== "object") return undefined;
      const out = [];
      const names = new Map();
      const add = (name, text) => { const t = textOf(text).slice(0, TOOL_TEXT); if (t.trim() && out.length < TOOLS_MAX && !out.some((o) => o.text === t)) out.push({ name: String(name || "").slice(0, 80), text: t }); };
      for (const m of list(body.messages)) {
        for (const c of list(m.tool_calls)) if (c.id && c.function) names.set(c.id, c.function.name);
        for (const c of list(m.content)) if (c.type === "tool_use" && c.id) names.set(c.id, c.name);
      }
      for (const m of since(list(body.messages), personSaid)) {
        if (m.role === "tool" || m.role === "function") add(m.name || names.get(m.tool_call_id), m.content);
        for (const c of list(m.content)) if (c.type === "tool_result") add(names.get(c.tool_use_id), c.content);
      }
      const items = list(body.input);
      for (const it of items) if (it.type === "function_call" && it.call_id) names.set(it.call_id, it.name);
      for (const it of since(items, (x) => x.role === "user")) if (it.type === "function_call_output") add(names.get(it.call_id), it.output);
      for (const c of since(list(body.contents), personAsked)) for (const p of list(c.parts)) if (p.functionResponse) add(p.functionResponse.name, p.functionResponse.response);
      const declared = declaredIn(body);
      for (const o of observedIn(turnTexts(body, true, declared), declared)) add(o.name, o.text);
      return out.length ? out : undefined;
    };

    // What the model asked the app to run: chat tool_calls (a stream's pieces joined by position), a
    // legacy function_call, a responses function_call item, an Anthropic or Bedrock tool use, a
    // Gemini functionCall. Read off the model's reply, and off this turn's earlier calls as the
    // prompt resends them. Names and arguments only: every value clipped, a secret never written.
    const CALLS_MAX = 12, VALUE_MAX = 200, ARGS_MAX = 1200;
    const SECRET_KEY = /(?:^|_)(?:pass(?:word|phrase)?|secret|token|api_?key|authorization|cookie|session(?:_id)?|credentials?|private_key)$/;
    const SECRET_VALUE = /^(?:Bearer\s|Basic\s|sk-|pk_|rk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|eyJ[\w-]{10,}\.)/;
    const clipped = (v, depth, max = VALUE_MAX) => {
      if (typeof v === "string") return SECRET_VALUE.test(v) ? "[secret]" : v.length > max ? v.slice(0, max) + "…" : v;
      if (Array.isArray(v)) return depth > 4 ? [] : v.slice(0, 20).map((x) => clipped(x, depth + 1, max));
      if (!v || typeof v !== "object") return v;
      const o = {};
      if (depth > 4) return o;
      for (const [k, x] of Object.entries(v).slice(0, 40)) o[k] = SECRET_KEY.test(k.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()) ? "[secret]" : clipped(x, depth + 1, max);
      return o;
    };
    const argsText = (raw) => {
      let v = raw;
      if (typeof raw === "string") { try { v = raw.trim() ? JSON.parse(raw) : {}; } catch { v = raw; } }
      return JSON.stringify(clipped(v === undefined || v === null ? {} : v, 0)).slice(0, ARGS_MAX);
    };
    // Each function tool the request declares, in every provider's shape: its name, what its
    // description says it does, and its JSON schema (null where it declares none).
    const toolDefs = (body) => {
      const out = [];
      const add = (name, does, schema) => { if (typeof name === "string" && name) out.push({ name, does: typeof does === "string" ? does : "", schema: schema && typeof schema === "object" ? schema : null }); };
      for (const t of [...list(body && body.tools), ...list(body && body.toolConfig && body.toolConfig.tools)]) {
        if (t.function) add(t.function.name, t.function.description, t.function.parameters);
        else if (t.toolSpec) add(t.toolSpec.name, t.toolSpec.description, t.toolSpec.inputSchema && t.toolSpec.inputSchema.json);
        else add(t.name, t.description, t.parameters || t.input_schema || t.inputSchema);
        for (const d of list(t.functionDeclarations || t.function_declarations)) add(d.name, d.description, d.parameters);
      }
      for (const f of list(body && body.functions)) add(f.name, f.description, f.parameters);
      return out;
    };
    const schemasOf = (body) => new Map(toolDefs(body).filter((d) => d.schema).map((d) => [d.name, d.schema]));
    // What a tool's declared schema refuses in the arguments the model sent, said plainly, or null.
    // Read before any value is clipped: a clipped value is ours, never the model's.
    const refusedBy = (schema, raw) => {
      let args = raw === undefined || raw === null ? {} : raw;
      if (typeof args === "string") { if (!args.trim()) args = {}; else { try { args = JSON.parse(args); } catch { return "the arguments are not valid JSON"; } } }
      if (!args || typeof args !== "object" || Array.isArray(args)) return "the arguments are not a JSON object";
      const missing = (Array.isArray(schema.required) ? schema.required : []).find((k) => typeof k === "string" && !Object.prototype.hasOwnProperty.call(args, k));
      return missing ? `the required input "${missing}" is missing` : null;
    };
    // `schemas`: the request's declared tools, so each call the reply makes is checked against its own.
    const callsOf = (events, schemas) => {
      const whole = new Map();
      const parts = new Map();
      let n = 0;
      const put = (key, name, args) => { if (name) whole.set(key || `w${n++}`, { name, args }); };
      const piece = (key, name, args) => {
        const p = parts.get(key) || { name: "", args: "" };
        if (name && !p.name) p.name = name;
        if (typeof args === "string") p.args += args;
        parts.set(key, p);
      };
      const blocks = (content) => {
        for (const b of list(content)) {
          if (b.type === "tool_use") put(b.id, b.name, b.input);
          if (b.toolUse) put(b.toolUse.toolUseId, b.toolUse.name, b.toolUse.input);
        }
      };
      for (const e of events) {
        if (!e || typeof e !== "object") continue;
        for (const c of list(e.choices)) {
          const m = c.message;
          if (m) {
            for (const t of list(m.tool_calls)) if (t.function) put(t.id, t.function.name, t.function.arguments);
            if (m.function_call) put(null, m.function_call.name, m.function_call.arguments);
          }
          const d = c.delta;
          if (d) {
            for (const t of list(d.tool_calls)) piece(`c${c.index || 0}.${t.index ?? t.id}`, t.function && t.function.name, t.function && t.function.arguments);
            if (d.function_call) piece(`f${c.index || 0}`, d.function_call.name, d.function_call.arguments);
          }
        }
        for (const it of [...list(e.output), ...list(e.item ? [e.item] : []), ...list(e.response && e.response.output)]) {
          if (it.type === "function_call") put(it.call_id || it.id, it.name, it.arguments);
        }
        blocks(e.content);
        blocks(e.message && e.message.content);
        blocks(e.output && e.output.message && e.output.message.content);
        if (e.type === "content_block_start" && e.content_block && e.content_block.type === "tool_use") piece(`a${e.index}`, e.content_block.name, "");
        if (e.type === "content_block_delta" && e.delta && e.delta.type === "input_json_delta") piece(`a${e.index}`, "", e.delta.partial_json);
        for (const c of list(e.candidates)) for (const p of list(c.content && c.content.parts)) if (p.functionCall) put(null, p.functionCall.name, p.functionCall.args);
      }
      return [...whole.values(), ...parts.values()].filter((p) => p.name).map((p) => {
        const refused = schemas && schemas.has(p.name) ? refusedBy(schemas.get(p.name), p.args) : null;
        return { name: String(p.name).slice(0, 80), arguments: argsText(p.args), ...(refused ? { refused } : {}) };
      });
    };
    // This turn's earlier calls, as the prompt resends them after the person's latest message.
    const calledBefore = (body) => callsOf([
      ...since(list(body.messages), personSaid).filter((m) => m.role === "assistant").map((m) => ({ choices: [{ message: m }], content: m.content })),
      { output: since(list(body.input), (x) => x.role === "user") },
      ...since(list(body.contents), personAsked).filter((c) => c.role === "model").map((c) => ({ candidates: [{ content: c }] })),
    ]);
    // Tool use a model writes in its words instead of as a structured call. A ReAct agent (CrewAI,
    // LangChain) writes "Action: name" then "Action Input: {...}" and is handed "Observation: ..."
    // back in its next prompt; others write <tool_call>{...}</tool_call>, <function=name>,
    // <invoke name="..."> or a JSON object that names the tool. A name counts only when the request
    // declares that tool, in its tools field or in the tool list its prompt carries, so a thought, a
    // "Final Answer" or prose that says Action is never a call.
    const FINAL = /^final[\s_-]*answer$/i;
    const TOOL_NAME = /^[A-Za-z_][\w.-]{0,79}$/;
    const promptText = (body) => [
      ...list(body.messages).filter((m) => m.role !== "assistant").map((m) => textOf(m.content)),
      textOf(body.system), textOf(body.instructions), typeof body.prompt === "string" ? body.prompt : "", typeof body.input === "string" ? body.input : "",
      ...list(body.input).filter((x) => x.role && x.role !== "assistant").map((x) => textOf(x.content)),
      textOf(body.systemInstruction && body.systemInstruction.parts), ...list(body.contents).filter((c) => c.role !== "model").map((c) => textOf(c.parts)),
    ].join("\n");
    const declaredIn = (body) => {
      const out = new Set();
      const add = (n) => { const s = typeof n === "string" ? n.trim().replace(/^["'`]+|["'`]+$/g, "") : ""; if (TOOL_NAME.test(s) && !FINAL.test(s)) out.add(s); };
      for (const d of toolDefs(body)) add(d.name);
      const text = promptText(body).slice(0, 200000);
      for (const m of text.matchAll(/^[ \t]*Tool Name:[ \t]*([^\n]+)/gim)) add(m[1]);
      for (const m of text.matchAll(/\b(?:one of|name of|names? from)[ \t]*\[([^\]\n]{1,2000})\]/gi)) for (const x of m[1].split(",")) add(x);
      for (const m of text.matchAll(/valid "?action"? values?:?[ \t]*([^\n]{1,2000})/gi)) for (const x of m[1].split(/,|\bor\b/)) add(x);
      for (const m of text.matchAll(/<(tools|functions)>([\s\S]*?)<\/\1>/gi)) for (const k of m[2].matchAll(/"name"\s*:\s*"([^"]+)"/g)) add(k[1]);
      for (const m of text.matchAll(/"name"\s*:\s*"([^"]+)"\s*,\s*"(?:description|parameters|input_schema)"/g)) add(m[1]);
      for (const m of text.matchAll(/<(?:tool|function)\s+name\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
      return out;
    };
    const REACT = /(?:^|\n)[ \t>*_#]*Action[ \t]*\d*[ \t*_]*:[ \t*_`]*([^\n`*]*?)[ \t*_`]*\n+[ \t>*_#]*Action[ \t]*\d*[ \t_]*Input[ \t*_]*:[ \t*_]*([\s\S]*?)(?=\n[ \t>*_#]*(?:Observation|Thought|Final[ \t]*Answer|Action)\b|\u0000|$)/gi;
    const TAG_CALL = /<(tool_call|function_call|tool_use)>([\s\S]*?)<\/\1>/gi;
    const FN_TAG = /<function=([\w.-]+)>([\s\S]*?)<\/function>/gi;
    const INVOKE = /<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
    const OBSERVED = /(?:^|\n)[ \t>*_]*Observation[ \t*_]*:[ \t]*([\s\S]*?)(?=\n[ \t>*_#]*(?:Thought|Action|Final[ \t]*Answer)\b|\u0000|$)|<(tool_response|tool_result|function_results?|observation)>([\s\S]*?)<\/\2>/gi;
    const paramsOf = (s) => { const o = {}; for (const m of s.matchAll(/<parameter(?:=|\s+name\s*=\s*["'])([\w.-]+)["']?\s*>([\s\S]*?)<\/parameter>/gi)) o[m[1]] = m[2].trim(); return o; };
    // Each balanced JSON object in the text, outermost first; its insides are not read again.
    const objectsIn = (text) => {
      const out = [];
      for (let i = text.indexOf("{"); i !== -1 && out.length < 20; i = text.indexOf("{", i + 1)) {
        let depth = 0, str = false, esc = false, end = -1;
        for (let j = i; j < text.length && j < i + 20000; j++) {
          const ch = text[j];
          if (str) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') str = false; continue; }
          if (ch === '"') str = true; else if (ch === "{") depth++; else if (ch === "}" && --depth === 0) { end = j; break; }
        }
        const v = end === -1 ? null : parse(text.slice(i, end + 1));
        if (v && typeof v === "object") { out.push({ at: i, v }); i = end; }
      }
      return out;
    };
    // An Action Input that opens with a JSON object is that object: a model that runs on past it
    // ("Observ: ...") does not put its own invention into the arguments.
    const leadingJson = (s) => { const t = s.trim(); const o = t[0] === "{" ? objectsIn(t)[0] : null; return o && o.at === 0 ? o.v : t; };
    // A tool's schema carries a description; a call does not.
    const jsonCall = (v) => {
      const f = v.function && typeof v.function === "object" ? v.function : v;
      if ("description" in f) return null;
      const name = [f.name, v.tool, v.tool_name, v.action, typeof v.function === "string" ? v.function : undefined].find((x) => typeof x === "string");
      return name ? { name, args: [f.arguments, f.args, f.parameters, v.action_input, v.tool_input, v.input, v.args, v.arguments, v.parameters].find((x) => x !== undefined) } : null;
    };
    const writtenCalls = (text, declared) => {
      const found = [];
      if (!text || !declared.size) return found;
      const s = text.slice(0, 50000);
      const take = (at, name, args) => { const n = String(name || "").trim(); if (declared.has(n)) found.push({ at, name: n, args: typeof args === "string" ? args.trim() : args }); };
      for (const m of s.matchAll(REACT)) take(m.index, m[1], leadingJson(m[2]));
      for (const m of s.matchAll(TAG_CALL)) { const v = parse(m[2].trim()); const c = v && typeof v === "object" && jsonCall(v); if (c) take(m.index, c.name, c.args); }
      for (const m of s.matchAll(FN_TAG)) { const v = parse(m[2].trim()); take(m.index, m[1], v && typeof v === "object" ? v : paramsOf(m[2])); }
      for (const m of s.matchAll(INVOKE)) take(m.index, m[1], paramsOf(m[2]));
      for (const { at, v } of objectsIn(s)) { const c = jsonCall(v); if (c) take(at, c.name, c.args); }
      return found.sort((a, b) => a.at - b.at);
    };
    // What a tool answered, named by the call written just before it.
    const observedIn = (text, declared) => {
      const s = String(text || "").slice(0, 50000);
      const calls = writtenCalls(s, declared);
      const out = [];
      if (calls.length) for (const m of s.matchAll(OBSERVED)) { const call = calls.filter((c) => c.at < m.index).pop(); if (call) out.push({ name: call.name, text: (m[1] ?? m[3]).trim() }); }
      return out;
    };
    // The model's own words: the text it answered, whole or streamed, in every provider's shape. A
    // responses stream sends its words as deltas and then whole again in its closing event: the
    // closing copy counts only where no delta came.
    const replyText = (events) => {
      let s = "", closing = "", streamed = false;
      for (const e of events) {
        if (!e || typeof e !== "object") continue;
        for (const c of list(e.choices)) { if (c.message) s += textOf(c.message.content); if (c.delta && typeof c.delta.content === "string") s += c.delta.content; if (typeof c.text === "string") s += c.text; }
        if (e.type === "response.output_text.delta" && typeof e.delta === "string") { s += e.delta; streamed = true; }
        for (const it of list(e.output)) if (it.type === "message") for (const p of list(it.content)) if (typeof p.text === "string") s += p.text;
        for (const it of list(e.response && e.response.output)) if (it.type === "message") for (const p of list(it.content)) if (typeof p.text === "string") closing += p.text;
        if (e.type === "content_block_delta" && e.delta && typeof e.delta.text === "string") s += e.delta.text;
        for (const b of [...list(e.content), ...list(e.message && e.message.content), ...list(e.output && e.output.message && e.output.message.content)]) if (typeof b.text === "string") s += b.text;
        if (e.message && typeof e.message.content === "string" && !e.choices) s += e.message.content;
        for (const c of list(e.candidates)) for (const p of list(c.content && c.content.parts)) if (typeof p.text === "string" && !p.thought) s += p.text;
        if (typeof e.response === "string") s += e.response;
      }
      return streamed ? s : s + closing;
    };
    // This turn as the prompt carries it: the model's earlier words after the person's latest
    // message, and everything from that message on, where a single-prompt agent keeps its scratchpad.
    // A user message right after the model wrote a tool call is the agent loop's nudge ("Analyze the
    // tool result"), never the person: after a call, only the loop speaks.
    const turnTexts = (body, withPerson, declared) => {
      const from = (items, isPerson) => { const at = items.findLastIndex(isPerson); return items.slice(withPerson ? Math.max(0, at) : at + 1); };
      const ours = (r) => withPerson ? r !== "system" && r !== "developer" : r === "assistant" || r === "model";
      const ms = list(body.messages);
      const person = (m) => personSaid(m) && !(ms[ms.indexOf(m) - 1] && ms[ms.indexOf(m) - 1].role === "assistant" && writtenCalls(textOf(ms[ms.indexOf(m) - 1].content), declared).length);
      return [
        ...from(ms, person).filter((m) => ours(m.role)).map((m) => textOf(m.content)),
        ...from(list(body.input), (x) => x.role === "user").filter((x) => ours(x.role)).map((x) => textOf(x.content ?? x.output)),
        ...from(list(body.contents), personAsked).filter((c) => ours(c.role)).map((c) => textOf(c.parts)),
        ...(withPerson ? [typeof body.prompt === "string" ? body.prompt : "", typeof body.input === "string" ? body.input : ""] : []),
      ].join("\u0000\n");
    };

    const calledIn = (sent, events, provided = []) => {
      const body = parse(sent);
      const out = [];
      const declared = body && typeof body === "object" ? declaredIn(body) : new Set();
      const written = [...writtenCalls(body && typeof body === "object" ? turnTexts(body, false, declared) : "", declared), ...writtenCalls(replyText(events), declared)].map((c) => ({ name: c.name, arguments: argsText(c.args) }));
      for (const c of [...(body && typeof body === "object" ? calledBefore(body) : []), ...callsOf(events, schemasOf(body)), ...provided, ...written]) {
        if (out.length < CALLS_MAX && !out.some((o) => o.name === c.name && o.arguments === c.arguments)) out.push(c);
      }
      return out.length ? out : undefined;
    };

    // Tools the model's provider runs for the app (a web search, a file search, a code interpreter, a
    // remote MCP server): the calls come back in the model's own reply, and so does what each answered
    // where the provider says it. A call it marks failed, or an error it hands back, is the tool failing
    // there, in the provider's own words. Answers pair with calls in the order the reply lists them.
    const PROVIDER_CALL = /^(web_search|file_search|code_interpreter|image_generation|mcp)_call$/;
    const PROVIDER_RESULT = /^\w+_tool_result$/;
    const providerIn = (sent, events) => {
      const body = parse(sent);
      const offered = list(body && body.tools).map((t) => t.type).filter((t) => typeof t === "string" && t !== "function" && t !== "custom");
      const named = (kind) => offered.find((t) => t.startsWith(kind)) || kind;
      const calls = new Map(), names = new Map(), answers = [];
      const answer = (name, text) => { const t = textOf(text).slice(0, TOOL_TEXT); if (name && t.trim() && answers.length < TOOLS_MAX && !answers.some((a) => a.name === name && a.text === t)) answers.push({ name: String(name).slice(0, 80), text: t, provider: true }); };
      for (const e of events) {
        if (!e || typeof e !== "object") continue;
        const order = [];
        for (const it of [...list(e.output), ...list(e.item ? [e.item] : []), ...list(e.response && e.response.output)]) {
          const m = PROVIDER_CALL.exec(it.type || "");
          if (m) {
            const name = m[1] === "mcp" ? String(it.name || "mcp") : named(m[1]);
            order.push(name);
            if (it.id) calls.set(it.id, { name: name.slice(0, 80), arguments: argsText(it.action ?? it.arguments ?? {}) });
            if (it.status === "failed" || it.error) answer(name, it.error || `${it.type} ${it.status}`);
          } else if (it.type === "tool_output") answer(order.shift() || (offered.length === 1 ? offered[0] : ""), it.output);
        }
        for (const b of [...list(e.content), ...list(e.message && e.message.content), ...list(e.content_block ? [e.content_block] : [])]) {
          if ((b.type === "server_tool_use" || b.type === "mcp_tool_use") && b.id) { names.set(b.id, b.name); calls.set(b.id, { name: String(b.name).slice(0, 80), arguments: argsText(b.input ?? {}) }); }
          const c = b.content;
          if (PROVIDER_RESULT.test(b.type || "") && (b.is_error === true || (c && !Array.isArray(c) && typeof c === "object" && /_error$/.test(c.type || "")))) answer(names.get(b.tool_use_id) || b.type.replace(/_tool_result$/, ""), c);
        }
      }
      return { calls: [...calls.values()], answers };
    };

    // What the prompt was handed besides its instructions, of two kinds. What the app retrieved: a
    // block it labels as context, documents, knowledge, sources or search results. And its own
    // record of the person, passed beside the ask: a profile, a résumé, an account, orders, a JSON
    // or key: value block of their data, under any heading or none ("data"). A reply's fact taken
    // from either was given, not made up: resumeforge put the saved profile into every prompt, and
    // its replies' facts from it were read as invention. In the system prompt or from the person's
    // latest message on, and Anthropic document and search_result blocks.
    const PASSAGE_TEXT = 3000, PASSAGES_MAX = 6;
    const MATERIAL = /\b(?:retriev\w*|context|knowledge|documents?|sources?|search[ _-]?results?|references?|passages?|excerpts?|snippets?|chunks?|background|faq|relevant)\b|检索|知识|参考资料|资料|上下文|文档|背景|相关/i;
    const RECORD = /\b(?:profiles?|r[eé]sum[eé]s?|cv|(?<!into )accounts?|orders|purchases|records|(?:user|customer|member|patient|student|client|candidate)[ _]?(?:info\w*|data|details?|facts)|(?:order|purchase|account|medical|payment|employment|transaction|work) history)\b|个人资料|用户资料|个人信息|用户信息|简历|档案|订单|账户|账号|会员/i;
    const nameOf = (label) => label.replace(/[#:：[\]=]/g, "").trim().replace(/(?:开始|\s+(?:start|begin))$/i, "").trim();
    // A record is named by a label that ends in its word ("User profile", "[已选个人资料开始]"): a
    // heading of the instructions that only mentions one ("关于简历通本身与使用平台") is not it.
    const RECORD_END = new RegExp(`(?:${RECORD.source})$`, "i");
    const isRecord = (label) => RECORD_END.test(nameOf(label));
    const isLabel = (label) => MATERIAL.test(label) || isRecord(label);
    const kindOf = (label) => (isRecord(label) ? "data" : undefined);
    const HEADING = /^\s*(?:#{1,6}\s+[^\n]{1,80}|[^\n]{1,80}[:：]\s*(?:\([^\n)]*\))?|\[[^\n\]]{1,80}\]|={2,}\s*[^\n]{1,80}?\s*={2,})\s*$/;
    // An inline label is a noun phrase that ends in the label word ("context:", "background:",
    // "user profile:"): "4. Knowledge:" in a numbered instruction and a JSON key are not.
    const INLINE = /^\s*(?:[-*]\s+)?([A-Za-z一-鿿][A-Za-z一-鿿 '’_-]{0,29})[:：]\s*\S/;
    const NAMED = new RegExp(`(?:${MATERIAL.source}|${RECORD.source})\\s*$`, "i");
    const TAGGED = /<([A-Za-z][\w-]*)[^>]*>([\s\S]*?)<\/\1>/g;
    // A label's block runs on to the next heading of its own kind: "资料：" over retrieved chunks
    // that open on markdown headings holds every chunk, where stopping at its first paragraph kept
    // one chunk of five and the reader called the knowledge base's own 1% fee made up. A markdown
    // label holds deeper headings. A closing paragraph that opens on a label of its own ("问题：...",
    // "Question: ...") is the prompt's ask, not material. A long block is several passages, cut
    // between its paragraphs, then its lines.
    const MARKDOWN = /^\s*(#{1,6})\s/;
    const endsBlock = (label, line) => {
      if (!HEADING.test(line)) return false;
      const outer = MARKDOWN.exec(label), inner = MARKDOWN.exec(line);
      return !inner || Boolean(outer && inner[1].length <= outer[1].length);
    };
    const asks = (para) => { const m = INLINE.exec(para.split("\n")[0]); return Boolean(m && !NAMED.test(m[1])); };
    // A heading inside a fenced block is the material's own text: a README chunk's "## Features".
    const FENCE = /^\s*(?:```|~~~)/;
    const fences = (para) => para.split("\n").filter((l) => FENCE.test(l)).length;
    const pieces = (p) => (p.length <= PASSAGE_TEXT ? [p] : p.split("\n").flatMap((l) => l.match(new RegExp(`[\\s\\S]{1,${PASSAGE_TEXT}}`, "g")) || []));
    const addBlock = (add, name, paras, kind) => {
      let text = "";
      for (const para of paras) {
        pieces(para).forEach((p, j) => {
          if (text && text.length + p.length + 2 > PASSAGE_TEXT) { add(name, text, kind); text = ""; }
          text += (text ? (j ? "\n" : "\n\n") : "") + p;
        });
      }
      add(name, text, kind);
    };
    // The person's data with no label word: a JSON object, or key: value lines (YAML too) under a
    // heading. A transcript pasted as "User: ... / Assistant: ..." is the conversation; a tool's
    // schema, an agent's Thought/Action scaffold and an answer's shape are instructions.
    const KV = /^\s*(?:[-*]\s+)?["']?([\p{L}_][\p{L}\p{N} _.'’()/-]{0,39})["']?\s*[:：]\s*(\S.*)?$/u;
    const ROLE = /^(?:user|assistant|human|ai|system|bot|model|agent|customer|用户|助手|客服|顾客|系统)$/i;
    const SCAFFOLD = /^(?:tool\b.*|action(?: input)?|thought|observation|final answer|question|answer|input|output)$/i;
    const SHAPE = /format|schema|example|output|respon|return|reply|格式|示例|输出|返回/i;
    const TOOL_SCHEMA = /"(?:parameters|input_schema|inputSchema)"\s*:/;
    // "[已选岗位结束]": the closing marker an app puts after a record is not part of it.
    const CLOSER = /^\s*\[[^\]\n]{1,80}\]\s*$/;
    const dataIn = (para, before) => {
      const lines = para.split("\n");
      const head = HEADING.test(lines[0]) ? lines[0] : null;
      const body = (head ? lines.slice(1) : lines).filter((l) => l.trim() && !FENCE.test(l));
      if (body.length > 1 && CLOSER.test(body[body.length - 1])) body.pop();
      const name = head || (before && !before.includes("\n") && HEADING.test(before) ? before : "");
      const text = body.join("\n");
      if (SHAPE.test(name)) return null;
      if (/^\s*[{[]/.test(text)) {
        try { const v = JSON.parse(text); return v && typeof v === "object" && Object.keys(v).length && !TOOL_SCHEMA.test(text) ? { name: nameOf(name) || "data", text } : null; } catch { return null; }
      }
      const kv = body.map((l) => KV.exec(l));
      const valued = kv.filter((m) => m && m[2]).map((m) => m[1].trim());
      const shaped = name && body.every((l, i) => kv[i] || /^\s+\S|^\s*-\s/.test(l));
      return shaped && valued.length >= 2 && valued.filter((k) => ROLE.test(k)).length < 2 && !valued.some((k) => SCAFFOLD.test(k)) ? { name: nameOf(name), text } : null;
    };
    const labelled = (text, add) => {
      const rest = String(text || "").replace(TAGGED, (all, tag, inner) => { const label = tag.replace(/_/g, " "); if (isLabel(label)) { add(tag, inner, kindOf(label)); return ""; } return all; });
      const paras = rest.split(/\n\s*\n/);
      for (let i = 0; i < paras.length; i++) {
        const lines = paras[i].split("\n");
        const head = lines[0];
        if (HEADING.test(head) && isLabel(head)) {
          const block = [lines.slice(1).join("\n")];
          let fenced = fences(block[0]) % 2 === 1;
          while (i + 1 < paras.length && (fenced || (!endsBlock(head, paras[i + 1].split("\n")[0]) && !(i + 2 === paras.length && asks(paras[i + 1]))))) {
            block.push(paras[++i]);
            if (fences(paras[i]) % 2 === 1) fenced = !fenced;
          }
          // A block that opens on a record's own label ("[已选个人资料开始]" under "参考资料：") is that record.
          const inner = block[0].trimStart().split("\n")[0];
          const label = HEADING.test(inner) && isRecord(inner) ? inner : head;
          addBlock(add, nameOf(label), block, kindOf(label));
          continue;
        }
        const inline = lines.map((l) => INLINE.exec(l)).find((m) => m && NAMED.test(m[1]));
        if (inline) { add(inline[1].trim(), paras[i], kindOf(inline[1])); continue; }
        const data = dataIn(paras[i], paras[i - 1]);
        if (data) addBlock(add, data.name, [data.text], "data");
      }
    };
    const passagesIn = (sent) => {
      const body = parse(sent);
      if (!body || typeof body !== "object") return undefined;
      const out = [];
      const add = (name, text, kind) => { const t = String(text || "").trim().slice(0, PASSAGE_TEXT); if (t.length >= 20 && out.length < PASSAGES_MAX && !out.some((o) => o.text === t)) out.push({ name: String(name || "").slice(0, 80), text: t, ...(kind ? { kind } : {}) }); };
      const scan = (content) => {
        if (typeof content === "string") return labelled(content, add);
        for (const b of list(content)) {
          if (b.type === "document") add(b.title || "document", b.source ? textOf(b.source.data ?? b.source.content) : textOf(b.content));
          else if (b.type === "search_result") add(b.title || b.source || "search result", textOf(b.content));
          else if (typeof b.text === "string") labelled(b.text, add);
        }
      };
      const messages = list(body.messages);
      for (const m of messages) if (m.role === "system" || m.role === "developer") scan(m.content);
      for (const m of messages.slice(Math.max(0, messages.findLastIndex(personSaid)))) if (m.role === "user") scan(m.content);
      scan(body.system);
      scan(body.instructions);
      scan(body.systemInstruction && body.systemInstruction.parts);
      const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : list(body.input);
      for (const it of input.slice(Math.max(0, input.findLastIndex((x) => x.role === "user")))) if (it.role === "user" || it.role === "system" || it.role === "developer") scan(it.content);
      return out.length ? out : undefined;
    };
    // The passages a retrieval call answered with: a vector store, a search index or a web search,
    // read off its reply when it is JSON. Text fields only, bounded like the rest.
    const RETRIEVAL_HOST = /pinecone\.io|qdrant|weaviate|chroma|zilliz|milvus|turbopuffer|upstash\.io|algolia|typesense|meilisearch|elastic|opensearch|vespa|tavily\.com|exa\.ai|serper\.dev|serpapi\.com|search\.brave\.com|bing\.microsoft\.com|jina\.ai/i;
    const RETRIEVAL_PATH = /\/(?:query|search|_search|retrieve|similarity_search|rerank|hybrid)(?:\/|$)|\/points\/(?:search|query)|\/rpc\/match\w*/i;
    const isRetrieval = (u) => RETRIEVAL_HOST.test(u.hostname) || RETRIEVAL_PATH.test(u.pathname);
    const PASSAGE_KEY = /^(?:text|content|page_?content|pageContent|chunk|snippet|passage|body|document|documents|description|answer|raw_content|highlights?|excerpt)$/i;
    const passagesFrom = (raw) => {
      const out = [];
      let nodes = 0;
      const walk = (v, key, depth) => {
        if (out.length >= PASSAGES_MAX || depth > 7 || ++nodes > 4000) return;
        const t = typeof v === "string" ? v.trim().slice(0, PASSAGE_TEXT) : "";
        if (t) { if (PASSAGE_KEY.test(key) && t.length >= 20 && !out.some((o) => o.text === t)) out.push({ name: key, text: t }); return; }
        if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
        if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
      };
      walk(parse(raw), "", 0);
      return out.length ? out : undefined;
    };
    const rulesIn = (sent) => {
      const list = rulesNow();
      // An empty list claims nothing either way: "carried none" needs rules to carry.
      if (!list || !list.length) return undefined;
      const body = norm(sent);
      return list.filter((r) => r.parts.every((p) => body.includes(p))).map((r) => r.id);
    };

    // What the person said to the app: every text value requests carried in their bodies and
    // addresses, long enough to tell apart, the newest kept. A model call's prompt is told apart from
    // them whichever side keeps the conversation. Kept by value, not by request: with trials side by
    // side a trial's opening message sat up to 282 requests back, and a window of the last 32 would
    // have told it as the app's own words on 114 of 132 later turns.
    // Bounded by characters as well as count: a raw body is one value, and 2000 of them at 64 KB would
    // hold about 128 MB inside the app.
    const HEARD_KEPT = 2000, HEARD_CHARS = 2_000_000, HEARD_MAX = 200, SAID_ASCII = 8, SAID_OTHER = 4;
    const heard = new Set();
    let heardChars = 0;
    const heardIn = (ctx) => {
      const out = new Set();
      const add = (s) => {
        const t = typeof s === "string" ? s.trim() : "";
        if (out.size < HEARD_MAX && t.length >= (/[^\x00-\x7F]/.test(t) ? SAID_OTHER : SAID_ASCII) && /\p{L}/u.test(t)) out.add(t);
      };
      const walk = (v, depth) => { if (typeof v === "string") add(v); else if (v && typeof v === "object" && depth < 12) for (const x of Object.values(v)) walk(x, depth + 1); };
      const raw = bodyOf(ctx);
      const json = parse(raw);
      if (json && typeof json === "object") walk(json, 0);
      else if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(raw)) for (const v of new URLSearchParams(raw).values()) add(v);
      else add(raw);
      for (const v of new URLSearchParams(ctx.path.split("?")[1] || "").values()) add(v);
      return out;
    };
    const hear = (ctx) => {
      try {
        for (const w of heardIn(ctx)) {
          if (heard.delete(w)) heardChars -= w.length;
          heard.add(w);
          heardChars += w.length;
        }
        for (const w of heard) {
          if (heard.size <= HEARD_KEPT && heardChars <= HEARD_CHARS) break;
          heard.delete(w);
          heardChars -= w.length;
        }
      } catch { /* nothing heard */ }
    };

    // What the app told the model on this call: its system prompt and every block it or its framework
    // put among the messages (a reminder, injected context, a prompt template), in prompt order. Never
    // the person's words: what a request carried is taken out of the person's side, and a message
    // that held only that is not told. Never the model's own words or a tool's answer. A reply is
    // read against this, and a block of it the reply repeats is a leak code decides.
    const INSTRUCTIONS_MAX = 12000, TOLD_MIN = 12;
    // The fields read below, in the shapes they are read in. A body with none of them is a shape
    // this hook cannot read: its instructions stay unrecorded, so the run keeps the read's copy of
    // the prompt, and "" always means the call really carried none.
    const shapeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
    const TOLD_FIELDS = { system: /^(?:string|array|object)$/, instructions: /^(?:string|array|object)$/, systemInstruction: /^object$/, messages: /^array$/, input: /^(?:string|array)$/, contents: /^array$/, prompt: /^string$/ };
    const instructionsIn = (body, words) => {
      if (!Object.entries(TOLD_FIELDS).some(([k, shape]) => shape.test(shapeOf(body[k])))) return undefined;
      // Longest first, so a short phrase the person repeated never splits a longer message of theirs.
      const said = [...words].sort((a, b) => b.length - a.length);
      const told = [];
      const own = (content) => { const t = textOf(content).trim(); if (t) told.push(t); };
      const added = (text) => {
        let left = text;
        for (const w of said) if (left.includes(w)) left = left.split(w).join(" ");
        if ((left.match(/[\p{L}\p{N}]/gu) || []).length >= TOLD_MIN) told.push(left.trim());
      };
      const texts = (content) => (typeof content === "string" ? [content] : list(content).filter((p) => typeof p.text === "string").map((p) => p.text));
      own(body.system);
      own(body.instructions);
      own(body.systemInstruction && body.systemInstruction.parts);
      for (const m of list(body.messages)) {
        if (m.role === "system" || m.role === "developer") own(m.content);
        else if (m.role === "user" && !HANDED_BACK.test(textOf(m.content))) texts(m.content).forEach(added);
      }
      for (const it of typeof body.input === "string" ? [{ role: "user", content: body.input }] : list(body.input)) {
        if (it.role === "system" || it.role === "developer") own(it.content);
        else if (it.role === "user") texts(it.content).forEach(added);
      }
      for (const c of list(body.contents)) if (c.role !== "model") texts(c.parts).forEach(added);
      if (typeof body.prompt === "string") added(body.prompt);
      return told.join("\n\n").slice(0, INSTRUCTIONS_MAX);
    };
    // The tools the call offered its model: each by name, a provider's own tool by its type, and the
    // declared ones as their schemas say: what each does and the inputs it requires.
    const TOOLS_OFFERED = 60, DOES_MAX = 300, INPUTS_MAX = 12;
    const toldOf = (body, ctx) => {
      const words = ctx ? new Set([...heard, ...heardIn(ctx)]) : heard;
      const provider = list(body.tools).filter((t) => !t.name && !t.function && typeof t.type === "string" && !/^(?:function|custom)$/.test(t.type)).map((t) => t.type);
      const offered = [...new Set([...[...declaredIn(body)].sort(), ...provider])].slice(0, TOOLS_OFFERED);
      const declared = [...new Map(toolDefs(body).filter((d) => d.schema).map((d) => [d.name, d])).values()].slice(0, TOOLS_OFFERED).map((d) => ({
        name: d.name.slice(0, 80),
        ...(d.does.trim() ? { does: d.does.trim().slice(0, DOES_MAX) } : {}),
        requires: (Array.isArray(d.schema.required) ? d.schema.required : []).filter((k) => typeof k === "string").slice(0, INPUTS_MAX),
      }));
      const instructions = instructionsIn(body, words);
      return { ...(instructions !== undefined ? { instructions } : {}), ...(offered.length ? { offered } : {}), ...(declared.length ? { declared } : {}) };
    };
    // Where models are served, by host, and the paths every OpenAI-shaped or vendor endpoint ends with.
    const MODEL_HOST = /(?:^|\.)(?:openai\.com|anthropic\.com|fireworks\.ai|openrouter\.ai|groq\.com|mistral\.ai|together\.xyz|together\.ai|deepseek\.com|cohere\.ai|cohere\.com|perplexity\.ai|x\.ai|googleapis\.com|openai\.azure\.com|cognitiveservices\.azure\.com|amazonaws\.com|replicate\.com|huggingface\.co|cerebras\.ai|deepinfra\.com|novita\.ai|moonshot\.cn|dashscope\.aliyuncs\.com|bigmodel\.cn|ai-gateway\.vercel\.sh|gateway\.ai\.cloudflare\.com|helicone\.ai|portkey\.ai)$/i;
    const MODEL_PATH = /\/(?:chat\/completions|completions|responses|messages|embeddings)$|:(?:generateContent|streamGenerateContent)|\/invoke(?:-with-response-stream)?$|\/api\/(?:chat|generate)$/i;
    // An embedding call answers nobody, so where it was made names no path a reply came down.
    const EMBEDDING = /\/embeddings$/i;
    const isModelCall = (host, path) => {
      const h = String(host || "").replace(/:\d+$/, "");
      const p = String(path || "").split("?")[0];
      if (/googleapis\.com$/i.test(h)) return /generativelanguage|aiplatform/i.test(h) && MODEL_PATH.test(p);
      if (/amazonaws\.com$/i.test(h)) return /^bedrock/i.test(h);
      return MODEL_HOST.test(h) ? true : MODEL_PATH.test(p) && /\/v\d|\/api\//.test(p);
    };
    // An exchange is kept when the request makes its first model call, for the first few requests
    // per route, and written once the app has answered. Model calls and tool rows carry the request's
    // id whether kept or not; the command joins them to the exchange it has.
    // The person's requests, ours (a run's turns, a knock) and the canary's each have their own count,
    // so a run that knocked first never takes the places of the requests that prove a door. Every one
    // of the person's is kept: their newest is the sign-in and the proof a run takes, and the command
    // keeps only the newest few per door.
    // ponytail: the trace file grows by one row per request of the person's; a cap per route if a person's own load test fills it.
    const EXCHANGES_PER_ROUTE = 4, CANARY_PER_ROUTE = 30, ROUTES_KEPT = 1000, SENT_MAX = 4, MODEL_WORDS = 4000;
    const slotOf = (turn) => (!turn ? { cls: "", max: Infinity } : /^canary:/.test(turn) ? { cls: "canary ", max: CANARY_PER_ROUTE } : { cls: "ours ", max: EXCHANGES_PER_ROUTE });
    const perRoute = new Map();
    // One route whatever id its path carries: a conversation in the path is a new path every trial.
    const routeKey = (method, path) => `${method} ${path.split("?")[0].split("/").map((s) => (/^\d+$/.test(s) || (s.length >= 8 && /\d/.test(s)) ? "{id}" : s)).join("/")}`;
    let lastExchange = 0;
    const bodyOf = (ctx) => (ctx.bodyText ?? Buffer.concat(ctx.chunks).toString("utf8")).slice(0, MAX);
    const tied = require("./tied.cjs").makeTied({ norm, bodyOf, replyOf: (ctx) => (ctx.reply ? ctx.reply.text.slice(0, MAX) : "") });
    const requestCtx = (method, path, headers, turn) => {
      if (turn) heldWarm();
      const ctx = { id: `${process.pid}.${++lastExchange}`, at: Date.now(), method, path, headers, chunks: [], size: 0, noted: false, kept: false, sent: [], turn, sites: [], traced: 0 };
      tied.opened(ctx);
      return ctx;
    };
    // The request a model call is pinned to, returned so the call's row carries it: the one it was
    // made inside, else the request that asked for it (lib/tied.cjs).
    const note = (ctx, sent) => {
      tied.sent(sent || "");
      if (!ctx) { try { ctx = tied.pinned(String(sent || "")); } catch { ctx = undefined; } }
      if (!ctx) return ctx;
      if (!ctx.noted) {
        ctx.noted = true;
        const { cls, max } = slotOf(ctx.turn);
        const key = cls + routeKey(ctx.method, ctx.path);
        const n = perRoute.get(key) || 0;
        if (n < max && (n || perRoute.size < ROUTES_KEPT)) { perRoute.set(key, n + 1); ctx.kept = true; }
      }
      if (ctx.kept && ctx.sent.length < SENT_MAX) ctx.sent.push(String(sent || "").slice(0, MAX));
      return ctx;
    };
    const cookieNames = (v) => [].concat(v || []).map((c) => String(c).split(";")[0].split("=")[0].trim()).filter(Boolean).slice(0, 20);
    const rowOf = (ctx) => {
      const { reply } = ctx;
      return { at: ctx.at, ms: ctx.ended - ctx.at, method: ctx.method, path: ctx.path, body: bodyOf(ctx), status: reply.status, type: String(reply.type || ""), ...(reply.writes ? { writes: reply.writes } : {}), reply: reply.text.slice(0, MAX), ...(reply.cookies.length ? { cookies: reply.cookies } : {}), ...(reply.cut ? { cut: true } : {}) };
    };
    // An answer that came on a second request is written as that request's row under the id of the
    // request that asked, with the requests of its turn in `after` (the one that asked last) and the
    // headers they were sent with: one line, so a reader never sees half a turn.
    const answered = (ctx, steps = []) => {
      const asker = steps.at(-1) || ctx;
      if (!asker.kept || asker.written) return;
      asker.written = true;
      const turn = ctx.turn || asker.turn;
      row({ ex: asker.id, ...rowOf(ctx), headers: Object.assign({}, ...steps.map((s) => s.headers), ctx.headers), ...(turn ? { turn } : {}), sent: asker.sent, ...(steps.length ? { after: steps.map(rowOf) } : {}) });
    };
    // Where in the app's own code each part of a reply was written: the app's line on the stack of the
    // write, or, for a web stream the app hands back, where its code put the chunk into the stream,
    // kept when the reply carried it. One entry per line and event name, with the first bytes written
    // there, so a block in the reply is placed at the write that sent it (lib/pyhook/cortad_sites.py).
    // ponytail: a reply's first thousand writes are traced; a leak later in a longer stream goes unplaced.
    const SITES_MAX = 16, SITE_TEXT = 300, SITE_WRITES = 1000, BUILT_WALK = 12;
    const EVENT = /^event:[ \t]*([\w.:-]{1,40})/m, JSON_EVENT = /"(?:type|event)"\s*:\s*"([\w.:-]{1,40})"/;
    const siteText = (chunk) => {
      if (typeof chunk === "string") return chunk.slice(0, SITE_TEXT);
      if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, SITE_TEXT)).toString("utf8").replace(/\uFFFD+$/, "");
      try { return chunk && typeof chunk === "object" ? String(JSON.stringify(chunk)).slice(0, SITE_TEXT) : ""; } catch { return ""; }
    };
    const wrote = (ctx, chunk, streamed) => {
      if (!ctx || !ctx.sites || ++ctx.traced > SITE_WRITES || ctx.sites.length >= SITES_MAX) return;
      // A method the app put on the response, such as a res.end that logs and calls the one it replaced,
      // only hands the write on: the app's line that called it wrote it.
      const frames = stackFrames(true);
      const i = frames.findIndex((f) => !f.file.startsWith("..") && f.type !== ctx.responseType);
      const text = i >= 0 && siteText(chunk);
      if (!text) return;
      // In a bundle the first frames are the SDK compiled into the same chunk: the next few are
      // handed on, and the command keeps the first that its map places in the app's own source.
      const own = frames[i];
      const at = own.built ? frames.slice(i, i + BUILT_WALK).filter((f) => f.built).map(atOf) : atOf(own);
      const m = EVENT.exec(text) || JSON_EVENT.exec(text);
      const event = m ? m[1] : undefined;
      if (ctx.sites.some((s) => String(s.at) === String(at) && s.event === event)) return;
      ctx.sites.push({ at, ...(event ? { event } : {}), text, ...(streamed ? { streamed } : {}) });
    };
    for (const Controller of [globalThis.ReadableStreamDefaultController, globalThis.TransformStreamDefaultController]) {
      const enqueue = Controller && Controller.prototype.enqueue;
      if (typeof enqueue !== "function") continue;
      Controller.prototype.enqueue = function (chunk) { try { wrote(als.getStore(), chunk, true); } catch { /* the chunk goes on */ } return enqueue.apply(this, arguments); };
    }
    // Written under the id its exchange is written by.
    const writtenAt = (ctx, steps) => {
      const asker = (steps && steps.at(-1)) || ctx;
      const turn = ctx.turn || asker.turn;
      const list = ctx.sites.filter((s) => !s.streamed || ctx.reply.text.includes(s.text)).map(({ streamed, ...s }) => s);
      if (list.length && (asker.kept || turn)) row({ sites: { ex: asker.id, ...(turn ? { turn } : {}), list } });
    };
    // Once the app has answered and a streamed body has been read whole.
    const ended = (ctx, reply) => {
      if (ctx.ended) return;
      ctx.ended = Date.now();
      ctx.reply = reply;
      const done = () => {
        hear(ctx);
        const steps = tied.closed(ctx);
        writtenAt(ctx, steps);
        if (steps) answered(ctx, steps);
        else if (!ctx.callsOpen) answered(ctx);
      };
      if (ctx.body) ctx.body.then(done);
      else done();
    };
    // What the app sends back, as it writes it: its own listeners and pipes see exactly the same.
    const watchReply = (ctx, res) => {
      if (!res || typeof res.write !== "function" || typeof res.end !== "function") return;
      ctx.responseType = res.constructor && res.constructor.name;
      const got = [];
      let size = 0, writes = 0;
      const keep = (chunk, encoding) => {
        if (chunk == null || typeof chunk === "function") return;
        writes += 1;
        wrote(ctx, chunk);
        if (size >= MAX) return;
        const b = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8") : Buffer.from(chunk);
        got.push(b);
        size += b.length;
      };
      for (const name of ["write", "end"]) {
        const orig = res[name];
        res[name] = function (chunk, encoding) { try { keep(chunk, encoding); } catch { /* the reply goes on */ } return orig.apply(this, arguments); };
      }
      // writeHead(status, headers) sends its headers without keeping them where getHeader looks: the
      // header block as sent says them either way.
      const sentHeader = (name) => {
        const kept = res.getHeader(name);
        if (kept !== undefined) return kept;
        const block = typeof res._header === "string" ? res._header : "";
        const found = block.split("\r\n").filter((l) => l.toLowerCase().startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trim());
        return name === "set-cookie" ? found : found[0];
      };
      // `cut`: the app began its reply and the connection closed before it finished, so the row holds
      // part of it. Either side may have closed it (a client that stopped reading, an app that broke
      // off mid-stream), so nothing downstream says which.
      const done = () => {
        try { ended(ctx, { status: res.statusCode, type: sentHeader("content-type"), writes, text: decoded(Buffer.concat(got), sentHeader("content-encoding")), cookies: cookieNames(sentHeader("set-cookie")), cut: res.headersSent && !res.writableFinished }); } catch { /* the command is gone */ }
      };
      res.once("finish", done);
      res.once("close", done);
    };
    // Bun hands back a Response; its body is read from a clone, so the client's copy is untouched.
    const watchResponse = (ctx, res) => {
      // Nothing to read: the request is closed and never written.
      const gone = () => { ctx.ended = Date.now(); ctx.reply = { status: 0, type: "", text: "", cookies: [] }; tied.closed(ctx); };
      if (!(res instanceof Response) || Number(res.headers.get("content-length") || 0) > REPLY_MAX) return gone();
      let copy;
      try { copy = res.clone(); } catch { return gone(); }
      copy.arrayBuffer().then((b) => Buffer.from(b), () => Buffer.alloc(0)).then((buf) => {
        const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : res.headers.get("set-cookie");
        ended(ctx, { status: res.status, type: res.headers.get("content-type"), text: decoded(buf.subarray(0, MAX), res.headers.get("content-encoding")), cookies: cookieNames(set) });
      }).catch(() => { /* the command is gone */ });
    };

    // Inbound: each request is handled inside its own context, and its body is seen as it arrives
    // without reading it, so your own body parser is untouched. A GET is watched but never made the
    // context a model call is pinned by: it can only be the step an answer comes on.
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (type, req, ...rest) {
      if (this[HELD]) return emit.call(this, type, req, ...rest);
      if (type === "listening") { try { listening(this.address()?.port); } catch { /* not a TCP server */ } }
      if (type === "request") { recheckRoutes(); sweepTools(); }
      if (type !== "request" || !req || !req.method || /^(?:HEAD|OPTIONS)$/.test(req.method)) return emit.call(this, type, req, ...rest);
      const { "x-cortad-turn": _turn, ...headers } = req.headers;
      const ctx = requestCtx(req.method, req.url || "/", headers, turnOf(req.headers));
      try { watchReply(ctx, rest[0]); } catch { /* the reply goes on unwatched */ }
      if (req.method === "GET") return emit.call(this, type, req, ...rest);
      const push = req.push;
      req.push = function (chunk, encoding) {
        if (chunk && ctx.size < MAX) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); ctx.chunks.push(b); ctx.size += b.length; }
        return push.call(this, chunk, encoding);
      };
      // A body parser carries on from the stream's own "end" event, and that event fires from the
      // socket's context, not the request's: every Express app lost its request there. Listeners put
      // on this request run inside it, the way OpenTelemetry binds a request's emitter.
      const bound = new WeakMap();
      for (const name of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
        const add = req[name];
        req[name] = function (event, fn) {
          if (typeof fn !== "function") return add.call(this, event, fn);
          const inside = bound.get(fn) || function (...a) { return als.run(ctx, () => fn.apply(this, a)); };
          bound.set(fn, inside);
          return add.call(this, event, inside);
        };
      }
      for (const name of ["off", "removeListener"]) {
        const remove = req[name];
        req[name] = function (event, fn) { return remove.call(this, event, (typeof fn === "function" && bound.get(fn)) || fn); };
      }
      return als.run(ctx, () => emit.call(this, type, req, ...rest));
    };

    // Bun serves through Bun.serve, never node:http, so the patch above saw no request at all: an
    // Elysia API on Bun took the customer's messages and nothing was written. Bun.serve is wrapped
    // instead, both the fetch handler and the per-route handlers Bun can dispatch to directly. The body
    // is read from a clone, so the app's own reader is untouched.
    if (isBun) {
      const inside = (handler, self) => function (req, server) {
        recheckRoutes();
        sweepTools();
        if (!req || /^(?:HEAD|OPTIONS)$/.test(req.method)) return handler.call(self, req, server);
        let path = "/";
        try { const u = new URL(req.url); path = u.pathname + u.search; } catch { /* keep "/" */ }
        const ctx = requestCtx(req.method, path, Object.fromEntries([...req.headers].filter(([k]) => k !== "x-cortad-turn")), turnOf(req.headers));
        if (req.method === "GET") {
          const out = handler.call(self, req, server);
          Promise.resolve(out).then((res) => watchResponse(ctx, res), () => watchResponse(ctx, null));
          return out;
        }
        // ponytail: a body is copied only when it is small or says it is text; an upload is left alone.
        const size = Number(req.headers.get("content-length") || 0);
        if (size <= MAX || /json|text|form/i.test(req.headers.get("content-type") || "")) {
          // Read as it arrives, so a model call made while the request is open knows the person's words.
          try { ctx.body = req.clone().arrayBuffer().then((b) => { ctx.bodyText = Buffer.from(b).subarray(0, MAX).toString("utf8"); }, () => { ctx.bodyText = ""; }); } catch { /* unread */ }
        }
        return als.run(ctx, () => {
          const out = handler.call(self, req, server);
          Promise.resolve(out).then((res) => watchResponse(ctx, res), () => {});
          return out;
        });
      };
      const routes = (table) => {
        if (!table || typeof table !== "object") return table;
        const out = {};
        for (const [route, value] of Object.entries(table)) {
          if (typeof value === "function") out[route] = inside(value, table);
          else if (value && typeof value === "object" && !(value instanceof Response)) {
            out[route] = {};
            for (const [verb, fn] of Object.entries(value)) out[route][verb] = typeof fn === "function" ? inside(fn, value) : fn;
          } else out[route] = value;
        }
        return out;
      };
      // Bun's own route table: a handler per path, or a handler per method.
      const bunTable = (table) => Object.entries(table && typeof table === "object" ? table : {}).map(([path, value]) => (
        typeof value === "function" ? { methods: null, path, handler: value }
          : value instanceof Response ? { methods: ["GET"], path, handler: null }
            : { methods: Object.keys(value || {}), path, handler: null }));
      const serve = Bun.serve;
      Bun.serve = function (options, ...rest) {
        let wrapped = options;
        try {
          if (options && typeof options === "object") {
            wrapped = Object.assign(Object.create(Object.getPrototypeOf(options)), options);
            if (typeof options.fetch === "function") wrapped.fetch = inside(options.fetch, options);
            if (options.routes) wrapped.routes = routes(options.routes);
          }
        } catch { wrapped = options; }
        try {
          if (Object.keys(require.cache).some((k) => k.includes("/node_modules/elysia/"))) seen.add("elysia");
          bunRoutes = bunTable(options && options.routes);
        } catch { /* no table */ }
        const server = serve.call(this, wrapped, ...rest);
        try { listening(server && server.port); } catch { /* not ours to fail */ }
        return server;
      };
    }

    // The meter. One row per model call: host, model id, status, and the provider's own token counts.
    const zlib = require("node:zlib");
    const REPLY_MAX = 8 * 1024 * 1024;
    const decoded = (buf, encoding) => {
      try {
        const e = String(encoding || "").toLowerCase();
        return (e === "gzip" ? zlib.gunzipSync(buf) : e === "br" ? zlib.brotliDecompressSync(buf) : e === "deflate" ? zlib.inflateSync(buf) : buf).toString("utf8");
      } catch { return ""; }
    };
    const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
    // The shapes the providers answer in. promptTokens is the whole input, cache included, so totals add up.
    const tokensOf = (u) => {
      if (!u || typeof u !== "object") return null;
      if (u.tokens && typeof u.tokens === "object") return tokensOf(u.tokens);
      if ("prompt_tokens" in u) return { promptTokens: n(u.prompt_tokens), cachedTokens: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens), completionTokens: n(u.completion_tokens) };
      if ("input_tokens" in u && u.input_tokens_details) return { promptTokens: n(u.input_tokens), cachedTokens: n(u.input_tokens_details.cached_tokens), completionTokens: n(u.output_tokens) };
      if ("input_tokens" in u) { const read = n(u.cache_read_input_tokens); return { promptTokens: n(u.input_tokens) + read + n(u.cache_creation_input_tokens), cachedTokens: read, completionTokens: n(u.output_tokens) }; }
      if ("inputTokens" in u) { const read = n(u.cacheReadInputTokens); return { promptTokens: n(u.inputTokens) + read + n(u.cacheWriteInputTokens), cachedTokens: read, completionTokens: n(u.outputTokens) }; }
      if ("promptTokenCount" in u) return { promptTokens: n(u.promptTokenCount), cachedTokens: n(u.cachedContentTokenCount), completionTokens: n(u.candidatesTokenCount) };
      return null;
    };
    // A stream spreads its counts over events (Anthropic's input in the first, output in the last);
    // later values win, so the fold ends on the final figures.
    const readReply = (type, text) => {
      const events = /event-stream/i.test(type || "")
        ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => parse(l.slice(5).trim()))
        : [].concat(parse(text));
      const usage = {};
      let model = null;
      for (const e of events) {
        if (!e || typeof e !== "object") continue;
        const part = e.usage || (e.message && e.message.usage) || (e.response && e.response.usage) || e.usageMetadata;
        if (part && typeof part === "object") Object.assign(usage, part);
        model = e.model || (e.message && e.message.model) || (e.response && e.response.model) || e.modelVersion || model;
      }
      return { tokens: tokensOf(Object.keys(usage).length ? usage : null), model, events };
    };
    // The model asked for, from what was sent; Gemini and Bedrock put it in the path instead.
    const askedFor = (path, sent) => {
      const body = parse(sent);
      if (body && typeof body.model === "string") return body.model;
      const m = /\/models\/([^/:]+):|\/model\/([^/]+)\/(?:invoke|converse)/.exec(path || "");
      return m ? decodeURIComponent(m[1] || m[2]) : "";
    };
    const meter = ({ host, path, sent, status, type, body, ctx, t0, caller }) => {
      try {
        const reply = readReply(type, String(body || "").slice(0, REPLY_MAX));
        const rules = rulesIn(sent);
        const provided = providerIn(sent, reply.events);
        const answered = [...(toolsIn(sent) || []), ...provided.answers];
        const tools = answered.length ? answered : undefined;
        const called = calledIn(sent, reply.events, provided.calls);
        const passages = passagesIn(sent);
        const turn = ctx && ctx.turn;
        const asked = parse(sent);
        const told = asked && typeof asked === "object" && !EMBEDDING.test(path) ? toldOf(asked, ctx) : {};
        tied.done(ctx);
        row({ call: { at: Date.now(), ms: Date.now() - t0, host: String(host).replace(/:443$/, ""), model: String(askedFor(path, sent) || reply.model || "").slice(0, 160), status, ...(reply.tokens || { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }), usage: Boolean(reply.tokens), ...(EMBEDDING.test(path) ? { embedding: true } : {}), ...(ctx ? { ex: ctx.id } : {}), ...(ctx && (ctx.kept || ctx.turn) ? { reply: replyText(reply.events).slice(0, MODEL_WORDS) } : {}), ...(turn ? { turn } : {}), ...(rules ? { rules } : {}), ...(tools ? { tools } : {}), ...(called ? { called } : {}), ...(passages ? { passages } : {}), ...(caller ? { caller } : {}), ...told } });
      } catch { /* the command is gone */ }
    };

    // Outbound to a service their own settings name (a vector store, a database API, a search
    // host): which setting, which host and whether it answered. No body, no headers, no query. A
    // run that tested a tutoring app while every lookup failed inside Node never knew; this is
    // the witness that lets the run say retrieval was not tested instead of grading without it.
    let depHosts = null, depSeen = -1;
    const depOf = (input) => {
      try {
        const keys = Object.keys(process.env);
        if (keys.length !== depSeen) {
          depSeen = keys.length; depHosts = new Map();
          for (const k of keys) {
            const v = process.env[k];
            if (!v || !/^https?:\/\//i.test(v) || /(^|_)(KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)) continue;
            try { depHosts.set(new URL(v).host.replace(/:443$/, ""), k); } catch { /* not a URL */ }
          }
        }
        const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
        const name = depHosts.get(u.host.replace(/:443$/, "")) || depHosts.get(u.hostname);
        return name ? { env: name, host: u.hostname } : null;
      } catch { return null; }
    };
    // A retrieval says so, with the app's line that asked, so one that came back empty has an address.
    const depRow = (dep, status, { code, passages, ctx, retrieval, caller } = {}) => {
      const turn = ctx && ctx.turn;
      row({ dep: { at: Date.now(), ...(dep.env ? { env: dep.env } : {}), host: dep.host, status, code: code ? String(code).slice(0, 40) : undefined, ...(ctx ? { ex: ctx.id } : {}), ...(turn ? { turn } : {}), ...(retrieval ? { retrieval: true } : {}), ...(caller ? { caller } : {}), ...(passages ? { passages } : {}) } });
    };

    // The app's own functions the read names as its tools. An app whose code picks the tool itself
    // (a classifier answers {"intent":"order"} and the code calls queryOrder) never names one on the
    // wire, so the function is wrapped where it is defined: each call writes its name, its clipped
    // arguments and what it returned, on the turn it ran in. The run writes the list beside the rules
    // and the command keeps the last one, so an app started again has it before its code loads.
    const TOOLS_FILE = process.env.CORTAD_TOOLS_FILE;
    const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
    const IDENT = /^[A-Za-z_$][\w$]*$/;
    let targets = [], targetsAt = -1;
    const targetsNow = () => {
      if (!TOOLS_FILE) return targets;
      try {
        const at = fs.statSync(TOOLS_FILE).mtimeMs;
        if (at !== targetsAt) {
          targetsAt = at;
          const raw = JSON.parse(fs.readFileSync(TOOLS_FILE, "utf8"));
          targets = list(raw).filter((t) => typeof t.name === "string" && t.name && typeof t.file === "string" && CODE_FILE.test(t.file) && IDENT.test(String(t.function)) && !(t.function in globalThis))
            .map((t) => ({ name: t.name.slice(0, 80), file: t.file.replace(/^\.?\/+/, ""), fn: t.function }))
            // One function named twice (by its own name, and as "queryOrder (fallback)" where a
            // router imported it) is recorded under its own name.
            .sort((a, b) => (a.name !== a.fn) - (b.name !== b.fn));
        }
      } catch { /* not written yet */ }
      return targets;
    };
    const targetsIn = (path) => targetsNow().filter((t) => path === t.file || path.endsWith("/" + t.file));
    const unsaid = new Set();
    const unwatched = (t, why) => {
      const key = `${t.file}#${t.fn}`;
      if (unsaid.has(key)) return;
      unsaid.add(key);
      try { process.stderr.write(`cortad: calls to ${t.name} in ${t.file} are not recorded: ${why}.\n`); } catch { /* no stderr */ }
    };
    // What a value is, as JSON can say it: a class instance (a client, a model) by its name only.
    const plainOf = (v, depth = 0) => {
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) return v;
      if (typeof v === "bigint") return String(v);
      if (typeof v !== "object" || depth > 4) return v === undefined ? null : `[${typeof v}]`;
      if (Array.isArray(v)) return v.slice(0, 20).map((x) => plainOf(x, depth + 1));
      if (typeof v.toJSON === "function") { try { return plainOf(v.toJSON(), depth + 1); } catch { return "[object]"; } }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return `[${(v.constructor && v.constructor.name) || "object"}]`;
      return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, plainOf(x, depth + 1)]));
    };
    // The returned value's shape and a clipped text: a string as it is, anything else named by kind.
    const returned = (v) => {
      if (v === undefined || v === null) return "returned nothing";
      if (typeof v === "string") return v;
      const p = clipped(plainOf(v), 0, TOOL_TEXT);
      const kind = Array.isArray(v) ? `list of ${v.length}` : typeof v === "object" ? "object" : "value";
      return `${kind}: ${JSON.stringify(p)}`;
    };
    const paramNames = (fn) => {
      let src = "";
      try { src = Function.prototype.toString.call(fn); } catch { return []; }
      const m = /^[^(=]*\(([^)]*)\)/.exec(src) || /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(src);
      if (!m || /[{[(]/.test(m[1])) return [];
      return m[1].split(",").map((p) => p.replace(/=[\s\S]*$/, "").replace(/^\s*\.\.\./, "").replace(/:[\s\S]*$/, "").trim());
    };
    const toolRow = (name, names, args, value, error, ctx) => {
      const turn = ctx && ctx.turn;
      const named = {};
      args.forEach((a, i) => { named[IDENT.test(names[i] || "") ? names[i] : String(i)] = plainOf(a); });
      let text;
      try { text = error ? `raised ${(error && error.name) || "an error"}: ${(error && error.message) || String(error)}` : returned(value); } catch { text = "returned a value this hook cannot read"; }
      row({ dep: { at: Date.now(), host: "in-app", status: 200, ...(ctx ? { ex: ctx.id } : {}), ...(turn ? { turn } : {}), called: [{ name, arguments: argsText(named) }], tools: [{ name, text: String(text).slice(0, TOOL_TEXT) }] } });
    };
    const TOOL = Symbol.for("cortad.wrapped");
    const wrappers = new WeakMap();
    const wrapTool = (fn, name) => {
      if (typeof fn !== "function" || fn[TOOL]) return fn;
      if (wrappers.has(fn)) return wrappers.get(fn);
      try { if (/^class\b/.test(Function.prototype.toString.call(fn))) return fn; } catch { return fn; }
      const names = paramNames(fn);
      const w = function (...args) {
        const ctx = als.getStore();
        let out;
        try { out = new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args); }
        catch (e) { toolRow(name, names, args, undefined, e, ctx); throw e; }
        // A promise is followed, and the one handed back is a new one, so a rejection nobody
        // handles still reaches the app as unhandled.
        if (out instanceof Promise) return out.then((v) => { toolRow(name, names, args, v, undefined, ctx); return v; }, (e) => { toolRow(name, names, args, undefined, e, ctx); throw e; });
        toolRow(name, names, args, out, undefined, ctx);
        return out;
      };
      try {
        Object.defineProperty(w, "name", { value: fn.name });
        Object.defineProperty(w, "length", { value: fn.length });
        Object.setPrototypeOf(w, Object.getPrototypeOf(fn));
        if (fn.prototype) w.prototype = fn.prototype;
        for (const k of Object.keys(fn)) w[k] = fn[k];
      } catch { /* the wrapper still calls through */ }
      w[TOOL] = fn;
      wrappers.set(fn, w);
      return w;
    };
    // Called from the lines added to the end of a tool's file: the function by its own binding
    // (an ES module's importers follow that binding) and by its CommonJS export.
    const take = (fn, set, mod, t) => {
      let done = false;
      if (typeof fn === "function") { try { set(wrapTool(fn, t.name)); done = true; } catch { /* a binding that cannot change */ } }
      const ex = mod && mod.exports;
      if (ex && (typeof ex === "object" || typeof ex === "function") && typeof ex[t.fn] === "function") { try { ex[t.fn] = wrapTool(ex[t.fn], t.name); done = true; } catch { /* read-only */ } }
      if (!done) unwatched(t, fn === undefined && !(ex && t.fn in ex) ? `the file has no function named ${t.fn}` : `${t.fn} there is not a function this hook can wrap`);
    };
    Object.defineProperty(globalThis, Symbol.for("cortad.tool"), { value: take, configurable: true });
    const trailer = (text, mine) => {
      let src = text;
      // A const binding cannot be changed from inside the file; a let can, and nothing else differs.
      for (const t of mine) src = src.replace(new RegExp(`(^|\\n)([ \\t]*(?:export[ \\t]+)?)const([ \\t]+${t.fn.replace(/\$/g, "\\$")}[ \\t]*[=:])`), "$1$2let$3");
      const hook = 'globalThis[Symbol.for("cortad.tool")]';
      return `${src}\n;${mine.map((t) => `try{${hook}(typeof ${t.fn}==="undefined"?undefined:${t.fn},(f)=>{${t.fn}=f},typeof module==="object"&&module?module:undefined,${JSON.stringify(t)})}catch{}`).join("")}\n`;
    };
    // Loading: a tool's file gets the lines above before it runs. Every other file is untouched.
    const seenFiles = new Set();
    const loadedFiles = new Set();
    const { fileURLToPath } = require("node:url");
    if (TOOLS_FILE && typeof Module.registerHooks === "function") {
      try {
        Module.registerHooks({
          load(url, context, nextLoad) {
            const out = nextLoad(url, context);
            try {
              if (typeof url !== "string" || !url.startsWith("file:") || url.includes("/node_modules/")) return out;
              const path = fileURLToPath(url);
              loadedFiles.add(path);
              const mine = targetsIn(path);
              if (!mine.length || out.source == null) return out;
              seenFiles.add(path);
              return { ...out, source: trailer(typeof out.source === "string" ? out.source : Buffer.from(out.source).toString("utf8"), mine) };
            } catch { return out; }
          },
        });
      } catch { /* this runtime has no module hooks */ }
    }
    // A list that arrives after the app loaded its tools: a CommonJS export is wrapped in place, which
    // reaches code that calls it through the module, but a function already taken by name cannot be
    // reached, so it is said once in the app's log. The command keeps the list for the next start.
    let sweptAt = -1;
    const sweepTools = () => {
      if (!TOOLS_FILE) return;
      const now = targetsNow();
      if (targetsAt === sweptAt) return;
      sweptAt = targetsAt;
      const cache = require.cache || {};
      for (const t of now) {
        const mine = (k) => (k === t.file || k.endsWith("/" + t.file)) && !k.includes("/node_modules/");
        const path = Object.keys(cache).find(mine) || [...loadedFiles].find(mine);
        if (!path || seenFiles.has(path)) continue;
        const ex = cache[path] && cache[path].exports;
        if (ex && typeof ex[t.fn] === "function") { try { ex[t.fn] = wrapTool(ex[t.fn], t.name); } catch { /* read-only */ } }
        unwatched(t, "the file was loaded before the list of tools arrived, and they are recorded from the app's next start");
      }
    };

    // A fetched body read to its end, or to where it broke off. Aborting the call (the client that
    // asked went away, or the framework ended the request once its own reply was sent) errors this
    // copy too, and what the model had said by then is still what it said.
    const readAll = async (res) => {
      const parts = [];
      let size = 0;
      try {
        const reader = res.body && res.body.getReader();
        for (let r = reader && await reader.read(); r && !r.done; r = await reader.read()) {
          if (size < REPLY_MAX) { parts.push(Buffer.from(r.value)); size += r.value.length; }
        }
      } catch { /* broken off: what arrived stands */ }
      return Buffer.concat(parts).toString("utf8");
    };

    // Every server the app opens a connection to, once each, by host and port only: a database named
    // in a config file rather than in the environment is seen the first time the app reaches it.
    // HTTP clients connect through here too; the command names only the ports stores listen on.
    const net = require("node:net");
    const connected = new Set();
    const socketConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      try {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const o = first && typeof first === "object" ? first : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
        const port = Number(o.port);
        if (!o.path && Number.isInteger(port) && port > 0 && port !== heldPort && connected.size < 64) {
          const host = String(o.host || "localhost").toLowerCase().slice(0, 253);
          if (!connected.has(`${host}:${port}`)) { connected.add(`${host}:${port}`); row({ conn: { host, port } }); }
        }
      } catch { /* the connection goes on unrecorded */ }
      return socketConnect.apply(this, args);
    };

    // Outbound writes a trial makes are held in the app, never sent: a trial that books, charges,
    // emails or deletes would otherwise do it for real. Held: a call made inside a request the run
    // tagged, with a writing method, to a host that is not a model, a retrieval, this machine, a copy
    // of ours or a host the person said yes to. A call carrying a provider's test key goes to that
    // provider's own sandbox as sent. The app is answered with a success shaped like what it sent,
    // and the run is told by a dep row with `held` and the clipped call.
    const OUTBOUND = process.env.CORTAD_OUTBOUND_FILE;
    let passed = [], passedAt = -1;
    const passNow = () => {
      try {
        const at = fs.statSync(OUTBOUND).mtimeMs;
        if (at !== passedAt) { passedAt = at; const got = JSON.parse(fs.readFileSync(OUTBOUND, "utf8")); passed = Array.isArray(got.pass) ? got.pass.filter((h) => typeof h === "string" && h) : []; }
      } catch { /* not written yet: nothing passes */ }
      return passed;
    };
    const WRITES = /^(?:POST|PUT|PATCH|DELETE)$/;
    const THIS_MACHINE = /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$/i;
    // ponytail: a sign-in's token refresh is a POST that changes nothing, told apart by its path only.
    const TOKEN_PATH = /\/(?:oauth2?\/)?token(?:[/?]|$)/i;
    // A provider's test-mode key (Stripe's sk_test_), or a value of a setting the app keeps as a test one.
    const testKey = (auth) => Boolean(auth) && (/\b[a-z]{2}_test_\w/.test(auth)
      || Object.entries(process.env).some(([k, v]) => /(?:^|_)TEST(?:_|$)/i.test(k) && v && v.length >= 8 && auth.includes(v)));
    const authText = (value) => { const a = String(value || ""); const m = /^Basic\s+(\S+)$/i.exec(a); return m ? Buffer.from(m[1], "base64").toString("utf8") : a; };
    // Neon's HTTP driver sends every query, reads too, to its region's API host and names the
    // database in a header: the call is decided on that database's host. No header: the API host.
    const NEON_SQL = /^api(?:auth)?\.[a-z0-9.-]+\.neon\.tech$/;
    const targetOf = (u, headerOf) => {
      const host = u.hostname.toLowerCase();
      if (!NEON_SQL.test(host) || u.pathname !== "/sql") return host;
      try { return new URL(headerOf("neon-connection-string")).hostname.toLowerCase() || host; } catch { return host; }
    };
    // `headerOf(name)`: one of the call's headers, read only for a call that is otherwise held. Once a
    // tagged write is being decided, a failure to decide holds it.
    const heldHere = (u, method, headerOf) => {
      const ctx = als.getStore();
      if (!ctx || !ctx.turn || !WRITES.test(method)) return false;
      try {
        const host = targetOf(u, headerOf);
        if (THIS_MACHINE.test(host) || isModelCall(u.host, u.pathname) || isRetrieval(u) || TOKEN_PATH.test(u.pathname) || testKey(authText(headerOf("authorization")))) return false;
        return !passNow().some((p) => host === p || host.endsWith("." + p));
      } catch { return true; }
    };
    // A GraphQL query reads; a mutation writes. A `query` that is not GraphQL (Neon's SQL) is held.
    const readsOnly = (text) => { try { const q = JSON.parse(text)?.query; return typeof q === "string" && /^\s*(?:\{|query\b|fragment\b)/.test(q) && !/\bmutation\b/.test(q); } catch { return false; } };
    let heldCount = 0;
    const fieldsOf = (text, type) => {
      try { const b = /form/i.test(type || "") ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { return {}; }
    };
    const heldReply = (text, type) => JSON.stringify({ ...fieldsOf(text, type), id: `cortad-held-${++heldCount}`, status: "ok" });
    // Named by method and host only: a webhook's path is its credential.
    const heldRow = (u, method, text, type, ctx) => row({ dep: { at: Date.now(), host: u.hostname, status: 200, held: true, ...(ctx ? { ex: ctx.id, turn: ctx.turn } : {}), called: [{ name: `${method} ${u.hostname}`.slice(0, 80), arguments: argsText(fieldsOf(text, type)) }] } });
    // http.request hands back a request before its body is written, so a held one is sent to a server
    // of this hook's own on this machine, which answers it. Started at the first tagged request.
    const HELD = Symbol("cortad.held");
    const heldWaiting = new Map();
    let heldPort = null, heldStarted = false, heldSent = 0;
    function heldWarm() {
      if (heldStarted) return;
      heldStarted = true;
      try {
        const server = http.createServer((req, res) => {
          const parts = [];
          req.on("data", (c) => { if (parts.length < 256) parts.push(c); });
          req.on("end", () => {
            const id = String(req.headers["x-cortad-held"] || "");
            const w = heldWaiting.get(id);
            heldWaiting.delete(id);
            const text = Buffer.concat(parts).toString("utf8").slice(0, MAX);
            if (w) heldRow(w.u, w.method, text, req.headers["content-type"], w.ctx);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(heldReply(text, req.headers["content-type"]));
          });
        });
        server[HELD] = true;
        server.listen(0, "127.0.0.1", () => { heldPort = server.address().port; });
        server.unref();
      } catch { /* no server: a held write fails to connect instead of leaving */ }
    }
    const headerIn = (headers, name) => {
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "";
      const k = Object.keys(headers).find((n) => n.toLowerCase() === name);
      return k ? String(headers[k]) : "";
    };
    // The call http.request was asked for, when it is one to hold.
    const heldCall = (args, secure) => {
      const first = args[0];
      const given = typeof first === "string" || first instanceof URL ? new URL(String(first)) : null;
      const o = (given ? (args[1] && typeof args[1] === "object" ? args[1] : {}) : first) || {};
      const host = String(o.hostname || (o.host && String(o.host).replace(/:\d+$/, "")) || (given && given.hostname) || "localhost");
      const path = String(o.path || (given ? given.pathname + given.search : "/"));
      const method = String(o.method || "GET").toUpperCase();
      const u = new URL(`${secure ? "https" : "http"}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${path.startsWith("/") ? path : "/" + path}`);
      const headerOf = (name) => headerIn(o.headers, name) || (name === "authorization" && o.auth ? `Basic ${Buffer.from(String(o.auth)).toString("base64")}` : "");
      return heldHere(u, method, headerOf) ? { u, method, o, cb: args.find((a) => typeof a === "function") } : null;
    };
    const httpRequest = http.request;
    const sendHeld = ({ u, method, o, cb }, secure) => {
      const id = String(++heldSent);
      heldWaiting.set(id, { u, method, ctx: als.getStore() });
      const headers = { ...(o.headers && typeof o.headers === "object" && !Array.isArray(o.headers) ? o.headers : {}), "x-cortad-held": id };
      // Port 1 answers nothing: a write held before the server listens fails instead of leaving.
      const req = httpRequest({ host: "127.0.0.1", port: heldPort || 1, method, path: u.pathname + u.search, headers, ...(o.timeout ? { timeout: o.timeout } : {}), ...(o.signal ? { signal: o.signal } : {}) }, cb);
      // A TLS client waits for the handshake before it writes (Stripe's does).
      if (secure) req.once("socket", (socket) => socket.once("connect", () => socket.emit("secureConnect")));
      return req;
    };
    const heldFetch = async (realFetch, input, init) => {
      const req = new Request(input, init);
      const text = await req.clone().text().catch(() => "");
      if (readsOnly(text)) return realFetch(req);
      const u = new URL(req.url);
      heldRow(u, req.method, text, req.headers.get("content-type"), als.getStore());
      return new Response(heldReply(text, req.headers.get("content-type")), { status: 200, headers: { "content-type": "application/json" } });
    };

    // Outbound: the model call your app makes while it handles that request.
    const bodyText = (body) => (typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "");
    if (typeof globalThis.fetch === "function") {
      const realFetch = globalThis.fetch;
      globalThis.fetch = function (input, init) {
        let url = null;
        let hold = false;
        try {
          const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
          if (isModelCall(u.host, u.pathname)) url = u;
          const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
          hold = !url && heldHere(u, method, (name) => new Headers((init && init.headers) || (input && input.headers) || undefined).get(name));
        } catch { /* not a URL we can read */ }
        if (hold) return heldFetch(realFetch, input, init);
        if (!url) {
          // Every outbound host, named by the setting that points at it when one does, and by the
          // host alone otherwise: the search provider behind TAVILY_API_KEY has no URL setting.
          let dep = depOf(input);
          let retrieval = false;
          try {
            const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
            // A store on this machine (a local Qdrant or Chroma) is still where the passages came from.
            retrieval = /^https?:$/.test(u.protocol) && isRetrieval(u);
            if (!dep && /^https?:$/.test(u.protocol) && (retrieval || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) dep = { host: u.hostname };
          } catch { /* not a URL */ }
          if (!dep) return realFetch.apply(this, arguments);
          const asked = { ctx: als.getStore(), retrieval, caller: retrieval ? callers() : undefined };
          return realFetch.apply(this, arguments).then(
            (res) => {
              if (!retrieval) { depRow(dep, res.status, asked); return res; }
              try { res.clone().text().then((t) => depRow(dep, res.status, { ...asked, passages: passagesFrom(t) }), () => depRow(dep, res.status, asked)); } catch { depRow(dep, res.status, asked); }
              return res;
            },
            (err) => { depRow(dep, 0, { ...asked, code: err && err.cause && err.cause.code }); throw err; },
          );
        }
        const sent = bodyText(init && init.body);
        const ctx = note(als.getStore(), sent);
        const call = { host: url.host, path: url.pathname, sent, ctx, t0: Date.now(), caller: EMBEDDING.test(url.pathname) ? undefined : callers() };
        return realFetch.apply(this, arguments).then((res) => {
          try {
            // A clone is a tee: your app's branch gets every byte as fast as it reads, this one is read to the end.
            const type = res.headers.get("content-type");
            readAll(res.clone()).then((text) => meter({ ...call, status: res.status, type, body: text }));
          } catch { meter({ ...call, status: res.status, type: "", body: "" }); }
          return res;
        }, (err) => { meter({ ...call, status: 0, type: "", body: "" }); throw err; });
      };
    }
    for (const mod of [http, https]) {
      const request = mod.request;
      mod.request = function (...args) {
        let held = null;
        try { held = heldCall(args, mod === https); } catch { /* not a call we can read: sent as asked */ }
        if (held) return sendHeld(held, mod === https);
        const req = request.apply(this, args);
        try {
          const o = typeof args[0] === "string" || args[0] instanceof URL ? new URL(String(args[0])) : args[0] || {};
          const host = o.host || o.hostname;
          const path = o.pathname ? o.pathname : o.path;
          if (isModelCall(host, path)) {
            const ctx = als.getStore();
            const parts = [];
            let sent = "";
            const write = req.write;
            const end = req.end;
            req.write = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); return write.call(this, chunk, ...r); };
            req.end = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); sent = Buffer.concat(parts).toString("utf8"); call.ctx = note(ctx, sent); return end.call(this, chunk, ...r); };
            const bare = String(path || "").split("?")[0];
            const call = { host: String(host || ""), path: bare, ctx, t0: Date.now(), caller: EMBEDDING.test(bare) ? undefined : callers() };
            let done = false;
            const once = (row) => { if (!done) { done = true; meter({ ...call, sent, ...row }); } };
            req.once("error", () => once({ status: 0, type: "", body: "" }));
            req.once("response", (res) => {
              // The reply's bytes as the parser hands them over, without reading the stream: your
              // app's own listeners and pipes see exactly what they would have.
              const got = [];
              let size = 0;
              const push = res.push;
              res.push = function (chunk, encoding) {
                if (chunk && size < REPLY_MAX) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); got.push(b); size += b.length; }
                return push.call(this, chunk, encoding);
              };
              const finish = () => once({ status: res.statusCode || 0, type: res.headers["content-type"] || "", body: decoded(Buffer.concat(got), res.headers["content-encoding"]) });
              res.once("end", finish);
              res.once("close", finish);
            });
          }
        } catch { /* leave the request alone */ }
        return req;
      };
    }
  } catch { /* an app must never fail to start because of this file */ }
}
