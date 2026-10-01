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
  return { dir, file, child, post, port };
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
  const handed = await (await post("/api/forgets", { message: "a ferry to the Berlengas" })).json();
  await (await post("/api/forgets", { message: "the ferry back at five", sessionId: handed.sessionId })).json();
  for (const message of ["is it ok to put an angry caller on hold?", "and if they refuse to hold?"]) await (await post("/api/lessons", { message, activity_uuid: "activity_5f1c446f-ebed-4931-bf92-54d99c730567" })).json();
  await (await post("/api/once", { message: "the code for a trip card" })).json();
  await (await post("/api/broken", { message: "is it raining in Rome" })).json();
}

test("Node: each door's ask, session, reply and model are read off two real turns", async () => {
  const app = await nodeApp();
  try { await twoTurns(app.post); await settle(); } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const of = (key) => proofs.get(key)?.proof;
  assert.deepEqual([...proofs.keys()].sort(), ["POST /api/assist", "POST /api/broken", "POST /api/chat", "POST /api/forgets", "POST /api/lessons", "POST /api/once", "POST /api/stream", "POST /api/threads/{id}/messages"]);
  // A lesson id sent with every message and echoed back is a fixed field, not a conversation id: it
  // stays in the template as captured and no trial opens without it or makes one up.
  assert.deepEqual([of("POST /api/lessons").session.carrier, of("POST /api/lessons").session.key], ["none", null], "an id the client sent first is not one the app handed back");
  assert.equal(proofs.get("POST /api/lessons").template.body.activity_uuid, "activity_5f1c446f-ebed-4931-bf92-54d99c730567");
  assert.equal(proofs.get("POST /api/lessons").template.sessionKey, null);

  assert.deepEqual(of("POST /api/chat").session, { held: true, carrier: "body", key: "sessionId", minted: "app" }, "the id the app handed back in its first reply");
  assert.deepEqual([of("POST /api/chat").askField, of("POST /api/chat").replyPath, of("POST /api/chat").stream], ["message", "reply", false]);
  assert.deepEqual([of("POST /api/chat").exchanges, of("POST /api/chat").modelCalls, of("POST /api/chat").model], [2, 1, "fixture-model"]);
  assert.deepEqual(of("POST /api/chat").tokens, { prompt: 50, completion: 12 }, "the provider's own counts, the median of the two turns");
  assert.equal(typeof of("POST /api/chat").replySeconds, "number");

  assert.deepEqual(of("POST /api/stream").session, { held: true, carrier: "history", key: "messages" });
  assert.deepEqual([of("POST /api/stream").askField, of("POST /api/stream").replyPath, of("POST /api/stream").stream], ["messages", null, true]);
  assert.equal(proofs.get("POST /api/stream").sample.reply, "About the Azores in winter: pack light. Earlier you asked about hiking in Madeira.", "the stream put back together from its events");

  assert.deepEqual(of("POST /api/threads/{id}/messages").session, { held: true, carrier: "path", key: "id", minted: "client" });
  assert.deepEqual(proofs.get("POST /api/threads/{id}/messages").template.pathValues, { id: "t-8f3a2c9d1e7b4a6c" }, "the route values the person's request carried go with the template");
  assert.equal(proofs.get("POST /api/chat").template.pathValues, undefined, "a route with no values sends none");
  assert.deepEqual(of("POST /api/assist").session, { held: true, carrier: "header", key: "x-conversation", minted: "client" });
  assert.equal(of("POST /api/assist").replyPath, null, "a plain text reply is read whole");
  assert.deepEqual(of("POST /api/once").session, { held: false, carrier: "none", key: null }, "the same words asked twice are not a conversation held, nor one tried");
  assert.deepEqual(of("POST /api/forgets").session, { held: false, carrier: "body", key: "sessionId", minted: "app", tried: true },
    "the id it handed back was sent back and it held nothing, and the id is named so no trial replays it");
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

  assert.deepEqual(problems("POST /api/chat"), [{ kind: "leaked-markup", said: 'The reply carried markup from the prompt your app sent the model: "</system-reminder>". The model said it.', file: "proof-app.cjs", line: lineOf("<system-reminder>") }]);
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

// yunqiao's streaming code sent the reminder its agent framework adds to the prompt as a "hint" event
// of its own, and the finding named the model call. The same shape here: the model never says the
// block, and the leak is placed at the line that sent it, written straight to the response or put
// into a web stream the app hands its server to pipe.
const HINTED = 'The reply carried markup from the prompt your app sent the model: "<system-reminder>". The model never said it: your app\'s own code sent it here, in its "hint" event.';
test("Node: a block the model never said is placed at the line of the app that sent it", async () => {
  const app = await nodeApp();
  try {
    for (const door of ["/api/hinted", "/api/web", "/api/logged"]) await (await app.post(door, { messages: [{ role: "user", content: "hiking in Madeira" }] })).text();
    await settle();
  } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const source = readFileSync(join(app.dir, "proof-app.cjs"), "utf8").split("\n");
  const lineOf = (text) => source.findIndex((l) => l.includes(text)) + 1;
  assert.deepEqual(proofs.get("POST /api/hinted").problems, [{ kind: "leaked-markup", said: HINTED, file: "proof-app.cjs", line: lineOf('res.write(event("hint"') }]);
  assert.deepEqual(proofs.get("POST /api/web").problems, [{ kind: "leaked-markup", said: HINTED, file: "proof-app.cjs", line: lineOf('controller.enqueue(bytes.encode(event("hint"') }]);
  assert.equal(proofs.get("POST /api/web").sample.reply, "<system-reminder>Keep answers short.</system-reminder>About hiking in Madeira: pack light.", "the reply as the person read it");
  assert.deepEqual(proofs.get("POST /api/logged").problems, [{ kind: "leaked-markup", said: HINTED.replace(', in its "hint" event', ""), file: "proof-app.cjs", line: lineOf("return res.end(JSON.stringify({ reply: `${REMINDER}") }],
    "the handler that wrote the reply, not the res.end the app put in front of the one it replaced");

  // The hooks keep a model's first 4000 characters: past them the block may be the model's own.
  const cut = rowsOf(app.file).map((r) => (r.call?.reply ? { ...r, call: { ...r.call, reply: r.call.reply.padEnd(4000, ".") } } : r));
  const unplaced = proofsOf(cut, { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) }).get("POST /api/hinted").problems;
  const atPrompt = [{ kind: "leaked-markup", said: 'The reply carried markup from the prompt your app sent the model: "<system-reminder>".', file: "proof-app.cjs", line: lineOf("<system-reminder>") }];
  assert.deepEqual(unplaced, atPrompt);
  // A line whose writes never carried the block is not where it was sent, though it is the only line seen.
  const deltas = rowsOf(app.file).map((r) => (r.sites ? { ...r, sites: { ...r.sites, list: r.sites.list.filter((s) => s.event === "delta") } } : r));
  assert.deepEqual(proofsOf(deltas, { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) }).get("POST /api/hinted").problems, atPrompt);
});

test("the command hands on the model's words and the lines that wrote the reply for the turn asked about, and for no other", async () => {
  const dir = inFolder("proof-app.cjs");
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const turn = "case_3:1";
  try {
    for (const tag of [turn, "case_4:1"]) await (await fetch(`http://127.0.0.1:${port}/api/hinted`, { method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": tag }, body: JSON.stringify({ messages: [{ role: "user", content: "hiking in Madeira" }] }) })).text();
    await settle();
  } finally { child.kill(); }
  const source = readFileSync(join(dir, "proof-app.cjs"), "utf8").split("\n");
  const at = (text) => `proof-app.cjs:${source.findIndex((l) => l.includes(text)) + 1}`;
  const rows = capture.usage(turn).rows;
  const [asked, other] = [turn, "case_4:1"].map((tag) => rows.find((r) => r.turn === tag));
  assert.equal(asked.said, "About hiking in Madeira: pack light.");
  assert.deepEqual(asked.sites.map((s) => [s.at, s.event]), [[at('res.write(event("hint"'), "hint"], [at('res.write(event("delta"'), "delta"], [at('res.end(event("done"'), "done"]]);
  assert.match(asked.sites[0].text, /<system-reminder>Keep answers short\.<\/system-reminder>/);
  assert.ok(other.said === undefined && other.sites === undefined, "another turn's rows carry neither");
  assert.ok(capture.usage().rows.every((r) => r.said === undefined && r.sites === undefined), "a report for no turn carries neither");
});

// The provider stream recorded from a real app that offers a web search its account cannot run: the
// agent's own first request shows the tool coming back as an error, at the line that offers it.
test("Node: a tool the model's provider ran that came back as an error is a problem at the line that offers it", async () => {
  const fx = JSON.parse(readFileSync(new URL("./hook-fixture.json", import.meta.url), "utf8"));
  const stream = join(mkdtempSync(join(tmpdir(), "proof-stream-")), "stream.txt");
  writeFileSync(stream, fx.providerTools.reply);
  const app = await nodeApp({ PROVIDER_STREAM: stream });
  try { await (await app.post("/api/search", { message: "what happened in the news this week?" })).json(); await settle(); } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const source = readFileSync(join(app.dir, "proof-app.cjs"), "utf8").split("\n");
  const search = proofs.get("POST /api/search");
  assert.deepEqual(search.problems, [{
    kind: "tool-failed",
    said: 'The tool web_search_preview came back as an error from your model provider, which runs it: "Error: Web search is not enabled for this account (allow-search-gateway)."',
    file: "proof-app.cjs", line: source.findIndex((l) => l.includes('type: "web_search_preview"')) + 1,
  }]);
  assert.deepEqual(search.proof.tools, ["web_search_preview"], "the tool it called, as the app offered it");
});

test("every request of the person's is kept and the first four of ours per route, whatever id the path carries", async () => {
  const app = await nodeApp();
  try {
    for (let i = 0; i < 6; i++) await (await app.post(`/api/threads/t-${i}f3a2c9d1e7b4a6c/messages`, { text: `museum ${i}` })).json();
    for (let i = 0; i < 6; i++) await (await app.post(`/api/threads/t-${i}a1b2c3d4e5f6a7b/messages`, { text: `gallery ${i}` }, { "x-cortad-turn": `cortad-${i}` })).json();
    await settle();
  } finally { app.child.kill(); }
  const rows = rowsOf(app.file).filter((r) => r.ex && r.method);
  assert.deepEqual([rows.filter((r) => !r.turn).length, rows.filter((r) => r.turn).length], [6, 4]);
  assert.equal(rowsOf(app.file).filter((r) => r.call).length, 12, "every model call is still metered");
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
    for (const door of ["/hinted", "/behind/hinted", "/timed/told"]) await (await post(door, { question: "a lemon tart" })).text();
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
  const hint = [{ kind: "leaked-markup", said: HINTED, file: "proof_app.py", line: source.findIndex((l) => l.includes('yield "event: hint')) + 1 }];
  assert.deepEqual(proofs.get("POST /hinted").problems, hint, "the line of the generator that made the event, not the one that passed it along");
  assert.deepEqual(proofs.get("POST /behind/hinted").problems, hint, "behind a middleware that hands the reply over from another task");
  assert.deepEqual(proofs.get("POST /timed/told").problems, [{ kind: "leaked-markup", said: 'The reply carried markup from the prompt your app sent the model: "<system-reminder>".', file: "proof_app.py", line: source.findIndex((l) => l.includes("<system-reminder>")) + 1 }],
    "no line of the app wrote a reply the framework rendered, least of all the middleware that only passed the request on: the block stays where the code writes it");
});

const FLASK_APP = `import json
from flask import Flask, Response, stream_with_context

app = Flask(__name__)
REMINDER = "<system-reminder>The kitchen closes at 22:00.</system-reminder>"


def events():
    yield "event: hint\\ndata: %s\\n\\n" % json.dumps({"text": REMINDER})
    for word in ["For", " a", " lemon", " tart"]:
        yield "event: delta\\ndata: %s\\n\\n" % json.dumps({"text": word})


@app.post("/hinted")
def hinted():
    return Response(stream_with_context(events()), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(port=4393)
`;

test("Python, WSGI: each part of a streamed reply is placed at the line of the generator that made it", { skip: skipPy }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "flask_hinted.py"), FLASK_APP);
  const child = spawn(PY, ["flask_hinted.py"], { cwd: dir, env: { ...process.env, PYTHONPATH: PYHOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch("http://127.0.0.1:4393/nothing"); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    await (await fetch("http://127.0.0.1:4393/hinted", { method: "POST", headers: { "x-cortad-turn": "case_7:1" } })).text();
    await settle();
  } finally { child.kill("SIGKILL"); }
  const lineOf = (text) => `flask_hinted.py:${FLASK_APP.split("\n").findIndex((l) => l.includes(text)) + 1}`;
  const { sites } = rowsOf(file).find((r) => r.sites);
  assert.equal(sites.turn, "case_7:1");
  assert.deepEqual(sites.list.map((s) => [s.at, s.event]), [[lineOf('yield "event: hint'), "hint"], [lineOf('yield "event: delta'), "delta"]]);
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

// yunqiao sends its thinking as an SSE event named for it; an OpenAI-compatible stream passed straight
// through carries it in delta.reasoning_content. Neither is the answer.
test("a stream's thinking, as a named SSE event or a reasoning field, is never taken as the reply", () => {
  const ex = (reply) => ({ reply, type: "text/event-stream", writes: 4, calls: [], deps: [], sent: [], body: "{}", headers: {}, path: "/api/chat", method: "POST" });
  const named = "event: thinking\ndata: {\"text\":\"Let me look at the refund policy before I answer this one.\"}\n\nevent: message\ndata: {\"text\":\"Your refund was sent on Monday.\"}\n\n";
  assert.equal(replyOf(ex(named)).text, "Your refund was sent on Monday.");
  const passed = [{ choices: [{ delta: { reasoning_content: "The user wants the refund date, so I should check the order first." } }] }, { choices: [{ delta: { content: "Your refund was sent on Monday." } }] }]
    .map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  assert.equal(replyOf(ex(passed)).text, "Your refund was sent on Monday.");
});

test("Node: a job answered by the app's own worker proves the queueing request, with the fetch that carried the answer", async () => {
  const app = await nodeApp();
  const at = (path) => fetch(`http://127.0.0.1:${app.port}${path}`).then((r) => r.json());
  try {
    for (const message of ["a weekend in Lisbon", "the leak season in Porto"]) {
      const { jobId } = await (await app.post("/api/jobs", { message, session: "s-5f2a9c1e7b3d" })).json();
      await at(`/api/jobs/${jobId}`);
    }
    await settle();
  } finally { app.child.kill(); }
  const rows = rowsOf(app.file);
  assert.equal(rows.filter((r) => r.call && !r.call.ex).length, 0, "each worker call is pinned to the message it answered");
  const jobs = proofsOf(rows).get("POST /api/jobs");
  assert.deepEqual(jobs.proof.answer, { method: "GET", path: "/api/jobs/{jobId}", tie: { key: "jobId", from: "got" }, askPath: "message", historyPath: null, before: [] });
  assert.deepEqual([jobs.proof.exchanges, jobs.proof.askField, jobs.proof.replyPath, jobs.proof.session.held], [2, "message", "reply", true]);
  assert.equal(jobs.sample.reply, "About the leak season in Porto: pack light. Earlier you asked about a weekend in Lisbon. </system-reminder>");
});

test("Python: an answer fetched on a second request proves the asking request as a door, with the step that fetched it", { skip: skipPy }, async () => {
  const dir = inFolder("proof_app.py");
  const file = join(dir, "trace.jsonl");
  const port = 4392;
  const child = spawn(PY, ["-m", "uvicorn", "proof_app:app", "--port", String(port)], { cwd: dir, env: { ...process.env, PYTHONPATH: PYHOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  const at = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(`${at}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const events = async (path) => (await (await fetch(`${at}${path}`)).text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  const session = "k3v9x2m7q1";
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${at}/nothing`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    let history = [];
    for (const message of ["a mushroom risotto for two", "a lemon tart for six"]) {
      await post("/queue/join", { fn: "show", data: [message, history], session });
      history = (await events(`/queue/data?session=${session}`)).at(-1).output.data[0];
      await post("/queue/join", { fn: "answer", data: [history], session });
      history = (await events(`/queue/data?session=${session}`)).at(-1).output.data[0];
    }
    const { event_id } = await post("/call/answer", { data: ["crispy tofu at home"] });
    await events(`/call/answer/${event_id}`);
    for (const message of ["a quick peanut sauce", "a green curry paste"]) await post("/pool", { message });
    await settle();
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  assert.equal(rows.filter((r) => r.call && !r.call.ex).length, 0, "every model call is pinned to the request its answer came on");
  const proofs = proofsOf(rows, { routes: rows.find((r) => r.routes)?.routes.routes });
  assert.deepEqual([...proofs.keys()].sort(), ["POST /call/answer", "POST /pool", "POST /queue/join"]);

  const queue = proofs.get("POST /queue/join");
  assert.deepEqual({ ...queue.proof.answer, before: queue.proof.answer.before.map(({ body, ...b }) => b) }, {
    method: "GET", path: "/queue/data?session={session}", tie: { key: "session", from: "sent" }, askPath: "data.0.-1.content", historyPath: "data.0",
    before: [{ method: "POST", path: "/queue/join", askPath: "data.0", historyPath: "data.1" }],
  });
  assert.deepEqual(queue.proof.answer.before[0].body.data[0], "a lemon tart for six", "the step that showed the message, as it was sent");
  assert.deepEqual([queue.proof.exchanges, queue.proof.askField, queue.proof.replyPath, queue.proof.session.held], [2, "data", "output.data.0.-1.content", true]);
  assert.equal(queue.sample.reply, "For a lemon tart for six, swap butter for olive oil. You also asked about a mushroom risotto for two.", "the answer read out of the whole thread the stream carried");

  const call = proofs.get("POST /call/answer").proof.answer;
  assert.deepEqual(call, { method: "GET", path: "/call/answer/{event_id}", tie: { key: "event_id", from: "got" }, askPath: "data.0", historyPath: null, before: [] });

  const pooled = proofs.get("POST /pool").proof;
  assert.deepEqual([pooled.exchanges, pooled.askField, pooled.answer], [2, "message", undefined], "the request still open when its call ran on a pool is the door itself");
});

// A client that picks the assistant's instructions and its model sends both beside the person's words,
// and the agent proving the door can put its own words in the instructions as well.
test("Node: a field the model took as its instructions, or that named its model, is the app's own and never the ask", async () => {
  const app = await nodeApp();
  const persona = { system: "You are Ava, a travel helper who answers in one line.", model: "fixture-model" };
  try {
    await (await app.post("/api/persona", { ...persona, message: "a weekend in Lisbon" })).json();
    await (await app.post("/api/persona", { ...persona, system: "the night trains to Vienna", message: "the night trains to Vienna" })).json();
    await settle();
  } finally { app.child.kill(); }
  const door = proofsOf(rowsOf(app.file)).get("POST /api/persona");
  assert.deepEqual([door.template.askField, door.proof.askField, door.proof.appFields.sort()], ["message", "message", ["model", "system"]]);
  assert.equal(door.sample.ask, "the night trains to Vienna");
});

// chatgpt-lite sends the persona's prompt in "prompt", which it makes the model's system message, and
// the person's words in "messages". The agent that proved its door put its own words in both, and the
// run filled both with every trial's words: the app's own personas never reached a trial.
test("recorded chatgpt-lite: a field the model was given as its system message is never the ask, whatever words it shares", () => {
  const { rows } = JSON.parse(readFileSync(new URL("./chatgpt-lite-fixture.json", import.meta.url), "utf8"));
  const exchanges = [...new Set(rows.filter((r) => r.ex).map((r) => r.ex))];
  const door = (ids) => proofsOf(rows.filter((r) => ids.includes(r.ex ?? r.call.ex))).get("POST /api/chat");
  for (const ids of [[exchanges[0]], [exchanges[1]], exchanges]) {
    const chat = door(ids);
    assert.deepEqual([chat.template.askField, chat.proof.askField, chat.proof.appFields], ["messages", "messages", ["prompt"]], `exchanges ${ids.join(", ")}`);
  }
  assert.equal(door([exchanges[0]]).sample.ask, "Hey, can you help me write a short email to my landlord asking to fix the kitchen faucet? It's been dripping for a week.");
});

// chatgpt-lite2 (run 707b51af): a request Cortad sent through the door carried no turn tag, so it was
// read as the person's, and every trial went out as it: "bl-1" and the agent's own prompt. Replayed
// with the tag the command now puts on every request of ours, it never is the request trials copy.
test("recorded chatgpt-lite: a request of ours is never the one trials copy, and a door only ours reached says so", () => {
  const { rows } = JSON.parse(readFileSync(new URL("./chatgpt-lite-fixture.json", import.meta.url), "utf8"));
  const [ours] = [...new Set(rows.filter((r) => r.ex).map((r) => r.ex))];
  const tagged = rows.map((r) => (r.ex === ours ? { ...r, turn: "cortad-0123456789abcdef" } : r));
  const both = proofsOf(tagged).get("POST /api/chat");
  assert.equal(both.template.body.prompt, "You are a professional, friendly, and helpful AI assistant.", "the person's own request is the shape");
  assert.ok(!JSON.stringify(both.template).includes("bl-1"));
  assert.deepEqual([both.proof.exchanges, both.proof.fallback], [1, undefined]);
  const onlyOurs = proofsOf(tagged.filter((r) => (r.ex ?? r.call.ex) === ours)).get("POST /api/chat");
  assert.deepEqual([onlyOurs.proof.exchanges, onlyOurs.proof.fallback], [1, true], "a door only our requests reached is labelled fallback");
});

// Two fields of their own with the same words, one the model took as its instructions and one as the
// turn: the words cannot tell them apart, and the first key in the body decided it, so every trial
// went out with the customer's words as the instructions and the agent's in the turn.
test("Node: the same words given as the instructions and as the turn are told apart by the fields' names, never by their order", async () => {
  const app = await nodeApp();
  const words = "the night trains to Vienna";
  try {
    await (await app.post("/api/persona", { system: words, message: words })).json();
    await (await app.post("/api/persona", { message: words, system: words })).json();
    await settle();
  } finally { app.child.kill(); }
  const rows = rowsOf(app.file);
  const exchanges = [...new Set(rows.filter((r) => r.ex).map((r) => r.ex))];
  assert.equal(exchanges.length, 2);
  for (const ex of exchanges) {
    const door = proofsOf(rows.filter((r) => (r.ex ?? r.call?.ex) === ex)).get("POST /api/persona");
    assert.deepEqual([door.template.askField, door.proof.askField, door.proof.appFields], ["message", "message", ["system"]], `exchange ${ex}`);
  }
});

// The AI SDK's client sends only its new message, and the words sit in that message's parts.
test("Node: a door that takes one message in parts is proven with those parts as its ask", async () => {
  const app = await nodeApp();
  const turn = (id, text) => ({ id: "c-7d1e2f3a4b5c6d7e8f9a", message: { id, role: "user", parts: [{ type: "text", text }] } });
  try {
    await (await app.post("/api/turn", turn("m-1", "a weekend in Lisbon"))).json();
    await (await app.post("/api/turn", turn("m-2", "the night trains to Vienna"))).json();
    await settle();
  } finally { app.child.kill(); }
  const door = proofsOf(rowsOf(app.file)).get("POST /api/turn");
  assert.deepEqual([door.template.askField, door.proof.askField, door.proof.appFields, door.proof.session.key], ["message.parts", "message.parts", undefined, "id"]);
});

// ai-appointment-setter: an AI SDK route left at one step. The model asked for checkAvailability, the
// route ran it and streamed its result, and the request ended with no model call after it; the
// reply the page got held the model's reasoning and no answer.
const ONE_STEP_APP = `
const http = require("node:http");
const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "checkAvailability", arguments: '{"date":"2026-10-06"}' } }] } }], usage: { prompt_tokens: 30, completion_tokens: 9 } }))); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      await fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: message }], tools: [{ type: "function", function: { name: "checkAvailability" } }] }) }).then((r) => r.json());
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (e) => res.write("data: " + JSON.stringify(e) + "\\n\\n");
      send({ type: "reasoning-delta", id: "r", delta: "The user is asking about availability for next Tuesday. I need to check that date first." });
      send({ type: "tool-input-available", toolCallId: "c1", toolName: "checkAvailability", input: { date: "2026-10-06" } });
      send({ type: "tool-output-available", toolCallId: "c1", output: { slots: ["09:00", "11:00"] } });
      res.end("data: [DONE]\\n\\n");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a request that ended right after its tool ran, with no model call after it, is a problem at the call, and the model's reasoning is never taken as the reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "onestep-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), ONE_STEP_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
  try {
    for (const message of ["what times are free next Tuesday?", "and Wednesday afternoon?"]) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await settle();
  } finally { child.kill(); }
  const door = proofsOf(rowsOf(file)).get("POST /api/chat");
  assert.ok(door.problems.some((p) => p.kind === "ended-on-tool" && /checkAvailability ran: no model call came after it/.test(p.said)), JSON.stringify(door.problems));
  assert.ok(!/The user is asking about availability/.test(door.sample.reply), "the model's reasoning is not the reply");
});

// yunqiao's provider streamed its answer with no usage chunk, and the quote had no price at all.
const UNCOUNTED_APP = `
const http = require("node:http");
const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Your refund of 40 dollars was sent on Monday and lands in three to five days." } }] }))); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const out = await fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "system", content: "You are the refunds desk of a small shop. Answer in two sentences." }, { role: "user", content: message }] }) }).then((r) => r.json());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: out.choices[0].message.content }));
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a model call whose reply carried no token counts is priced from its text, and the proof says the count is estimated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncounted-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), UNCOUNTED_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
  try {
    for (const message of ["where is my refund for order 1182?", "and when will it land?"]) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await settle();
  } finally { child.kill(); }
  const { tokens } = proofsOf(rowsOf(file)).get("POST /api/chat").proof;
  assert.equal(tokens.estimated, true);
  assert.ok(tokens.prompt >= 20 && tokens.prompt < 60, `prompt ${tokens.prompt}`);
  assert.ok(tokens.completion >= 15 && tokens.completion < 30, `completion ${tokens.completion}`);
});

// LearnHouse's lesson chat streams its answer in chunks, says done, then asks the model a second time
// for follow-up suggestions and streams those last. The proof showed the suggestions as the reply.
const SUGGESTS_APP = `
const http = require("node:http");
const ANSWER = "Say no clearly and early, then offer the one thing you can do for them, such as a partial credit.";
const FOLLOW = JSON.stringify(["Can you give an example?", "What if they refuse?"]);
const provider = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => {
  const asked = JSON.parse(b);
  const content = /follow-up/.test(asked.messages[0].content) ? FOLLOW : ANSWER;
  res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 40, completion_tokens: 20 } }));
}); }).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  const ask = (system, user) => fetch(base + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "system", content: system }, { role: "user", content: user }] }) }).then((r) => r.json()).then((j) => j.choices[0].message.content);
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { message } = JSON.parse(body);
      const answer = await ask("You are a course tutor for the lesson Saying no.", message);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ type: "start" }) + "\\n\\n");
      for (const piece of answer.match(/.{1,20}/g)) res.write("data: " + JSON.stringify({ type: "chunk", content: piece }) + "\\n\\n");
      res.write("data: " + JSON.stringify({ type: "done" }) + "\\n\\n");
      const follow = JSON.parse(await ask("Write two short follow-up questions as a JSON list.", answer));
      res.end("data: " + JSON.stringify({ type: "follow_ups", follow_up_suggestions: follow }) + "\\n\\n");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`;

test("a request that asks its model twice, an answer then follow-up suggestions, has the answer as its reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suggests-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), SUGGESTS_APP);
  const child = spawn(process.execPath, ["--require", HOOK, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }); child.on("exit", (code) => reject(new Error(`the app exited ${code}`))); });
  try {
    for (const message of ["A customer wants a refund after 30 days. How do I say no?", "and if they threaten a bad review?"]) await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })).text();
    await settle();
  } finally { child.kill(); }
  const door = proofsOf(rowsOf(file)).get("POST /api/chat");
  assert.match(door.sample.reply, /^Say no clearly and early/, door.sample.reply);
  assert.doesNotMatch(door.sample.reply, /follow|example\?/i);
});
