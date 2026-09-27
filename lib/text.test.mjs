import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsText, nextCall, refusedText, runText, statusText } from "./text.mjs";
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
  assert.match(all[1], /^Run r, findings continued\.\n\n14 findings at src\/f\d\.ts:10, continued\n/);
  assert.match(first, /Unsettled: under the 22-reading floor\./);
  assert.match(first, /Decided by code in 2 readings, by a model in 7 readings\./);
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
  assert.match(text, /1 finding without a line/);
  assert.match(text, /    Request: POST \/api\/courses \{"topic":"x"\}/);
  assert.match(text, /    Response: \{"detail":"failed"\}/);
  assert.match(text, /    Log: KeyError: 'x'/);
  assert.match(text, /    At app\/courses.py:741/);
  assert.match(text, /finding at app\/b.py\n/);
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

// Three agents on three repositories read "97/100", "90/100" and "0/100 provisional" ahead of the
// checks they stood on, and asked for what was tested first and why the rest was not.
test("the checks measured lead the score, and the checks not measured say why in groups that add up", () => {
  const notMeasured = { total: 52, groups: [
    { id: "conversation", count: 34, said: "34 need a conversation past the first reply", checks: ["Does the reply drop, deny or contradict something already on the thread?"] },
    { id: "condition", count: 12, said: "12 never met their condition (the reply quotes a price)", checks: [] },
    { id: "none", count: 6, said: "6 have no trial yet", checks: [] },
  ] };
  const run = { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 91, of: 91, score: 97, ci: { low: 90, high: 99 }, readings: 1200, questionsAsked: 26, questionsOf: 78, notMeasured };
  const text = runText(run);
  assert.match(text, /^Run j: finished, 91 of 91 trials played\.\n26 of 78 checks measured; score 97 of 100 on those 26, interval 90 to 99\.\n52 not measured: 34 need a conversation past the first reply; 12 never met their condition \(the reply quotes a price\); 6 have no trial yet\.\n/);
  assert.doesNotMatch(text, /never came up/);
  assert.match(findingsText({ runId: "r", findings: [], ...run }), /^Run r: 0 findings\.\n26 of 78 checks measured; score 97 of 100 on those 26, interval 90 to 99\.\n52 not measured: /);

  const provisional = runText({ ...run, score: 0, ci: { low: 0, high: 16 }, decided: 3, questionsAsked: 4, questionsOf: 106, replies: { total: 60, crashed: 59 },
    notMeasured: { total: 102, groups: [{ id: "failed", count: 102, said: "102 were due on replies where your app failed", checks: [] }] } });
  assert.match(provisional, /\n4 of 106 checks measured; provisional score 0 of 100 on those 4, interval 0 to 16, from 3 decided readings: under the 22-reading floor, so not a verdict yet; 59 of 60 replies were failures and are not in it\.\n102 not measured: 102 were due on replies where your app failed\.\n/);
  // An API that sends no set size prints the score alone, as before.
  assert.match(runText({ ...run, questionsOf: undefined, notMeasured: undefined }), /\nScore 97 of 100, interval 90 to 99\.\n/);
});

test("a running run says what it is doing now, and a finished one does not", () => {
  const now = { doing: "Playing trials: 3 of 15 answered so far; your app is answering the next.", forS: 12 };
  assert.equal(runText({ jobId: "j", status: "running", played: 3, of: 15, now }), "Run j: running, 3 of 15 trials played.\nPlaying trials: 3 of 15 answered so far; your app is answering the next.\nnext: run_status j");
  assert.doesNotMatch(runText({ jobId: "j", status: "succeeded", played: 15, of: 15, now }), /Playing trials/);
});
