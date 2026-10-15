// A MongoDB database copied for a session on the server it lives on, with MongoDB's own tools: a
// dump of it restored under a name of ours, and dropped after. Or, for an app that names its
// databases in its code, the whole server copied into a container of ours (serveMongo). The address
// carries the password, so it reaches mongodump and mongorestore through a config file only its user
// can read, and mongosh through its environment: never a command line another process can read.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker, dockerUp, freePort, runCopy, servedBy, until } from "./container.mjs";

// A database bigger than this is not copied: said instead, so the person decides.
export const MONGO_CAP = 1024 ** 3;

// The address with another database in it. A user kept in the app's own database signs in there,
// which the address says by naming that database, so the copy's address names it as the place to
// sign in. Rewritten as text: a replica set's host list (a:27017,b:27018) is no URL a parser takes.
export function withDb(uri, db, source) {
  const [, head, hosts, path = "", query = "", tail = ""] = /^([^:]+:\/\/)([^/?#]*)(?:\/([^?#]*))?(\?[^#]*)?(#.*)?$/.exec(uri);
  const cut = hosts.lastIndexOf("@");
  const signsIn = cut > 0 && !hosts.startsWith(":") && !/[?&]authSource=/i.test(query);
  const own = (() => { try { return decodeURIComponent(path); } catch { return path; } })();
  const from = signsIn ? `${query ? `${query}&` : "?"}authSource=${encodeURIComponent(own || source || "admin")}` : query;
  return `${head}${hosts}/${encodeURIComponent(db)}${from}${tail}`;
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

// The address with only this host in it, for a reader that talks to the one server it names: a
// replica set's member list holds names only its own network resolves.
function directTo(uri, hostPort) {
  const [, head, hosts, rest = "", query = "", tail = ""] = /^([^:]+:\/\/)([^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(uri);
  const cut = hosts.lastIndexOf("@");
  const params = new URLSearchParams(query.slice(1));
  params.delete("replicaSet");
  params.set("directConnection", "true");
  return `${head}${cut >= 0 ? hosts.slice(0, cut + 1) : ""}${hostPort}${rest || "/"}?${params}${tail}`;
}

// A replica set that asks for a password needs a key its members share, one member or not: made in
// the container before mongod starts, readable by mongod alone.
const KEYED = 'umask 077; head -c 756 /dev/urandom | base64 > /tmp/cortad.key; chown mongodb /tmp/cortad.key; exec docker-entrypoint.sh mongod "$@"';

// The whole server copied into a container of ours (lib/container.mjs) with MongoDB's own tools,
// which the container has whatever this machine lacks: every database, its indexes, and its users
// and roles, so the app signs in there as it does on the original. A server the app signs in to is
// copied into one that asks for a password too: the dump is restored by a user of ours, made through
// MongoDB's localhost exception and dropped after. Answers { port } or { why }.
export async function serveMongo(conn, name) {
  if (!(await dockerUp())) return { why: "docker" };
  const from = await servedBy(conn.port);
  let image = from?.image;
  if (!image) {
    const v = await shell(conn.uri, "print(c.getDB('admin').version())");
    if (v.code !== 0) return { why: refusal(v) };
    image = `mongo:${v.out.trim()}`;
  }
  const port = await freePort();
  const replSet = new URLSearchParams(/\?([^#]*)/.exec(conn.uri)?.[1] ?? "").get("replicaSet");
  const restorer = conn.user ? { user: `cortad_${randomBytes(4).toString("hex")}`, pwd: randomBytes(24).toString("hex") } : null;
  const mongod = ["--port", String(port), "--bind_ip_all", ...(replSet ? ["--replSet", replSet] : []), ...(restorer ? ["--auth"] : [])];
  const started = restorer && replSet
    ? { entrypoint: "bash", args: ["-c", KEYED, "bash", ...mongod, "--keyFile", "/tmp/cortad.key"] }
    : { args: mongod };
  if (!(await runCopy({ name, image, port, network: from?.net, ...started }))) return { why: "container" };
  const inside = (script, env = {}) => docker(["exec", ...Object.keys(env).flatMap((k) => ["-e", k]), name, "mongosh", "--quiet", "--port", String(port), "--eval", script], { env });
  if (!(await until(async () => (await inside("db.runCommand({ ping: 1 }).ok")).out.trim() === "1", 90_000))) return { why: "other" };
  if (replSet) {
    await inside(`rs.initiate({ _id: ${JSON.stringify(replSet)}, members: [{ _id: 0, host: "127.0.0.1:${port}" }] })`);
    if (!(await until(async () => (await inside("db.hello().isWritablePrimary")).out.trim() === "true", 60_000))) return { why: "other" };
  }
  if (restorer && (await inside(`print(db.getSiblingDB("admin").createUser({ user: ${JSON.stringify(restorer.user)}, pwd: process.env.CORTAD_PWD, roles: ["root"] }).ok)`, { CORTAD_PWD: restorer.pwd })).out.trim() !== "1") return { why: "other" };
  const source = directTo(conn.uri, from?.ip ? `${from.ip}:${from.inner}` : `host.docker.internal:${conn.port}`);
  const target = `mongodb://${restorer ? `${restorer.user}:${restorer.pwd}@` : ""}127.0.0.1:${port}/?directConnection=true${restorer ? "&authSource=admin" : ""}`;
  const size = await docker(["exec", "-e", "CORTAD_SOURCE", name, "mongosh", "--nodb", "--quiet", "--eval", "print(new Mongo(process.env.CORTAD_SOURCE).getDB('admin').adminCommand({ listDatabases: 1 }).totalSize)"], { env: { CORTAD_SOURCE: source } });
  if (!size.ok) return { why: refusal({ code: 1, err: size.err + size.out }) };
  if (Number(size.out.trim()) > MONGO_CAP) return { why: "big" };
  // Each address goes into a file only the container's own user reads, never onto a command line.
  const copy = await docker(["exec", "-e", "CORTAD_FROM", "-e", "CORTAD_TO", name, "bash", "-c",
    "set -o pipefail; umask 077; printf '%s\\n' \"$CORTAD_FROM\" > /tmp/from.yaml && printf '%s\\n' \"$CORTAD_TO\" > /tmp/to.yaml && mongodump --config=/tmp/from.yaml --archive --quiet | mongorestore --config=/tmp/to.yaml --archive --quiet --nsExclude='config.*'; s=$?; rm -f /tmp/from.yaml /tmp/to.yaml; exit $s"],
  { env: { CORTAD_FROM: `uri: ${JSON.stringify(source)}`, CORTAD_TO: `uri: ${JSON.stringify(target)}` }, timeout: 900_000 });
  if (!copy.ok) return { why: refusal({ code: 1, err: copy.err }) };
  if (restorer) await docker(["exec", "-e", "CORTAD_TARGET", name, "mongosh", "--nodb", "--quiet", "--eval", `new Mongo(process.env.CORTAD_TARGET).getDB("admin").dropUser(${JSON.stringify(restorer.user)})`], { env: { CORTAD_TARGET: target } });
  return { port };
}
