import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const readRows = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

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
  const dir = mkdtempSync(join(tmpdir(), "held-"));
  const file = join(dir, "trace.jsonl");
  const outbound = join(dir, "outbound.json");
  writeFileSync(join(dir, "app.cjs"), APP);
  const arrived = [];
  const fake = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { arrived.push(b); res.end("{}"); }); });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], {
    env: { ...process.env, CORTAD_TRACE_FILE: file, CORTAD_OUTBOUND_FILE: outbound, FAKE_PORT: String(fake.address().port) }, stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    const turn = (tag, body = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json", ...(tag ? { "x-cortad-turn": tag } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());

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
    assert.deepEqual(JSON.parse(held.find((r) => r.dep.host === "api.provider.test").dep.called[0].arguments), { amount: 5, email: "a@b.co" });
    assert.ok(!readFileSync(file, "utf8").includes("live_key_1234"), "no header value is written");
    assert.ok(rows.some((r) => r.call?.host === "api.openai.com" && r.call.turn === "t1:1"), "a model call is never held");
    assert.ok(rows.filter((r) => r.conn).every((r) => [fake.address().port, 443, 80].includes(r.conn.port)), "the hook's own server is never a store the app reached");
  } finally {
    child.kill();
    fake.close();
  }
});
