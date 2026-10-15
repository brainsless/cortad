import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { storeKeeper, storesOf } from "./stores.mjs";

// Stores of the test's own, each in a container started here the way a repository's compose file
// starts one, and copies made by the real keeper. Run only where Docker runs and holds the images:
// a test never pulls gigabytes.
const MONGO = "mongo:7.0.14";
const ELASTIC = "docker.elastic.co/elasticsearch/elasticsearch:8.15.0";
const sh = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const has = (image) => { try { sh(["image", "inspect", image]); return true; } catch { return false; } };
const onPath = (bin) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const until = async (ok, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1000))) { try { if (await ok()) return true; } catch { /* not yet */ } } return false; };
const ledgerOf = () => join(mkdtempSync(join(tmpdir(), "copies-")), "made.json");
const gone = (name) => sh(["ps", "-a", "-q", "--filter", `name=^${name}$`]) === "";
const volumesOf = (name) => JSON.parse(sh(["inspect", "-f", "{{json .Mounts}}", name])).filter((m) => m.Type === "volume").map((m) => m.Name);
const volumeGone = (v) => { try { sh(["volume", "inspect", v]); return false; } catch { return true; } };

describe("a MongoDB whose databases the app names in its code", { skip: (!has(MONGO) || !onPath("mongosh")) && `Docker with ${MONGO}, and mongosh, are needed` }, () => {
  const mongosh = (uri, script) => execFileSync("mongosh", ["--quiet", uri, "--eval", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  // Every collection's contents and every database's name, as the server hashes them.
  const fingerprint = (uri) => mongosh(uri, "const out = {}; for (const d of db.adminCommand({ listDatabases: 1, nameOnly: true }).databases) out[d.name] = d.name === 'local' || d.name === 'config' ? null : db.getSiblingDB(d.name).runCommand({ dbHash: 1 }).md5; print(JSON.stringify(out))");

  test("is copied whole into a container of ours, signs in there as before, and is removed after with its volumes", { timeout: 240_000 }, async () => {
    const port = await freePort();
    const original = `cortad-test-mongo-${process.pid}`;
    sh(["run", "-d", "--name", original, "-p", `127.0.0.1:${port}:27017`, "-e", "MONGO_INITDB_ROOT_USERNAME=root", "-e", "MONGO_INITDB_ROOT_PASSWORD=r00t-pw", MONGO]);
    const uri = `mongodb://root:r00t-pw@127.0.0.1:${port}/?authSource=admin`;
    try {
      assert.ok(await until(() => mongosh(uri, "db.runCommand({ ping: 1 }).ok") === "1", 60_000));
      mongosh(uri, "const r = db.getSiblingDB('research'); r.legislation.insertMany([{ cite: 'art 178' }, { cite: 'art 171' }, { cite: 'art 23' }]); r.legislation.createIndex({ cite: 1 }); r.threads.insertOne({ _id: 'seed', status: 'answered' })");
      const before = fingerprint(uri);
      const ledgerFile = ledgerOf();
      const keeper = storeKeeper({ ledgerFile });
      const got = await keeper.keep(storesOf({ MONGO_URI: uri }));
      assert.deepEqual(got.blocked, []);
      assert.deepEqual(got.copies, ["Your app runs against a copy of its whole MongoDB server, made in a Docker container of ours, through MONGO_URI; the original is not touched, and the container is deleted when this command ends and made again from the original at the next connect."]);
      const ours = Number(/^mongodb:\/\/root:r00t-pw@127\.0\.0\.1:(\d+)\/\?authSource=admin$/.exec(got.env.MONGO_URI)?.[1]);
      assert.ok(ours && ours !== port, got.env.MONGO_URI);
      assert.equal(mongosh(got.env.MONGO_URI, "db.getSiblingDB('research').legislation.countDocuments()"), "3", "the app's own sign-in works on the copy");
      assert.throws(() => mongosh(`mongodb://127.0.0.1:${ours}/?directConnection=true`, "db.getSiblingDB('research').legislation.countDocuments()"), "the copy asks for a password as the original does");
      assert.equal(mongosh(got.env.MONGO_URI, "db.getSiblingDB('admin').system.users.countDocuments({ user: /^cortad_/ })"), "0", "the user that restored it is gone");
      assert.equal(mongosh(got.env.MONGO_URI, "db.getSiblingDB('research').legislation.getIndexes().length"), "2", "the index came with it");
      mongosh(got.env.MONGO_URI, "db.getSiblingDB('research').threads.insertOne({ _id: 'a trial', status: 'pending' }); db.getSiblingDB('made_by_a_trial').x.insertOne({})");
      assert.equal(fingerprint(uri), before, "the original holds the same bytes and the same databases");
      const [row] = JSON.parse(readFileSync(ledgerFile, "utf8"));
      assert.equal(row.kind, "server");
      const volumes = volumesOf(row.made);
      await keeper.drop();
      assert.ok(gone(row.made), "our container is gone");
      assert.ok(volumes.length > 0 && volumes.every(volumeGone), "and its volumes with it");
      assert.deepEqual(JSON.parse(readFileSync(ledgerFile, "utf8")), []);
    } finally { sh(["rm", "-f", "-v", original]); }
  });

  test("a replica set that asks for a password is copied as one of the same name that asks too, so the app's address finds its member", { timeout: 240_000 }, async () => {
    const port = await freePort();
    const original = `cortad-test-rsauth-${process.pid}`;
    const keyed = 'umask 077; head -c 756 /dev/urandom | base64 > /tmp/k; chown mongodb /tmp/k; exec docker-entrypoint.sh mongod "$@"';
    sh(["run", "-d", "--name", original, "-p", `127.0.0.1:${port}:${port}`, "--entrypoint", "bash", MONGO, "-c", keyed, "bash", "--port", String(port), "--bind_ip_all", "--replSet", "rs0", "--auth", "--keyFile", "/tmp/k"]);
    const inside = (script) => sh(["exec", original, "mongosh", "--quiet", "--port", String(port), "--eval", script]);
    try {
      assert.ok(await until(() => inside("db.runCommand({ ping: 1 }).ok") === "1", 60_000));
      inside(`rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:${port}' }] })`);
      assert.ok(await until(() => inside("db.hello().isWritablePrimary") === "true", 60_000));
      inside("db.getSiblingDB('admin').createUser({ user: 'root', pwd: 'r00t-pw', roles: ['root'] })");
      const uri = `mongodb://root:r00t-pw@127.0.0.1:${port}/?replicaSet=rs0&authSource=admin`;
      mongosh(uri, "db.getSiblingDB('shop').orders.insertOne({ item: 'a real order' })");
      const keeper = storeKeeper({ ledgerFile: ledgerOf() });
      const got = await keeper.keep(storesOf({ MONGODB_URL: uri }));
      assert.deepEqual(got.blocked, []);
      assert.match(got.env.MONGODB_URL, /^mongodb:\/\/root:r00t-pw@127\.0\.0\.1:\d+\/\?replicaSet=rs0&authSource=admin$/);
      assert.equal(mongosh(got.env.MONGODB_URL, "db.getSiblingDB('shop').orders.countDocuments()"), "1");
      assert.equal(mongosh(got.env.MONGODB_URL, "rs.status().set"), "rs0");
      await keeper.drop();
    } finally { sh(["rm", "-f", "-v", original]); }
  });

  test("a replica set is copied as one of the same name, so the app's address finds its member", { timeout: 240_000 }, async () => {
    const port = await freePort();
    const original = `cortad-test-rs-${process.pid}`;
    sh(["run", "-d", "--name", original, "-p", `127.0.0.1:${port}:${port}`, MONGO, "--port", String(port), "--bind_ip_all", "--replSet", "rs0"]);
    const direct = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    try {
      assert.ok(await until(() => mongosh(direct, "db.runCommand({ ping: 1 }).ok") === "1", 60_000));
      mongosh(direct, `rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:${port}' }] })`);
      assert.ok(await until(() => mongosh(direct, "db.hello().isWritablePrimary") === "true", 60_000));
      const uri = `mongodb://127.0.0.1:${port}/?replicaSet=rs0`;
      mongosh(uri, "db.getSiblingDB('shop').orders.insertOne({ item: 'a real order' })");
      const keeper = storeKeeper({ ledgerFile: ledgerOf() });
      const got = await keeper.keep(storesOf({ MONGODB_URL: uri }));
      assert.match(got.env.MONGODB_URL, /^mongodb:\/\/127\.0\.0\.1:\d+\/\?replicaSet=rs0$/);
      assert.equal(mongosh(got.env.MONGODB_URL, "db.getSiblingDB('shop').orders.countDocuments()"), "1");
      assert.equal(mongosh(got.env.MONGODB_URL, "rs.status().set"), "rs0");
      await keeper.drop();
    } finally { sh(["rm", "-f", "-v", original]); }
  });
});

describe("an Elasticsearch whose indexes the app names in its code", { skip: !has(ELASTIC) && `Docker with ${ELASTIC} is needed` }, () => {
  const es = (base, method, path, body) => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("elastic:el4stic-pw").toString("base64")}` }, body: body && JSON.stringify(body) }).then((r) => r.json());
  // Every index's name, settings that are its own, mappings, aliases and documents with their versions.
  const fingerprint = async (base) => {
    const indexes = (await es(base, "GET", "/_cat/indices?format=json&h=index")).map((i) => i.index).filter((i) => !i.startsWith(".")).sort();
    const out = [];
    for (const index of indexes) {
      const held = (await es(base, "GET", `/${index}`))[index];
      const docs = (await es(base, "POST", `/${index}/_search`, { size: 1000, seq_no_primary_term: true, version: true })).hits.hits.map((h) => [h._id, h._routing, h._version, h._seq_no, h._source]).sort((a, b) => a[0].localeCompare(b[0]));
      out.push([index, held.mappings, held.aliases, held.settings.index.uuid, docs]);
    }
    return createHash("sha256").update(JSON.stringify(out)).digest("hex");
  };

  test("is copied whole into a container of ours with its analyzers, aliases and documents, signed in through the settings beside it, and removed after", { timeout: 420_000 }, async () => {
    const port = await freePort();
    const original = `cortad-test-es-${process.pid}`;
    sh(["run", "-d", "--name", original, "-p", `127.0.0.1:${port}:9200`, "-e", "discovery.type=single-node", "-e", "xpack.security.enabled=true", "-e", "xpack.security.http.ssl.enabled=false", "-e", "ELASTIC_PASSWORD=el4stic-pw", "-e", "ES_JAVA_OPTS=-Xms512m -Xmx512m", "-e", "cluster.routing.allocation.disk.threshold_enabled=false", ELASTIC]);
    const base = `http://127.0.0.1:${port}`;
    try {
      assert.ok(await until(async () => (await es(base, "GET", "/_cluster/health?wait_for_status=yellow&timeout=1s")).status, 180_000));
      await es(base, "PUT", "/legislation", {
        settings: { index: { number_of_shards: 2, analysis: { analyzer: { legal: { type: "custom", tokenizer: "standard", filter: ["lowercase", "arabic_normalization"] } } } } },
        mappings: { properties: { cite: { type: "keyword" }, text: { type: "text", analyzer: "legal" } } },
        aliases: { laws: {} },
      });
      for (const [id, doc] of [["178", { cite: "art 178", text: "مدة الاستئناف ثلاثون يوماً" }], ["171", { cite: "art 171", text: "تصرف الفضولي" }], ["23", { cite: "art 23", text: "إنهاء عقد العمل" }]]) await es(base, "PUT", `/legislation/_doc/${id}?refresh=true`, doc);
      await es(base, "PUT", "/legislation/_doc/routed?routing=jo&refresh=true", { cite: "routed", text: "نص" });
      const before = await fingerprint(base);
      const ledgerFile = ledgerOf();
      const keeper = storeKeeper({ ledgerFile });
      const got = await keeper.keep(storesOf({ ELASTICSEARCH_URL: base, ELASTIC_PASSWORD: "el4stic-pw" }));
      assert.deepEqual(got.blocked, []);
      assert.deepEqual(got.copies, ["Your app runs against a copy of its whole Elasticsearch server, made in a Docker container of ours, through ELASTICSEARCH_URL; the original is not touched, and the container is deleted when this command ends and made again from the original at the next connect."]);
      const ours = got.env.ELASTICSEARCH_URL;
      assert.match(ours, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal((await es(ours, "POST", "/laws/_search", { query: { match: { text: "الاستئناف" } } })).hits.hits[0]._id, "178", "the alias and the analyzer came with it, and the app's own sign-in is taken");
      assert.equal((await es(ours, "GET", "/legislation/_doc/routed?routing=jo")).found, true, "a routed document keeps its routing");
      assert.equal((await es(ours, "GET", "/legislation/_count")).count, 4);
      await es(ours, "PUT", "/legislation/_doc/by-a-trial?refresh=true", { cite: "made by a trial" });
      await es(ours, "PUT", "/asks/_doc/1?refresh=true", { asked: "made by a trial" });
      assert.equal(await fingerprint(base), before, "the original holds the same indexes and documents at the same versions");
      assert.equal((await fetch(`${ours}/legislation/_count`)).status, 401, "the copy asks for the sign-in the original does");
      const [row] = JSON.parse(readFileSync(ledgerFile, "utf8"));
      await keeper.drop();
      assert.ok(gone(row.made));
      // The app signs in as a user of its own: that user is made on the copy with the same password.
      await es(base, "PUT", "/_security/user/research_app", { password: "app-pass-123", roles: ["superuser"] });
      const own = storeKeeper({ ledgerFile });
      const signed = await own.keep(storesOf({ ELASTICSEARCH_URL: `http://research_app:app-pass-123@127.0.0.1:${port}` }));
      const at = new URL(signed.env.ELASTICSEARCH_URL);
      assert.equal(at.username, "research_app");
      const asApp = await fetch(`http://127.0.0.1:${at.port}/legislation/_count`, { headers: { authorization: `Basic ${Buffer.from("research_app:app-pass-123").toString("base64")}` } });
      assert.equal((await asApp.json()).count, 4);
      await own.drop();
      // An API key cannot be made again on a copy: the store holds Run, and no copy is started.
      const { encoded } = await es(base, "POST", "/_security/api_key", { name: "app" });
      const keyed = await storeKeeper({ ledgerFile }).keep(storesOf({ ELASTICSEARCH_URL: base, ELASTIC_API_KEY: encoded }));
      assert.deepEqual(keyed.blocked.map((b) => b.why), ["ELASTICSEARCH_URL points at the Elasticsearch server on this machine, and your app signs in to it in a way a copy of it cannot be given, so test conversations would save into it. Point ELASTICSEARCH_URL at a scratch server, or sign in with a user and password, then run the connect command again."]);
      assert.equal(sh(["ps", "-a", "-q", "--filter", "label=cortad.copy=1", "--filter", `name=cortad-elasticsearch-${process.pid}-`]), "");
    } finally { sh(["rm", "-f", "-v", original]); }
  });
});

describe("a copy a session left when it died", { skip: !has(MONGO) && `Docker with ${MONGO} is needed` }, () => {
  test("is removed by the next session's first look, with its volumes", { timeout: 60_000 }, async () => {
    const left = `cortad-mongo-999999-${process.pid}`;
    sh(["run", "-d", "--name", left, "--label", "cortad.copy=1", MONGO]);
    const volumes = volumesOf(left);
    const ledgerFile = ledgerOf();
    writeFileSync(ledgerFile, JSON.stringify([{ kind: "server", key: "mongo|localhost|27017|", made: left, pid: 999_999 }]));
    await storeKeeper({ ledgerFile }).keep([]);
    assert.ok(gone(left));
    assert.ok(volumes.every(volumeGone));
    assert.deepEqual(JSON.parse(readFileSync(ledgerFile, "utf8")), []);
  });
});

