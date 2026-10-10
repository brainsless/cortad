import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const readRows = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// The app under the hook, and a turn sent to it: tagged as a trial's, or untagged as the person's.
async function hooked(app, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "held-"));
  const file = join(dir, "trace.jsonl");
  const outbound = join(dir, "outbound.json");
  writeFileSync(join(dir, "app.cjs"), app);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], {
    env: { ...process.env, CORTAD_TRACE_FILE: file, CORTAD_OUTBOUND_FILE: outbound, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  child.stderr.on("data", (d) => { printed += d; });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const turn = (tag, body = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...(tag ? { "x-cortad-turn": tag } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
  return { file, outbound, turn, printed: () => printed, stop: () => child.kill() };
}

// An app whose turn writes out twice, by fetch and by http.request, to hosts off this machine, and
// calls a model. http.request reaches the fake provider on this machine through its own lookup, so
// what arrives there is what would have left.
const APP = `
const http = require("node:http");
const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const { auth } = JSON.parse(body || "{}");
    const fetched = await fetch("https://api.provider.test/v1/charges", { method: "POST", headers: { "content-type": "application/json", authorization: auth || "Bearer live_key_1234" }, body: JSON.stringify({ amount: 5, email: "a@b.co" }) })
      .then((r) => r.json()).catch((e) => ({ error: String((e.cause && e.cause.code) || e.message) }));
    const requested = await new Promise((resolve) => {
      const r = http.request({ host: "hooks.provider.test", port: Number(process.env.FAKE_PORT), path: "/notify", method: "POST", headers: { "content-type": "application/json" }, lookup }, (out) => {
        let t = ""; out.on("data", (c) => { t += c; }); out.on("end", () => resolve({ status: out.statusCode, body: t }));
      });
      r.on("error", (e) => resolve({ error: e.code }));
      r.end(JSON.stringify({ ticket: 9 }));
    });
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }).catch(() => {});
    res.end(JSON.stringify({ fetched, requested }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("a trial's outbound writes are held and answered in the app; the person's, a model call, a test key and a host said yes to pass", async () => {
  const arrived = [];
  const fake = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { arrived.push(b); res.end("{}"); }); });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const { file, outbound, turn, stop } = await hooked(APP, { FAKE_PORT: String(fake.address().port) });
  try {
    const trial = await turn("t1:1");
    assert.match(trial.fetched.id, /^cortad-held-\d+$/);
    assert.deepEqual([trial.fetched.amount, trial.fetched.status], [5, "ok"], "shaped like what the app sent");
    assert.equal(trial.requested.status, 200);
    assert.match(JSON.parse(trial.requested.body).id, /^cortad-held-\d+$/);
    assert.equal(JSON.parse(trial.requested.body).ticket, 9);
    assert.equal(arrived.length, 0, "nothing a trial wrote left the app");

    const person = await turn(null);
    assert.ok(person.fetched.error, "the person's own request goes out as sent");
    assert.deepEqual(arrived, [JSON.stringify({ ticket: 9 })]);

    const sandboxed = await turn("t2:1", { auth: "Bearer sk_test_51Habc" });
    assert.ok(sandboxed.fetched.error, "a test key goes to the provider's sandbox");

    writeFileSync(outbound, JSON.stringify({ pass: ["provider.test"] }));
    await turn("t3:1");
    assert.equal(arrived.length, 2, "a host the person said yes to passes");

    await new Promise((r) => setTimeout(r, 300));
    const rows = readRows(file);
    const held = rows.filter((r) => r.dep?.held);
    assert.deepEqual(held.map((r) => `${r.dep.host} ${r.dep.turn}`).sort(), ["api.provider.test t1:1", "hooks.provider.test t1:1", "hooks.provider.test t2:1"]);
    assert.deepEqual(held.find((r) => r.dep.host === "api.provider.test").dep.called[0], { name: "POST api.provider.test", arguments: JSON.stringify({ amount: 5, email: "a@b.co" }) });
    assert.ok(!readFileSync(file, "utf8").includes("live_key_1234"), "no header value is written");
    assert.ok(rows.some((r) => r.call?.host === "api.openai.com" && r.call.turn === "t1:1"), "a model call is never held");
    assert.ok(rows.filter((r) => r.conn).every((r) => [fake.address().port, 443, 80].includes(r.conn.port)), "the hook's own server is never a store the app reached");
  } finally {
    stop();
    fake.close();
  }
});

// A provider's own test mode, named in the key behind any prefix or in the host. No host here
// resolves, so a call that left fails and a held one is answered.
const SANDBOX_APP = `
require("node:http").createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const { auth, host, path, method, header } = JSON.parse(body);
    const got = await fetch("https://" + host + (path || "/v1/charges"), { method: method || "POST", headers: { [header || "authorization"]: auth }, body: "{}" })
      .then((r) => r.json()).catch((e) => ({ error: String((e.cause && e.cause.code) || e.message) }));
    res.end(JSON.stringify(got));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("a trial's write with a test key behind any prefix, to a provider's sandbox host, or named as a read where every call is a POST goes out as sent; any other is held and says so once in the app's output", async () => {
  const { turn, printed, stop } = await hooked(SANDBOX_APP);
  const live = { auth: "Bearer live_key_1234", host: "api.cortad-nowhere.test" };
  try {
    assert.ok((await turn("t1:1", { auth: "Bearer am_sk_test_abc123", host: "api.cortad-nowhere.test" })).error, "a test key with a longer prefix");
    assert.ok((await turn("t2:1", { auth: "Bearer pdl_sdbx_apikey_01h", host: "api.cortad-nowhere.test" })).error, "a sandbox key");
    assert.ok((await turn("t2:2", { header: "x-api-key", auth: "sk_test_abc123", host: "api.cortad-nowhere.test" })).error, "a test key in x-api-key");
    assert.ok((await turn("t3:1", { auth: "Bearer live_key_1234", host: "api.sandbox.cortad-nowhere.test" })).error, "a sandbox host");
    assert.match((await turn("t4:1", { auth: "Bearer am_sk_live_abc123", host: "api.cortad-nowhere.test" })).id, /^cortad-held-\d+$/);
    assert.match((await turn("t5:1", { auth: "Bearer live_key_1234", host: "sandboxes.cortad-nowhere.test" })).id, /^cortad-held-\d+$/, "a host that only starts like one");
    for (const path of ["/v1/customers.get", "/v1/balances.check", "/v1/billing.preview_attach", "/acme.v1.UserService/GetUser"]) assert.ok((await turn("t6:1", { ...live, path })).error, `${path} reads`);
    for (const path of ["/v1/customers.get_or_create", "/v1/balances.track", "/bookings.check_in", "/v1/credits.check_deduct", "/v1/usage.count_increment", "/billing.v1.Credits/GetAndDeduct", "/acme.v1.UserService/UpdateUser", "/booking.v1.BookingService/CheckIn", "/jobs.v1.Queue/FetchNext", "/lock.v1.Locks/GetLease", "/rest/v1/rpc/get_balance", "/v1.2/check", "/bookings/check-in"]) assert.match((await turn("t7:1", { ...live, path })).id, /^cortad-held-\d+$/, `${path} writes`);
    // The word test outside the key's own prefix is not a test key.
    for (const auth of [`Basic ${Buffer.from("test-admin:LivePass1").toString("base64")}`, "Bearer live-Test-key12345678", "Bearer contest_winner_live_key"]) assert.match((await turn("t9:1", { auth, host: "api.cortad-nowhere.test" })).id, /^cortad-held-\d+$/, auth);
    for (const [method, path] of [["PUT", "/repos/acme/site/contents/config/allow.list"], ["DELETE", "/v1/customers.get"]]) assert.match((await turn("t8:1", { ...live, method, path })).id, /^cortad-held-\d+$/, `${method} ${path} writes`);
    const said = printed().split("\n").filter((l) => l.startsWith("cortad: a request Cortad sent made this app send POST to api.cortad-nowhere.test."));
    assert.deepEqual(said, ["cortad: a request Cortad sent made this app send POST to api.cortad-nowhere.test. Cortad kept that call on this machine and answered it with a stand-in success, since it could change something real. A failure right after this line may come from that stand-in rather than from your code. With that service's test key the call goes out as sent."], "said once per method and host, however many were held");
    assert.ok(!printed().includes("live_key_1234") && !printed().includes("/v1/"), "by host alone: no key and no path");
  } finally {
    stop();
  }
});

// Neon's HTTP driver posts each query, reads too, to its region's API host and names the database in
// a header; a webhook's path is its credential. Neither host resolves, so a call that left fails.
const NEON_APP = `
require("node:http").createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const { db } = JSON.parse(body);
    const read = await fetch("https://api.cortad-nowhere.aws.neon.tech/sql", { method: "POST", headers: { "content-type": "application/json", "Neon-Connection-String": "postgresql://app:pw@" + db + "/shop" }, body: JSON.stringify({ query: "SELECT * FROM orders", params: [] }) })
      .then((r) => r.json()).catch((e) => ({ error: String((e.cause && e.cause.code) || e.message) }));
    await fetch("https://hooks.cortad-nowhere.test/services/T0/B0/s3cretpath", { method: "POST", body: "{}" }).catch(() => {});
    res.end(JSON.stringify({ read }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("a Neon query over HTTP is decided on the database its header names, and a held call is named by its host alone", async () => {
  const { file, outbound, turn, stop } = await hooked(NEON_APP);
  try {
    writeFileSync(outbound, JSON.stringify({ pass: ["ep-branch-1.cortad-nowhere.aws.neon.tech"] }));
    const branch = await turn("t1:1", { db: "ep-branch-1.cortad-nowhere.aws.neon.tech" });
    assert.ok(branch.read.error, "a query to the session's branch goes out");
    const original = await turn("t2:1", { db: "ep-prod-1.cortad-nowhere.aws.neon.tech" });
    assert.match(original.read.id, /^cortad-held-\d+$/, "a query to the original database is held, SQL is no GraphQL read");
    await new Promise((r) => setTimeout(r, 300));
    const held = readRows(file).filter((r) => r.dep?.held);
    assert.deepEqual(held.map((r) => `${r.dep.turn} ${r.dep.called[0].name}`).sort(), ["t1:1 POST hooks.cortad-nowhere.test", "t2:1 POST api.cortad-nowhere.aws.neon.tech", "t2:1 POST hooks.cortad-nowhere.test"]);
    assert.ok(!readFileSync(file, "utf8").includes("s3cretpath"), "a webhook's path never leaves the app");
  } finally {
    stop();
  }
});

// A chat bot that answers its webhook at once and sends the reply later from a worker started at
// boot, outside every request (a WhatsApp or Telegram bot's queue).
const QUEUE_APP = `
const http = require("node:http");
const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
const queue = [];
let wake = null;
(async function worker() {
  for (;;) {
    if (!queue.length) await new Promise((r) => { wake = r; });
    const msg = queue.shift();
    await new Promise((done) => {
      const r = http.request({ host: "wa.provider.test", port: Number(process.env.FAKE_PORT), path: "/send", method: "POST", headers: { "content-type": "application/json" }, lookup }, (out) => { out.resume(); out.on("end", done); });
      r.on("error", done);
      r.end(JSON.stringify({ to: msg.to, text: "reply" }));
    });
  }
})();
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => { queue.push(JSON.parse(body || "{}")); if (wake) { const w = wake; wake = null; w(); } res.end('{"ok":true}'); });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("a worker's write outside every request goes out before a run and is held while one is live", async () => {
  const arrived = [];
  const fake = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { arrived.push(b); res.end("{}"); }); });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const { file, turn, stop } = await hooked(QUEUE_APP, { FAKE_PORT: String(fake.address().port) });
  const settle = () => new Promise((r) => setTimeout(r, 400));
  try {
    await turn(null, { to: "person" });
    await settle();
    assert.deepEqual(arrived, [JSON.stringify({ to: "person", text: "reply" })], "no run yet: the person's queued send goes out");

    await turn("t1:1", { to: "trial" });
    await settle();
    await turn(null, { to: "person-during-run" });
    await settle();
    assert.equal(arrived.length, 1, "while a run is live, nothing a worker writes leaves the app");
    const held = readRows(file).filter((r) => r.dep?.held);
    assert.deepEqual(held.map((r) => [r.dep.host, r.dep.turn ?? null]), [["wa.provider.test", null], ["wa.provider.test", null]]);
  } finally {
    stop();
    fake.close();
  }
});

// An app whose turn asks its analytics database, which takes every query as a POST of its text.
const ANALYTICS_APP = `
const http = require("node:http");
const lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
const query = (sql, host = "ch-cluster.shop.test", path = "/?database=analytics", headers = { "x-clickhouse-user": "default" }) => new Promise((resolve) => {
  const r = http.request({ host, port: Number(process.env.FAKE_PORT), path, method: "POST", headers, lookup }, (out) => {
    let t = ""; out.on("data", (c) => { t += c; }); out.on("end", () => resolve({ status: out.statusCode, body: t }));
  });
  r.on("error", (e) => resolve({ error: e.code }));
  r.end(sql);
});
const fetched = (url, body) => fetch(url, { method: "POST", body }).then((r) => r.json()).catch((e) => ({ error: String((e.cause && e.cause.code) || e.message) }));
http.createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    res.end(JSON.stringify({
      read: await query("SELECT count() FROM events WHERE name = 'insert; drop' -- update\\n FORMAT JSON"),
      schema: await query("SHOW CREATE TABLE events"),
      system: await query("select name from system.columns where table = 'events'"),
      wrote: await query("INSERT INTO events FORMAT JSONEachRow {\\"a\\":1}"),
      second: await query("SELECT 1; DROP TABLE events"),
      nested: await query("WITH gone AS (DELETE FROM events RETURNING *) SELECT * FROM gone"),
      inAddress: await query("", "ch-cluster.shop.test", "/?query=" + encodeURIComponent("ALTER TABLE events DELETE WHERE 1")),
      passedOn: await query("SELECT * FROM TABLE(pg.system.query(query => 'DELETE FROM t RETURNING 1'))"),
      hidden: await query("SELECT 1 /* ' */ ; DROP TABLE events /* ' */"),
      open: await query("SELECT 'a ; DROP TABLE events"),
      escaped: await query(String.raw\`SELECT 'a\\' , n FROM TABLE(pg.system.query(query => 'SELECT pg_terminate_backend(1)')) --'\`),
      analyzed: await query("EXPLAIN ANALYZE INSERT INTO events SELECT * FROM events"),
      asJson: await query(JSON.stringify({ query: "SELECT 1" })),
      elsewhere: await query("SELECT 1", "api.shop.test", "/run", {}),
      byFetch: await fetched("https://ch-cluster.shop.test:8443/?query_id=1", "SELECT 1"),
      byFetchWrote: await fetched("https://ch-cluster.shop.test:8443/?query_id=2", "DROP TABLE events"),
    }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

// databuddy, 2026-10-06: its agent's ClickHouse SELECTs were answered with a stand-in, and it told
// eight people "The query failed".
test("a trial's read of an analytics database goes out as sent and its answer comes back; a write, a second statement, or the same text to any other host is held", async () => {
  const arrived = [];
  const fake = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { arrived.push({ sql: b || new URL(req.url, "http://x").searchParams.get("query"), host: req.headers.host, held: req.headers["x-cortad-held"], user: req.headers["x-clickhouse-user"] }); res.writeHead(200, { "x-clickhouse-summary": "{}" }); res.end('{"data":[{"n":7}]}'); }); });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const { file, turn, stop } = await hooked(ANALYTICS_APP, { FAKE_PORT: String(fake.address().port) });
  try {
    const got = await turn("t1:1");
    for (const name of ["read", "schema", "system"]) assert.deepEqual(got[name], { status: 200, body: '{"data":[{"n":7}]}' }, `${name}: the database's own answer`);
    assert.deepEqual(arrived.map((a) => a.sql), ["SELECT count() FROM events WHERE name = 'insert; drop' -- update\n FORMAT JSON", "SHOW CREATE TABLE events", "select name from system.columns where table = 'events'"], "only the reads left, as sent");
    assert.ok(arrived.every((a) => a.host.startsWith("ch-cluster.shop.test") && a.user === "default" && a.held === undefined), "to the host the app named, with its headers and none of ours");
    for (const name of ["wrote", "second", "nested", "inAddress", "passedOn", "hidden", "open", "escaped", "analyzed", "asJson", "elsewhere"]) assert.match(got[name].body, /cortad-held-\d+/, `${name}: held`);
    assert.equal(got.byFetch.error, "ENOTFOUND", "a read by fetch left this machine");
    assert.match(got.byFetchWrote.id, /^cortad-held-\d+$/);
    const held = readRows(file).filter((r) => r.dep?.held);
    assert.equal(held.length, 12);
    assert.ok(held.every((r) => r.dep.turn === "t1:1"));
  } finally { stop(); fake.close(); }
});

// A Qdrant server as its REST API answers: collections with points, made, read page by page,
// written into and deleted. Every write names the collection it landed in.
function fakeQdrant() {
  const collections = new Map([["docs", [{ id: 1, vector: [0.1, 0.2], payload: { text: "the first page" } }]]]);
  const writes = [];
  const json = (res, result, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ result, status: "ok" })); };
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => { b += c; });
    req.on("end", () => {
      const m = /^\/collections\/([^/?]+)(\/[^?]*)?/.exec(req.url);
      const name = m && decodeURIComponent(m[1]), rest = (m && m[2]) || "";
      const held = name && collections.get(name);
      if (req.headers["api-key"] !== "q-key") return json(res, null, 401);
      if (req.method === "GET" && rest === "") return held ? json(res, { points_count: held.length, config: { params: { vectors: { size: 2, distance: "Cosine" } } }, payload_schema: {} }) : json(res, null, 404);
      if (req.method === "PUT" && rest === "") { collections.set(name, []); writes.push(`create ${name}`); return json(res, true); }
      if (req.method === "DELETE" && rest === "") { collections.delete(name); writes.push(`drop ${name}`); return json(res, true); }
      if (req.method === "POST" && rest === "/points/scroll") return json(res, { points: held ?? [], next_page_offset: null });
      if (req.method === "PUT" && rest === "/points") { held.push(...JSON.parse(b).points); writes.push(`upsert ${name}`); return json(res, { status: "completed" }); }
      if (req.method === "POST" && rest === "/points/search") return json(res, (held ?? []).map((pt) => ({ id: pt.id, score: 1, payload: pt.payload })));
      json(res, null, 404);
    });
  });
  return { server, collections, writes };
}

// An app whose turn writes a point into a Qdrant collection (by fetch, as Qdrant's own client does)
// and another into a second collection by http.request, then searches the first.
const QDRANT_APP = `
const http = require("node:http");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const base = "http://127.0.0.1:" + process.env.QDRANT_PORT;
    const headers = { "content-type": "application/json", "api-key": "q-key" };
    const { who } = JSON.parse(body || "{}");
    const upsert = await fetch(base + "/collections/docs/points?wait=true", { method: "PUT", headers, body: JSON.stringify({ points: [{ id: 7, vector: [0.3, 0.4], payload: { text: "written by " + who } }] }) }).then((r) => r.json());
    const send = (path, payload) => new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: Number(process.env.QDRANT_PORT), path, method: "PUT", headers }, (out) => { let t = ""; out.on("data", (c) => { t += c; }); out.on("end", () => resolve(JSON.parse(t))); });
      r.on("error", (e) => resolve({ error: e.code }));
      r.end(JSON.stringify(payload));
    });
    await send("/collections/notes", { vectors: { size: 2, distance: "Cosine" } });
    const noted = await send("/collections/notes/points", { points: [{ id: 1, vector: [0.5, 0.5], payload: { text: "a note" } }] });
    const found = await fetch(base + "/collections/docs/points/search", { method: "POST", headers, body: JSON.stringify({ vector: [0.3, 0.4], limit: 10 }) }).then((r) => r.json());
    res.end(JSON.stringify({ upsert, noted, found: found.result.map((p) => p.payload.text) }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("a trial's write into a Qdrant collection goes to a copy made on the same server at that first write, every later call to that collection goes to the copy, and the person's own write goes to the original", async () => {
  const { server, collections, writes } = fakeQdrant();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { file, turn, stop } = await hooked(QDRANT_APP, { QDRANT_PORT: String(server.address().port) });
  try {
    const trial = await turn("t1:1", { who: "a trial" });
    const copy = [...collections.keys()].find((name) => /^docs_cortad_\d+$/.test(name));
    assert.ok(copy, `docs was copied under our name: ${[...collections.keys()].join(", ")}`);
    assert.deepEqual(collections.get("docs").map((p) => p.payload.text), ["the first page"], "the original holds only what it held");
    assert.deepEqual(collections.get(copy).map((p) => p.payload.text), ["the first page", "written by a trial"], "the copy holds the original's points and the trial's write");
    assert.deepEqual(trial.found, ["the first page", "written by a trial"], "the trial's search reads the copy, so the app finds what it wrote");
    assert.equal(trial.upsert.status, "ok");
    const notes = [...collections.keys()].find((name) => /^notes_cortad_\d+$/.test(name));
    assert.ok(notes, "a collection the server did not hold is made under our name, by the app's own create");
    assert.equal(trial.noted.status, "ok");
    assert.deepEqual(collections.get(notes).map((p) => p.payload.text), ["a note"], "the app's write by http.request landed in the copy");
    assert.deepEqual(writes.filter((w) => !w.includes("_cortad_")), [], "no write reached a collection of theirs");
    const rows = readRows(file).filter((r) => r.copy);
    assert.deepEqual(rows.map((r) => [r.copy.collection, r.copy.clone, r.copy.base]).sort(), [["docs", copy, `http://127.0.0.1:${server.address().port}`], ["notes", notes, `http://127.0.0.1:${server.address().port}`]], "each copy is reported for the command to delete");
    const again = await turn("t1:2", { who: "the second turn" });
    assert.deepEqual(again.found, ["the first page", "written by a trial", "written by the second turn"], "the same copy serves the rest of the run");
    assert.equal([...collections.keys()].filter((n) => n.startsWith("docs")).length, 2, "one copy per collection");
    const theirs = await turn(null, { who: "the person" });
    assert.deepEqual(collections.get("docs").map((p) => p.payload.text), ["the first page", "written by the person"], "the person's own write, outside a run, goes where it was sent");
    void theirs;
  } finally { stop(); server.close(); }
});
