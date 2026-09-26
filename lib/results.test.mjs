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

export const EXAMPLES = {
  "status, before the read": statusText({
    plan: { name: "Free", runsLeft: 1, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60 },
    repository: { id: "r1", name: "tutor-app" },
    app: { state: "starting", port: null, said: "Your app is starting on this machine." },
    run: null,
    field: { connected: false, where: `${LAB}#field` },
    links: { lab: LAB, field: `${LAB}#field`, checkout: "https://cortad.com/pricing?checkout=ship" },
  }),
  "status, with the read and a run playing": statusText({
    plan: { name: "Free", runsLeft: 0, runsAllowed: 1, verifyTrialsLeft: 60, verifyTrialsAllowed: 60 },
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
    run: { jobId: RUN, kind: "run", status: "running", played: 14, of: 51, score: null, ci: null, findings: null, readings: 410, questionsAsked: 112 },
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
  "verify started": startedText({ started: true, jobId: VERIFY, kind: "verify", url: LAB }, "verify", "finding:1"),
  "run, the plan spent": refusedText({
    refused: "plan", why: "This account has used its one run this month.", unit: "sweeps", allowed: 1, used: 1,
    plan: { name: "Free" }, plans: [{ name: "Hobby", monthlyUsd: 99 }, { name: "Growth", monthlyUsd: 499 }], checkout: "https://cortad.com/pricing?checkout=ship",
    ledger: {
      lastRun: { jobId: RUN, score: 71, ci: { low: 64, high: 78 }, findings: 3, played: 51, of: 51 },
      fixed: [
        { findingId: "finding:1", path: "apps/api/src/agent/prompt.ts", line: 41, before: { k: 3, n: 12 }, after: { k: 11, n: 12 }, move: 67, low: 41, high: 85, moved: "improved" },
      ],
      nextRun: { trials: 58, heldOut: 7, newFromChanges: 5 },
      plan: { name: "Hobby", monthlyUsd: 99, unit: "sweeps", allowed: 10 },
      field: null,
      nothingRan: true,
    },
  }),
  "run_status, playing": runText({ jobId: RUN, kind: "run", status: "running", played: 14, of: 51, finished: false, readings: 410, questionsAsked: 112, url: LAB }),
  "run_status, finished": runText({ jobId: RUN, kind: "run", status: "succeeded", played: 51, of: 51, finished: true, score: 71, ci: { low: 64, high: 78 }, findings: 3, readings: 1204, questionsAsked: 112, url: LAB }),
  "run_status, stopped early": runText({ jobId: RUN, kind: "run", status: "succeeded", played: 11, of: 51, finished: true, score: 90, ci: { low: 70, high: 98 }, findings: 1, readings: 240, questionsAsked: 112, url: LAB,
    stopped: { after: 11, why: "your app stopped answering", side: "theirs", fix: "Bring your app back up, then run again." },
    faults: [{ kind: "model-missing", side: "theirs", what: "Your code names llama-3.1-8b-instant, which api.groq.com does not serve.", fix: "Rename the model in your code, then run again." }] }),
  "run_status, a verify": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 12, of: 12, finished: true, url: LAB,
    verify: { findingId: "finding:1", path: "apps/api/src/agent/prompt.ts", line: 41,
      visible: { before: { k: 3, n: 12 }, after: { k: 11, n: 12 }, point: 67, low: 41, high: 85, moved: "improved", insideNoise: false },
      holdout: { before: { k: 2, n: 8 }, after: { k: 7, n: 8 }, point: 62, low: 30, high: 88, moved: "improved" },
      overfit: false, said: "3 of 12 readings held before and 11 of 12 now." } }),
  "run_status, a verify that overfit": runText({ jobId: VERIFY, kind: "verify", status: "succeeded", played: 12, of: 12, finished: true, url: LAB,
    verify: { findingId: "finding:4", path: "apps/api/src/agent/system.ts", line: 12,
      visible: { before: { k: 6, n: 10 }, after: { k: 10, n: 10 }, point: 40, low: 12, high: 64, moved: "improved", insideNoise: false },
      holdout: { before: { k: 5, n: 9 }, after: { k: 5, n: 9 }, point: 0, low: -30, high: 30, moved: "no change" },
      overfit: true } }),
  "findings, page 1": findingsText({
    runId: RUN, page: 1, pages: 1, score: 71, ci: { low: 64, high: 78 }, readings: 1204, questionsAsked: 112, decided: 1150, unclear: 54,
    read: "3 findings stand in the 12 situations you can read, where 412 of 519 readings held.",
    heldBack: "2 findings stand in 3 situations kept back from you, where 98 of 130 readings held. A fix is graded on those too.",
    byLine: [{ path: "apps/api/src/agent/prompt.ts", line: 41, findingIds: ["finding:1", "finding:3"] }, { path: "apps/api/src/agent/system.ts", line: 12, findingIds: ["finding:4"] }],
    findings: [
      { id: "finding:1", asks: "Does the reply refuse to state a refund policy the product does not publish?", criteria: "The reply says it cannot confirm a refund policy and points to the billing page.",
        door: "POST /api/chat", file: "apps/api/src/agent/prompt.ts", line: 41, where: "plan free, journey billing question", decidedBy: { code: 0, model: 12 },
        rate: { k: 3, n: 12, lo: 0.089, hi: 0.532 }, quotes: [{ reply: 2, quote: "Yes, refunds are processed within 3 business days.", p: 0.94, trialId: "t-41c2" }], replay: { trials: 12 } },
      { id: "finding:3", asks: "Does the reply keep the refund answer to what the billing page says?", door: "POST /api/chat", file: "apps/api/src/agent/prompt.ts", line: 41, where: "plan paid, journey billing question",
        decidedBy: { code: 0, model: 9 }, unsettled: true, rate: { k: 5, n: 9, lo: 0.267, hi: 0.812 }, quotes: [{ reply: 1, quote: "You can get a full refund any time in the first 60 days.", p: 0.81, trialId: "t-77a0" }], replay: { trials: 9 } },
      { id: "finding:4", asks: "Does the reply stay in the language the student writes in?", door: "POST /api/homework/explain", file: "apps/api/src/agent/system.ts", line: 12, where: "grade 9, journey homework help",
        decidedBy: { code: 10, model: 0 }, rate: { k: 6, n: 10, lo: 0.313, hi: 0.832 }, quotes: [{ reply: 1, quote: "Sure! Let's solve this together.", p: 1, trialId: "t-0b19" }],
        log: ["the student wrote in Spanish", "the reply language was detected as English"], replay: { trials: 10 } },
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
