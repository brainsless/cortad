import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proofsOf, replyOf } from "./proof.mjs";
import { makeCapture, sourceFinder, withoutCarriers } from "./replay.mjs";

// Real apps under the real hooks: each door holds a conversation its own way, a client drives two
// turns through it the way the app's own client would, and the proof is read off what was recorded.
const HOOK = new URL("./trace.cjs", import.meta.url).pathname;
const PYHOOK = new URL("./pyhook/", import.meta.url).pathname;
const PY = new URL("../.scratch/py-app/.venv/bin/python", import.meta.url).pathname;
const rowsOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setTimeout(r, 400));

function inFolder(name) {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  copyFileSync(new URL(`./${name}`, import.meta.url), join(dir, name));
  return dir;
}

async function nodeApp(env = {}) {
  const dir = inFolder("proof-app.cjs");
  const file = join(dir, "trace.jsonl");
  const child = spawn(process.execPath, ["--require", HOOK, "proof-app.cjs"], { cwd: dir, env: { ...process.env, CORTAD_TRACE_FILE: file, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { dir, file, child, post };
}

// Two turns on each of the Node app's doors, each the way that door's own client holds a conversation.
async function twoTurns(post) {
  const first = await (await post("/api/chat", { message: "a weekend in Lisbon" }, { authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" })).json();
  await (await post("/api/chat", { message: "the leak season in Porto", sessionId: first.sessionId }, { authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" })).json();
  const streamed = await (await post("/api/stream", { messages: [{ role: "user", content: "hiking in Madeira" }] })).text();
  const said = streamed.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).content ?? "").join("");
  await (await post("/api/stream", { messages: [{ role: "user", content: "hiking in Madeira" }, { role: "assistant", content: said }, { role: "user", content: "the Azores in winter" }] })).text();
  for (const text of ["museums in Madrid", "tapas near Retiro"]) await (await post("/api/threads/t-8f3a2c9d1e7b4a6c/messages", { text })).json();
  for (const q of ["trains from Paris to Nice", "night trains to Vienna"]) await (await post("/api/assist", { q }, { "x-conversation": "c-7d1e2f3a4b5c6d7e8f9a" })).text();
  for (let i = 0; i < 2; i++) await (await post("/api/once", { message: "a day trip to Sintra" })).json();
  await (await post("/api/once", { message: "the code for a trip card" })).json();
  await (await post("/api/broken", { message: "is it raining in Rome" })).json();
}

test("Node: each door's ask, session, reply and model are read off two real turns", async () => {
  const app = await nodeApp();
  try { await twoTurns(app.post); await settle(); } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const of = (key) => proofs.get(key)?.proof;
  assert.deepEqual([...proofs.keys()].sort(), ["POST /api/assist", "POST /api/broken", "POST /api/chat", "POST /api/once", "POST /api/stream", "POST /api/threads/{id}/messages"]);

  assert.deepEqual(of("POST /api/chat").session, { held: true, carrier: "body", key: "sessionId", minted: "app" }, "the id the app handed back in its first reply");
  assert.deepEqual([of("POST /api/chat").askField, of("POST /api/chat").replyPath, of("POST /api/chat").stream], ["message", "reply", false]);
  assert.deepEqual([of("POST /api/chat").exchanges, of("POST /api/chat").modelCalls, of("POST /api/chat").model], [2, 1, "fixture-model"]);
  assert.deepEqual(of("POST /api/chat").tokens, { prompt: 50, completion: 12 }, "the provider's own counts, the median of the two turns");
  assert.equal(typeof of("POST /api/chat").replySeconds, "number");

  assert.deepEqual(of("POST /api/stream").session, { held: true, carrier: "history", key: "messages" });
  assert.deepEqual([of("POST /api/stream").askField, of("POST /api/stream").replyPath, of("POST /api/stream").stream], ["messages", null, true]);
  assert.equal(proofs.get("POST /api/stream").sample.reply, "About the Azores in winter: pack light. Earlier you asked about hiking in Madeira.", "the stream put back together from its events");

  assert.deepEqual(of("POST /api/threads/{id}/messages").session, { held: true, carrier: "path", key: "id", minted: "client" });
  assert.deepEqual(of("POST /api/assist").session, { held: true, carrier: "header", key: "x-conversation", minted: "client" });
  assert.equal(of("POST /api/assist").replyPath, null, "a plain text reply is read whole");
  assert.deepEqual(of("POST /api/once").session, { held: false, carrier: "none", key: null }, "the same words asked twice are not a conversation held");
});

test("Node: the problems a line of code decides are named with the line that holds them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-rules-"));
  writeFileSync(join(dir, "rules.json"), JSON.stringify([{ id: "rule:short", text: "Keep answers short." }]));
  const app = await nodeApp({ CORTAD_RULES_FILE: join(dir, "rules.json") });
  try { await twoTurns(app.post); await settle(); } finally { app.child.kill(); }
  // The same literals in a doc, a test and another code file: the file the call came from answers.
  const others = { "README.md": "Our prompt uses <system-reminder> tags.", "docs/prompt.js": "// <system-reminder>", "test/app.test.js": "// The assistant is unavailable right now.", "prompts.js": "export const TAG = '<system-reminder>';" };
  mkdirSync(join(app.dir, "docs"));
  mkdirSync(join(app.dir, "test"));
  for (const [rel, text] of Object.entries(others)) writeFileSync(join(app.dir, rel), text);
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => [...Object.keys(others), "proof-app.cjs"]) });
  const source = readFileSync(join(app.dir, "proof-app.cjs"), "utf8").split("\n");
  const lineOf = (text) => source.findIndex((l) => l.includes(text)) + 1;
  const problems = (key) => proofs.get(key).problems;

  assert.deepEqual(problems("POST /api/chat"), [{ kind: "leaked-markup", said: 'The reply carried markup from the prompt your app sent the model: "</system-reminder>".', file: "proof-app.cjs", line: lineOf("<system-reminder>") }]);
  const broken = problems("POST /api/broken");
  assert.deepEqual(broken.map((p) => p.kind), ["error-under-2xx", "model-call-failed"]);
  assert.deepEqual([broken[0].file, broken[0].line], ["proof-app.cjs", lineOf("The assistant is unavailable right now.")], "the error sentence found where the app wrote it");
  assert.match(broken[1].said, /^A model call to 127\.0\.0\.1:\d+ for fixture-model answered 503\.$/);
  assert.deepEqual([broken[1].file, broken[1].line], ["proof-app.cjs", lineOf("const complete = ")], "the app's own line that made the call");
  assert.deepEqual(problems("POST /api/assist").map((p) => [p.kind, p.line]), [["rules-not-carried", lineOf("const complete = ")]], "its own system prompt carried none of the read's rules");
  assert.deepEqual(problems("POST /api/stream"), []);
  assert.deepEqual(problems("POST /api/once"), [], "the prompt's markup shown inside a code block is the answer, not a leak");
  const chat = proofs.get("POST /api/chat").proof;
  assert.deepEqual([chat.host, chat.rules, chat.tools, chat.passages], ["127.0.0.1", ["rule:short"], [], 0], "the host without its port, the rule the prompts carried");
  assert.deepEqual(proofs.get("POST /api/assist").proof.rules, [], "carried none, said as none");
});

test("the first four requests per route are kept, whatever id the path carries", async () => {
  const app = await nodeApp();
  try {
    for (let i = 0; i < 6; i++) await (await app.post(`/api/threads/t-${i}f3a2c9d1e7b4a6c/messages`, { text: `museum ${i}` })).json();
    await settle();
  } finally { app.child.kill(); }
  const rows = rowsOf(app.file);
  assert.equal(rows.filter((r) => r.ex && r.method).length, 4);
  assert.equal(rows.filter((r) => r.call).length, 6, "every model call is still metered");
});

test("the command sends each door once it is proven and again only when a new exchange changes it; header values stay here", async () => {
  const dir = inFolder("proof-app.cjs");
  const sent = [];
  const kept = [];
  const capture = makeCapture({ work: dir, keepSecret: (v) => kept.push(v), onProof: (p) => sent.push(p), root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const first = await post({ message: "a weekend in Lisbon" });
    await settle();
    capture.alive();
    assert.equal(sent.length, 1, "proven by one exchange");
    assert.deepEqual([sent[0].proof.exchanges, sent[0].proof.session.held], [1, false]);
    capture.alive();
    assert.equal(sent.length, 1, "nothing new, nothing sent");
    await post({ message: "the leak season in Porto", sessionId: first.sessionId });
    await settle();
    capture.alive();
    const last = sent.at(-1);
    assert.deepEqual([last.proof.exchanges, last.proof.session], [2, { held: true, carrier: "body", key: "sessionId", minted: "app" }]);
    assert.deepEqual(last.door, { method: "POST", path: "/api/chat" });
    assert.deepEqual(last.template, { body: { message: "the leak season in Porto", sessionId: first.sessionId }, headerNames: ["accept", "accept-language", "authorization", "content-type", "sec-fetch-mode", "user-agent"], askField: "message", sessionKey: "sessionId" });
    assert.ok(!JSON.stringify(sent).includes("tok-4f9a8b7c6d5e4f3a2b1c"), "a sign-in value never leaves");
    assert.ok(kept.includes("tok-4f9a8b7c6d5e4f3a2b1c"), "and is kept to be masked out of anything that does");
    assert.equal(capture.headers().authorization, "Bearer tok-4f9a8b7c6d5e4f3a2b1c", "speaking as the person uses their own header, here");
  } finally { child.kill(); }
});

test("a literal outside the call's own files is placed only when one code file holds it", () => {
  const dir = mkdtempSync(join(tmpdir(), "finder-"));
  const files = { "a.jsx": "<p>Hello {name}</p>", "b.jsx": "<b>{name}</b>", "c.py": 'PROMPT = "Answer as {persona}."', "README.md": "{persona} is set per user." };
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
  const find = sourceFinder(dir, () => ["README.md", ...Object.keys(files)]);
  assert.equal(find("{name}"), null, "two components hold it: neither is the address");
  assert.deepEqual(find("{name}", ["b.jsx"]), { file: "b.jsx", line: 1 }, "the file the call came from answers first");
  assert.deepEqual(find("{persona}"), { file: "c.py", line: 1 }, "the doc never answers");
  writeFileSync(join(dir, "unlisted.py"), 'X = "{persona}"');
  assert.deepEqual(find("{persona}", ["unlisted.py"]), { file: "c.py", line: 1 }, "a frame file outside the shareable files is never read");
});

const skipPy = !existsSync(PY);

test("Python: a cookie the app set, an id the client minted, a stream, and a retrieval that came back empty", { skip: skipPy }, async () => {
  const dir = inFolder("proof_app.py");
  const file = join(dir, "trace.jsonl");
  const port = 4391;
  const child = spawn(PY, ["-m", "uvicorn", "proof_app:app", "--port", String(port)], { cwd: dir, env: { ...process.env, PYTHONPATH: PYHOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/nothing`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    const one = await post("/chat", { message: "a mushroom risotto" });
    const cookie = one.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    await one.json();
    await (await post("/chat", { message: "a lemon tart for six" }, { cookie })).json();
    for (const question of ["crispy tofu at home", "a quick peanut sauce"]) await (await post("/ask", { thread_id: "7f3c2a9e-1b4d-4c8e-9a2f-6d5e4c3b2a10", question })).text();
    await (await post("/recipes", { q: "vegan lasagne" })).json();
    await settle();
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  const proofs = proofsOf(rows, { find: sourceFinder(dir, () => ["proof_app.py"]), routes: rows.find((r) => r.routes)?.routes.routes });
  const of = (key) => proofs.get(key).proof;
  assert.deepEqual(of("POST /chat").session, { held: true, carrier: "cookie", key: "conv", minted: "app" });
  assert.deepEqual([of("POST /chat").askField, of("POST /chat").replyPath, of("POST /chat").tokens], ["message", "answer", { prompt: 40, completion: 9 }]);
  assert.deepEqual(of("POST /ask").session, { held: true, carrier: "body", key: "thread_id", minted: "client" });
  assert.deepEqual([of("POST /ask").askField, of("POST /ask").stream], ["question", true]);
  assert.equal(proofs.get("POST /ask").sample.reply, "For a quick peanut sauce, swap butter for olive oil. You also asked about crispy tofu at home.", "a stream whose events say token keeps its words");
  const source = readFileSync(join(dir, "proof_app.py"), "utf8").split("\n");
  assert.equal(of("POST /recipes").rules, undefined, "no rules file, so nothing is claimed about rules");
  assert.deepEqual(proofs.get("POST /recipes").problems, [{ kind: "retrieval-empty", said: "A retrieval from 127.0.0.1 returned nothing.", file: "proof_app.py", line: source.findIndex((l) => l.includes("found = httpx.post(")) + 1 }]);
});

test("speaking as the person never sends what carries a proven conversation", () => {
  const person = { authorization: "Bearer t", cookie: "conv=abc; theme=dark", "x-conversation": "c-1" };
  assert.deepEqual(withoutCarriers(person, [{ carrier: "cookie", key: "conv" }, { carrier: "header", key: "x-conversation" }]),
    { authorization: "Bearer t", cookie: "theme=dark" });
  assert.deepEqual(withoutCarriers({ cookie: "conv=abc" }, [{ carrier: "cookie", key: "conv" }]), {});
});

// A Next.js app on the AI SDK streams its UI message events; with no model words to match, the ids on
// every event outweighed the text and the sample the agent read was a run of message ids.
test("a UI message stream is read as its words, not its ids or event names", () => {
  const frames = [
    { type: "start", messageId: "x8dBiDJwSGF8fiWi" }, { type: "start-step" },
    { type: "reasoning-start", id: "rs_b4caa19f4ccc49088c3d663f6257c1de:0" },
    { type: "text-start", id: "msg_2ca540be544544beb9bdd07de7d8386b" },
    ...["Two ", "benefits: ", "early errors ", "and better tooling."].map((delta) => ({ type: "text-delta", id: "msg_2ca540be544544beb9bdd07de7d8386b", delta })),
    { type: "text-end", id: "msg_2ca540be544544beb9bdd07de7d8386b" }, { type: "finish" },
  ];
  const reply = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  const ex = { reply, type: "text/event-stream", writes: frames.length, calls: [], deps: [], sent: [], body: "{}", headers: {}, path: "/api/chat", method: "POST" };
  assert.equal(replyOf(ex).text, "Two benefits: early errors and better tooling.");
});
