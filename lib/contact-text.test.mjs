import assert from "node:assert/strict";
import { test } from "node:test";
import { contactLines } from "./contact-text.mjs";
import { statusText } from "./text.mjs";

// The status the backend builds from the proofs lib/proof.test.mjs derives from the fixture app's two
// turns on /api/chat, and one endpoint the read named that no request reached.
const contact = {
  proven: [{
    door: "POST /api/chat", surface: "chat", requests: 2, model: "fixture-model", modelCallsPerRequest: 1,
    askField: "message", session: { held: true, carrier: "body", key: "sessionId" },
    rules: { carried: 1, of: 3, examples: [{ text: "Keep answers short.", path: "proof-app.cjs", line: 6 }] },
    tools: [], passages: 0, replySeconds: 1.2,
    problems: [{ kind: "leaked-markup", said: 'The reply carried "</system-reminder>", markup from the prompt your app sent the model.', file: "proof-app.cjs", line: 6 }],
    sample: { ask: "the leak season in Porto", reply: "About the leak season in Porto: pack light. Earlier you asked about a weekend in Lisbon. </system-reminder>" },
  }],
  notCalled: [{ name: "summaries", method: "POST", path: "/api/summarize", file: "src/summarize.ts", line: 12 }],
  ready: { trials: 36, replies: 72, minutes: 3, usd: 0.41, provider: "OpenAI", model: "gpt-4o-mini" },
};

test("each proven endpoint says what its requests did inside the app, then what no request reached, then the run", () => {
  assert.deepEqual(contactLines(contact), [
    "Endpoints your own requests proved (1):",
    "  POST /api/chat: 2 requests reached fixture-model, 1 model call each, 1.2 seconds a reply.",
    '    The message goes in "message".',
    '    A later request\'s prompt carried an earlier one, held by the body field "sessionId".',
    '    The prompts carried 1 of the 3 rules read from your code, for example proof-app.cjs:6 "Keep answers short.".',
    '    Problem at proof-app.cjs:6: The reply carried "</system-reminder>", markup from the prompt your app sent the model.',
    '    Last request: "the leak season in Porto", answered "About the leak season in Porto: pack light. Earlier you asked about a weekend in Lisbon. </system-reminder>".',
    "Endpoints the read found that no request has reached (1):",
    "  POST /api/summarize  src/summarize.ts:12",
    "A run on the proven endpoints: 36 trials, 72 replies, up to about 3 minutes at one request at a time, about $0.41 on your OpenAI key for gpt-4o-mini.",
  ]);
});

test("a session not held, a problem with no line, and figures nothing measured are said plainly or left out", () => {
  const door = { door: "POST /api/once", requests: 2, model: null, modelCallsPerRequest: 1, replySeconds: null, session: { held: false, carrier: "none", key: null }, rules: { carried: 0, of: 3, examples: [] }, problems: [{ kind: "error-status", said: "Your app answered 500 after it called the model.", file: null, line: null }] };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready: { trials: 10, replies: 10, minutes: null, usd: null, provider: null, model: null } }), [
    "Endpoints your own requests proved (1):",
    "  POST /api/once: 2 requests reached the model, 1 model call each.",
    "    No later request's prompt carried an earlier one.",
    "    The prompts carried none of the 3 rules read from your code.",
    "    Problem: Your app answered 500 after it called the model.",
    "A run on the proven endpoints: 10 trials, 10 replies.",
  ]);
  const cut = { ...door, problems: [], sample: { ask: "a day trip to Sintra", reply: "Take the train from Rossio", cut: true } };
  assert.equal(contactLines({ proven: [cut], notCalled: [], ready: null }).at(-1), '    Last request: "a day trip to Sintra", answered "Take the train from Rossio", and the reply stopped before it finished.');
});

// The door the proof tests derive from a queue app's two turns: the message joins a queue, and the
// answer comes on the session's stream of events.
test("a door whose answer came on a second request says which request carried it and what tied the two", () => {
  const door = {
    door: "POST /queue/join", requests: 2, model: "fixture-model", modelCallsPerRequest: 1, replySeconds: 0.4, askField: "data",
    secondStep: { request: "GET /queue/data?session={session}", tie: { key: "session", from: "sent" }, before: ["POST /queue/join"] },
    session: { held: true, carrier: "history", key: "data" },
  };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready: null }).slice(1, 4), [
    "  POST /queue/join: 2 requests reached fixture-model, 1 model call each, 0.4 seconds a reply.",
    '    The message goes in "data".',
    '    The answer came on a second request, GET /queue/data?session={session}, tied by the "session" the first request sent; each turn first sent POST /queue/join.',
  ]);
});

test("status carries the section where the API sends one, and the API's next step", () => {
  const text = statusText({ repository: { name: "app" }, contact: { proven: [], notCalled: [], ready: null }, next: "Send one real request to each endpoint of the app that reaches its model.", run: null });
  assert.equal(text, "Cortad · app\nNo request has reached the app's model yet.\nNo run yet.\nSend one real request to each endpoint of the app that reaches its model.");
  assert.equal(statusText({ repository: { name: "app" }, run: null }), "Cortad · app\nNo run yet.", "an API without the section prints nothing for it");
});

test("what a run would write into for real is said right under the run, and without a run it is still said", () => {
  const data = ["What trials create in the Redis database 0 that REDIS_URL names stays there: we copy Postgres and Redis for a run, not that one."];
  const text = statusText({ repository: { name: "app" }, app: { data }, contact, run: null }).split("\n");
  const ready = text.findIndex((l) => l.startsWith("A run on the proven endpoints"));
  assert.equal(text[ready + 1], `Data: ${data[0]}`);
  assert.deepEqual(contactLines(null, data), [`Data: ${data[0]}`]);
});

// chatgpt-lite2 as the backend now says it (src/local/canary.ts): the canary found the model's
// instructions in no file of the app, so the door is held out of runs and Run with it, with the app's
// own persona offered; the field its client sets says where a trial takes it from.
test("each value the app's client sets says where a trial takes it, and a door runs will not use says why and whose it is", () => {
  const why = 'The instructions the model was given are not written in your code: "You are a helpful assistant.". They came from the request that proved this endpoint.';
  const door = {
    door: "POST /api/chat", requests: 2, model: "glm-5p3-flash", modelCallsPerRequest: 1, replySeconds: 4.8, askField: "messages",
    standing: "excluded", side: "ours", why, appFields: [{ field: "prompt", from: "request", path: null }],
  };
  const ready = { trials: 30, replies: 60, minutes: 11, usd: null, provider: null, model: null,
    blocked: [{ door: "POST /api/chat", side: "ours", why, question: 'Which of these does your app send as "prompt"? ChatGPT in src/lib/chat-utils.ts: "You are a professional, friendly, and helpful AI assistant.".' }] };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready }), [
    "Endpoints your own requests proved (1):",
    "  POST /api/chat: 2 requests reached glm-5p3-flash, 1 model call each, 4.8 seconds a reply.",
    `    Runs will not use this endpoint yet, on Cortad's side: ${why}`,
    '    The message goes in "messages".',
    '    "prompt" is only in your agent\'s request.',
    "A run on the proven endpoints: 30 trials, 60 replies, up to about 11 minutes at one request at a time.",
    `Run is held, on Cortad's side: POST /api/chat: ${why} Which of these does your app send as "prompt"? ChatGPT in src/lib/chat-utils.ts: "You are a professional, friendly, and helpful AI assistant.".`,
  ]);
  const fixed = { ...door, standing: "proven", why: null, side: null, appFields: [{ field: "prompt", from: "app", path: "src/lib/chat-utils.ts" }] };
  assert.deepEqual(contactLines({ proven: [fixed], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', '    "prompt" is set by your app at src/lib/chat-utils.ts.']);
  const reading = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 36, replies: 108, minutes: 4, usd: 0.06, provider: "Fireworks", model: null, reading: true } });
  assert.equal(reading.at(-1), "A run on the proven endpoints: 36 trials so far, 108 replies, up to about 4 minutes at one request at a time, about $0.06 so far on your Fireworks key. The read is still adding trials; the run waits for it and plays them all.");
  const bare = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 24, replies: 48, minutes: 3, usd: null, provider: null, model: null, rules: 0 } });
  assert.equal(bare.at(-1), "A run on the proven endpoints: 24 trials, 48 replies, up to about 3 minutes at one request at a time. No rules of your own were read from the code, so the run checks replies against generic standards.");
  const ruled = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 24, replies: 48, minutes: 3, usd: null, provider: null, model: null, rules: 9 } });
  assert.equal(ruled.at(-1), "A run on the proven endpoints: 24 trials, 48 replies, up to about 3 minutes at one request at a time. Replies are checked against the 9 rules read from your code.");
  const captured = { ...fixed, appFields: null, oneAccount: true };
  assert.deepEqual(contactLines({ proven: [captured], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', "    Every trial sends the sign-in your agent's own request carried, so all trials act as one account."]);
  const ours = { ...fixed, standing: "fallback", side: "ours", why: "Send one request the way your app's own client does, and it is proven by yours.", appFields: null };
  assert.equal(contactLines({ proven: [ours], notCalled: [], ready: null })[2], "    Proven by Cortad's requests alone: Send one request the way your app's own client does, and it is proven by yours.");
});
