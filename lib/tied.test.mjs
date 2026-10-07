import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { norm } from "./proof.mjs";

const { makeTied } = createRequire(import.meta.url)("./tied.cjs");

// One turn of a chat UI's queue as a real app's hook recorded it: a join that shows the message, a
// join that answers it, both carrying the page's session hash, and the stream the answer came on.
const SESSION = "0i3ghyjdcrxc";
const ASK = "Hi, what was my most recent purchase?";
const show = (session = SESSION, ask = ASK) => ({ method: "POST", path: "/gradio_api/queue/join", body: JSON.stringify({ data: [ask, [], null], event_data: null, fn_index: 0, trigger_id: 7, session_hash: session }), reply: '{"event_id": "c5016b460fa3491584df545033e6d47d"}' });
const join = (session = SESSION, ask = ASK) => ({ method: "POST", path: "/gradio_api/queue/join", body: JSON.stringify({ data: [[{ role: "user", metadata: null, content: ask, options: null }], null], event_data: null, fn_index: 1, trigger_id: null, session_hash: session }), reply: '{"event_id": "4505f8fd05f843cc8819a825ddef7be6"}' });
const stream = (session = SESSION) => ({ method: "GET", path: `/gradio_api/queue/data?session_hash=${session}`, body: "", reply: "" });
const prompt = (...asks) => JSON.stringify({ model: "accounts/fireworks/models/glm-5p3-flash", messages: [{ role: "system", content: "You are the store's assistant." }, ...asks.map((content) => ({ role: "user", content }))] });

// Requests open and close the way the hook sees them, one millisecond apart.
function app() {
  const tied = makeTied({ norm, bodyOf: (r) => r.body, replyOf: (r) => r.reply });
  let clock = Date.now();
  const opened = (req) => { req.at = clock++; tied.opened(req); return req; };
  const asked = (req) => { opened(req); tied.closed(req); return req; };
  const call = (sent) => { const asker = tied.pinned(sent); if (asker) asker.kept = true; return asker; };
  return { tied, opened, asked, call };
}

test("a call made while the answer is fetched is pinned to the join that asked, with the join that showed the message before it", () => {
  const { tied, opened, asked, call } = app();
  const before = asked(show());
  const asker = asked(join());
  const fetch = opened(stream());
  assert.equal(call(prompt(ASK)), asker);
  tied.done(asker);
  assert.deepEqual(tied.closed(fetch), [before, asker], "the stream completes the turn");
});

test("a call made before the answer is fetched is pinned to the newest request of the turn whose words are in the prompt", () => {
  const { tied, opened, asked, call } = app();
  asked(show());
  const asker = asked(join());
  assert.equal(call(prompt(ASK)), asker, "the show step says the same words, and shares the session with the join");
  const fetch = opened(stream());
  assert.equal(tied.closed(fetch), null, "no answer while the call is still running");
  tied.done(asker);
  const again = opened(stream());
  assert.equal(tied.closed(again).at(-1), asker);
});

test("a stream the client opened between a turn's two joins never splits it: every call goes to the join being answered, and the next turn's steps are its own", () => {
  const { tied, opened, asked, call } = app();
  const shown = asked(show());
  const heartbeat = opened({ method: "GET", path: `/gradio_api/heartbeat/${SESSION}`, body: "", reply: "" });
  const asker = asked(join());
  const fetch = opened(stream());
  assert.equal(call(prompt(ASK)), asker, "both joins carry the words; the newest of the session is the one answered");
  assert.equal(call(prompt("Route this to the invoice sub-agent.")), asker, "a call with none of the person's words");
  tied.done(asker);
  tied.done(asker);
  assert.deepEqual(tied.closed(fetch), [shown, asker]);
  const next = "And the one before that, please?";
  const shown2 = asked(show(SESSION, next));
  const asker2 = asked(join(SESSION, next));
  const fetch2 = opened(stream());
  assert.equal(call(prompt("Route this to the invoice sub-agent.")), asker2);
  tied.done(asker2);
  assert.deepEqual(tied.closed(fetch2), [shown2, asker2], "the first turn's joins are no steps of the second");
  assert.equal(tied.closed(heartbeat), null);
});

test("two conversations fetching at once: each call goes to the one whose words its prompt carries, and to none when both are", () => {
  const { opened, asked, call } = app();
  const mine = asked(join("0i3ghyjdcrxc", ASK));
  const theirs = asked(join("7kq2mz81xdav", "Which albums by AC/DC do you carry?"));
  opened(stream("0i3ghyjdcrxc"));
  opened(stream("7kq2mz81xdav"));
  assert.equal(call(prompt(ASK)), mine);
  assert.equal(call(prompt("Which albums by AC/DC do you carry?")), theirs);
  const twin = app();
  twin.asked(join("0i3ghyjdcrxc", ASK));
  twin.asked(join("7kq2mz81xdav", ASK));
  twin.opened(stream("0i3ghyjdcrxc"));
  twin.opened(stream("7kq2mz81xdav"));
  assert.equal(twin.call(prompt(ASK)), undefined, "the same words in two conversations pin nothing");
});

test("a stream the page opened before the message was sent is not the one its answer came on", () => {
  const { tied, opened, asked, call } = app();
  const heartbeat = opened({ method: "GET", path: `/gradio_api/heartbeat/${SESSION}`, body: "", reply: "" });
  const asker = asked(join());
  const fetch = opened(stream());
  assert.equal(call(prompt(ASK)), asker);
  tied.done(asker);
  assert.equal(tied.closed(heartbeat), null);
  assert.equal(tied.closed(fetch).at(-1), asker);
});

test("a call outside a request is never pinned to a request served in its own context", () => {
  const { tied, opened, call } = app();
  const chat = opened({ method: "POST", path: "/api/chat", body: JSON.stringify({ message: ASK }), reply: "" });
  chat.noted = true;
  assert.equal(call(prompt("Summarize the conversation so far.", ASK)), undefined, "a summary the app writes on its own quotes the open request's words");
  assert.equal(tied.closed(chat), null);
});

test("a prompt this process sent, arriving at a server of its own, never asks", () => {
  const { tied, asked, call } = app();
  const first = prompt(ASK);
  tied.sent(first);
  asked({ method: "POST", path: "/v1/chat/completions", body: first, reply: "" });
  assert.equal(call(prompt(ASK, "My customer ID is 5")), undefined);
});

// Both hooks, played the same requests: JavaScript in process, Python in its own. The hook keeps only
// the first four exchanges; every exchange after that is pinned all the same.
const PYTHON = `
import contextvars, json, sys, time
sys.path.insert(0, sys.argv[1])
from cortad_tied import Tied
tied = Tied(lambda s: " ".join(str(s).lower().split()), lambda r: r["body"], lambda r: r["reply"])
reqs, clock, kept, pinned, handlers = {}, int(time.time() * 1000), 0, [], {}
for op, arg, *handler in json.load(sys.stdin):
    if op == "open":
        arg["at"], clock = clock, clock + 1
        reqs[arg["id"]] = arg
        tied.opened(arg)
    elif op == "close":
        tied.closed(reqs[arg])
    else:
        # A call made in a handler's own context, as a queue runs each handler.
        asker = handlers.setdefault(handler[0] if handler else None, contextvars.copy_context()).run(tied.pinned, arg)
        if asker and not asker.get("noted"):
            asker["noted"], asker["kept"], kept = True, kept < 4, kept + 1
        Tied.done(asker)
        pinned.append(asker and asker["id"])
print(json.dumps(pinned))
`;
const hooks = {
  javascript(ops) {
    const tied = makeTied({ norm, bodyOf: (r) => r.body, replyOf: (r) => r.reply });
    const reqs = new Map();
    let clock = Date.now(), kept = 0;
    const pinned = [];
    for (const [op, arg] of ops) {
      if (op === "open") { const req = { ...arg, at: clock++ }; reqs.set(req.id, req); tied.opened(req); }
      else if (op === "close") tied.closed(reqs.get(arg));
      else {
        const asker = tied.pinned(arg);
        if (asker && !asker.noted) Object.assign(asker, { noted: true, kept: kept++ < 4 });
        tied.done(asker);
        pinned.push(asker?.id ?? null);
      }
    }
    return pinned;
  },
  python(ops) {
    const run = spawnSync("python3", ["-c", PYTHON, new URL("./pyhook/", import.meta.url).pathname], { input: JSON.stringify(ops), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  },
};
const hasPython = spawnSync("python3", ["--version"]).status === 0;

for (const [hook, play] of Object.entries(hooks)) {
  test(`${hook}: every turn of a long conversation is pinned to its own join, past the exchanges the hook keeps`, { skip: hook === "python" && !hasPython }, () => {
    const asks = ["Hi, what was my most recent purchase?", "My customer ID is 5 please", "And how much was that invoice?", "Which albums by AC/DC do you carry?", "Can I get a refund on that order?", "Thanks, that is all for today"];
    const ops = asks.flatMap((ask, i) => [
      ["open", { id: `show${i}`, ...show(SESSION, ask) }], ["close", `show${i}`],
      ["open", { id: `shown${i}`, ...stream() }], ["close", `shown${i}`],
      ["open", { id: `join${i}`, ...join(SESSION, ask) }], ["close", `join${i}`],
      ["open", { id: `fetch${i}`, ...stream() }],
      ["call", prompt(...asks.slice(0, i + 1))],
      ["close", `fetch${i}`],
    ]);
    assert.deepEqual(play(ops), asks.map((_, i) => `join${i}`));
  });

  test(`${hook}: two clients each holding a heartbeat on their session: each call with the person's words goes to its own client's join`, { skip: hook === "python" && !hasPython }, () => {
    const turn = (c, session, ask) => [
      ["open", { id: `show${c}`, ...show(session, ask) }], ["close", `show${c}`],
      ["open", { id: `beat${c}`, method: "GET", path: `/gradio_api/heartbeat/${session}`, body: "", reply: "" }],
      ["open", { id: `join${c}`, ...join(session, ask) }], ["close", `join${c}`],
      ["open", { id: `fetch${c}`, ...stream(session) }],
    ];
    const other = "Which albums by AC/DC do you carry?";
    const ops = [...turn("A", "0i3ghyjdcrxc", ASK), ...turn("B", "7kq2mz81xdav", other), ["call", prompt(ASK), "A"], ["call", prompt(other), "B"]];
    assert.deepEqual(play(ops), ["joinA", "joinB"]);
  });
}

test("python: a handler's later calls, with none of the person's words, go where its first call went while two clients are open", { skip: !hasPython }, () => {
  const turn = (c, session, ask) => [
    ["open", { id: `show${c}`, ...show(session, ask) }], ["close", `show${c}`],
    ["open", { id: `join${c}`, ...join(session, ask) }], ["close", `join${c}`],
    ["open", { id: `fetch${c}`, ...stream(session) }],
  ];
  const other = "Which albums by AC/DC do you carry?";
  const routed = prompt("Route this to the invoice sub-agent.");
  const ops = [...turn("A", "0i3ghyjdcrxc", ASK), ...turn("B", "7kq2mz81xdav", other),
    ["call", prompt(ASK), "A"], ["call", prompt(other), "B"], ["call", routed, "A"], ["call", routed, "B"], ["call", routed, "C"]];
  assert.deepEqual(hooks.python(ops), ["joinA", "joinB", "joinA", "joinB", null], "a call in a context no pinned call ran in is pinned to nothing");
});

// A request still open has a worker's call pinned to it and makes one of its own; both end with no
// response heard, then its reply says only ok. Nothing of it is still running, so it was not
// answered later: a counter left at one would have made it so, and it would never settle.
const COUNTED = `
import json, sys
sys.path.insert(0, sys.argv[1])
from cortad_tied import Tied
tied = Tied(lambda s: " ".join(str(s).lower().split()), lambda r: r["body"], lambda r: r["reply"])
req = {"id": "r", "at": 1, "method": "POST", "path": "/api/chat", "body": json.dumps({"text": sys.argv[2]}), "reply": ""}
tied.opened(req)
pinned = tied.pinned(sys.argv[3])
own = tied.inside(req, sys.argv[3])
Tied.done(pinned)
Tied.done(own)
tied.replied(req, 200, lambda: '{"ok": true}')
print(json.dumps([pinned is req, own is req, bool(req.get("late"))]))
`;
test("every call made for a request is counted once: a pinned one and its own both end, and nothing is left running", () => {
  const words = "Where is my parcel going next week?";
  const tied = makeTied({ norm, bodyOf: (r) => r.body, replyOf: (r) => r.reply });
  const req = { method: "POST", path: "/api/chat", body: JSON.stringify({ text: words }), reply: "", at: Date.now() };
  tied.opened(req);
  const pinned = tied.pinned(prompt(words));
  const own = tied.inside(req, prompt(words));
  tied.done(pinned);
  tied.done(own);
  tied.replied(req, 200, () => '{"ok":true}');
  assert.deepEqual([pinned === req, own === req, Boolean(req.late)], [true, true, false]);
  if (!hasPython) return;
  const run = spawnSync("python3", ["-c", COUNTED, new URL("./pyhook/", import.meta.url).pathname, words, prompt(words)], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [true, true, false], "the same in Python");
});

// A legal research API, 2026-10-06: the ask answers at once with a thread id, a worker embeds the
// question, searches, then asks its model, and the page polls the thread. The first poll to come back
// between two of those calls was taken for the answer, on a thread with no answer in it, and the ask
// left: 36 of its model calls were then pinned to nothing and the endpoint was never proven.
const THREAD = "66f1a2b3c4d5e6f7a8b9c0d1";
const QUESTION = "ما هي مدة الطعن بالاستئناف في القضايا الحقوقية؟";
const READING = "تحدد المادة مدة الطعن بالاستئناف بثلاثين يوماً من اليوم التالي لتاريخ تبليغ الحكم.";
const thread = (turn) => JSON.stringify({ id: THREAD, turns: [{ n: 1, request: QUESTION, ...turn }] });
const POLLED = [
  ["open", { id: "ask", method: "POST", path: "/v1/research/ask", body: JSON.stringify({ request: QUESTION }), reply: "" }],
  ["reply", "ask", JSON.stringify({ thread_id: THREAD, turn: { n: 1, status: "running" } })],
  ["close", "ask"],
  ["call", JSON.stringify({ model: "qwen/qwen3-embedding-8b", input: QUESTION })],
  ["open", { id: "poll-1", method: "GET", path: `/v1/research/threads/${THREAD}`, body: "", reply: "" }],
  ["close", "poll-1", thread({ status: "running", stage: "retrieving" })],
  ["call", JSON.stringify({ model: "gpt-6-astra", input: [{ role: "user", content: `<request>${QUESTION}</request>` }] }), JSON.stringify({ interim_answer: READING, unstated: null })],
  ["open", { id: "poll-2", method: "GET", path: `/v1/research/threads/${THREAD}`, body: "", reply: "" }],
  ["close", "poll-2", thread({ status: "answered", answer: READING })],
];
const PYTHON_POLLED = `
import json, sys, time
sys.path.insert(0, sys.argv[1])
from cortad_tied import Tied
tied = Tied(lambda s: " ".join(str(s).lower().split()), lambda r: r["body"], lambda r: r["reply"], lambda r: (r.get("said") or "") if r.get("late") else None)
reqs, clock, out = {}, int(time.time() * 1000), []
for op, arg, *more in json.load(sys.stdin):
    if op == "open":
        arg["at"], clock = clock, clock + 1
        reqs[arg["id"]] = arg
        tied.opened(arg)
    elif op == "reply":
        reqs[arg]["reply"] = more[0]
        tied.replied(reqs[arg], 200, lambda: more[0])
    elif op == "close":
        if more:
            reqs[arg]["reply"] = more[0]
        steps = tied.closed(reqs[arg])
        out.append([s["id"] for s in steps] if steps else None)
    else:
        asker = tied.pinned(arg)
        if asker:
            asker["noted"] = True
        Tied.done(asker)
        if asker and more:
            asker["said"] = more[0]
        out.append(asker and asker["id"])
print(json.dumps(out))
`;
const polled = {
  javascript(ops) {
    const tied = makeTied({ norm, bodyOf: (r) => r.body, replyOf: (r) => r.reply, saidOf: (r) => (r.late ? r.said ?? "" : undefined) });
    const reqs = new Map();
    let clock = Date.now();
    const out = [];
    for (const [op, arg, more] of ops) {
      if (op === "open") { const req = { ...arg, at: clock++ }; reqs.set(req.id, req); tied.opened(req); }
      else if (op === "reply") { reqs.get(arg).reply = more; tied.replied(reqs.get(arg), 200, () => more); }
      else if (op === "close") { if (more !== undefined) reqs.get(arg).reply = more; const steps = tied.closed(reqs.get(arg)); out.push(steps ? steps.map((s) => s.id) : null); }
      else { const asker = tied.pinned(arg); if (asker) asker.noted = true; tied.done(asker); if (asker && more) asker.said = more; out.push(asker?.id ?? null); }
    }
    return out;
  },
  python(ops) {
    const run = spawnSync("python3", ["-c", PYTHON_POLLED, new URL("./pyhook/", import.meta.url).pathname], { input: JSON.stringify(ops), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  },
};
for (const hook of ["javascript", "python"]) {
  test(`${hook}: a poll that comes back between two of an ask's model calls is not its answer; the poll that carries the model's words is`, { skip: hook === "python" && !hasPython }, () => {
    assert.deepEqual(polled[hook](POLLED), [null, "ask", null, "ask", ["ask"]]);
  });
}
