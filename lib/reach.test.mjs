import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { makeVerbs } from "./verbs.mjs";

const API = "https://cortad.test/api";
const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const memory = () => { let value = null; return { read: () => value, write: (p) => { value = p; } }; };
const SECRET = "s3cr3t-session-token-9f2c";

// A stand-in for the person's app: each request is held 200 ms before its answer, so requests sent
// at once are open together.
async function standIn() {
  const seen = [];
  let open = 0;
  let most = 0;
  const server = createServer(async (req, res) => {
    open += 1;
    most = Math.max(most, open);
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, path: req.url, headers: req.headers, body });
    await new Promise((r) => setTimeout(r, 200));
    open -= 1;
    const [status, said] = req.url === "/api/assist" ? [400, '{"error":"orgId is required"}']
      : req.url === "/api/private" ? [401, `Not signed in with ${req.headers.cookie}`] : [200, '{"reply":"Hello"}'];
    res.writeHead(status, { "content-type": "application/json" }).end(said);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, seen, most: () => most, close: () => new Promise((r) => server.close(r)) };
}

const ready = (path, body = { message: "Hi. What can you help me with?" }) => ({ names: [], method: "POST", path, file: null, line: null, request: { method: "POST", path, body } });
const contact = { proven: [], notCalled: [
  ready("/api/chat"), ready("/api/summarize", { text: "Summarize my week." }), ready("/api/assist"), ready("/api/private"),
  { ...ready("/api/contact", { topic: "Hi. What can you help me with?" }), unsure: true, why: "Listed only because the request its client sends has a \"topic\" field." },
  { names: [], method: "POST", path: "/api/threads/:id/runs", file: null, line: null, byHand: "Its address takes a value from your app's own data." },
] };

// The server answers status; every other address is the app on this machine, asked for real.
const verbsFor = (runner, asked = []) => makeVerbs({ api: API, token: "k", pending: memory(), runner: () => runner,
  fetchImpl: async (url, init) => { asked.push(String(url)); return String(url).startsWith(API) ? json(200, { contact }) : fetch(url, init); } });

test("reach sends every endpoint it has a request for at once, and prints each one's status and time, the app's words where it was not 2xx", async (t) => {
  const app = await standIn();
  t.after(app.close);
  const out = await verbsFor({ state: "up", port: app.port, host: "127.0.0.1" }).reach({ headers: { cookie: `session=${SECRET}`, "x-cortad-turn": "run:1:a" } });
  assert.equal(app.most(), 4, "the four were open at the same time");
  assert.deepEqual(app.seen.map((r) => r.path).sort(), ["/api/assist", "/api/chat", "/api/private", "/api/summarize"]);
  assert.ok(app.seen.every((r) => r.headers.cookie === `session=${SECRET}` && !("x-cortad-turn" in r.headers) && r.headers["content-type"] === "application/json"));
  assert.deepEqual(JSON.parse(app.seen.find((r) => r.path === "/api/summarize").body), { text: "Summarize my week." });
  const lines = out.text.split("\n");
  assert.equal(lines[0], `Sent 4 requests to your app on port ${app.port} at once, with the headers cookie:`);
  assert.match(out.text, /\n {2}POST \/api\/chat: 200 in \d+\.\d seconds\.\n/);
  assert.match(out.text, /\n {2}POST \/api\/assist: 400 in \d+\.\d seconds\. Your app answered: "\{"error":"orgId is required"\}"\n/);
  assert.match(out.text, /\n {2}POST \/api\/private: 401 in \d+\.\d seconds\. Your app answered: "Not signed in with \[sign-in\]"\n/);
  assert.ok(!out.text.includes(SECRET), "a header's value is never printed, even where the app wrote it back");
  assert.deepEqual(lines.slice(5), [
    "Not sent; send these by hand the way their client does:",
    "  POST /api/contact: Cortad is not sure it reaches your model; name its path to reach to send it.",
    "  POST /api/threads/:id/runs: Its address takes a value from your app's own data.",
    "Fix and send by hand only those that did not answer 2xx.",
    "status shows which of them reached your model.",
    "next: status",
  ]);
  assert.equal(out.isError, undefined);
});

test("an endpoint marked by hand is sent when its path is named, and only the named ones are", async (t) => {
  const app = await standIn();
  t.after(app.close);
  const out = await verbsFor({ state: "up", port: app.port, host: "127.0.0.1" }).reach({ paths: ["/api/contact", "/api/nowhere"] });
  assert.deepEqual(app.seen.map((r) => r.path), ["/api/contact"]);
  assert.match(out.text, /^Sent 1 request to your app on port \d+ at once, with no headers:\n {2}POST \/api\/contact: 200 in \d+\.\d seconds\.\nNot among the endpoints no request has reached: \/api\/nowhere\.\nstatus shows which of them reached your model\.\nnext: status$/);
});

test("an app that is not on this machine, or a header that would end its line, is refused and nothing is sent", async (t) => {
  const app = await standIn();
  t.after(app.close);
  for (const host of ["10.0.0.8", "example.com", "0.0.0.0"]) {
    const asked = [];
    const out = await verbsFor({ state: "up", port: app.port, host }, asked).reach({ headers: { cookie: `session=${SECRET}` } });
    assert.equal(out.isError, true);
    assert.equal(out.text, `${host} is not this machine; reach sends only to your app on this machine. Nothing was sent.\nnext: status`);
    assert.ok(asked.every((url) => url.startsWith(API)), "nothing but the status was asked");
  }
  const here = { state: "up", port: app.port, host: "127.0.0.1" };
  const broken = await verbsFor(here).reach({ headers: { cookie: `${SECRET}\r\nx-admin: 1` } });
  assert.equal(broken.text, "The value of the header cookie holds a line break. Nothing was sent.\nnext: status");
  const unnamed = await verbsFor(here).reach({ headers: { [`Bearer ${SECRET}`]: null } });
  assert.ok(unnamed.isError && !unnamed.text.includes(SECRET));
  assert.equal((await verbsFor(null).reach({})).text, "No connect command is running for this repository, so no app is up on this machine. Nothing was sent.\nnext: status");
  assert.deepEqual(app.seen, []);
});

// The server names the endpoint and prepares its request; the command sends only that endpoint's own.
test("reach never sends a request prepared for one endpoint to another address, nor one to an address that administers the app", async (t) => {
  const app = await standIn();
  t.after(() => app.close());
  const steered = { proven: [], notCalled: [
    { names: [], method: "POST", path: "/api/chat", file: null, line: null, request: { method: "POST", path: "/api/admin/delete-everything", body: {} } },
    { names: [], method: "POST", path: "/api/threads/:id/runs", file: null, line: null, request: { method: "POST", path: "/api/threads/t_1/runs", body: { message: "Hi." } } },
    { names: [], method: "POST", path: "/api/settings/model", file: null, line: null, request: { method: "POST", path: "/api/settings/model", body: { model: "x" } } },
  ] };
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), runner: () => ({ state: "up", port: app.port, host: "127.0.0.1" }),
    fetchImpl: async (url, init) => (String(url).startsWith(API) ? json(200, { contact: steered }) : fetch(url, init)) });
  const { text: out } = await verbs.reach({ headers: { cookie: `session=${SECRET}` } });
  assert.match(out, /POST \/api\/chat: not sent, the request prepared for it goes to another address\./);
  assert.match(out, /POST \/api\/settings\/model: not sent, its address says it administers your app\./);
  assert.match(out, /POST \/api\/threads\/:id\/runs: 200 in /, "a value filled into the listed address is still that endpoint");
  assert.deepEqual(app.seen.map((r) => r.path), ["/api/threads/t_1/runs"], "only the one that is its endpoint's own left the command");
});
