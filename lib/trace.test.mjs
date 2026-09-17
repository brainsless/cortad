import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A small app under the hook: one route calls a model (a host that does not resolve; the hook notes
// the call as it is made, not when it answers), one route does not.
const APP = `
const http = require("node:http");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    if (req.url === "/api/talk") await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: JSON.parse(body).text }] }) }).catch(() => {});
    res.end(JSON.stringify({ ok: true, got: body.length }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("the request during which the app called a model is written down, with its body and sign-in; others are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), APP);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer their-session" }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await post("/api/save", { title: "not a chat" })).ok, true);
  const answered = await post("/api/talk", { text: "hello from me", thread: 7 });
  assert.equal(answered.got, JSON.stringify({ text: "hello from me", thread: 7 }).length, "the app still read its own body whole");
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].hello, "node", "the hook says it is there");
  const rows = lines.filter((l) => !l.hello);
  assert.equal(rows.length, 1);
  assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /api/talk");
  assert.deepEqual(JSON.parse(rows[0].body), { text: "hello from me", thread: 7 });
  assert.equal(rows[0].headers.authorization, "Bearer their-session");
  assert.match(rows[0].sent, /hello from me/);
});
