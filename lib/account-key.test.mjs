// The key a folder keeps follows the account that last connected it: a new account connected by its
// code on a laptop that held another account's key kept the old key, and the coding agent's tools
// read the other account's failed run, its endpoints and its plan.
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

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");

async function connectWith(args) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-key-")));
  writeFileSync(join(root, "app.js"), "require('node:http').createServer((q, s) => s.end('ok')).listen(process.env.PORT);\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "key-test", scripts: { start: "node app.js" } }));
  const home = mkdtempSync(join(tmpdir(), "cortad-key-home-"));
  const project = homeOf(projectOf(root), join(home, ".cortad"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "token"), "cm_old_account");
  const seen = { attach: null, asked: null };
  let uploaded;
  const done = new Promise((r) => { uploaded = r; });
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const reply = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") { seen.attach = { body: JSON.parse(body), auth: req.headers.authorization ?? null }; return reply({ box: "lo_0123456789abcdef01234567", key: "k" }); }
    if (req.url.includes("/tree") && req.url.includes("last=1")) {
      seen.asked = req.headers["x-cortad-machine"] ?? null;
      reply({ id: "c", resumed: true, ...(seen.asked ? { machineKey: "cm_new_account" } : {}) });
      return setTimeout(uploaded, 200);
    }
    if (req.url.includes("/jobs")) return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
    reply({ ok: true });
  }).listen(0, "127.0.0.1");
  await once(api, "listening");
  const child = spawn(process.execPath, [LOCAL, ...args, "--start", "node app.js"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), CORTAD_NO_REGISTER: "1", CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}` }, stdio: "ignore",
  });
  await Promise.race([done, once(child, "exit"), new Promise((r) => setTimeout(r, 60_000))]);
  child.kill("SIGKILL");
  api.close();
  return { ...seen, token: readFileSync(join(project, "token"), "utf8").trim() };
}

test("a connect by a code replaces the key the folder kept from another account", async () => {
  const r = await connectWith(["ABCD2345"]);
  assert.equal(r.attach?.body.code, "ABCD2345");
  assert.ok(r.asked, "the upload asks for this account's own key");
  assert.equal(r.token, "cm_new_account");
});

test("a connect with no code signs in by the kept key and keeps it", async () => {
  const r = await connectWith([]);
  assert.equal(r.attach?.auth, "Bearer cm_old_account");
  assert.equal(r.asked, null);
  assert.equal(r.token, "cm_old_account");
});
