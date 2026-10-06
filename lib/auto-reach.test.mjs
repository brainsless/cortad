import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

// The whole command against a real small app and a stand-in for our API: the app is started while the
// code is still being sent, and once status lists an endpoint the command tests it by itself.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await done()) return true; return done(); };

// The command, connected with these env lines, beside a stand-in for our API that lists one endpoint.
async function connect(t, envText) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-auto-")));
  const home = mkdtempSync(join(tmpdir(), "cortad-auto-home-"));
  const base = join(home, ".cortad");
  mkdirSync(homeOf(projectOf(root), base), { recursive: true });
  writeFileSync(join(homeOf(projectOf(root), base), "token"), "machine-key");
  const seen = join(home, "seen.jsonl");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "auto", version: "1.0.0" }));
  writeFileSync(join(root, ".env"), envText);
  writeFileSync(join(root, "app.js"), `
    const fs = require("node:fs");
    fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ start: Date.now() }) + "\\n");
    require("node:http").createServer((q, r) => {
      if (q.method !== "HEAD" && q.url !== "/") fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ method: q.method, url: q.url, turn: q.headers["x-cortad-turn"], origin: q.headers.origin }) + "\\n");
      r.end(JSON.stringify({ reply: "Hello" }));
    }).listen(0, "127.0.0.1");
  `);

  const c = { treeAt: 0, out: "" };
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply(200, { box: "lo_000000000000000000000001", key: "k" });
    if (req.url.includes("/tree")) { await new Promise((r) => setTimeout(r, 1500)); c.treeAt = Date.now(); return reply(200, { id: "c" }); }
    if (req.url.startsWith("/api/mcp/status")) {
      assert.equal(req.headers.authorization, "Bearer machine-key");
      return reply(200, { read: { complete: false }, contact: { proven: [], notCalled: [{ names: [], method: "POST", path: "/api/chat", file: "app.js", line: 4, request: { method: "POST", path: "/api/chat", body: { message: "Hi" } } }] } });
    }
    if (req.url.includes("/jobs")) return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
    return reply(200, { ok: true });
  }).listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());

  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}`, CORTAD_NO_REGISTER: "1" };
  const child = spawn(process.execPath, [LOCAL, "ABCD2345", "--start", `"${process.execPath}" app.js`], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { c.out += d; });
  child.stderr.on("data", (d) => { c.out += d; });
  t.after(() => child.kill("SIGINT"));
  c.rows = () => { try { return readFileSync(seen, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return c;
}

test("the connect command starts the app during the upload and tests each listed endpoint by itself, tagged as its own", { timeout: 60_000 }, async (t) => {
  // A hosted address listed first is no page of the app's: the local one is its Origin.
  const c = await connect(t, "NEXT_PUBLIC_SITE_URL=https://example.com\nFRONTEND_URL=http://localhost:5173\n");
  assert.ok(await until(() => /tested 1 endpoint: 1 answered/.test(c.out), 40_000), c.out);
  const [started, ...asked] = c.rows();
  assert.ok(started.start < c.treeAt, "the app started before the upload ended");
  assert.deepEqual(asked, [{ method: "POST", url: "/api/chat", turn: "reach:auto:1", origin: "http://localhost:5173" }]);
  await new Promise((r) => setTimeout(r, 6_000));
  assert.equal(c.rows().length, 2, "an endpoint is tested once per connection");
});

// A store off this machine that no copy could be made of holds Run until the person says yes, and
// Cortad's own test requests with it: they would write into the person's real data.
test("no test request reaches an app whose hosted store waits for the person's yes", { timeout: 60_000 }, async (t) => {
  const c = await connect(t, "DATABASE_URL=postgres://app:pw@db.example-hosted.com:5432/prod\n");
  assert.ok(await until(() => /Go back to the browser/.test(c.out), 40_000), c.out);
  await new Promise((r) => setTimeout(r, 8_000));
  assert.deepEqual(c.rows().slice(1), [], c.out);
});
