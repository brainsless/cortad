// The services your app reaches on this machine, brought up when nothing answers there and the
// repository says how: a store its compose file runs from an image, with Docker, or a second
// service of its own, with that service's own start. Only a port the app is known to reach is
// brought up: one its settings name when it could not start without it, or one the hook saw it
// reach for. A compose file often lists a store the app is set up not to use, and starting it
// would be a download of gigabytes nobody asked for. Each is stopped when this command ends, and
// one that could not be brought up, or that nothing here brings up, is said before a run, with whose
// side it is on.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join, relative } from "node:path";
import { ledger } from "./ledger.mjs";
import { servicePort } from "./service.mjs";
import { startPlan, workspaces } from "./start.mjs";

// Something accepts a connection on the port: a database answers no HTTP, so this is the test.
export function tcpOpen(host, port, ms = 1500) {
  return new Promise((done) => {
    const s = connect({ host: host && !host.startsWith("/") && host !== "0.0.0.0" ? host.replace(/^\[|\]$/g, "") : "127.0.0.1", port });
    const end = (ok) => { s.destroy(); done(ok); };
    s.setTimeout(ms, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}
async function waitTcp(port, ms, gone = () => false) {
  for (const until = Date.now() + ms; Date.now() < until && !gone(); await new Promise((r) => setTimeout(r, 1000))) if (await tcpOpen("127.0.0.1", port)) return true;
  return false;
}

const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/;
// The files compose reads by default come first: a second file beside them is a variant.
const DEFAULT_FIRST = (a, b) => Number(/^(?:docker-)?compose\.ya?ml$/.test(basename(b))) - Number(/^(?:docker-)?compose\.ya?ml$/.test(basename(a))) || a.localeCompare(b);
export function composeFiles(dirs) {
  const out = new Set();
  for (const dir of dirs) { try { for (const f of readdirSync(dir)) if (COMPOSE_FILE.test(f)) out.add(join(dir, f)); } catch { /* no folder */ } }
  return [...out].sort(DEFAULT_FIRST);
}

const unquote = (v) => String(v ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
// ${PG_PORT:-5432} and ${PG_PORT}, from the settings the app starts with.
const interpolate = (v, values) => v.replace(/\$\{(\w+)(?::?-([^}]*))?\}/g, (_, name, dflt) => values[name] || dflt || "");
// The host port of one port mapping: "5432:5432", "127.0.0.1:5432:5432/tcp". None for a container
// port alone (compose picks the host's) or a range.
function published(entry, values) {
  const parts = interpolate(unquote(entry), values).replace(/\/(?:tcp|udp)$/, "").split(":");
  const host = parts.length >= 2 ? parts[parts.length - 2] : "";
  return /^\d+$/.test(host) ? Number(host) : null;
}

// The services a compose file declares: name, whether it runs an image or builds this repository's
// code, and the host ports it publishes. A reader of the shape compose files are written in, not of
// YAML at large.
// ponytail: no anchors, extends, include or profiles; add them when a repository needs one to be read.
export function composeServices(text, values = {}) {
  const out = [];
  let inServices = false, nameIndent = -1, keyIndent = -1, svc = null, portsIndent = -1;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\t/g, "  ").replace(/\s+#.*$/, "");
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) { inServices = /^services:\s*$/.test(t); svc = null; continue; }
    if (!inServices) continue;
    if (nameIndent < 0) nameIndent = indent;
    if (indent <= nameIndent) {
      const m = /^["']?([\w.-]+)["']?:\s*$/.exec(t);
      svc = indent === nameIndent && m ? { name: m[1], image: null, build: false, ports: [] } : null;
      if (svc) out.push(svc);
      keyIndent = -1; portsIndent = -1;
      continue;
    }
    if (!svc) continue;
    if (portsIndent >= 0 && indent > portsIndent) {
      const item = /^-\s*(.*)$/.exec(t);
      const port = item && !/^[A-Za-z_]\w*:(?:\s|$)/.test(item[1]) ? published(item[1], values) : Number(unquote(/^(?:-\s*)?published:\s*(.+)$/.exec(t)?.[1] ?? "")) || null;
      if (port) svc.ports.push(port);
      continue;
    }
    portsIndent = -1;
    if (keyIndent < 0) keyIndent = indent;
    if (indent !== keyIndent) continue;
    const kv = /^([\w-]+):\s*(.*)$/.exec(t);
    if (!kv) continue;
    if (kv[1] === "image") svc.image = unquote(kv[2]);
    else if (kv[1] === "build") svc.build = true;
    else if (kv[1] === "ports") {
      if (kv[2].startsWith("[")) for (const e of kv[2].replace(/^\[|\]$/g, "").split(",")) { const p = published(e, values); if (p) svc.ports.push(p); }
      else portsIndent = indent;
    }
  }
  return out;
}

// A setting that is an address a page is opened from, not a service the app calls.
const PAGE = /(?:^|_)(?:ORIGINS?|FRONTEND|CLIENT|SITE|WEB|CALLBACK|REDIRECT|CORS|ALLOWED|HOMEPAGE)(?:_|$)/;
// Addresses on this machine the app's settings point at: http://localhost:4000/api under API_URL.
export function localAddresses(values) {
  const byPort = new Map();
  for (const [name, raw] of Object.entries(values)) {
    if (PAGE.test(name)) continue;
    let u;
    try { u = new URL(String(raw ?? "").trim()); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !u.port || !/^(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname)) continue;
    const port = Number(u.port);
    byPort.set(port, [...(byPort.get(port) ?? []), name]);
  }
  return [...byPort].map(([port, names]) => ({ port, names }));
}

const run = (bin, args, opts = {}) => new Promise((done) => {
  execFile(bin, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => done({ ok: !err, out: String(stdout ?? ""), err: String(stderr ?? err?.message ?? "") }));
});
// A service's own last words go into a sentence that leaves this machine: an address's password never does.
const lastLine = (text) => String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[masked]@").split("\n").map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 160) ?? "";

// How compose is run here: the docker plugin, the older standalone binary, or not at all and why.
async function composeCommand(onPath) {
  if (!onPath("docker") && !onPath("docker-compose")) return { why: "Docker is not installed on this machine" };
  if (!(await run("docker", ["info"], { timeout: 15_000 })).ok) return { why: "Docker is not running on this machine" };
  if ((await run("docker", ["compose", "version"], { timeout: 15_000 })).ok) return { bin: "docker", pre: ["compose"] };
  return onPath("docker-compose") ? { bin: "docker-compose", pre: [] } : { why: "Docker here has no compose command" };
}

const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Why a port is wanted: a setting names it, or the app was seen reaching for it.
const pointer = (w) => (!w.names?.length ? "Your app reached for"
  : w.names.length === 1 ? `${w.names[0]} points at` : `${w.names[0]} and ${w.names.length - 1} more setting${w.names.length > 2 ? "s" : ""} point at`);
const said = {
  up: (what, how, w) => `Started ${what} ${how}: ${pointer(w)} port ${w.port} on this machine and nothing answered there. It is stopped when this command ends.`,
  theirs: (what, why, w) => `${pointer(w)} port ${w.port} on this machine and nothing answers there. ${upper(what)} would start it, but ${why}: start it yourself before a run. This is on your side.`,
  exited: (what, tail, w) => `${pointer(w)} port ${w.port} on this machine, which ${what} serves, and it stopped before it answered: ${tail}. This is on your side.`,
  none: (w) => `${pointer(w)} port ${w.port} on this machine and nothing answers there, and nothing in this repository starts it: start it yourself before a run. This is on your side.`,
  slow: (what, secs, w) => `${pointer(w)} port ${w.port} on this machine; ${what} was started for it, but nothing answered there within ${secs} seconds. This is on our side.`,
};

// One session's services. up(wants) brings up each wanted port it can, where nothing answers: a
// compose store first, else a workspace of this repository that serves it. `launch` starts a
// workspace the way the app is started and hands back its process. Answers what it said and the
// ports that now answer.
export function makeBacking({ root, appDir, values, onPath, ledgerFile, launch, adopt = true, storeWaitMs = 120_000, serviceWaitMs = 90_000 }) {
  const book = ledger(ledgerFile);
  const started = [];
  const tried = new Set();
  let compose = null;
  const files = composeFiles([...new Set([appDir, root])]).map((file) => ({ file, services: (() => { try { return composeServices(readFileSync(file, "utf8"), values); } catch { return []; } })() }));
  // Services a session that died left running are stopped by the next session that starts the app,
  // never removed: the person may have used them since, and a removed container takes what they put
  // in it. A session attached to an app already running leaves them to that app.
  for (const row of adopt ? book.orphans("service") : []) {
    const [file, service] = row.key.split("#");
    if (!existsSync(file)) continue;
    const kept = { ...row, made: "stop" };
    book.remove(row);
    book.add(kept);
    started.push({ file, service, row: kept });
  }

  async function fromCompose(found, w) {
    const where = `the ${found.service} service in ${relative(root, found.file) || basename(found.file)}`;
    compose ??= await composeCommand(onPath);
    if (compose.why) return said.theirs(where, compose.why, w);
    const opts = { cwd: dirname(found.file), env: { ...process.env } };
    const args = (...a) => [...compose.pre, "-f", found.file, ...a];
    const existed = Boolean((await run(compose.bin, args("ps", "-a", "-q", found.service), opts)).out.trim());
    const up = await run(compose.bin, args("up", "-d", found.service), opts);
    if (!up.ok) return said.theirs(where, `Docker could not start it: ${lastLine(up.err)}`, w);
    const row = { kind: "service", key: `${found.file}#${found.service}`, made: existed ? "stop" : "remove" };
    book.add(row);
    started.push({ file: found.file, service: found.service, row });
    if (!(await waitTcp(w.port, storeWaitMs))) return said.slow(where, Math.round(storeWaitMs / 1000), w);
    return said.up(where, "with Docker", w);
  }

  async function fromWorkspace(dir, w) {
    const plan = startPlan({ root: dir, onPath });
    if (!plan?.cmd) return null;
    const what = relative(root, dir) || basename(dir);
    const kid = launch(plan);
    let exited = null;
    let tail = "";
    kid.on("exit", (code) => { exited = code ?? 1; });
    const keep = (d) => { tail = (tail + d).slice(-2000); };
    kid.stdout?.on("data", keep);
    kid.stderr?.on("data", keep);
    if (await waitTcp(w.port, serviceWaitMs, () => exited !== null)) return said.up(what, `with ${plan.cmd}`, w);
    if (exited !== null) return said.exited(what, lastLine(tail) || `it exited ${exited}`, w);
    return said.slow(what, Math.round(serviceWaitMs / 1000), w);
  }

  return {
    // wants: [{ port, names, store }], each a port on this machine the app reaches or its settings
    // name; `store` lets a compose image serve it. Answers what was said and the ports brought up.
    async up(wants) {
      const lines = [];
      const ports = [];
      for (const w of wants) {
        if (tried.has(w.port) || (await tcpOpen("127.0.0.1", w.port))) continue;
        const image = w.store ? files.flatMap(({ file, services }) => services.filter((x) => x.image && !x.build && x.ports.includes(w.port)).map((x) => ({ file, service: x.name })))[0] : null;
        const dir = image ? null : workspaces(root).find((d) => d !== appDir && servicePort(d) === w.port);
        // A port only seen reached, and not a store's, may be a passing connection of the app's own.
        if (!image && !dir && !w.names?.length && !w.store) continue;
        tried.add(w.port);
        if (!image && !dir) { lines.push(said.none(w)); continue; }
        const line = image ? await fromCompose(image, w) : await fromWorkspace(dir, w);
        if (line) lines.push(line);
        if (await tcpOpen("127.0.0.1", w.port)) ports.push(w.port);
      }
      return { lines, ports };
    },
    // Compose services only: a workspace's process is the caller's, stopped with the app.
    async stop() {
      compose ??= started.length ? await composeCommand(onPath) : null;
      if (!compose || compose.why) return;
      for (const { file, service, row } of started.splice(0)) {
        const how = row.made === "stop" ? ["stop", service] : ["rm", "-s", "-f", service];
        if ((await run(compose.bin, [...compose.pre, "-f", file, ...how], { cwd: dirname(file), env: { ...process.env } })).ok) book.remove(row);
      }
    },
  };
}
