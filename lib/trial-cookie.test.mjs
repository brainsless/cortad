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

// A trial carried the person's captured cookie beside its own: an app that keys its conversation on a
// cookie read the first of the two, so every trial wrote into the person's one conversation.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };

const APP = (port) => `
  const fs = require("node:fs");
  require("node:http").createServer(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const { trial, first } = JSON.parse(body || "{}");
    fs.appendFileSync(process.env.SEEN, JSON.stringify({ trial, cookie: req.headers.cookie ?? null }) + "\\n");
    if (first) res.setHeader("set-cookie", "conv=" + trial + "; Path=/; HttpOnly");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reply: "ok" }));
  }).listen(${port}, "127.0.0.1");
`;

async function listening(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("a trial's own conversation cookie replaces the captured one of the same name, and stays its own", { timeout: 60_000 }, async () => {
  const queued = [];
  const results = new Map();
  const api = await listening(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const reply = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply({ box: "lo_000000000000000000000003", key: "k" });
    if (req.url.includes("/tree")) return reply({ id: "c", resumed: true });
    if (req.url.endsWith("/app")) return reply({ jobId: "raise" });
    const done = /\/jobs\/([\w-]+)$/.exec(req.url);
    if (done) { results.set(done[1], JSON.parse(body || "{}")); return reply({ ok: true }); }
    if (req.url.includes("/jobs")) { await until(() => queued.length > 0, 500); return reply({ jobs: queued.splice(0) }); }
    reply({ ok: true });
  });
  let n = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-cookie-")));
  const probe = await listening(() => {});
  const port = probe.address().port;
  probe.close();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cookie", version: "1.0.0" }));
  writeFileSync(join(root, "app.js"), APP(port));
  const home = mkdtempSync(join(tmpdir(), "cortad-cookie-home-"));
  mkdirSync(homeOf(projectOf(root), join(home, ".cortad")), { recursive: true });
  writeFileSync(join(homeOf(projectOf(root), join(home, ".cortad")), "token"), "machine-key");
  const seenFile = join(home, "seen");
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmpdir(), SEEN: seenFile, CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}` };
  const child = spawn(process.execPath, [LOCAL, "--token", "--start", `"${process.execPath}" app.js`], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const seen = () => { try { return readFileSync(seenFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const turn = async (trial, at, first) => {
    const id = `j${++n}`;
    queued.push({ id, verb: "fetch", body: { port, path: "/chat", method: "POST", headers: { "content-type": "application/json", Cookie: "sid=person; conv=person", "x-cortad-turn": `${trial}:${at}` }, body: JSON.stringify({ trial, first }) } });
    assert.ok(await until(() => results.has(id), 10_000), out);
    return seen().at(-1).cookie;
  };
  try {
    assert.ok(await until(() => /your app is answering on port/.test(out), 30_000), out);
    assert.equal(await turn("case-1", 1, true), "sid=person; conv=person", "the first turn goes as captured");
    assert.equal(await turn("case-1", 2, false), "sid=person; conv=case-1", "the trial's own conversation, once, in place of the person's");
    assert.equal(await turn("case-2", 1, true), "sid=person; conv=person", "another trial never gets the first one's");
    assert.equal(await turn("case-2", 2, false), "sid=person; conv=case-2");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    api.closeAllConnections();
    api.close();
  }
});
