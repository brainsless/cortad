import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { connect } from "./connect-kit.mjs";
import { MARKER, tooOld } from "./redis.mjs";
import { storeKeeper, storesOf, unnamedLines } from "./stores.mjs";

const onPath = (bin) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));
const tree = (files) => { const root = realpathSync(mkdtempSync(join(tmpdir(), "stores-app-"))); for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); } return root; };
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });

test("every store the settings name, one entry per database, and how to point each at a copy", () => {
  const stores = storesOf({
    DATABASE_URL: "postgresql+asyncpg://app:s3cret@localhost:5432/shop?sslmode=disable",
    DIRECT_URL: "postgres://app:s3cret@127.0.0.1:5432/shop",
    // A container's first start: the server, with no database, is the same store.
    POSTGRES_HOST: "localhost", POSTGRES_USER: "app", POSTGRES_PASSWORD: "s3cret",
    REDIS_URL: "redis://:pw@localhost:6379/2",
    QDRANT_URL: "http://localhost:6333", QDRANT_API_KEY: "k",
    MONGODB_URI: "mongodb+srv://u:p@cluster0.abcd.mongodb.net/app?retryWrites=true",
    SUPABASE_URL: "https://xyz.supabase.co",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
  });
  const by = (engine) => stores.filter((s) => s.engine === engine);
  assert.equal(by("postgres").length, 1);
  const pg = by("postgres")[0];
  assert.deepEqual(pg.names, ["DATABASE_URL", "DIRECT_URL", "POSTGRES_HOST"]);
  assert.equal(pg.db, "shop");
  assert.equal(pg.conn.password, "s3cret");
  assert.deepEqual(Object.assign({}, ...pg.points.map((p) => p("shop_cortad_1"))), {
    DATABASE_URL: "postgresql+asyncpg://app:s3cret@localhost:5432/shop_cortad_1?sslmode=disable",
    DIRECT_URL: "postgres://app:s3cret@127.0.0.1:5432/shop_cortad_1",
  });
  assert.equal(by("redis")[0].db, 2);
  assert.equal(by("redis")[0].points[0](15).REDIS_URL, "redis://:pw@localhost:6379/15");
  assert.equal(by("qdrant")[0].port, 6333);
  assert.equal(by("mongo")[0].host, "cluster0.abcd.mongodb.net");
  assert.equal(by("supabase")[0].port, 443);
  assert.equal(stores.length, 5, "the model provider is not a store");
});

test("settings in parts name a store, and a Redis with no database setting cannot be pointed", () => {
  const [pg] = storesOf({ DB_HOST: "127.0.0.1", DB_PORT: "5433", DB_NAME: "notes", DB_USER: "u", DB_PASSWORD: "p", DB_CONNECTION: "pgsql" });
  assert.deepEqual([pg.engine, pg.port, pg.db, pg.conn.user], ["postgres", 5433, "notes", "u"]);
  assert.deepEqual(pg.points[0]("notes_copy"), { DB_NAME: "notes_copy" });
  const [redis] = storesOf({ REDIS_HOST: "localhost", REDIS_PORT: "6380" });
  assert.deepEqual([redis.engine, redis.port, redis.db, redis.points.length], ["redis", 6380, 0, 0]);
  assert.deepEqual(storesOf({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", OLLAMA_HOST: "http://localhost:11434" }), []);
  assert.deepEqual(storesOf({ QDRANT_HOST: "", QDRANT_PORT: "6333", QDRANT_PATH: "./data/qdrant" }), [], "a blank host is a store set up not to be used");
});

test("a template the code fills is not an address, and one that is no percent-encoding or lists a replica set is read as written", () => {
  assert.deepEqual(storesOf({ A: "postgresql://%s:%s@localhost:5432/%s", B: "postgres://${U}:${P}@localhost/app", C: "postgresql://{}:{}@localhost/{}" }), []);
  const [pg] = storesOf({ DATABASE_URL: "postgres://localhost:5432/%DB%" });
  assert.deepEqual([pg.engine, pg.port, pg.db], ["postgres", 5432, "%DB%"]);
  const [mongo] = storesOf({ MONGO_URL: "mongodb://app:pw@localhost:27017,localhost:27018/shop?replicaSet=rs0" });
  assert.deepEqual([mongo.host, mongo.port, mongo.db], ["localhost", 27017, "shop"]);
  assert.deepEqual(mongo.points[0]("shop_copy"), { MONGO_URL: "mongodb://app:pw@localhost:27017,localhost:27018/shop_copy?replicaSet=rs0&authSource=shop" });
});

test("a collection setting is Qdrant's only when no other store the settings name could own it", async () => {
  const engines = (v) => storesOf(v).map((s) => [s.engine, s.db, s.names]);
  const mongo = { QDRANT_URL: "http://localhost:6333", MONGODB_URI: "mongodb+srv://u:p@cluster0.abcd.mongodb.net/app", MONGODB_COLLECTION_NAME: "chat_history" };
  assert.deepEqual(engines(mongo), [["mongo", "app", ["MONGODB_URI"]], ["qdrant", null, ["QDRANT_URL"]]]);
  assert.deepEqual(engines({ ...mongo, MONGODB_COLLECTION_NAME: undefined, COLLECTION_NAME: "chat_history" }), [["mongo", "app", ["MONGODB_URI"]], ["qdrant", null, ["QDRANT_URL"]]], "a bare name beside another collection store is not taken");
  assert.deepEqual(engines({ QDRANT_URL: "http://localhost:6333", REDIS_URL: "redis://localhost:6379/0", COLLECTION_NAME: "docs" })[0], ["qdrant", "docs", ["QDRANT_URL", "COLLECTION_NAME"]], "Redis holds no collections");
  assert.deepEqual(engines({ QDRANT_HOST: "localhost", QDRANT_PORT: "6333", QDRANT_COLLECTION_NAME: "docs" }), [["qdrant", "docs", ["QDRANT_HOST", "QDRANT_COLLECTION_NAME"]]]);
  const got = await storeKeeper({ ledgerFile: join(mkdtempSync(join(tmpdir(), "stores-")), "made.json") }).keep(storesOf(mongo), { down: async () => false });
  assert.deepEqual(got.env, {}, "no Mongo setting is renamed");
  assert.deepEqual(got.risks, [
    "What trials create in the Qdrant server that QDRANT_URL names stays there: its settings do not say which collection the app keeps there, so the app cannot be pointed at a copy. Point QDRANT_URL at a scratch server before a run if that one holds real data.",
  ]);
  assert.deepEqual(got.blocked.map((b) => b.why), [
    "Trials would write into the MongoDB database app that MONGODB_URI names, on a server off this machine, and a hosted MongoDB is not one we copy. Point MONGODB_URI at a server on this machine, then run the command again.",
  ]);
});

test("before a copy is tried, a store that cannot be copied is said in their words, and nothing secret is", async () => {
  const keeper = storeKeeper({ ledgerFile: join(mkdtempSync(join(tmpdir(), "stores-")), "made.json") });
  const stores = storesOf({ MYSQL_URL: "mysql://u:hunter22@localhost:3306/app", SUPABASE_URL: "https://xyz.supabase.co", REDIS_HOST: "localhost" });
  const got = await keeper.keep(stores, { down: async () => false });
  assert.deepEqual(got.env, {});
  assert.deepEqual(got.risks.sort(), [
    "What trials create in the MySQL database app that MYSQL_URL names stays there: we copy Postgres, Redis, MongoDB and Qdrant for a run, not MySQL. Point MYSQL_URL at a scratch database before a run if that one holds real data.",
    "What trials create in the Redis database 0 that REDIS_HOST names stays there: the database number is not among its settings, so the app cannot be pointed at a copy. Put it in one before a run if that one holds real data.",
  ]);
  assert.deepEqual(got.blocked.map((b) => b.why), [
    "Trials would write into the Supabase server that SUPABASE_URL names, on a server off this machine, and a local Supabase needs supabase/config.toml, Docker and the supabase command. Add them, or point SUPABASE_URL at a local Supabase, then run the command again.",
  ]);
  assert.ok(!got.risks.join(" ").includes("hunter22"));
  const attached = await storeKeeper({ ledgerFile: join(mkdtempSync(join(tmpdir(), "stores-")), "made.json") }).keep(stores.slice(0, 1), { started: false });
  assert.match(attached.risks[0], /stays there: your app was already running when this command started/);
});

test("a store the app reached that no setting names is said once; one a setting names is not", () => {
  const stores = storesOf({ DATABASE_URL: "postgres://localhost:5432/app" });
  const told = new Set();
  const conns = [{ host: "127.0.0.1", port: 5432 }, { host: "localhost", port: 27017 }, { host: "api.openai.com", port: 443 }, { host: "abc-123.svc.pinecone.io", port: 443 }, { host: "127.0.0.1", port: 3000 }];
  assert.deepEqual(unnamedLines(conns, stores, told), [
    "Your app connects to a MongoDB server on this machine that none of its settings names, so it cannot be pointed at a copy: what trials create there stays there.",
    "Your app reaches Pinecone on a server off this machine, and a copy is only made on this machine: what trials create there stays there.",
  ]);
  assert.deepEqual(unnamedLines(conns, stores, told), [], "said once");
});

// The whole command against an app that reaches a store its settings never name, written into its
// code: the hook sees the connection, and the line reaches the run before Run is pressed. A plain
// listener stands at MongoDB's own port, since the store is known by that port alone.
test("a store the app reaches that no setting names is said to the run once the hook sees it", { timeout: 90_000 }, async (t) => {
  const store = createServer((s) => s.end()).listen(27017, "127.0.0.1");
  const bound = await new Promise((ok) => { store.once("listening", () => ok(true)); store.once("error", () => ok(false)); });
  if (!bound) return t.skip("port 27017 is taken on this machine");
  const root = tree({
    "package.json": JSON.stringify({ name: "catalog", scripts: { dev: "node app.cjs" } }),
    "app.cjs": "require('node:http').createServer((q, r) => { require('node:net').connect(27017, '127.0.0.1').on('error', () => {}).end(); r.end('ok'); }).listen(0, '127.0.0.1');",
  });
  const kit = await connect(root);
  try {
    const app = await kit.announced();
    await fetch(`http://127.0.0.1:${app.port}/`);
    const told = await kit.announced((a) => a.data?.some((l) => l.includes("MongoDB")));
    assert.equal(told.data[0], "Your app connects to a MongoDB server on this machine that none of its settings names, so it cannot be pointed at a copy: what trials create there stays there.");
  } finally { kit.close(); store.close(); }
});

// The whole command against an app whose code carries defaults that are templates or list a replica
// set, and whose settings name stores on this machine where nothing answers and nothing in the
// repository starts them: it starts, and each of those stores is said to the run as theirs.
test("an app whose stores are templates, replica sets or down still starts, and each down store is said as theirs", { timeout: 90_000 }, async () => {
  const [pgPort, mongoA, mongoB, redisPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const root = tree({
    "package.json": JSON.stringify({ name: "notes", scripts: { dev: "node app.cjs" } }),
    ".env": `REDIS_URL=redis://localhost:${redisPort}/0\n`,
    "app.cjs": [
      `const db = process.env.DATABASE_URL || 'postgres://localhost:${pgPort}/%DB%';`,
      `const docs = process.env.MONGO_URL || 'mongodb://localhost:${mongoA},localhost:${mongoB}/app?replicaSet=rs0';`,
      "require('node:http').createServer((q, r) => { r.statusCode = 500; r.end('the database is down'); }).listen(0, '127.0.0.1');",
    ].join("\n"),
    "settings.py": 'import os\nDB_URL = os.getenv("DB_URL", "postgresql://%s:%s@localhost:5432/%s")\n',
  });
  const kit = await connect(root);
  try {
    const theirs = (names, port) => `${names} points at port ${port} on this machine and nothing answers there, and nothing in this repository starts it: start it yourself before a run. This is on your side.`;
    const told = await kit.announced((a) => a.data?.length >= 3);
    assert.deepEqual(told.data.slice().sort(), [theirs("DATABASE_URL", pgPort), theirs("MONGO_URL", mongoA), theirs("REDIS_URL", redisPort)].sort(), kit.out);
    assert.equal(kit.command.exitCode, null, "the command is still serving the app");
  } finally { kit.close(); }
});

// A Postgres server of the test's own, made in a temp folder: password sign-in over TCP, so the
// copy is proven to reach it with the settings' own credentials and nothing else.
async function postgres() {
  const dir = mkdtempSync(join(tmpdir(), "pg-"));
  writeFileSync(join(dir, "pw"), "s3cret-pw\n");
  execFileSync("initdb", ["-D", join(dir, "data"), "-U", "app", "--auth-local=trust", "--auth-host=scram-sha-256", `--pwfile=${join(dir, "pw")}`, "-E", "UTF8", "--no-locale"], { stdio: "ignore" });
  const port = await freePort();
  execFileSync("pg_ctl", ["-D", join(dir, "data"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, "-w", "-l", join(dir, "log"), "start"], { stdio: "ignore" });
  const url = (db) => `postgresql://app:s3cret-pw@127.0.0.1:${port}/${db}`;
  const sql = (db, q) => execFileSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url(db), "-c", q], { encoding: "utf8" }).trim();
  // The server in the foreground, as a service of a repository runs it. On macOS it will not start
  // without a locale, and the command under test runs with a bare environment.
  const serve = `LC_ALL=C postgres -D ${join(dir, "data")} -p ${port} -k ${dir} -c listen_addresses=127.0.0.1`;
  const start = async () => { for (let i = 0; i < 50; i++, await new Promise((r) => setTimeout(r, 200))) { try { execFileSync("pg_ctl", ["-D", join(dir, "data"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, "-w", "-l", join(dir, "log"), "start"], { stdio: "ignore" }); return; } catch { /* the last one is still going */ } } };
  return { port, url, sql, serve, start, stop: () => { try { execFileSync("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" }); } catch { /* not running */ } } };
}

describe("a real Postgres", { skip: !["initdb", "pg_ctl", "psql", "pg_dump"].every(onPath) && "the Postgres server and client tools are not on PATH" }, () => {
  test("the app's database is copied on its server, the copy takes the writes, and the copy is gone after", { timeout: 60_000 }, async () => {
    const pg = await postgres();
    try {
      pg.sql("postgres", "create database shop");
      pg.sql("shop", "create table orders(id serial primary key, item text); insert into orders(item) values ('a real order')");
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "stores-")), "made.json");
      const keeper = storeKeeper({ ledgerFile });
      const stores = storesOf({ DATABASE_URL: pg.url("shop") });
      const got = await keeper.keep(stores);
      assert.deepEqual(got.risks, []);
      const clone = `shop_cortad_${process.pid}`;
      assert.equal(got.env.DATABASE_URL, pg.url(clone));
      assert.deepEqual(got.copies, [`Your app runs against a copy of its Postgres database shop, made on the same server, through DATABASE_URL; the original is not touched, and the copy is deleted when this command ends.`]);
      assert.equal(JSON.parse(readFileSync(ledgerFile, "utf8"))[0].made, clone);
      pg.sql(clone, "insert into orders(item) values ('made by a trial')");
      assert.equal(pg.sql(clone, "select count(*) from orders"), "2");
      assert.equal(pg.sql("shop", "select count(*) from orders"), "1", "the original is untouched");
      await keeper.drop();
      assert.equal(pg.sql("postgres", `select count(*) from pg_database where datname = '${clone}'`), "0");
      assert.deepEqual(JSON.parse(readFileSync(ledgerFile, "utf8")), []);
    } finally { pg.stop(); }
  });

  test("a database in use is copied by a dump, and a copy a dead session left is dropped by the next", { timeout: 60_000 }, async () => {
    const pg = await postgres();
    let holder = null;
    try {
      pg.sql("postgres", "create database shop2");
      pg.sql("shop2", "create table t(x int); insert into t values (1)");
      // The app's own pool, holding the database open: a template copy refuses it.
      holder = spawn("psql", ["-X", pg.url("shop2")], { stdio: ["pipe", "ignore", "ignore"] });
      for (let i = 0; i < 50 && pg.sql("postgres", "select count(*) from pg_stat_activity where datname = 'shop2'") === "0"; i++) await new Promise((r) => setTimeout(r, 100));
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "stores-")), "made.json");
      const stores = storesOf({ DATABASE_URL: pg.url("shop2") });
      const got = await storeKeeper({ ledgerFile }).keep(stores);
      const clone = `shop2_cortad_${process.pid}`;
      assert.equal(pg.sql(clone, "select count(*) from t"), "1", "the dump carried the rows");
      holder.kill();
      // The session that made it died without a word: its row names a pid that is gone.
      writeFileSync(ledgerFile, JSON.stringify(JSON.parse(readFileSync(ledgerFile, "utf8")).map((r) => ({ ...r, pid: 999_999 }))));
      await storeKeeper({ ledgerFile }).keep([]);
      assert.equal(pg.sql("postgres", `select count(*) from pg_database where datname = '${clone}'`), "1", "a row is only undone for a store the settings still name");
      await storeKeeper({ ledgerFile }).keep(stores.map((s) => ({ ...s, db: "gone" })));
      assert.equal(pg.sql("postgres", `select count(*) from pg_database where datname = '${clone}'`), "0");
      assert.ok(got.env.DATABASE_URL.endsWith(`/${clone}`));
    } finally { holder?.kill(); pg.stop(); }
  });

  // The whole command against a small app that keeps its notes in Postgres through the DATABASE_URL
  // its .env names, the way a run's trials write: every write lands in the copy, the original keeps
  // exactly what it had, and when the command ends the copy is gone and nothing is left to undo.
  test("the app the command starts writes to a copy of its Postgres database, and the session leaves nothing behind", { timeout: 120_000 }, async () => {
    const pg = await postgres();
    let kit = null;
    try {
      pg.sql("postgres", "create database notes");
      pg.sql("notes", "create table notes(id serial primary key, body text); insert into notes(body) values ('a real note')");
      const root = tree({
        "package.json": JSON.stringify({ name: "notes", scripts: { dev: "node server.mjs" } }),
        ".env": `DATABASE_URL=${pg.url("notes")}\n`,
        "server.mjs": [
          "import { execFileSync } from 'node:child_process';",
          "import { createServer } from 'node:http';",
          "const sql = (q) => execFileSync('psql', ['-X', '-q', '-A', '-t', process.env.DATABASE_URL, '-c', q], { encoding: 'utf8' }).trim();",
          "createServer((req, res) => { if (req.url === '/note') sql(\"insert into notes(body) values ('written by a trial')\"); res.end(sql('select count(*) from notes')); }).listen(0, '127.0.0.1');",
        ].join("\n"),
      });
      kit = await connect(root);
      const app = await kit.announced();
      const clone = `notes_cortad_${kit.command.pid}`;
      assert.ok(app.data.includes("Your app runs against a copy of its Postgres database notes, made on the same server, through DATABASE_URL; the original is not touched, and the copy is deleted when this command ends."), `${JSON.stringify(app.data)}\n${kit.out}`);
      assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/note`)).text(), "2");
      assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/note`)).text(), "3", "the copy took both writes");
      assert.equal(pg.sql(clone, "select count(*) from notes"), "3");
      assert.equal(pg.sql("notes", "select count(*) from notes"), "1", "the original has only its real note");
      await kit.stop();
      assert.equal(pg.sql("postgres", "select count(*) from pg_database where datname like 'notes_cortad_%'"), "0", "the copy is dropped when the command ends");
      assert.equal(pg.sql("notes", "select body from notes"), "a real note");
      assert.deepEqual(JSON.parse(readFileSync(join(kit.project, "made.json"), "utf8")), [], "nothing is left to undo");
    } finally {
      kit?.close();
      pg.stop();
    }
  });

  // An app that connects on first use starts while its database is down. The command sees its settings
  // name a store on this machine, starts it with the repository's own service, copies it, starts the
  // app again on the copy, and when it ends drops the copy before it stops the service.
  test("a database the settings name that is down is started by the repository's service, copied, and put back", { timeout: 180_000 }, async () => {
    const pg = await postgres();
    let kit = null;
    try {
      pg.sql("postgres", "create database notes");
      pg.sql("notes", "create table notes(id serial primary key, body text); insert into notes(body) values ('a real note')");
      pg.stop();
      const root = tree({
        "package.json": JSON.stringify({ name: "notes", scripts: { dev: "node server.mjs" } }),
        ".env": `DATABASE_URL=${pg.url("notes")}\n`,
        "server.mjs": [
          "import { execFileSync } from 'node:child_process';",
          "import { createServer } from 'node:http';",
          "const sql = (q) => execFileSync('psql', ['-X', '-q', '-A', '-t', process.env.DATABASE_URL, '-c', q], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();",
          "createServer((req, res) => { try { if (req.url === '/note') sql(\"insert into notes(body) values ('written by a trial')\"); res.end(sql('select count(*) from notes')); } catch { res.statusCode = 500; res.end('the database is down'); } }).listen(0, '127.0.0.1');",
        ].join("\n"),
        "db/package.json": JSON.stringify({ name: "db", scripts: { dev: `PORT=${pg.port} ${pg.serve}` } }),
      });
      kit = await connect(root);
      const copied = "Your app runs against a copy of its Postgres database notes, made on the same server, through DATABASE_URL; the original is not touched, and the copy is deleted when this command ends.";
      const app = await kit.announced((a) => a.data?.includes(copied), 120_000);
      assert.ok(app.data.includes(`Started db with npm run dev: DATABASE_URL points at port ${pg.port} on this machine and nothing answered there. It is stopped when this command ends.`), JSON.stringify(app.data));
      const clone = `notes_cortad_${kit.command.pid}`;
      assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/note`)).text(), "2");
      assert.equal(pg.sql(clone, "select count(*) from notes"), "2", "the restarted app writes to the copy");
      assert.equal(pg.sql("notes", "select count(*) from notes"), "1", "the original has only its real note");
      await kit.stop();
      await pg.start();
      assert.equal(pg.sql("postgres", "select count(*) from pg_database where datname like 'notes_cortad_%'"), "0", "the copy was dropped while its server still answered");
      assert.equal(pg.sql("notes", "select body from notes"), "a real note");
      assert.deepEqual(JSON.parse(readFileSync(join(kit.project, "made.json"), "utf8")), [], "nothing is left to undo");
    } finally {
      kit?.close();
      pg.stop();
    }
  });

  test("a hosted database with its own migrations is run against an empty copy on this machine they build, deleted at the end", { timeout: 60_000 }, async () => {
    const pg = await postgres();
    try {
      const repo = mkdtempSync(join(tmpdir(), "shadow-"));
      mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
      writeFileSync(join(repo, "supabase", "migrations", "0001_notes.sql"), "create table notes (id serial primary key, body text not null);\n");
      writeFileSync(join(repo, "supabase", "migrations", "0002_tags.sql"), "alter table notes add column tag text;\n");
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "stores-")), "made.json");
      const values = { DATABASE_URL: "postgresql+asyncpg://app:hosted-pw@db.example.com:5432/shop?sslmode=require" };
      const keeper = storeKeeper({ ledgerFile, values, dirs: [repo], local: { host: "127.0.0.1", port: pg.port, user: "app", password: "s3cret-pw" } });
      const got = await keeper.keep(storesOf(values), { down: async () => false });
      assert.deepEqual(got.blocked, []);
      const shadow = /\/(cortad_shadow_\w+)$/.exec(got.env.DATABASE_URL)?.[1];
      assert.equal(got.env.DATABASE_URL, `postgresql+asyncpg://app:s3cret-pw@127.0.0.1:${pg.port}/${shadow}`);
      assert.equal(pg.sql(shadow, "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'notes'"), "body,id,tag");
      assert.equal(got.copies[0], "Your app runs against an empty Postgres database on this machine built by its own Supabase migrations, through DATABASE_URL; the hosted one is not touched, and the copy is deleted when this command ends.");
      await keeper.drop();
      assert.equal(pg.sql("postgres", "select count(*) from pg_database where datname like 'cortad_shadow_%'"), "0");
      assert.deepEqual(JSON.parse(readFileSync(ledgerFile, "utf8")), []);
    } finally {
      pg.stop();
    }
  });

  test("a password the server refuses is said as theirs, with no copy and nothing quoted", { timeout: 60_000 }, async () => {
    const pg = await postgres();
    try {
      const got = await storeKeeper({ ledgerFile: join(mkdtempSync(join(tmpdir(), "stores-")), "made.json") }).keep(storesOf({ DATABASE_URL: pg.url("postgres").replace("s3cret-pw", "wrong") }));
      assert.deepEqual(got.env, {});
      assert.equal(got.risks[0], "What trials create in the Postgres database postgres that DATABASE_URL names stays there: the password its settings carry was refused, so no copy was made. Check that setting before a run.");
    } finally { pg.stop(); }
  });
});

describe("a real Redis", { skip: !onPath("redis-server") && "redis-server is not on PATH" }, () => {
  test("its keys are copied into an empty database of the same server, and only that database is emptied after", { timeout: 30_000 }, async () => {
    const port = await freePort();
    const server = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--requirepass", "pw"], { stdio: "ignore" });
    const cli = (...a) => execFileSync("redis-cli", ["-p", String(port), "--no-auth-warning", "-a", "pw", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    try {
      for (let i = 0; i < 50; i++) { try { if (cli("ping") === "PONG") break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
      cli("-n", "2", "set", "cart:1", "a real cart");
      cli("-n", "2", "set", "session:9", "x", "EX", "600");
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "stores-")), "made.json");
      const keeper = storeKeeper({ ledgerFile });
      const got = await keeper.keep(storesOf({ REDIS_URL: `redis://:pw@127.0.0.1:${port}/2` }));
      assert.equal(got.env.REDIS_URL, `redis://:pw@127.0.0.1:${port}/15`);
      assert.equal(cli("-n", "15", "get", "cart:1"), "a real cart");
      assert.ok(Number(cli("-n", "15", "ttl", "session:9")) > 0, "an expiry is copied with its key");
      cli("-n", "15", "set", "cart:2", "made by a trial");
      assert.equal(cli("-n", "2", "dbsize"), "2", "the original is untouched");
      await keeper.drop();
      assert.equal(cli("-n", "15", "dbsize"), "0");
      assert.equal(cli("-n", "2", "get", "cart:1"), "a real cart");
      // COPY came in 6.2: the server's own INFO says which it is.
      assert.equal(tooOld(Buffer.from(cli("info", "server"))), false);
      assert.equal(tooOld(Buffer.from(cli("info", "server").replace(/redis_version:[\d.]+/, "redis_version:6.0.16"))), true);
      // A session killed mid-copy recorded the copy before it knew the database it claimed: the next
      // session finds that database by its marker and empties it, and no other.
      cli("-n", "14", "set", MARKER, "dead-1");
      cli("-n", "14", "set", "cart:3", "half copied");
      cli("-n", "13", "set", "kept", "someone else's");
      const store = storesOf({ REDIS_URL: `redis://:pw@127.0.0.1:${port}/2` })[0];
      writeFileSync(ledgerFile, JSON.stringify([{ kind: "copy", key: store.key, made: null, marker: "dead-1", pid: 2 ** 22 + 7 }]));
      const next = storeKeeper({ ledgerFile });
      await next.keep([store]);
      assert.equal(cli("-n", "14", "dbsize"), "0", "the dead session's copy is emptied");
      assert.equal(cli("-n", "13", "get", "kept"), "someone else's");
      assert.ok(!JSON.parse(readFileSync(ledgerFile, "utf8")).some((r) => r.marker === "dead-1"), "and its row is gone");
      await next.drop();
    } finally { server.kill(); }
  });
});

// The address lists a replica set's hosts, which no URL parser takes: the copy is tried and said.
test("a MongoDB replica set's address is copied from or said, never a stop", { skip: !onPath("mongosh") && "mongosh is not on PATH" }, async () => {
  const [a, b] = [await freePort(), await freePort()];
  const got = await storeKeeper({ ledgerFile: join(mkdtempSync(join(tmpdir(), "stores-")), "made.json") }).keep(storesOf({ MONGO_URL: `mongodb://127.0.0.1:${a},127.0.0.1:${b}/app?replicaSet=rs0&serverSelectionTimeoutMS=1500` }), { down: async () => false });
  assert.deepEqual(got.risks, ["What trials create in the MongoDB database app that MONGO_URL names stays there: nothing answered at the address its settings give, so no copy was made. Start it before a run."]);
});

const until = async (ok, ms = 20_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { try { if (await ok()) return true; } catch { /* not yet */ } } return false; };

describe("a real MongoDB", { skip: !["mongod", "mongodump", "mongorestore", "mongosh"].every(onPath) && "mongod and MongoDB's tools are not on PATH" }, () => {
  test("the app's database is copied under a name of ours, signs in where the original did, and is dropped after", { timeout: 90_000 }, async () => {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), "mongo-"));
    const server = spawn("mongod", ["--dbpath", dir, "--port", String(port), "--bind_ip", "127.0.0.1", "--auth", "--quiet"], { stdio: "ignore" });
    const sh = (uri, script) => execFileSync("mongosh", ["--quiet", uri, "--eval", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    try {
      assert.ok(await until(() => sh(`mongodb://127.0.0.1:${port}/admin`, "db.runCommand({ ping: 1 }).ok") === "1"));
      sh(`mongodb://127.0.0.1:${port}/admin`, "db.createUser({ user: 'root', pwd: 'r00t-pw', roles: ['root'] })");
      const root = `mongodb://root:r00t-pw@127.0.0.1:${port}`;
      sh(`${root}/shop?authSource=admin`, "db.orders.insertMany([{ item: 'a real order' }, { item: 'another' }]); db.orders.createIndex({ item: 1 }); db.createUser({ user: 'app', pwd: 'app-pw', roles: [{ role: 'readWrite', db: 'shop' }] }); db.createUser({ user: 'wide', pwd: 'wide-pw', roles: [{ role: 'readWriteAnyDatabase', db: 'admin' }] })");
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "stores-")), "made.json");
      const keeper = storeKeeper({ ledgerFile });
      const got = await keeper.keep(storesOf({ MONGODB_URI: `${root}/shop?authSource=admin` }));
      const clone = `shop_cortad_${process.pid}`;
      assert.equal(got.env.MONGODB_URI, `${root}/${clone}?authSource=admin`);
      assert.deepEqual(got.copies, ["Your app runs against a copy of its MongoDB database shop, made on the same server, through MONGODB_URI; the original is not touched, and the copy is deleted when this command ends."]);
      assert.equal(sh(got.env.MONGODB_URI, "db.orders.countDocuments()"), "2");
      assert.equal(sh(got.env.MONGODB_URI, "db.orders.getIndexes().length"), "2", "the index came with it");
      sh(got.env.MONGODB_URI, "db.orders.insertOne({ item: 'made by a trial' })");
      assert.equal(sh(`${root}/shop?authSource=admin`, "db.orders.countDocuments()"), "2", "the original is untouched");
      await keeper.drop();
      assert.equal(sh(`${root}/admin?authSource=admin`, `db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.some((d) => d.name === '${clone}')`), "false");
      // A user kept in the app's own database signs in there, and the copy's address says so.
      const own = storeKeeper({ ledgerFile });
      const signed = await own.keep(storesOf({ MONGODB_URI: `mongodb://wide:wide-pw@127.0.0.1:${port}/shop` }));
      assert.equal(signed.env.MONGODB_URI, `mongodb://wide:wide-pw@127.0.0.1:${port}/${clone}?authSource=shop`);
      assert.equal(sh(signed.env.MONGODB_URI, "db.orders.countDocuments()"), "2");
      await own.drop();
      // A user kept in the app's own database, allowed only that one, cannot make a second: said, and nothing made.
      const narrow = await storeKeeper({ ledgerFile }).keep(storesOf({ MONGODB_URI: `mongodb://app:app-pw@127.0.0.1:${port}/shop` }));
      assert.deepEqual(narrow.env, {});
      assert.equal(narrow.risks[0], "What trials create in the MongoDB database shop that MONGODB_URI names stays there: the user it signs in as may not create databases, so no copy was made. Give that user the right to create databases, or point it at a scratch database, before a run.");
    } finally { server.kill(); }
  });
});

describe("a real Qdrant", { skip: !onPath("qdrant") && "qdrant is not on PATH" }, () => {
  test("a collection its settings name is copied with its vectors, payloads and indexes, and deleted after", { timeout: 90_000 }, async () => {
    const [port, grpc] = [await freePort(), await freePort()];
    const dir = mkdtempSync(join(tmpdir(), "qdrant-"));
    const server = spawn("qdrant", [], { cwd: dir, env: { PATH: process.env.PATH, QDRANT__SERVICE__HTTP_PORT: String(port), QDRANT__SERVICE__GRPC_PORT: String(grpc), QDRANT__SERVICE__HOST: "127.0.0.1", QDRANT__STORAGE__STORAGE_PATH: join(dir, "storage"), QDRANT__STORAGE__SNAPSHOTS_PATH: join(dir, "snapshots"), QDRANT__SERVICE__API_KEY: "q-key", QDRANT__TELEMETRY_DISABLED: "true" }, stdio: "ignore" });
    const base = `http://127.0.0.1:${port}`;
    const q = async (method, path, body) => (await (await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "api-key": "q-key" }, body: body && JSON.stringify(body) })).json()).result;
    try {
      assert.ok(await until(async () => (await fetch(`${base}/collections`, { headers: { "api-key": "q-key" } })).ok));
      await q("PUT", "/collections/docs", { vectors: { size: 4, distance: "Cosine" } });
      await q("PUT", "/collections/docs/index?wait=true", { field_name: "lang", field_schema: "keyword" });
      const points = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, vector: [1, i % 7, i % 3, 0.5], payload: { lang: i % 2 ? "en" : "zh", text: `passage ${i}` } }));
      await q("PUT", "/collections/docs/points?wait=true", { points });
      const ledgerFile = join(mkdtempSync(join(tmpdir(), "stores-")), "made.json");
      const keeper = storeKeeper({ ledgerFile });
      const got = await keeper.keep(storesOf({ QDRANT_URL: base, QDRANT_API_KEY: "q-key", QDRANT_COLLECTION: "docs" }));
      const clone = `docs_cortad_${process.pid}`;
      assert.deepEqual(got.env, { QDRANT_COLLECTION: clone });
      assert.deepEqual(got.copies, ["Your app runs against a copy of its Qdrant collection docs, made on the same server, through QDRANT_URL and QDRANT_COLLECTION; the original is not touched, and the copy is deleted when this command ends."]);
      const copy = await q("GET", `/collections/${clone}`);
      assert.equal(copy.points_count, 600);
      assert.equal(copy.payload_schema.lang.data_type, "keyword");
      assert.deepEqual((await q("POST", `/collections/${clone}/points`, { ids: [42], with_payload: true, with_vector: true }))[0].payload, { lang: "en", text: "passage 41" });
      await q("PUT", `/collections/${clone}/points?wait=true`, { points: [{ id: 9999, vector: [0, 0, 1, 1], payload: { text: "made by a trial" } }] });
      assert.equal((await q("GET", "/collections/docs")).points_count, 600, "the original is untouched");
      await keeper.drop();
      assert.deepEqual((await q("GET", "/collections")).collections.map((c) => c.name), ["docs"]);
    } finally { server.kill(); }
  });
});
