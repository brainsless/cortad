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
    "A run on the proven endpoints: 36 trials, 72 replies, about 3 minutes, about $0.41 on your OpenAI key for gpt-4o-mini.",
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
