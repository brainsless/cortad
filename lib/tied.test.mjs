import assert from "node:assert/strict";
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
