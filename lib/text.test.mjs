import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsText, nextCall, PAGE_CHARS, refusedText, runText, statusText } from "./text.mjs";

test("a finding's interval is its own bounds in percent, not rounded through k", () => {
  const text = findingsText({ runId: "r", findings: [{ id: "finding:1", asks: "Q?", file: "a.ts", line: 3, rate: { k: 3, n: 12, lo: 0.089, hi: 0.532 }, quotes: [], replay: { trials: 12 } }] });
  assert.match(text, /Held in 3 of 12 replies, 25%, interval 9% to 53%\./);
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
