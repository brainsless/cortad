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
    '    A later request\'s prompt carried an earlier one, tied by the body field "sessionId".',
    '    The prompts carried 1 of the 3 rules read from your code, for example proof-app.cjs:6 "Keep answers short.".',
    '    Problem at proof-app.cjs:6: The reply carried "</system-reminder>", markup from the prompt your app sent the model.',
    '    Last message: "the leak season in Porto".',
    "Endpoints the read found that no request has reached (1):",
    "  POST /api/summarize  src/summarize.ts:12",
    "For the person: a run plays 36 conversations: about 72 replies in about 3 minutes. It costs about $0.41 on your OpenAI key for gpt-4o-mini.",
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
    "For the person: a run plays 10 conversations: about 10 replies. It runs on your app's own model keys; Cortad could not price it from what your app's model calls reported.",
  ]);
  const cut = { ...door, problems: [], sample: { ask: "a day trip to Sintra", reply: "Take the train from Rossio", cut: true } };
  assert.equal(contactLines({ proven: [cut], notCalled: [], ready: null }).at(-1), '    Last message: "a day trip to Sintra"; the reply stopped before it finished.');
  assert.match(contactLines({ proven: [door], notCalled: [], ready: { trials: 10, replies: 30, minutes: 5, usd: 0.02, usdHigh: 0.08, provider: "Fireworks", model: null, estimated: true } }).at(-1), / It costs about \$0\.02 to \$0\.08 on your Fireworks key, estimated from the length of the text since your provider sent no token counts\.$/);
  const unfound = { ...door, problems: [], sample: { ask: "", reply: "We are open until eleven on Saturdays." } };
  assert.equal(contactLines({ proven: [unfound], notCalled: [], ready: null }).at(-1), '    Last reply: "We are open until eleven on Saturdays.".', "an ask the proof could not find is left out, never shown as empty quotes");
  const long = { ...unfound, sample: { ask: "", reply: "We are open until eleven on Saturdays, and on Sundays we open at noon and close at nine." } };
  assert.equal(contactLines({ proven: [long], notCalled: [], ready: null }).at(-1), '    Last reply: "We are open until eleven on Saturdays, and on Sundays we open at noon and clo...".');
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

// gemnex-whatsapp-agent: the webhook answers {"ok":true} at once and its worker's model answers later.
test("a door the app answers later says so, and that the model's last answer is what is graded", () => {
  const door = { door: "POST /api/simulate", requests: 1, model: "fake-model", modelCallsPerRequest: 3, replySeconds: 5.2, askField: "text", later: true, session: { held: false, carrier: "none", key: null } };
  assert.deepEqual(contactLines({ proven: [door], notCalled: [], ready: null }).slice(1), [
    "  POST /api/simulate: 1 request reached fake-model, 3 model calls each, 5.2 seconds a reply.",
    '    The message goes in "text".',
    "    Your app takes the message at once and its model answers afterwards; Cortad grades the model's last answer to each message.",
  ]);
});

test("status carries the section where the API sends one, and the API's next step", () => {
  const text = statusText({ repository: { name: "app" }, contact: { proven: [], notCalled: [], ready: null }, next: "Send one real request to each endpoint of the app that reaches its model.", run: null });
  assert.equal(text, "Cortad · app\nSend one real request to each endpoint of the app that reaches its model.");
  assert.equal(statusText({ repository: { name: "app" }, run: null }), "Cortad · app", "an API without the section prints nothing for it");
});

test("what a run would write into for real is said right under the run, and without a run it is still said", () => {
  const data = ["What trials create in the Redis database 0 that REDIS_URL names stays there: we copy Postgres and Redis for a run, not that one."];
  const text = statusText({ repository: { name: "app" }, app: { data }, contact, run: null }).split("\n");
  const ready = text.findIndex((l) => l.startsWith("For the person: a run plays "));
  assert.equal(text[ready + 1], `Data: ${data[0]}`);
  assert.deepEqual(contactLines(null, data), [`Data: ${data[0]}`]);
});

// chatgpt-lite2 as the backend now says it (src/local/canary.ts): the canary found the model's
// instructions in no file of the app, so the door is held out of runs and Run with it, with the app's
// own persona offered; the field its client sets says where a trial takes it from. The hold on Run is
// the server's next line, so `blocked` prints nothing here.
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
    `    Runs leave this endpoint out: ${why} That is on Cortad's side, not your app's.`,
    '    The message goes in "messages".',
    '    "prompt" is only in your agent\'s request.',
    "For the person: a run plays 30 conversations: about 60 replies in about 11 minutes. It runs on your app's own model keys; Cortad could not price it from what your app's model calls reported.",
  ]);
  const theirs = { ...door, side: "theirs", why: "Your app answered 500 to every message." };
  assert.equal(contactLines({ proven: [theirs], notCalled: [], ready: null })[2], "    Runs leave this endpoint out: Your app answered 500 to every message. That is in your app.");
  const fixed = { ...door, standing: "proven", why: null, side: null, appFields: [{ field: "prompt", from: "app", path: "src/lib/chat-utils.ts" }] };
  assert.deepEqual(contactLines({ proven: [fixed], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', '    "prompt" is set by your app at src/lib/chat-utils.ts.']);
  const reading = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 36, replies: 108, minutes: 4, usd: 0.06, provider: "Fireworks", model: null, reading: true } });
  assert.equal(reading.at(-1), "For the person: a run plays 36 conversations so far: about 108 replies in about 4 minutes. It costs about $0.06 so far on your Fireworks key. Your code is still being read; the run waits for it and plays every conversation it adds.");
  const bare = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 24, replies: 48, minutes: 3, usd: null, provider: null, model: null, rules: 0 } });
  assert.equal(bare.at(-1), "For the person: a run plays 24 conversations: about 48 replies in about 3 minutes. It runs on your app's own model keys; Cortad could not price it from what your app's model calls reported. No rules of your own were read from the code, so replies are checked against general standards only.");
  const ruled = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 24, replies: 48, minutes: 3, usd: null, provider: null, model: null, rules: 9 } });
  assert.equal(ruled.at(-1), "For the person: a run plays 24 conversations: about 48 replies in about 3 minutes. It runs on your app's own model keys; Cortad could not price it from what your app's model calls reported. Every reply is checked against the 9 rules read from your code.");
  const noted = { ...fixed, appFields: null, checks: ["The second message of one conversation did not carry the first, though your own requests showed this endpoint holds a conversation."] };
  assert.deepEqual(contactLines({ proven: [noted], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', "    Cortad's test conversation here: The second message of one conversation did not carry the first, though your own requests showed this endpoint holds a conversation."]);
  const slow = contactLines({ proven: [fixed], notCalled: [], ready: { trials: 44, planned: 72, replies: 88, minutes: 12, usd: null, provider: null, model: null } });
  assert.equal(slow.at(-1), "For the person: a run plays 44 of the 72 conversations planned, as many as fit in one run's time: about 88 replies in about 12 minutes. It runs on your app's own model keys; Cortad could not price it from what your app's model calls reported.");
  const captured = { ...fixed, appFields: null, accounts: 1 };
  assert.deepEqual(contactLines({ proven: [captured], notCalled: [], ready: null }).slice(2), ['    The message goes in "messages".', "    All conversations act as one account."]);
  assert.equal(contactLines({ proven: [{ ...captured, accounts: 3 }], notCalled: [], ready: null })[3], "    Conversations are split across 3 accounts, one for each customer your requests signed in as.");
  assert.equal(contactLines({ proven: [{ ...captured, accounts: null }], notCalled: [], ready: null }).length, 3, "an endpoint that needs no sign-in says nothing of accounts");
  const ours = { ...fixed, standing: "fallback", side: "ours", why: "Send one request the way your app's own client does, and it is proven by yours.", appFields: null };
  assert.equal(contactLines({ proven: [ours], notCalled: [], ready: null })[2], "    Proven by Cortad's requests alone: Send one request the way your app's own client does, and it is proven by yours.");
});

// ulaim: two of its endpoints had no token counts, and one unpriced leg used to blank the whole price.
test("a price that covers some endpoints says at least, and on how many", async () => {
  const { contactLines } = await import("./contact-text.mjs");
  const lines = contactLines({ proven: [], ready: { trials: 40, planned: 47, replies: 120, minutes: 9, usd: 0.42, usdHigh: 1.4, provider: "Fireworks", model: "glm-5p3-flash", pricedOn: { endpoints: 13, of: 15 } } });
  const line = lines.find((l) => l.startsWith("For the person: a run plays "));
  assert.match(line, /It costs at least \$0\.42, priced on 13 of 15 endpoints on your Fireworks key for glm-5p3-flash\./);
  assert.doesNotMatch(line, /\$1\.40/);
});

test("the quote says the conversations the run plays at its start, and follow-ups apart", async () => {
  const { contactLines } = await import("./contact-text.mjs");
  const line = contactLines({ proven: [], ready: { trials: 79, planned: 79, followUps: 12, replies: 240, minutes: 9 } }).find((l) => l.startsWith("For the person: a run plays "));
  assert.match(line, /^For the person: a run plays 79 conversations, and up to 12 more where something breaks: about 240 replies in about 9 minutes\./);
});

// The run widens only while replies keep pace: an app that answers one request at a time fits 49 of
// these 93 conversations in the run's time, and the quote used to say so.
test("an app that answers one request at a time is not promised every conversation", () => {
  const line = contactLines({ proven: [], ready: { trials: 93, planned: 93, replies: 279, minutes: 5, usd: 0.31, usdHigh: 1.08, provider: "Fireworks", model: null, atOne: { trials: 49, minutes: 12 } } }).at(-1);
  assert.equal(line, "For the person: a run plays 93 conversations: about 279 replies in about 5 to 12 minutes. If your app answers one request at a time, about 49 of them fit in that time. It costs about $0.31 to $1.08 on your Fireworks key.");
});

// ulaim's hold on its Qdrant was read twice in one status: here and in the server's next line.
test("a store decision the server sends as the next step is said once, after the quote", () => {
  const held = "DATABASE_URL points at the Postgres database shop off this machine, and no migrations were found to build a copy on this machine from, so the run would write into it as it is. Point DATABASE_URL at a database on this machine, then run the connect command again.";
  const next = `For the person: ${held} Or one press on the card in the browser lets the run write into it and starts the run.`;
  const ready = { ...contact.ready, blocked: [{ door: "DATABASE_URL", side: "theirs", why: held }] };
  const lines = statusText({ repository: { name: "app" }, contact: { ...contact, ready }, next, run: null }).split("\n");
  assert.equal(lines.filter((l) => l.includes("DATABASE_URL points at")).length, 1);
  assert.equal(lines.at(-1), next);
  assert.equal(lines.at(-2), "For the person: a run plays 36 conversations: about 72 replies in about 3 minutes. It costs about $0.41 on your OpenAI key for gpt-4o-mini.");
});

test("while the code is still being read the quote says so once and claims no rules are missing", () => {
  const line = contactLines({ proven: [], ready: { trials: 24, planned: 24, replies: 72, minutes: 3, usd: null, provider: null, model: null, rules: 0, reading: true } }).at(-1);
  assert.doesNotMatch(line, /No rules of your own/);
  assert.match(line, / Your code is still being read; the run waits for it and plays every conversation it adds\.$/);
  const status = statusText({ repository: { name: "app" }, read: { complete: false }, contact: { proven: [], ready: { trials: 24, planned: 24, reading: true } }, run: null });
  assert.equal(status.split("still being read").length - 1, 1);
});
