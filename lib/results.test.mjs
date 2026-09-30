import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { showText } from "./read-text.mjs";
import { fieldConnectText, fieldText, findingsText, refusedText, runText, STARTING, startedText, statusText } from "./text.mjs";

// The skill's reference shows what each verb prints. Every example there is rendered here from the
// same data, so the words the agent learns from are the words it will read.
const RUN = "8f2a1c4e-5b6d-4e7f-9a0b-1c2d3e4f5a6b";
const NEXT = "9a10b3d2-7c8d-4e9f-8a1b-2c3d4e5f6a7b";
const VERIFY = "7c31e0aa-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const LAB = "https://cortad.com/lab";
const HOBBY = { name: "Hobby", monthlyUsd: 99, runs: 10, verifyTrials: 600, productionReplies: 100000 };
const SPENT = { usd: 0.41, calls: 214, promptTokens: 402118, completionTokens: 38020 };
const NOT_MEASURED = { total: 28, groups: [
  { id: "conversation", count: 16, said: "16 need a conversation past the first reply", checks: ["Does the reply drop, deny or contradict something already on the thread?"] },
  { id: "condition", count: 8, said: "8 never met their condition (the parent asks what the plan costs)", checks: ["Does the reply quote a price the pricing page does not show?"] },
  { id: "none", count: 4, said: "4 have no trial yet", checks: ["In the journey \"account recovery\", is this step still not done after the reply: confirm the email"] },
] };

// A settled break of the app's own rule, as the server sends it: in trials, repeated, with the exchange.
const TOP = { id: "finding:1", questionId: "rule:refund-policy", asks: "Does the reply state a refund policy the product does not publish?",
  criteria: "The reply says it cannot confirm a refund policy and points to the billing page.",
  door: "POST /api/chat", file: "apps/api/src/agent/prompt.ts", line: 41, where: "plan free, journey billing question", decidedBy: { code: 0, reader: 2 },
  trials: { failed: 9, of: 12, lo: 0.467, hi: 0.911, said: "failed in 9 of 12 trials, between 47% and 91% of trials" }, baseline: { trials: 4, failed: 4 },
  rate: { k: 5, n: 31, lo: 0.07, hi: 0.33 },
  quotes: [{ reply: 2, quote: "Yes, refunds are processed within 3 business days.", trialId: "41c2e0b7", asked: "Can I get my money back if I cancel this week?",
    answer: "Of course! Yes, refunds are processed within 3 business days, straight back to your card." }],
  replay: { trials: 12, plan: "A verify replays its 9 failing trials word for word, round after round until it decides, up to 20 replays. 2 clean replays show it gone." } };
const PROMISES = { decided: 38, held: 27, failed: 11,
  said: "38 trials measured your app's own promises: 27 kept every promise they were asked about and 11 broke at least one.",
  measured: [
    { questionId: "rule:refund-policy", words: "Never state a refund policy the product does not publish.", at: "apps/api/src/agent/prompt.ts:41", failed: 9, of: 12 },
    { questionId: "rule:language", words: "Answer in the language the student writes in.", at: "apps/api/src/agent/system.ts:12", failed: 2, of: 26 },
  ] };

export const EXAMPLES = {
  "status, before the read": statusText({
    plan: { name: "Free", runsLeft: 1, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: HOBBY },
    repository: { id: "r1", name: "tutor-app" },
    app: { state: "starting", port: null, said: "Your app is starting on this machine." },
    run: null,
    field: { connected: false, where: `${LAB}#field` },
    links: { lab: LAB, field: `${LAB}#field`, checkout: "https://cortad.com/pricing?checkout=ship" },
  }),
  "status, after the agent's own requests": statusText({
    plan: { name: "Free", runsLeft: 1, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: HOBBY },
    repository: { id: "r1", name: "tutor-app" },
    app: { state: "ready-to-test", port: 3100, said: "Your app answered on port 3100." },
    contact: {
      proven: [{
        door: "POST /api/chat", surface: "homework help", requests: 2, model: "gpt-4o-mini", modelCallsPerRequest: 2, replySeconds: 3.1,
        rules: { carried: 9, of: 46, examples: [{ text: "Never state a refund policy the product does not publish.", path: "apps/api/src/agent/prompt.ts", line: 41 }] },
        tools: ["search_lessons"], passages: 3,
        problems: [{ kind: "leaked-markup", said: 'The reply carried "</student_profile>", markup from the prompt your app sent the model.', file: "apps/api/src/agent/system.ts", line: 30 }],
        sample: { ask: "and the second question?", reply: "For question 2, start by writing what the angle is opposite to." },
      }],
      notCalled: [{ name: "homework explain", method: "POST", path: "/api/homework/explain", file: "apps/api/src/routes/homework.ts", line: 18 }],
      ready: { trials: 36, replies: 72, minutes: 6, usd: 0.38, provider: "OpenAI", model: "gpt-4o-mini" },
    },
    run: null,
    next: "A run starts only when the person asks: from Run in the browser, or from the run verb.",
    field: { connected: false, where: `${LAB}#field` },
    links: { lab: LAB, field: `${LAB}#field` },
  }),
  "status, with the read and a run playing": statusText({
    plan: { name: "Free", runsLeft: 0, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: HOBBY },
    repository: { id: "r1", name: "tutor-app" },
    app: { state: "ready-to-test", port: 3100, said: "Your app answered on port 3100." },
    read: {
      rules: { count: 46, files: 5, examples: [
        { text: "Never state a refund policy the product does not publish.", path: "apps/api/src/agent/prompt.ts", line: 41 },
        { text: "Answer in the language the student writes in.", path: "apps/api/src/agent/system.ts", line: 12 },
        { text: "Cite the lesson a fact comes from.", path: "apps/api/src/tools/search.ts", line: 8 },
      ] },
      journeys: { count: 4, names: ["homework help", "billing question", "account recovery", "first lesson"] },
      profiles: { count: 3, names: ["student in grade 9", "parent paying for the plan", "teacher checking progress"] },
      doors: { count: 2, names: ["POST /api/chat", "POST /api/homework/explain"] },
      machine: { decided: 38, met: 35, missed: 3, misses: [
        { standard: "The model call has a timeout", detail: "the OpenAI client is created with no timeout, so a slow reply holds the request open", path: "apps/api/src/agent/client.ts", line: 9, decidedBy: "code" },
        { standard: "User text stays out of the system prompt", detail: "the student's name is written into the system prompt", path: "apps/api/src/agent/system.ts", line: 30, decidedBy: "model" },
        { standard: "Tool errors reach the model as errors", detail: "search returns an empty list when the index is down", path: "apps/api/src/tools/search.ts", line: 51, decidedBy: "model" },
      ] },
      questions: { total: 112, everywhere: 40, placed: 72 },
      trials: { written: 58, playable: 51, held: [
        { surface: "POST /api/homework/upload", n: 7, why: "the route needs a signed file URL, and no test account can make one", side: "theirs" },
      ] },
    },
    run: { jobId: RUN, kind: "run", status: "running", played: 14, of: 51, findings: null },
    field: { connected: false, where: `${LAB}#field` },
    links: { lab: LAB, field: `${LAB}#field`, checkout: "https://cortad.com/pricing?checkout=ship" },
  }),
  "status, show rules": showText({ read: { rules: { count: 16, files: 5, all: [
    { text: "Never state a refund policy the product does not publish.", path: "apps/api/src/agent/prompt.ts", line: 41 },
    { text: "Point billing questions to the billing page.", path: "apps/api/src/agent/prompt.ts", line: 44 },
    { text: "Answer in the language the student writes in.", path: "apps/api/src/agent/system.ts", line: 12 },
    { text: "Keep an answer for a grade 9 student to grade 9 words.", path: "apps/api/src/agent/system.ts", line: 15 },
    { text: "Ask which lesson the question is about before answering it.", path: "apps/api/src/agent/system.ts", line: 19 },
    { text: "Give the method before the answer on homework.", path: "apps/api/src/agent/system.ts", line: 22 },
    { text: "Leave the student's name out of the reply.", path: "apps/api/src/agent/system.ts", line: 30 },
    { text: "Cite the lesson a fact comes from.", path: "apps/api/src/tools/search.ts", line: 8 },
    { text: "Say so when search finds nothing, rather than answering from memory.", path: "apps/api/src/tools/search.ts", line: 14 },
    { text: "Quote at most two sentences from a lesson.", path: "apps/api/src/tools/search.ts", line: 17 },
    { text: "Hand a refund request to a person.", path: "apps/api/src/agent/handoff.ts", line: 6 },
    { text: "Hand an account recovery to a person once the email is confirmed.", path: "apps/api/src/agent/handoff.ts", line: 9 },
    { text: "Tell a parent what the plan costs only from the pricing page.", path: "apps/api/src/agent/billing.ts", line: 21 },
    { text: "Never promise a teacher a feature that is not released.", path: "apps/api/src/agent/billing.ts", line: 27 },
    { text: "Greet a first lesson with what the student can ask.", path: "apps/web/src/chat/welcome.ts", line: 3 },
    { text: "End each homework answer with one practice question.", path: "apps/web/src/chat/welcome.ts", line: 11 },
  ] } } }, "rules"),
  "run, the app already up": startedText({ started: true, jobId: NEXT, kind: "run", url: LAB, poll: `/mcp/run/${NEXT}` }, "run"),
  "run, the app still starting": STARTING,
  "verify started": startedText({ started: true, jobId: VERIFY, kind: "verify", url: LAB, note: "A verify replays its 3 failing trials word for word, and 2 held-out trials once, round after round until it decides, up to 20 replays. 2 clean replays show it gone." }, "verify", "finding:1"),
  "run, the plan spent": refusedText({
    refused: "plan", why: "This account has used its one run this month.", unit: "sweeps", allowed: 1, used: 1,
    plan: { name: "Free" }, plans: [{ name: "Hobby", monthlyUsd: 99 }, { name: "Growth", monthlyUsd: 499 }], checkout: "https://cortad.com/pricing?checkout=ship",
    ledger: {
      lastRun: { jobId: RUN, score: 71, ci: { low: 64, high: 78 }, findings: 3, played: 51, of: 51 },
      fixed: [
        { findingId: "finding:1", path: "apps/api/src/agent/prompt.ts", line: 41, verdict: "gone", before: { trials: 3, failed: 3, from: "run" }, after: { replays: 3, failed: 0 } },
      ],
      nextRun: { trials: 58, heldOut: 7, newFromChanges: 5 },
      plan: { name: "Hobby", monthlyUsd: 99, unit: "sweeps", allowed: 10 },
      field: null,
      nothingRan: true,
    },
  }),
  "run_status, playing": runText({ jobId: RUN, kind: "run", status: "running", played: 14, of: 51, finished: false, url: LAB }),
  "run_status, finished": runText({ jobId: RUN, kind: "run", status: "succeeded", played: 51, of: 51, finished: true, findings: 4, settled: 2,
    durationS: 452, spent: SPENT, promises: PROMISES, questionsAsked: 112, questionsOf: 140, notMeasured: NOT_MEASURED, url: LAB,
    plan: { name: "Free", runsLeft: 0, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60, next: HOBBY },
    dissection: {
      run: { id: RUN, played: 51, planned: 51, model: "gpt-4o-mini", durationS: 452, spent: SPENT, replies: { n: 138, medianS: 3.1, slowestS: 11.4 } },
      tools: { offered: 4, ran: 3, neverRan: ["open_ticket"] },
      runOnly: [{
        id: "finding:1", asks: TOP.asks, at: "apps/api/src/agent/prompt.ts:41", leads: true,
        reach: "failed in 9 of 12 trials, 47% to 91% of trials; 9 of its 10 breaks at reply 2",
        step: "written by the model call at apps/api/src/agent/answer.ts:58, as 61 of the run's 138 replies were, none with a tool",
        tools: [],
        layer: { name: "routing", said: "the reply was written at apps/api/src/agent/answer.ts:58 with no tool after apps/api/src/agent/route.ts:22 chose where the ask went; the fix is that choice, so this ask reaches a step with the tool" },
        exchange: { sent: "Can I get my money back if I cancel this week?", broke: "Yes, refunds are processed within 3 business days." },
        verify: TOP.replay.plan,
      }, {
        id: "finding:2", asks: "Is the reply written in a language other than the one the student wrote in?", at: "apps/api/src/agent/system.ts:12", leads: true,
        reach: "failed in 4 of 6 trials, 30% to 90% of trials",
        step: "written by the model call at apps/api/src/agent/answer.ts:58, as 61 of the run's 138 replies were, none with a tool",
        tools: ["search_lessons"],
        layer: { name: "prompt", said: "the model wrote this with its instructions in hand; the fix is the prompt at apps/api/src/agent/system.ts:12" },
        exchange: { sent: "¿Me ayudas con esta ecuación? 2x + 3 = 11", broke: "Sure! Let's solve this together." },
        verify: "A verify replays its 4 failing trials word for word, round after round until it decides, up to 20 replays. 2 clean replays show it gone.",
      }],
      also: ["Pressed by the customer, it gave way in 4 of 22 trials."],
      inCode: [{ id: "access:1", asks: "GET /api/admin/students answered 200 to a request with no sign-in; it should have refused.", at: "apps/api/src/routes/admin.ts:14", leads: true,
        reach: "knocked once, with no sign-in", verify: "verify access:1 knocks the routes again." }],
      held: "Held: 7 trials held back (POST /api/homework/upload: the route needs a signed file URL, and no test account can make one).",
      notMeasured: "28 checks not measured: 16 need a conversation past the first reply; 8 never met their condition (the parent asks what the plan costs); 4 have no trial yet.",
      next: "The next run is paired with this one, run 8f2a1c4e: the same questions on replayed trials, reply by reply, so each finding's move is counted, not guessed.",
    } }),
  "run_status, stopped early": runText({ jobId: RUN, kind: "run", status: "succeeded", played: 11, of: 51, finished: true, findings: 1, url: LAB,
    stopped: { after: 11, why: "your app stopped answering", side: "theirs", fix: "Bring your app back up, then run again." },
    faults: [{ kind: "model-missing", side: "theirs", what: "Your code names llama-3.1-8b-instant, which api.groq.com does not serve.", fix: "Rename the model in your code, then run again." }] }),
  "run_status, a verify that is gone": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 5, of: 5, finished: true, url: LAB,
    plan: { name: "Free", runsLeft: 0, runsAllowed: 1, verifyTrialsLeft: 55, verifyTrialsAllowed: 60, next: HOBBY },
    verify: { findingId: "finding:1", file: "apps/api/src/agent/prompt.ts", line: 41, verdict: "gone",
      said: "The failure is gone on its own trials: none of 3 replays failed, against 3 of 3 trials in the run it was found in. Held out, the same question in situations you cannot see: 1 of 2 trials failed before, 0 of 2 replayed after." } }),
  "run_status, a verify playing another round": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 3, of: 3, finished: false, url: LAB,
    verify: { findingId: "finding:1", file: "apps/api/src/agent/prompt.ts", line: 41, verdict: "cannot tell", going: true,
      said: "Cannot tell yet: 1 of 3 replays failed, against 3 of 3 trials in the run it was found in; 1 more clean replay would show it failing less often. Replaying the 3 failing trials again now, round 2." } }),
  "run_status, a verify that stayed": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 4, of: 4, finished: true, url: LAB,
    verify: { findingId: "finding:4", file: "apps/api/src/agent/system.ts", line: 12, verdict: "stayed",
      said: "The failure stayed: 4 of 4 replays failed, against 4 of 4 trials in the run it was found in; the same question fails on 3 of 18 trials elsewhere in your app, so these still stand out beyond chance. The replay of trial t-0b19 said at reply 1: \"Sure! Let's solve this together.\"" } }),
  "run_status, a verify the endpoint refused": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 5, of: 5, finished: true, url: LAB,
    verify: { findingId: "finding:2", file: "backend/tools/refunds.py", line: 0, verdict: "stayed",
      said: "Your app refused 5 of 5 replays (HTTP 422), so they got no answer: the fix changed what the endpoint accepts. The failure stayed: 5 of 5 replays got no answer, against 5 of 5 trials in the run it was found in; the same question fails on 2 of 16 trials elsewhere in your app, so these still stand out beyond chance." } }),
  "findings, page 1": findingsText({
    runId: RUN, page: 1, pages: 1, durationS: 452, spent: SPENT, promises: PROMISES, questionsAsked: 112, questionsOf: 140, notMeasured: NOT_MEASURED, decided: 38,
    read: "3 findings stand in the 12 situations you can read.",
    heldBack: "2 findings stand in 3 situations kept back from you. You cannot read them, and a fix is graded on those too.",
    findings: [
      TOP,
      { id: "finding:2", questionId: "language-match", asks: "Is the reply written in a language other than the one the student wrote in?", door: "POST /api/homework/explain", file: "apps/api/src/agent/system.ts", line: 12, where: "grade 9, journey homework help",
        decidedBy: { code: 2, reader: 0 }, trials: { failed: 4, of: 6, lo: 0.3, hi: 0.903 }, rate: { k: 6, n: 10, lo: 0.313, hi: 0.832 },
        quotes: [{ reply: 1, quote: "Sure! Let's solve this together.", trialId: "0b19a3f2", asked: "¿Me ayudas con esta ecuación? 2x + 3 = 11" }],
        log: ["the student wrote in Spanish", "the reply language was detected as English"],
        replay: { trials: 6, plan: "A verify replays its 4 failing trials word for word, round after round until it decides, up to 20 replays. 2 clean replays show it gone." } },
      { id: "finding:3", questionId: "rule:refund-paid", asks: "Does the reply promise a refund the billing page does not offer?", door: "POST /api/chat", file: "apps/api/src/agent/prompt.ts", line: 44, where: "plan paid, journey billing question",
        decidedBy: { code: 0, reader: 1 }, unsettled: true, trials: { failed: 2, of: 7, lo: 0.082, hi: 0.641 }, rate: { k: 5, n: 9, lo: 0.267, hi: 0.812 },
        quotes: [{ reply: 1, quote: "You can get a full refund any time in the first 60 days.", trialId: "77a0c5d1", asked: "We are on the paid plan. What happens if we cancel?" }],
        replay: { trials: 7, plan: "A verify replays its 2 failing trials word for word, round after round until it decides, up to 20 replays. 3 clean replays show it gone." } },
    ],
  }),
  "field_connect": fieldConnectText({ connected: false, steps: [
    "The owner creates the key at https://cortad.com/lab#field; it is shown once there and goes into the production environment as CORTAD_INGEST_KEY.",
    "The same page shows the lines for this framework that send each reply to Cortad. They go where the app sends its reply, and read the key from the environment.",
    "Deploy. Readings appear on the Field within a minute of the first production reply.",
  ] }),
  "field": fieldText({ days: 30, url: `${LAB}#field`,
    totals: { n: 4812, read: 4790, rulings: 61204, rulingsHeld: 56920, rulingsUnsure: 1120, resolved: 3401, frustrated: 287, wantsHuman: 96, unanswered: 191 },
    rules: [{ id: "rule:answer-first", broke: 412 }, { id: "rule:language", broke: 188 }, { id: "rule:cite-source", broke: 97 }],
    journeys: [{ value: "homework help", n: 3102, rulings: 40000, rulingsHeld: 37600 }, { value: "billing question", n: 410, rulings: 5000, rulingsHeld: 4400 }] }),
};

test("every example in the skill's reference is what the verbs print for it", () => {
  const reference = readFileSync(new URL("../skill/references/results.md", import.meta.url), "utf8");
  for (const [name, text] of Object.entries(EXAMPLES)) assert.ok(reference.includes(`\`\`\`\n${text}\n\`\`\``), `results.md does not show "${name}" as the verbs print it`);
});

test("no result tells the agent to poll, to wait on a clock, or to stay quiet, and none carries an em dash", () => {
  const reference = readFileSync(new URL("../skill/references/results.md", import.meta.url), "utf8");
  for (const text of [reference, ...Object.values(EXAMPLES)]) assert.doesNotMatch(text, /\b(?:poll|stay quiet|every 30 seconds)\b|\u2014/i);
  for (const [name, text] of Object.entries(EXAMPLES)) if (name.startsWith("run_status")) assert.match(text, /\nnext: \S.*$/, `${name} ends with the next call`);
});
