// A MongoDB database copied for a session on the server it lives on, with MongoDB's own tools: a
// dump of it restored under a name of ours, and dropped after. The address carries the password, so
// it reaches mongodump and mongorestore through a config file only this user can read, and mongosh
// through its environment: never a command line another process on this machine can read.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A database bigger than this is not copied: said instead, so the person decides.
export const MONGO_CAP = 1024 ** 3;

// The address with another database in it. A user kept in the app's own database signs in there,
// which the address says by naming that database, so the copy's address names it as the place to
// sign in.
export function withDb(uri, db, source) {
  const u = new URL(uri);
  const signsIn = u.username && !u.searchParams.has("authSource");
  if (signsIn) u.searchParams.set("authSource", decodeURIComponent(u.pathname.replace(/^\//, "")) || source || "admin");
  u.pathname = `/${encodeURIComponent(db)}`;
  return u.toString();
}

function run(bin, args, { env = {}, stdin = null } = {}) {
  return new Promise((done) => {
    const child = spawn(bin, args, { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    if (stdin) stdin.pipe(child.stdin);
    child.on("error", (e) => done({ code: e.code === "ENOENT" ? "missing" : 1, out, err: String(e.message) }));
    child.on("close", (code) => done({ code, out, err }));
  });
}
// One statement against the server, the address in the environment.
const shell = (uri, script) => run("mongosh", ["--nodb", "--quiet", "--eval", `const c = new Mongo(process.env.CORTAD_MONGO); ${script}`], { env: { CORTAD_MONGO: uri } });

// Why a tool refused, as a class the sentence is written from, never in the server's own words.
export function refusal(r) {
  if (r.code === "missing") return "missing";
  if (/Authentication failed|AuthenticationFailed|auth error/i.test(r.err)) return "auth";
  if (/not authorized|Unauthorized|requires authentication/i.test(r.err)) return "rights";
  if (/ECONNREFUSED|connection refused|server selection|No servers available|timed out/i.test(r.err)) return "down";
  return "other";
}

export async function cloneMongo(conn, source, clone) {
  const size = await shell(withDb(conn.uri, source, source), `print(c.getDB(${JSON.stringify(source)}).stats().dataSize)`);
  if (size.code !== 0) return { why: refusal(size) };
  if (Number(size.out.trim()) > MONGO_CAP) return { why: "big" };
  const dir = mkdtempSync(join(tmpdir(), "cortad-mongo-"));
  try {
    writeFileSync(join(dir, "from.yaml"), `uri: ${JSON.stringify(withDb(conn.uri, source, source))}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "to.yaml"), `uri: ${JSON.stringify(withDb(conn.uri, "", source))}\n`, { mode: 0o600 });
    const dump = spawn("mongodump", [`--config=${join(dir, "from.yaml")}`, `--db=${source}`, "--archive"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let dumpErr = "";
    dump.stderr.on("data", (d) => { dumpErr = (dumpErr + d).slice(-4000); });
    const dumped = new Promise((done) => { dump.on("error", (e) => done(e.code === "ENOENT" ? "missing" : 1)); dump.on("close", done); });
    const restored = await run("mongorestore", [`--config=${join(dir, "to.yaml")}`, "--archive", `--nsInclude=${source}.*`, `--nsFrom=${source}.*`, `--nsTo=${clone}.*`], { stdin: dump.stdout });
    const dumpCode = await dumped;
    if (dumpCode === 0 && restored.code === 0) return { how: "dump" };
    await dropMongo(conn, clone, source);
    // Either side ending stops the other, which then fails for that reason alone: the telling one wins.
    const whys = [dumpCode === 0 ? null : refusal({ code: dumpCode, err: dumpErr }), restored.code === 0 ? null : refusal(restored)].filter(Boolean);
    return { why: whys.find((w) => w !== "other") ?? "other" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function dropMongo(conn, clone, source) {
  return (await shell(withDb(conn.uri, clone, source), `c.getDB(${JSON.stringify(clone)}).dropDatabase()`)).code === 0;
}
