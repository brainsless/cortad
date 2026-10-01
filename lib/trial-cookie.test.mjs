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

// The whole command against a small app, a stand-in for our API handing it trial requests that carry
// the person's captured cookies.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };

async function listening(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

// `app(port)`: the app's source. Each POST it answers is logged to SEEN as {trial, cookie}.
async function connected(app, captured) {
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-cookie-")));
  const probe = await listening(() => {});
  const port = probe.address().port;
  probe.close();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cookie", version: "1.0.0" }));
  writeFileSync(join(root, "app.js"), app(port));
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
  let n = 0;
  const turn = async (trial, at, first) => {
    const id = `j${++n}`;
    queued.push({ id, verb: "fetch", body: { port, path: "/chat", method: "POST", headers: { "content-type": "application/json", Cookie: captured, "x-cortad-turn": `${trial}:${at}` }, body: JSON.stringify({ trial, first }) } });
    assert.ok(await until(() => results.has(id), 10_000), out);
    return { status: results.get(id).status, cookie: seen().filter((r) => r.trial === trial).at(-1)?.cookie ?? null };
  };
  assert.ok(await until(() => /your app is answering on port/.test(out), 30_000), out);
  return {
    turn,
    stop: async () => { child.kill("SIGTERM"); await once(child, "exit"); api.closeAllConnections(); api.close(); },
  };
}

// A trial carried the person's captured cookie beside its own: an app that keys its conversation on a
// cookie read the first of the two, so every trial wrote into the person's one conversation.
test("a trial's own conversation cookie replaces the captured one of the same name, and stays its own", { timeout: 60_000 }, async () => {
  const app = await connected((port) => `
    const fs = require("node:fs");
    require("node:http").createServer(async (req, res) => {
      let body = "";
      for await (const d of req) body += d;
      if (req.method !== "POST") return res.end();
      const { trial, first } = JSON.parse(body || "{}");
      fs.appendFileSync(process.env.SEEN, JSON.stringify({ trial, cookie: req.headers.cookie ?? null }) + "\\n");
      if (first) res.setHeader("set-cookie", "conv=" + trial + "; Path=/; HttpOnly");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ reply: "ok" }));
    }).listen(${port}, "127.0.0.1");
  `, "sid=person; conv=person");
  try {
    assert.equal((await app.turn("case-1", 1, true)).cookie, "sid=person; conv=person", "the first turn goes as captured");
    assert.equal((await app.turn("case-1", 2, false)).cookie, "sid=person; conv=case-1", "the trial's own conversation, once, in place of the person's");
    assert.equal((await app.turn("case-2", 1, true)).cookie, "sid=person; conv=person", "another trial never gets the first one's");
    assert.equal((await app.turn("case-2", 2, false)).cookie, "sid=person; conv=case-2");
  } finally { await app.stop(); }
});

// AI Answers hands every new visitor a session and answers one message at a time per session. Every
// trial carried the agent's one session, so trials were refused "already in progress" while the
// agent's own chat ran. An app that refuses a new visitor keeps the person's session.
const VISITORS = (signedIn) => (port) => `
  const fs = require("node:fs");
  let n = 0;
  require("node:http").createServer(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const sid = /(?:^|;\\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!sid) res.setHeader("set-cookie", "sid=visitor-" + (++n) + "; Path=/; HttpOnly");
    if (req.method !== "POST") return res.end();
    const { trial } = JSON.parse(body || "{}");
    fs.appendFileSync(process.env.SEEN, JSON.stringify({ trial, cookie: req.headers.cookie ?? null }) + "\\n");
    if (${signedIn} && sid !== "person") { res.statusCode = 401; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ reply: "ok" }));
  }).listen(${port}, "127.0.0.1");
`;

test("each trial gets its own visitor session, and an app that refuses a new visitor gets the person's", { timeout: 90_000 }, async () => {
  const open = await connected(VISITORS(false), "sid=person; lang=en");
  try {
    const one = await open.turn("case-1", 1);
    const two = await open.turn("case-2", 1);
    assert.match(one.cookie, /^sid=visitor-\d+; lang=en$|^lang=en; sid=visitor-\d+$/);
    assert.notEqual(one.cookie, two.cookie, "two trials, two sessions");
    assert.equal((await open.turn("case-1", 2)).cookie, one.cookie, "a trial keeps its own session from turn to turn");
  } finally { await open.stop(); }

  const closed = await connected(VISITORS(true), "sid=person");
  try {
    assert.deepEqual(await closed.turn("case-1", 1), { status: 200, cookie: "sid=person" }, "refused as a new visitor, it goes as the person");
    assert.deepEqual(await closed.turn("case-2", 1), { status: 200, cookie: "sid=person" });
  } finally { await closed.stop(); }
});
