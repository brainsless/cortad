import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsText, nextCall, planLine, refusedText, runText, statusText } from "./text.mjs";
import { PAGE_CHARS } from "./words.mjs";

test("a finding's interval is its own bounds in percent, not rounded through k", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", asks: "Q?", file: "a.ts", line: 3, rate: { k: 3, n: 12, lo: 0.089, hi: 0.532 }, quotes: [], replay: { trials: 12 } }] });
  assert.match(text, /Broke in 9 of 12 replies, 75%, interval 47% to 91%\./);
});

test("findings pages stay under the size Copilot keeps, name the next page, and carry every finding once", () => {
  const findings = Array.from({ length: 40 }, (_, i) => ({
    id: `finding:${i + 1}`, asks: `Does reply ${i + 1} keep to the rule? ${"x".repeat(80)}`, criteria: "c".repeat(300), door: "POST /api/chat", where: "plan free",
    file: `src/f${i % 3}.ts`, line: 10, rate: { k: 1, n: 9, lo: 0.02, hi: 0.4 }, unsettled: true, decidedBy: { code: 2, model: 7 },
    quotes: [{ reply: 1, quote: "q".repeat(500), p: 0.9, trialId: "t" }, { reply: 2, quote: "r".repeat(500), p: 0.8, trialId: "u" }], log: ["l".repeat(400)], replay: { trials: 9 },
  }));
  const d = { runId: "r", findings, byLine: [0, 1, 2].map((n) => ({ path: `src/f${n}.ts`, line: 10, findingIds: findings.filter((f) => f.file === `src/f${n}.ts`).map((f) => f.id) })) };
  const first = findingsText(d, 1);
  const pages = Number(first.match(/page 1 of (\d+), call findings with page 2$/)?.[1]);
  assert.ok(pages > 3);
  const all = Array.from({ length: pages }, (_, i) => findingsText(d, i + 1));
  for (const page of all) assert.ok(page.length < PAGE_CHARS, `a page is ${page.length} characters`);
  assert.match(all.at(-1), new RegExp(`page ${pages} of ${pages}$`));
  const seen = all.join("\n").match(/^finding:\d+ /gm);
  assert.equal(seen.length, 40);
  assert.equal(new Set(seen).size, 40);
  assert.match(all[1], /^Run r, findings continued\.\n\nfinding:\d+ /);
  assert.match(first, /Broke in 8 of 9 replies, 89%, interval 60% to 98%\. Unsettled\./);
  assert.match(first, /Decided by code on 2 quoted replies, by a model on 7 quoted replies\./);
});

test("a field the API leaves out prints nothing, so today's API and tomorrow's both render", () => {
  assert.equal(statusText({}), "");
  assert.equal(statusText({ plan: { name: "Free", runs: { left: 1, allowed: 1 } }, repository: { name: "app" }, cases: { written: 3 }, run: null }), "Cortad · app\nPlan: Free.\nNo run yet.");
  assert.equal(runText({ jobId: "j", status: "queued" }), "Run j: queued, no trial played yet.\nnext: run_status j");
  assert.equal(refusedText({ why: "This account has used its one run this month." }), "Refused: This account has used its one run this month.\nNothing ran.");
});

test("the next call follows the run: itself while it plays, findings once there are any, status after a clean one", () => {
  assert.equal(nextCall({ jobId: "j", status: "running" }), "run_status j");
  assert.equal(nextCall({ jobId: "j", status: "succeeded", findings: 2 }), "findings");
  assert.equal(nextCall({ jobId: "j", kind: "verify", finished: true }), "findings");
  assert.equal(nextCall({ jobId: "j", status: "failed", findings: 0 }), "status");
});

test("a stop before the last trial says where and whose side; one after it is a note", () => {
  const stopped = { after: 11, why: "your app stopped answering", side: "theirs", fix: "Bring your app back up, then run again." };
  assert.match(runText({ jobId: "j", status: "succeeded", played: 11, of: 50, stopped }), /\nStopped at 11 of 50 trials, on the app's side: your app stopped answering at turn 11\. Bring your app back up, then run again\.\n/);
  assert.match(runText({ jobId: "j", status: "succeeded", played: 50, of: 50, stopped: { ...stopped, after: 112, side: "ours" } }), /\nYour app stopped answering at turn 112, on Cortad's side\./);
});

test("a verify stopped before its first trial names the door once, with no turn and one full stop", () => {
  const why = "The door this finding's trials use, POST /api/courses/from-source, did not answer when your app came up (HTTP 500: it failed on our first message and that is what it said).";
  const text = runText({ jobId: "v", kind: "verify", status: "failed", played: 0, of: 6, error: `${why} Fix that, then verify again.`, stopped: { after: 0, why, side: "theirs", fix: "Fix that, then verify again." } });
  assert.match(text, /\nStopped at 0 of 6 trials, on the app's side: The door this finding's trials use, POST \/api\/courses\/from-source, did not answer when your app came up \(HTTP 500: it failed on our first message and that is what it said\)\. Fix that, then verify again\.\n/);
  assert.doesNotMatch(text, /at turn 0|\)\. at|\nError:/);
});

test("a failed reply prints its request, response and log, and a finding with no line is never at :0", () => {
  const d = {
    runId: "r",
    byLine: [{ path: "", line: 0, findingIds: ["finding:1"] }, { path: "app/b.py", line: 0, findingIds: ["finding:2"] }],
    findings: [
      { id: "finding:1", asks: "Does your app answer?", file: "", line: 0, quotes: [{
        quote: "your app answered HTTP 500", p: 1, reply: 1, trialId: "t1",
        request: { method: "POST", path: "/api/courses", body: "{\"topic\":\"x\"}" },
        response: "{\"detail\":\"failed\"}",
        log: ["Traceback (most recent call last):", "  File \"/repo/app/courses.py\", line 741, in create", "KeyError: 'x'"],
        at: "app/courses.py:741",
      }] },
      { id: "finding:2", asks: "Q?", file: "app/b.py", line: 0, quotes: [] },
    ],
  };
  const text = findingsText(d);
  assert.doesNotMatch(text, /:0\b/);
  assert.match(text, /^finding:1  Does your app answer\?\n  Reply 1: /m);
  assert.match(text, /    Request: POST \/api\/courses \{"topic":"x"\}/);
  assert.match(text, /    Response: \{"detail":"failed"\}/);
  assert.match(text, /    Log: KeyError: 'x'/);
  assert.match(text, /    At app\/courses.py:741/);
  assert.match(text, /finding:2  Q\?\n  At app\/b.py$/);
});

// ai-robot's agents were told its knowledge base's own 1% fee was made up, with nothing to check
// the claim against, and sent to the CrewAI agent the read had labelled the door while the
// LangChain path answered. The quote now carries what the reader had and where the call was made.
test("a quote read against what the app retrieved prints what was checked, the passages and the line the call came from", () => {
  const passage = "## 保证金与服务费 1. 发布商品暂不收取发布费； 2. 交易成功后平台按成交金额收取 1% 服务费。";
  const text = findingsText({ runId: "r", findings: [{
    id: "finding:1", asks: "Does the reply state something nothing in transcript or retrieved gives?", file: "app/rag/retriever.py", line: 268, door: "CrewAI 多智能体",
    quotes: [{ quote: "平台对每笔交易收取 5% 手续费。", p: 0.93, reply: 1, trialId: "t1", at: "app/services/chat.py:71",
      checked: "Checked against 1 passage and \"已选个人资料\" your app gave the model for this reply (152 characters); none of it states this.", passages: [{ text: passage, source: "资料" }] }],
  }] });
  assert.match(text, /\n  At app\/rag\/retriever.py:268\n/);
  assert.match(text, /\n  Endpoint: CrewAI 多智能体$/);
  assert.match(text, /  Reply 1: "平台对每笔交易收取 5% 手续费。".*\n    Checked against 1 passage and "已选个人资料" your app gave the model for this reply \(152 characters\); none of it states this\.\n    Passage \(资料\): "## 保证金与服务费 1\. 发布商品暂不收取发布费； 2\. 交易成功后平台按成交金额收取 1% 服务费。"\n    At app\/services\/chat.py:71/);
});

// yunqiao's agent was sent to backend/degradation.py:104, the model-timeout wrapper, for a retrieval
// miss. A line that is not the check's own says what it is.
test("a finding placed at the tool that ran, or only at the model call, says which", () => {
  const text = findingsText({ runId: "r", findings: [
    { id: "finding:1", asks: "Do the passages miss what the customer asked?", file: "backend/tools/knowledge.py", line: 0, addressed: "the search_faq function, which ran for the replies quoted", quotes: [] },
    { id: "finding:2", asks: "Does the reply state something nothing gives?", file: "backend/degradation.py", line: 104, addressed: "the model call; the code that shaped this reply may be elsewhere", quotes: [] },
  ] });
  assert.match(text, /\n  At backend\/tools\/knowledge.py: the search_faq function, which ran for the replies quoted\n/);
  assert.match(text, /\n  At backend\/degradation.py:104: the model call; the code that shaped this reply may be elsewhere$/);
});

// ai-robot's agent read 72 playable, 59 run and 7 held back, and six held-back rows that summed to
// seven of thirteen. The run's counts now add up in one line, and the rows sum to the held-back count.
test("a run's trials add up in one line, and every held-back trial is in a row or the remainder", () => {
  const heldBack = Array.from({ length: 11 }, (_, i) => ({ surface: `reason ${i}`, trials: i === 1 || i === 8 ? 2 : 1, why: "not testable here" }));
  const text = runText({ jobId: "j", status: "succeeded", played: 59, of: 59, trials: { written: 72, chosen: 59, played: 59, notPlayed: 0, heldBack: 13, notPlanned: 0 }, heldBack });
  assert.match(text, /\nTrials: 72 written: 59 chosen for this run, 13 held back\.\n/);
  const rows = [...text.matchAll(/Held back: (\d+) (?:more )?trials?/g)].reduce((n, m) => n + Number(m[1]), 0);
  assert.equal(rows, 13);
  assert.match(text, /\nHeld back: 6 more trials for 5 other reasons\.\n/);
  const running = runText({ jobId: "j", status: "running", played: 3, of: 12, trials: { written: 20, chosen: 12, played: 3, notPlayed: 9, heldBack: 6, notPlanned: 2 } });
  assert.match(running, /\nTrials: 20 written: 12 chosen for this run, 6 held back, 2 not planned; 3 played, 9 still to play\.\n/);
  const status = statusText({ read: { trials: { written: 80 } }, run: { jobId: "j", kind: "run", status: "succeeded", played: 59, of: 59, trials: { written: 72, chosen: 59, played: 59, notPlayed: 0, heldBack: 13, notPlanned: 0 } } });
  assert.match(status, /\n8 more trials written since this run; the next run chooses from them too\./);
});

// socialcoach's twelve findings were one crash. The finding says where else the same sentence broke.
test("a finding from one cause lists the other places it stood in", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", asks: "Did it do what was asked?", file: "", where: "Role-play", rate: { k: 0, n: 28, lo: 0, hi: 0.12 }, quotes: [], replay: { trials: 4 },
    alsoIn: [{ where: "Assessment", asks: "Does it fit the voice?", rate: { k: 0, n: 22 } }, { where: "Role-play", asks: "Does it fit the voice?", rate: { k: 1, n: 28 } }] }] });
  assert.match(text, /  Same cause in 2 more places, the same reply sentence in each:\n    Assessment: Does it fit the voice\?, broke in 22 of 22 replies\n    Role-play: Does it fit the voice\?, broke in 27 of 28 replies/);
  assert.match(text, /^Run r: 1 finding\./);
});

// ai-robot's language check failed in eight situations and read as eight findings. The other
// situations sit under the one finding, apart from the other checks the same sentence broke.
test("a finding lists the other situations its own question failed in, apart from other checks", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", questionId: "language-match", asks: "Is the reply in another language?", file: "", where: "Chat", rate: { k: 0, n: 22, lo: 0, hi: 0.15 }, quotes: [], replay: { trials: 4 },
    alsoIn: [
      { questionId: "language-match", where: "intent order, Chat", asks: "Is the reply in another language?", rate: { k: 0, n: 5 } },
      { questionId: "language-match", where: "Ingest", asks: "Is the reply in another language?", rate: { k: 1, n: 4 } },
      { questionId: "did-what-was-asked", where: "Chat", asks: "Did it do what was asked?", rate: { k: 2, n: 21 } },
    ] }] });
  assert.match(text, /  Failed in 3 situations; the other 2:\n    intent order, Chat: broke in 5 of 5 replies\n    Ingest: broke in 3 of 4 replies\n  Same cause in 1 more place, the same reply sentence in each:\n    Chat: Did it do what was asked\?, broke in 19 of 21 replies/);
});

// Three agents on three repositories read "97/100", "90/100" and "0/100 provisional" ahead of the
// checks they stood on. A run from before the score counted promise trials still prints its case
// score, after what was measured, and never "on those N" for a number not computed on them.
test("what was measured comes before the score, and the checks not measured say why in groups that add up", () => {
  const notMeasured = { total: 52, groups: [
    { id: "conversation", count: 34, said: "34 need a conversation past the first reply", checks: ["Does the reply drop, deny or contradict something already on the thread?"] },
    { id: "condition", count: 12, said: "12 never met their condition (the reply quotes a price)", checks: [] },
    { id: "none", count: 6, said: "6 have no trial yet", checks: [] },
  ] };
  const run = { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 91, of: 91, score: 97, ci: { low: 90, high: 99 }, readings: 1200, questionsAsked: 26, questionsOf: 78, notMeasured };
  const text = runText(run);
  assert.match(text, /^Run j: finished, 91 of 91 trials played\.\n26 of 78 checks measured\.\n52 not measured: 34 need a conversation past the first reply; 12 never met their condition \(the reply quotes a price\); 6 have no trial yet\.\n/);
  assert.doesNotMatch(text, /[Ss]core/);
  assert.doesNotMatch(text, /never came up|on those/);
  assert.match(findingsText({ runId: "r", findings: [], ...run }), /^Run r: 0 findings\.\n\n26 of 78 checks measured\.\n52 not measured: /);
  const provisional = runText({ ...run, score: 0, ci: { low: 0, high: 16 }, decided: 3, questionsAsked: 4, questionsOf: 106, replies: { total: 60, crashed: 59 },
    notMeasured: { total: 102, groups: [{ id: "failed", count: 102, said: "102 were due on replies where your app failed", checks: [] }] } });
  assert.match(provisional, /\n4 of 106 checks measured\.\n102 not measured: 102 were due on replies where your app failed\.\n/);
  assert.doesNotMatch(provisional, /[Ss]core/);
});

test("a running run says what it is doing now, and a finished one does not", () => {
  const now = { doing: "Playing trials: 3 of 15 answered so far; your app is answering the next.", forS: 12 };
  assert.equal(runText({ jobId: "j", status: "running", played: 3, of: 15, now }), "Run j: running, 3 of 15 trials played.\nPlaying trials: 3 of 15 answered so far; your app is answering the next.\nnext: run_status j");
  assert.doesNotMatch(runText({ jobId: "j", status: "succeeded", played: 15, of: 15, now }), /Playing trials/);
});

test("a finding the run kept back is shown without its inputs", () => {
  const text = findingsText({ runId: "r", findings: [], keptBack: [{ id: "finding:3", asks: "Does the reply keep the refund policy?", file: "src/rules.ts", line: 12, layer: "policy-hold", reply: 2, rate: { k: 1, n: 6 }, quote: "Sure, full refund any time." }] });
  assert.match(text, /Kept back finding:3: "Does the reply keep the refund policy\?" at src\/rules\.ts:12, held 1 of 6 at reply 2; the reply said "Sure, full refund any time\."\. Its inputs are not shown; verify finding:3 replays them\./);
});

// An audit gate miss the run knocked open reads like a crash finding: its own words, the request
// that got past the gate, and how to prove the fix.
test("an open gate is a finding with its request, status and a replay line", () => {
  const text = findingsText({ runId: "r", findings: [{
    id: "access:1", kind: "access-open", method: "GET", route: "/api/admin/products", path: "backend/admin.py", line: 157,
    standard: "OWASP API2:2023 - every door behind the product's auth chain", as: "no-sign-in",
    request: { method: "GET", path: "/api/admin/products" }, status: 200, response: '{"products":[]}',
    says: "GET /api/admin/products answered 200 to a request with no sign-in; it should have refused.",
  }] });
  assert.match(text, /^Run r: 1 finding\./);
  assert.match(text, /access:1  GET \/api\/admin\/products answered 200 to a request with no sign-in; it should have refused\./);
  assert.match(text, /\n  At backend\/admin\.py:157\n/);
  assert.match(text, /\n  Sent: GET \/api\/admin\/products with no sign-in\n/);
  assert.match(text, /\n  Answered: 200, \{"products":\[\]\}\n/);
  assert.match(text, /\n  Replay: verify access:1$/);
});

// verify access:1 prints the routes side by side and the count that closed.
test("an access verify prints before and after per route and the aggregate", () => {
  const verify = {
    findingId: "access:1", access: true, comparable: true, routesKnocked: 3, before: 3, after: 0,
    said: "Before: 3 of 3 routes answered without a sign-in. Now: 0 of 3.",
    routes: [
      { method: "GET", route: "/api/admin/products", before: 200, after: 401, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
      { method: "GET", route: "/api/admin/orders", before: 200, after: 401, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
      { method: "GET", route: "/api/sessions/{session_id}/history", before: 200, after: 403, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
    ],
  };
  const text = runText({ jobId: "j", kind: "verify", status: "succeeded", finished: true, verify });
  assert.match(text, /Verify of access:1\./);
  assert.match(text, /\n  GET \/api\/admin\/products: answered 200 with no sign-in, now refuses \(401\)\.\n/);
  assert.match(text, /\nBefore: 3 of 3 routes answered without a sign-in\. Now: 0 of 3\.\n/);
});

// A verify is its verdict in the server's words, under the finding's file and line: no move, no
// interval and no noise floor of the CLI's own.
test("a verify prints the finding's place and the server's verdict, and a verify still playing names the next call", () => {
  const said = "Cannot tell yet: 1 of 3 replays failed, against 3 of 3 trials in the run it was found in; 1 more clean replay would show it failing less often. Replaying the 3 failing trials again now, round 2.";
  const text = runText({ jobId: "j", kind: "verify", status: "succeeded", finished: false, played: 3, of: 3,
    verify: { findingId: "finding:4", file: "apps/api/src/agent/system.ts", line: 12, verdict: "cannot tell", going: true, said } });
  assert.equal(text, `Verify j: running, 3 of 3 trials played.\nVerify of finding:4 at apps/api/src/agent/system.ts:12.\n${said}\nnext: run_status j`);
});

// bloom's agent read 8 of 11 replies with no answer as its app failing. They were our own wait
// running out on a course generator that takes ninety seconds a reply; the run and the findings say so.
test("a slow app's pace and the replies our wait cut off are printed, and said as ours", () => {
  const pace = { said: "Your app answers in about 90 seconds, so this run plays 8 of its 11 trials, one at a time, and waits up to 270 seconds for each reply." };
  const waited = { replies: 8, of: 11, said: "8 of 11 replies got no answer before we stopped waiting, which is on our side: your app was still working on them." };
  const running = runText({ jobId: "j", kind: "run", status: "running", played: 2, of: 11, now: { doing: "Playing trials: 2 of 11 answered so far. Your app is answering trial 3; its replies take about 90 seconds." }, pace });
  assert.match(running, /\nPlaying trials: 2 of 11 answered so far\. Your app is answering trial 3; its replies take about 90 seconds\.\nYour app answers in about 90 seconds, so this run plays 8 of its 11 trials/);
  const done = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 3, of: 11, pace, waited, halted: { after: 9, side: "ours", why: "we stopped waiting: 3 replies in a row did not come back" } });
  assert.match(done, /\n8 of 11 replies got no answer before we stopped waiting, which is on our side: your app was still working on them\.\n/);
  assert.match(done, /Stopped on Cortad's side after 9 turns: we stopped waiting/);
  assert.doesNotMatch(done, /Your app stopped answering|We lost your app/);
  const found = findingsText({ runId: "r", findings: [], waited, pace });
  assert.match(found, /8 of 11 replies got no answer before we stopped waiting/);
});

// A route the app no longer has, or did not answer, or was not re-knocked is named as such, never
// read as a closed gate, and the aggregate counts only the routes knocked both times.
test("an access verify keeps 'not knocked' apart from 'no answer' and does not count either", () => {
  const verify = {
    findingId: "access:2", access: true, comparable: true, routesKnocked: 1, before: 1, after: 0,
    said: "Before: 1 of 1 route answered without a sign-in. Now: 0 of 1.",
    routes: [
      { method: "GET", route: "/api/admin/products", before: 200, after: 401, wasOpen: true, nowOpen: false, state: "answered", comparable: true },
      { method: "GET", route: "/api/admin/orders", before: 200, after: 0, wasOpen: true, nowOpen: false, state: "gone", comparable: false },
      { method: "POST", route: "/api/chat", before: 422, after: 0, wasOpen: true, nowOpen: false, state: "no-answer", comparable: false },
      { method: "GET", route: "/api/sessions", before: 200, after: 0, wasOpen: true, nowOpen: false, state: "not-reknocked", comparable: false },
    ],
  };
  const text = runText({ jobId: "j", kind: "verify", status: "succeeded", finished: true, verify });
  assert.match(text, /\n  GET \/api\/admin\/orders: answered 200 with no sign-in, your app no longer has this route\.\n/);
  assert.match(text, /\n  POST \/api\/chat: reached its own checks with no sign-in \(HTTP 422\), your app did not answer this time\.\n/);
  assert.match(text, /\n  GET \/api\/sessions: answered 200 with no sign-in, was not knocked again\.\n/);
  assert.match(text, /\nBefore: 1 of 1 route answered without a sign-in\. Now: 0 of 1\.\n/);
});

// bloom, round 14: "We saw 'app answering' alongside 'app starting', then a finished run with zero
// behavior checks measured." Each endpoint's first conversation is its own line while the run plays
// and after, beside which code was played and the pace; a stop on those conversations names each
// endpoint rather than a turn.
test("the first conversation on each endpoint is its own line, and a stop on them names no turn", () => {
  const first = ["First conversation on POST /api/courses/{id}/next: 3 replies, 11 checks measured, held.", "First conversation on POST /api/courses: your app answered HTTP 500 at backend/app/courses.py:703, on the app's side; this endpoint is set aside."];
  const tested = { startedAt: "2026-09-27T16:23:15Z" };
  const now = { doing: "Playing trials: 1 of 13 answered so far; your app is answering the next.", forS: 3 };
  const lines = runText({ jobId: "j", status: "running", played: 2, of: 13, first, tested, now }).split("\n");
  assert.match(lines[1], /^App started \d\d:\d\d:\d\d\.$/);
  assert.deepEqual(lines.slice(2, 5), [...first, now.doing]);

  const why = "No endpoint held its first conversation, so the run stopped before playing any other trial: POST /gemini: your app answered with an error (HTTP 400): \"Gemini API key not configured\", on the app's side.";
  const stopped = { after: 1, why, side: "theirs", fix: "Fix what your app answered on POST /gemini, then run again.", first: true };
  assert.match(runText({ jobId: "j", status: "succeeded", played: 1, of: 13, stopped }), /\nStopped at 1 of 13 trials, on the app's side: No endpoint held its first conversation, .*on the app's side\. Fix what your app answered on POST \/gemini, then run again\.\n/);
});

// A break recorded on the 2026-09-26 loop: a rule of the app's own prompt broke in every trial that
// asked it, on replies about a search that came back empty. The agent reads that first, in trials,
// with the exchange and the line, then what was measured of the app's promises, then the score.
const top = {
  id: "finding:1", questionId: "rule:0dbfa24fa2", asks: "Does the reply break this rule of the product: You must respond with a list of strings.",
  file: "app/prompts.py", line: 257, door: "POST /api/chat", where: "chat",
  trials: { failed: 19, of: 19, lo: 0.832, hi: 1, said: "failed in 19 of 19 trials" }, baseline: { trials: 4, failed: 4 },
  rate: { k: 0, n: 52, lo: 0, hi: 0.07, said: "0 of 52 readings held" },
  quotes: [{ reply: 2, p: 0.93, trialId: "e52e8b43", quote: "Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from.",
    asked: "That's not what I asked for. I need the five subtopics broken down.",
    answer: "Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from. Rather than fabricate citations, here's a structured breakdown based on my built-in knowledge." }],
  replay: { trials: 12, seeds: [] },
};
const promises = { score: 26, ci: { low: 16, high: 42 }, decided: 38, held: 10, failed: 28,
  said: "38 trials measured your app's own promises: 10 kept every promise they were asked about and 28 broke at least one.",
  measured: [{ questionId: "rule:0dbfa24fa2", words: "You must respond with a list of strings.", at: "app/prompts.py:257", failed: 22, of: 22 }] };

test("a finished run leads with its top settled finding in trials, then what the promises measured, then the score", () => {
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 36, of: 36, findings: 3, settled: 2, top, promises, score: 26, ci: { low: 16, high: 42 }, decided: 38 });
  assert.equal(text.split("\n").slice(0, 10).join("\n"), [
    "Run j: finished, 36 of 36 trials played.",
    "Top finding:",
    "finding:1  Does the reply break this rule of the product: You must respond with a list of strings.",
    "  Failed in 19 of 19 trials, between 83% and 100% of trials.",
    "  Played again: 4 fresh trials of the same ask in other words; it broke again in 4.",
    "  Sent: \"That's not what I asked for. I need the five subtopics broken down.\"",
    "  Reply 2: \"Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from. Rather than fabricate citations, here's a structured breakdown based on my built-in knowledge.\" (trial e52e8b43)",
    "    It broke on: \"Quick transparency note before the breakdown: my live search tool is returning empty results and there's no report in this session to cite from.\"",
    "  At app/prompts.py:257",
    "  Endpoint: POST /api/chat",
  ].join("\n"));
  const order = ["Top finding:", "3 findings in all, 2 settled (enough trials to say each fails at least one visit in five; findings lists them first).", promises.said, '  "You must respond with a list of strings." (app/prompts.py:257): broke in 22 of 22 trials.']
    .map((line) => text.indexOf(`${line}\n`));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), "finding, count, then promises, in that order");
  assert.doesNotMatch(text, /kept every one/, "the server's sentence already says how many trials kept every promise");
});

test("under the floor there is no score, only what was measured; and findings pages carry the score after the findings", () => {
  const few = { ...promises, score: null, ci: null, decided: 14, held: 10, failed: 4, said: "14 trials measured your app's own promises: 10 kept every promise they were asked about and 4 broke at least one. That is too few for a score; it takes 16." };
  const text = runText({ jobId: "j", status: "succeeded", finished: true, played: 36, of: 36, findings: 0, promises: few, score: null });
  assert.match(text, /\n14 trials measured your app's own promises: 10 kept every promise they were asked about and 4 broke at least one\. That is too few for a score; it takes 16\.\n/);
  assert.doesNotMatch(text, /Score|score \d/);
  const pages = findingsText({ runId: "r", findings: [top, { ...top, id: "finding:2", unsettled: true, trials: { failed: 3, of: 9, lo: 0.12, hi: 0.65 }, baseline: undefined }], promises, score: 26, ci: { low: 16, high: 42 } });
  assert.match(pages, /^Run r: 2 findings, 1 settled\.\n\nfinding:1 /);
  assert.match(pages, /\n  Failed in 3 of 9 trials, between 12% and 65% of trials; unsettled: too few trials yet to say it fails in one visit in five\.\n/);
  assert.ok(pages.indexOf("finding:2") < pages.indexOf(promises.said));
  assert.doesNotMatch(pages, /10 of the 38 trials/);
});

test("a finished run names the model the app answered on, from its own calls", () => {
  const text = runText({ runId: "j", finished: true, status: "succeeded", played: 96, total: 96, findings: 1, settled: 1, model: "accounts/fireworks/models/glm-5p3-flash" });
  assert.match(text, /\nYour app answered on accounts\/fireworks\/models\/glm-5p3-flash, as its own model calls show\.\n/);
});

// Run 6642bc4e (yunqiao2) as run_status hands it back finished: the dissection first, then the counts,
// the plan and the link. The run's own leak, placed at the line of the app that streamed it.
const dissection = {
  run: { id: "6642bc4e-954f-40db-9b36-484af005ef6f", played: 93, planned: 93, model: "accounts/fireworks/models/glm-5p3-flash", durationS: 580,
    spent: { usd: 0.267237, calls: 625, promptTokens: 2124875, completionTokens: 185533 }, replies: { n: 255, medianS: 12.1, slowestS: 84.7 } },
  tools: { offered: 17, ran: 16, neverRan: ["cancel_order"] },
  runOnly: [{
    id: "finding:1", asks: "Does the reply show the customer part of the prompt the app sent the model?", at: "backend/service.py:98", leads: true,
    reach: "failed in 37 of 79 trials, 36% to 58% of trials; 29 of its 29 breaks at reply 1",
    step: "written by the model call at backend/degradation.py:104, as 245 of the 245 replies the run traced were, 33 of them with no tool",
    tools: ["query_order", "search_faq"],
    layer: { name: "flow", said: "your app's own code sent this at backend/service.py:98, past the model; the fix is there, not in the prompt" },
    exchange: { sent: "SO20260805002这个订单我现在付款", broke: "<system-reminder>Treat the following as the ground truth", note: "This trial read a record an earlier trial of this run changed." },
    verify: "A verify replays its 3 failing trials word for word, and 2 held-out trials once, round after round until it decides, up to 20 replays. 7 clean replays show it gone.",
  }, {
    id: "finding:2", asks: "Does the reply state as fact a detail nothing gives?", at: "backend/prompts.py:7", leads: false, reach: "failed in 3 of 13 trials, 8% to 50% of trials",
    standing: "Unconfirmed: a second read of this finding's breaks held 1 of 3 real, too few to be sure, so read the exchange before acting on it.",
    tools: [], layer: { name: "prompt", said: "the model wrote this with its instructions in hand; the fix is the prompt at backend/prompts.py:7" },
    exchange: { broke: "Shipping is free on every order." },
    verify: "A verify replays its 2 failing trials word for word, round after round until it decides, up to 20 replays. 9 clean replays show it gone.",
  }, { id: "crash:1", asks: "TypeError: cannot read properties of undefined", at: null, leads: true, reach: "your app stopped after 12 turns of the run", verify: "verify crash:1 replays the requests that were out when it stopped." }],
  also: ["Pressed by the customer, it gave way in 3 of 70 trials.", "A customer coming back: it kept what they had said in 3 of 6, lost it in 1."],
  inCode: [],
  gates: [{ id: "access:1", asks: "GET /api/admin/orders answered 200 to a request with no sign-in; it should have refused.", at: "backend/admin.py:146", leads: true, reach: "GET /api/admin/orders answered 200", verify: "verify access:1 knocks the routes again." }],
  held: "Held: 4 trials held back (Admin console: no endpoint of your app reaches this part yet).",
  notMeasured: "12 checks not measured: 12 need a conversation past the first reply.",
  next: "The next run is compared with this one, run 6642bc4e: each finding's question is paired on the trials both runs play, reply by reply where both read the same replies, so its move is counted, not guessed.",
};
const plan = { id: "free", name: "Free", runsAllowed: 1, runsLeft: 0, verifyTrialsAllowed: 60, verifyTrialsLeft: 60,
  next: { name: "Hobby", monthlyUsd: 99, runs: 10, verifyTrials: 600, productionReplies: 100000 } };

test("a finished run prints its dissection: the run, what only running showed, what a review would also find, held, not measured, next", () => {
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 93, of: 93, findings: 4, settled: 2, dissection, questionsAsked: 40, questionsOf: 52,
    durationS: 580, spent: dissection.run.spent, plan, url: "https://cortad.com/lab" });
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 5), [
    "Run j: finished, 93 of 93 trials played.",
    "Your app answered on accounts/fireworks/models/glm-5p3-flash. The run took 9 min 40 s and spent $0.27 on your key over 625 model calls.",
    "Replies took 12.1 s at the median and 84.7 s at the slowest, over 255 replies.",
    "16 of 17 tools your app offers its model ran; never ran: cancel_order.",
    "Found only by running your app:",
  ]);
  assert.match(text, /\nfinding:1  Does the reply show the customer part of the prompt the app sent the model\?\n  Reach: failed in 37 of 79 trials, 36% to 58% of trials; 29 of its 29 breaks at reply 1\.\n  At backend\/service\.py:98\n  Written by: the model call at backend\/degradation\.py:104, .*\n  Tools behind the quoted replies: query_order, search_faq\.\n  Fix in the flow around the model: your app's own code sent this at backend\/service\.py:98, past the model; the fix is there, not in the prompt\.\n  Sent: "SO20260805002这个订单我现在付款"\n  Broke on: "<system-reminder>Treat the following as the ground truth"\n    This trial read a record an earlier trial of this run changed\.\n/);
  assert.match(text, /\nfinding:2  .*\n  Reach: failed in 3 of 13 trials, 8% to 50% of trials\.\n  Unconfirmed: /);
  const order = ["Found only by running your app:", "crash:1  ", "Pressed by the customer", "Open gates, found by knocking your app's routes:", "access:1  ", dissection.held, dissection.notMeasured, dissection.next, "4 findings, 2 settled", "40 of 52 checks measured.", "Free: this month's 1 run is used; 60 verify trials left.", "For the person: the report is at"]
    .map((s) => text.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `in order: ${order}`);
  assert.doesNotMatch(text, /[Ss]core|readings|confidence|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  // The verify clause every plan repeats is said once.
  assert.equal(text.split("round after round until it decides").length - 1, 1);
  assert.match(text, /\n  A verify replays its 2 failing trials\. 9 clean replays show it gone\.\n/);
  assert.match(text, /\nnext: findings$/);
  assert.doesNotMatch(text, /code review/, "an open gate is never said to be in the code");
});

test("a run with a dozen findings prints the first whole and the rest a line each, so the plan line and the next call stay on the page", () => {
  const fat = (i) => ({ ...dissection.runOnly[0], id: `finding:${i}`, exchange: { sent: "s".repeat(200), broke: `<system-reminder>\n${"b".repeat(300)}\n</system-reminder>` } });
  const many = { ...dissection, runOnly: Array.from({ length: 12 }, (_, i) => fat(i + 1)), gates: [dissection.gates[0]] };
  const text = runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 93, of: 93, findings: 13, dissection: many, plan, url: "https://cortad.com/lab" });
  assert.ok(text.length < PAGE_CHARS, `the run is ${text.length} characters`);
  assert.match(text, /\nfinding:1  .*\n  Reach: /);
  assert.match(text, /\nfinding:12  Does the reply show .* Reach: failed in 37 of 79 trials.*\.\n/);
  assert.match(text, /\naccess:1  GET \/api\/admin\/orders .* Reach: /);
  assert.match(text, /\nfindings shows the last \d+ findings whole\.\n/);
  assert.match(text, /  Broke on: "<system-reminder> b+/, "a quoted block is one line");
  assert.match(text, /\nFree: .*\nFor the person: the report is at https:\/\/cortad\.com\/lab\nnext: findings$/);
});

test("the plan line says what this month used and what the plan above costs and buys", () => {
  assert.equal(planLine(plan), "Free: this month's 1 run is used; 60 verify trials left. Hobby $99 a month: runs and reruns included, 100,000 production replies read.");
  assert.equal(planLine({ ...plan, runsLeft: 1 }), "Free: 1 of 1 run left this month; 60 verify trials left. Hobby $99 a month: runs and reruns included, 100,000 production replies read.");
  assert.equal(planLine({ name: "Growth", runsAllowed: 30, runsLeft: 0, verifyTrialsLeft: 2000 }), "Growth: all 30 runs of this month are used; 2,000 verify trials left.");
  assert.match(statusText({ plan, repository: { name: "app" } }), /^Cortad · app\nFree: this month's 1 run is used; 60 verify trials left\. Hobby \$99 a month: /);
  const verify = runText({ jobId: "v", kind: "verify", status: "succeeded", finished: true, plan, verify: { findingId: "finding:1", said: "Gone: 0 of 7 replays failed." } });
  assert.match(verify, /\nGone: 0 of 7 replays failed\.\nFree: this month's 1 run is used; 60 verify trials left\. Hobby \$99 a month: runs and reruns included, 100,000 production replies read\.\nnext: findings$/);
  assert.doesNotMatch(runText({ jobId: "j", status: "running", plan }), /Hobby/, "a run still playing says no price");
});

test("findings name a trial by eight characters, say no confidence, and the run's cost and time", () => {
  const text = findingsText({ runId: "r", durationS: 45, spent: { usd: null, calls: 12 }, findings: [{ id: "finding:1", asks: "Q?", file: "a.ts", line: 3, trials: { failed: 2, of: 4, lo: 0.1, hi: 0.9 },
    quotes: [{ quote: "q", p: 0.91, reply: 1, trialId: "aaaaaaaa-1111-4111-8111-111111111111" }], replay: { trials: 2, plan: "A verify replays its 2 failing trials word for word, round after round until it decides, up to 20 replays. 7 clean replays show it gone." } }] });
  assert.match(text, /^Run r: 1 finding, 1 settled\.\nThe run took 45 s and made 12 model calls on your key, not all of them priced\.\n/);
  assert.match(text, /\(trial aaaaaaaa\)/);
  assert.doesNotMatch(text, /confidence|aaaaaaaa-1111/);
});

// Run 04943451 (a Chinese shop's support agent): the customers who ended their own trials were sent
// away on orders after payment. That group is what only running the app showed; read by Jev, its fix
// is a layer, read by words alone it is a note after the exchange and never a fix; with nothing of the
// kind, the run says nothing broke.
const sentAway = { id: "finding:2", asks: "Sends customers away on orders after payment: its last reply declines them or points them somewhere else, or they ask for a person and are not put through.",
  at: "src/agent/nodes.py:230", leads: true, harm: "sent away", reach: "failed in 3 of 3 trials, 44% to 100% of trials: 1 ended with a reply that declined them, 3 with one that pointed them somewhere else and 3 asked for a person and were not put through; some trials were sent away more than one way",
  step: "written by the model call at src/agent/nodes.py:230, as 12 of the 12 replies the run traced were, 9 of them with no tool", tools: [],
  neverRan: ["lookup_order", "lookup_orders_by_email", "search_orders"],
  exchange: { sent: "你们是卖东西的，连我订单都查不了？", broke: "我这边确实没有接入订单和支付系统，这个查询我做不到", after: "你们不是管订单售后的吗？怎么到查订单就说不行了？" },
  verify: "" };
const sentAwayRun = (part) => runText({ jobId: "j", kind: "run", status: "succeeded", finished: true, played: 21, of: 21, dissection: { ...dissection, runOnly: part ? [part] : [], inCode: [], gates: [] }, plan, url: "https://cortad.com/lab" });

test("customers sent away are found only by running the app, with the tools that never ran and what the customer said next", () => {
  const read = sentAwayRun({ ...sentAway, layer: { name: "prompt", said: "your prompt at src/agent/nodes.py:195 (\"没有工具结果时\") told the model to answer this way on 2 of the 3 replies read; the fix is that line" } });
  assert.match(read, /\nFound only by running your app:\nfinding:2  Sends customers away on orders after payment: .*\n  Reach: failed in 3 of 3 trials, 44% to 100% of trials: .*; some trials were sent away more than one way\.\n  Harm: sent away\.\n/);
  assert.match(read, /\n  Offered and never run in these trials: lookup_order, lookup_orders_by_email, search_orders\.\n  Fix in the prompt: your prompt at src\/agent\/nodes\.py:195 .*\n  Sent: ".*"\n  Broke on: "我这边确实没有接入订单和支付系统.*"\n  Then: "你们不是管订单售后的吗？怎么到查订单就说不行了？"\n/);
  assert.doesNotMatch(read, /Nothing broke/);
  const note = "Where the fix belongs is not known: no model read these replies. By words alone, 2 of the 3 replies read share the most with src/agent/nodes.py:199; that is a word match, not the line that wrote them.";
  const words = sentAwayRun({ ...sentAway, note });
  assert.doesNotMatch(words, /Fix in the/);
  assert.ok(words.indexOf(`  ${note}`) > words.indexOf("  Then: "), "said after the exchange");
  assert.match(sentAwayRun(null), /\nNothing broke that only running your app could show\.\n/);
});

test("a finding of customers sent away says how they were, the tools never run and what the customer said next", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", asks: "Sends customers away on orders after payment.", file: "src/agent/nodes.py", line: 230, trials: { failed: 3, of: 3, lo: 0.44, hi: 1 },
    sentAway: { said: "1 ended with a reply that declined them and 3 asked for a person and were not put through", neverRan: ["lookup_order"], note: "Where the fix belongs is not known: no model read these replies." },
    quotes: [{ quote: "查不到", answer: "查不到", after: "转人工", reply: 3, trialId: "6cf117d4-3f90-4f8b-9563-bfe1250eccff" }], replay: { trials: 3 } }] });
  assert.match(text, /\n  Failed in 3 of 3 trials, between 44% and 100% of trials\.\n  Of them, 1 ended with a reply that declined them and 3 asked for a person and were not put through\.\n  Reply 3: "查不到" \(trial 6cf117d4\)\n    Then the customer: "转人工"\n/);
  assert.match(text, /\n  Offered and never run in these trials: lookup_order\.\n/);
  assert.match(text, /\n  Where the fix belongs is not known: no model read these replies\.\n/);
  assert.doesNotMatch(text, /\n  Fix: /);
});

test("status says the latest finished run's counts and cost, never its dissection", () => {
  const text = statusText({ run: { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 93, of: 93, findings: 4, settled: 2, model: "glm-5p3-flash", durationS: 580, spent: { usd: 0.27, calls: 625 } } });
  assert.match(text, /^Latest run j: finished, 93 of 93 trials played\.\n4 findings, 2 settled .*\nYour app answered on glm-5p3-flash, as its own model calls show\.\nThe run took 9 min 40 s and spent \$0\.27 on your key over 625 model calls\./);
  assert.doesNotMatch(text, /Found only by running/);
});
