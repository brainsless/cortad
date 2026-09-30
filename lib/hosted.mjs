// A store the app's settings name on a server off this machine. Trials write for real, so a run
// never writes into one without the person's yes: the app is pointed at a copy made where the
// store's maker makes one (a Neon branch, a local Supabase started from the repository's own
// config), or at an empty database on this machine built by the app's own migrations. keep()
// answers { env, pass, how } or { why } with every reason no copy could be made, most useful first.
// Nothing here copies a row out of the hosted store.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { applySql, dropPg, emptyPg } from "./pg.mjs";

const NEON_API = "https://console.neon.tech/api/v2";
const NEON_HOST = /\.neon\.tech$/i;
// The endpoint a Neon host serves, pooled or not: ep-cool-darkness-123456(-pooler).region.aws.neon.tech.
const ENDPOINT = /^(ep-[a-z0-9-]+?)(?:-pooler)?\./i;
const SUPABASE_HOST = /\.supabase\.(?:co|in|com)$/i;
const READY_MS = 90_000;
const MIGRATE_MS = 180_000;
const PROJECTS_MAX = 100;

// A command of the repository's own, with the settings the app starts with. Never a shell.
export function runCmd(bin, args, { cwd, env = process.env, timeout = 60_000 } = {}) {
  return new Promise((done) => {
    let out = "";
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => { out = (out + d).slice(-20_000); });
    child.stderr.on("data", () => {});
    child.on("error", () => { clearTimeout(timer); done({ ok: false, out }); });
    child.on("close", (code) => { clearTimeout(timer); done({ ok: code === 0, out }); });
  });
}

const settingWith = (values, text) => Object.keys(values).filter((k) => String(values[k] ?? "").includes(text));
const swapped = (values, names, from, to) => Object.fromEntries(names.map((k) => [k, String(values[k]).split(from).join(to)]));

function neonApi(key, fetchFn) {
  return async (method, path, body) => {
    const res = await fetchFn(`${NEON_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`neon answered ${res.status}`);
    return res.status === 204 ? {} : res.json();
  };
}

// The project and branch behind an endpoint: the API has no lookup by endpoint, so each project is asked.
async function neonParent(api, endpoint) {
  let cursor = "";
  for (let seen = 0; seen < PROJECTS_MAX;) {
    const page = await api("GET", `/projects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const projects = page.projects ?? [];
    for (const p of projects) {
      const { endpoints = [] } = await api("GET", `/projects/${encodeURIComponent(p.id)}/endpoints`);
      const at = endpoints.find((e) => e.id === endpoint);
      if (at) return { project: p.id, branch: at.branch_id };
    }
    seen += projects.length;
    cursor = page.pagination?.cursor ?? "";
    if (!projects.length || !cursor) break;
  }
  return null;
}

async function settled(api, project, branch) {
  for (const until = Date.now() + READY_MS; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
    const got = await api("GET", `/projects/${project}/branches/${branch}`);
    if (got.branch?.current_state === "ready") return true;
  }
  return false;
}

// How the app's schema is built where it has none yet, by the tool the repository already uses.
const venvBin = (dir, bin) => ["venv", ".venv"].map((v) => join(dir, v, "bin", bin)).find(existsSync) ?? bin;
const MIGRATORS = [
  { tool: "Prisma", finds: (d) => existsSync(join(d, "prisma", "schema.prisma")),
    cmd: (d) => ["npx", existsSync(join(d, "prisma", "migrations")) ? ["--no-install", "prisma", "migrate", "deploy"] : ["--no-install", "prisma", "db", "push", "--skip-generate"]] },
  { tool: "Drizzle", finds: (d) => ["ts", "js", "mjs", "cjs", "json"].some((x) => existsSync(join(d, `drizzle.config.${x}`))), cmd: () => ["npx", ["--no-install", "drizzle-kit", "push", "--force"]] },
  { tool: "Alembic", finds: (d) => existsSync(join(d, "alembic.ini")), cmd: (d) => [venvBin(d, "alembic"), ["upgrade", "head"]] },
  { tool: "Django", finds: (d) => existsSync(join(d, "manage.py")), cmd: (d) => [venvBin(d, "python3"), ["manage.py", "migrate", "--noinput"]] },
  { tool: "Supabase", finds: (d) => existsSync(join(d, "supabase", "migrations")), files: (d) => readdirSync(join(d, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => join(d, "supabase", "migrations", f)) },
];

// `values`: every setting the app starts with. `dirs`: the app's folder, then the repository's.
// `local`: the Postgres on this machine a stand-in is made on. `book`: the ledger, so what a session
// that died made is undone by the next one.
export function hostedKeeper({ values, dirs, book, fetchFn = globalThis.fetch, run = runCmd, local = null }) {
  const made = [];
  const neonKey = String(values.NEON_API_KEY ?? "").trim();
  const api = neonKey ? neonApi(neonKey, fetchFn) : null;
  const here = local ?? { host: "localhost", port: 5432, user: process.env.PGUSER || userInfo().username, password: process.env.PGPASSWORD ?? "" };
  let supabase = null;

  const undo = {
    branch: async (row) => { if (!api) return false; await api("DELETE", `/projects/${row.made}`); return true; },
    shadow: (row) => dropPg(here, row.made),
    supabase: async (row) => (await run("supabase", ["stop", "--no-backup"], { cwd: row.made, timeout: 120_000 })).ok,
  };
  const undone = async (row) => { if (await undo[row.kind](row).catch(() => false)) book.remove(row); };

  async function neon(s) {
    const endpoint = ENDPOINT.exec(s.host)?.[1];
    const parent = endpoint && (await neonParent(api, endpoint));
    if (!parent) return null;
    const got = await api("POST", `/projects/${parent.project}/branches`, { branch: { parent_id: parent.branch, name: `cortad-${process.pid}-${Date.now()}` }, endpoints: [{ type: "read_write" }] });
    const branch = got.branch?.id;
    const host = got.endpoints?.[0]?.host ?? "";
    const fresh = ENDPOINT.exec(host)?.[1];
    if (!branch) return null;
    const row = { kind: "branch", key: s.key, made: `${parent.project}/branches/${branch}` };
    book.add(row);
    made.push(row);
    if (!fresh || !(await settled(api, parent.project, branch))) return null;
    // Every setting naming the endpoint, pooled or direct, names the branch's: roles and passwords come with it.
    return { how: "neon", env: swapped(values, settingWith(values, endpoint), endpoint, fresh), pass: [host, host.replace(fresh, `${fresh}-pooler`)] };
  }

  // One local Supabase per session, whichever store asks first; stopped at the end only when started here.
  async function localSupabase() {
    const dir = dirs.find((d) => existsSync(join(d, "supabase", "config.toml")));
    if (!dir || !(await run("supabase", ["--version"], { timeout: 15_000 })).ok || !(await run("docker", ["info"], { timeout: 15_000 })).ok) return null;
    let status = await run("supabase", ["status", "-o", "env"], { cwd: dir, timeout: 30_000 });
    let started = false;
    if (!status.ok) {
      const row = { kind: "supabase", key: dir, made: dir };
      book.add(row);
      made.push(row);
      started = true;
      if (!(await run("supabase", ["start"], { cwd: dir, timeout: 600_000 })).ok) return null;
      status = await run("supabase", ["status", "-o", "env"], { cwd: dir, timeout: 30_000 });
      if (!status.ok) return null;
    }
    const vars = Object.fromEntries(status.out.split("\n").map((l) => /^([A-Z_]+)="?([^"]*)"?$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
    return vars.API_URL ? { vars, started } : null;
  }
  async function supabaseCopy(s) {
    const got = await (supabase ??= localSupabase().catch(() => null));
    if (!got) return null;
    const { vars } = got;
    const env = {};
    if (s.engine === "postgres") for (const n of s.names) if (/:\/\//.test(values[n] ?? "")) env[n] = vars.DB_URL;
    if (s.engine === "supabase") {
      for (const n of s.names) env[n] = vars.API_URL;
      for (const k of Object.keys(values).filter((k) => /SUPABASE/i.test(k))) {
        const v = /ANON|PUBLISHABLE/i.test(k) ? vars.ANON_KEY ?? vars.PUBLISHABLE_KEY : /SERVICE_ROLE|SECRET_KEY/i.test(k) ? vars.SERVICE_ROLE_KEY ?? vars.SECRET_KEY : /JWT_SECRET/i.test(k) ? vars.JWT_SECRET : undefined;
        if (v) env[k] = v;
      }
    }
    return Object.values(env).every(Boolean) && Object.keys(env).length ? { how: "supabase", env, pass: [], started: got.started } : null;
  }

  // An empty database on this machine, built by the app's own migrations. Only settings that are
  // whole addresses can be pointed at it.
  async function shadow(s) {
    const urls = s.names.filter((n) => /^[a-z][\w+.-]*:\/\//i.test(String(values[n] ?? "")));
    if (!urls.length || urls.length !== s.names.length) return { why: "parts" };
    const dir = dirs.find((d) => MIGRATORS.some((m) => m.finds(d)));
    const migrator = dir && MIGRATORS.find((m) => m.finds(dir));
    if (!migrator) return { why: "no-migrations" };
    const name = `cortad_shadow_${process.pid}_${Date.now().toString(36)}`;
    const row = { kind: "shadow", key: s.key, made: name };
    book.add(row);
    const got = await emptyPg(here, name);
    if (got.why) { book.remove(row); return { why: got.why === "down" || got.why === "auth" || got.why === "missing" ? "no-local" : "other" }; }
    made.push(row);
    const address = `${encodeURIComponent(here.user)}${here.password ? `:${encodeURIComponent(here.password)}` : ""}@${here.host}:${here.port}/${name}`;
    const env = Object.fromEntries(urls.map((n) => [n, `${/^([a-z][\w+.-]*):\/\//i.exec(values[n])[1]}://${address}`]));
    const ok = migrator.files
      ? await (async () => { for (const f of migrator.files(dir)) if (!(await applySql(here, name, f))) return false; return true; })()
      : (await run(...migrator.cmd(dir), { cwd: dir, env: { ...process.env, ...values, ...env }, timeout: MIGRATE_MS })).ok;
    return ok ? { how: "shadow", tool: migrator.tool, env, pass: [] } : { why: "migrations", tool: migrator.tool };
  }

  return {
    // Copies a session that died left behind.
    orphans: async () => { for (const kind of Object.keys(undo)) for (const row of book.orphans(kind)) await undone(row); },
    async keep(s) {
      const why = [];
      if (NEON_HOST.test(s.host)) {
        if (!api) why.push("neon-key");
        else { const got = await neon(s).catch(() => null); if (got) return got; why.push("neon"); }
      }
      if (SUPABASE_HOST.test(s.host) || s.engine === "supabase") {
        const got = await supabaseCopy(s).catch(() => null);
        if (got) return got;
        why.push("supabase");
      }
      if (s.engine !== "postgres") return { why: [...why, "engine"] };
      const got = await shadow(s).catch(() => ({ why: "other" }));
      return got.env ? got : { why: [...why, got.why], tool: got.tool };
    },
    drop: async () => { for (const row of made.splice(0).reverse()) await undone(row); },
  };
}
