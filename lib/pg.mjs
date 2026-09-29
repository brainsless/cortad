// A Postgres database copied for a session on the server it lives on, with the credentials the
// app's own settings carry, and dropped after. Postgres's own tools do the work (psql, and pg_dump
// when the database is in use); the password reaches them through their environment, never a
// command line another process on this machine can read.
import { spawn } from "node:child_process";

// A database bigger than this is not copied: said instead, so the person decides.
export const PG_CAP = 1024 ** 3;
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;

const envOf = (conn, db) => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  PGDATABASE: db,
  PGCONNECT_TIMEOUT: "10",
  PGAPPNAME: "cortad",
  ...(conn.host ? { PGHOST: conn.host } : {}),
  ...(conn.port ? { PGPORT: String(conn.port) } : {}),
  ...(conn.user ? { PGUSER: conn.user } : {}),
  ...(conn.password ? { PGPASSWORD: conn.password } : {}),
  ...(conn.sslmode ? { PGSSLMODE: conn.sslmode } : {}),
});

function run(bin, args, env, input = null) {
  return new Promise((done) => {
    const child = spawn(bin, args, { env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    if (input) input.pipe(child.stdin);
    child.on("error", (e) => done({ code: e.code === "ENOENT" ? "missing" : 1, out, err: String(e.message) }));
    child.on("close", (code) => done({ code, out, err }));
  });
}

// One statement per -c: CREATE and DROP DATABASE refuse to run inside a transaction, and several
// statements in one string are one.
const psql = (conn, db, ...statements) =>
  run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", ...statements.flatMap((s) => ["-c", s])], envOf(conn, db));

// Why psql refused, as a class the sentence is written from. Never the server's own words: they
// name the user and the host, and the sentence leaves this machine.
export function refusal(err) {
  const code = /(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/.exec(err)?.[1];
  // A refusal while connecting carries no code, only the server's words.
  if (code === "28P01" || code === "28000" || /password authentication failed|no pg_hba\.conf entry|role "[^"]*" does not exist|no password supplied/i.test(err)) return "auth";
  if (code === "42501") return "rights";
  if (code === "55006") return "busy";
  if (code === "3D000" || /database "[^"]*" does not exist/i.test(err)) return "gone";
  if (/server version mismatch|aborting because of server version/i.test(err)) return "version";
  if (/Connection refused|could not connect|No such file or directory|timeout expired|could not translate host/i.test(err)) return "down";
  return "other";
}

// The database to stand in while a copy is made: never the source, which a template copy needs
// free of every connection, ours included.
async function maintenance(conn, source) {
  for (const db of ["postgres", "template1"].filter((d) => d !== source)) {
    const r = await psql(conn, db, "select 1");
    if (r.code === 0) return { db };
    if (r.code === "missing") return { why: "missing" };
    const why = refusal(r.err);
    if (why !== "gone") return { why };
  }
  return { why: "other" };
}

// The copy: a template copy first, which Postgres makes file by file; when the database is in use,
// which a template copy refuses, a dump of it restored into an empty one. Answers { how } or { why }.
export async function clonePg(conn, source, clone) {
  const home = await maintenance(conn, source);
  if (!home.db) return { why: home.why };
  const size = await psql(conn, home.db, `select pg_database_size(${literal(source)})`);
  if (size.code !== 0) return { why: refusal(size.err) };
  if (Number(size.out.trim()) > PG_CAP) return { why: "big" };
  const made = await psql(conn, home.db, `CREATE DATABASE ${quote(clone)} TEMPLATE ${quote(source)}`);
  if (made.code === 0) return { how: "template" };
  const why = refusal(made.err);
  if (why !== "busy") return { why };
  const empty = await psql(conn, home.db, `CREATE DATABASE ${quote(clone)}`);
  if (empty.code !== 0) return { why: refusal(empty.err) };
  const dump = spawn("pg_dump", ["--no-owner", "--no-privileges"], { env: envOf(conn, source), stdio: ["ignore", "pipe", "pipe"] });
  let dumpErr = "";
  dump.stderr.on("data", (d) => { dumpErr = (dumpErr + d).slice(-4000); });
  const dumped = new Promise((done) => { dump.on("error", (e) => done(e.code === "ENOENT" ? "missing" : 1)); dump.on("close", done); });
  const restored = await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], envOf(conn, clone), dump.stdout);
  const dumpCode = await dumped;
  if (dumpCode === 0 && restored.code === 0) return { how: "dump" };
  await dropPg(conn, clone);
  return { why: dumpCode === "missing" ? "missing" : refusal(dumpCode !== 0 ? dumpErr : restored.err) };
}

// The copy's own connections are ended first: the app is stopped by then, but a pool can outlive it.
export async function dropPg(conn, clone) {
  const home = await maintenance(conn);
  if (!home.db) return false;
  const r = await psql(conn, home.db,
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = ${literal(clone)} and pid <> pg_backend_pid()`,
    `DROP DATABASE IF EXISTS ${quote(clone)}`);
  return r.code === 0;
}
