import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsText, runText } from "./text.mjs";

// resumeforge's agent read "17 of 33 replies failed" and asked what was attempted, whose it was and
// how to reproduce each. The replies that did not count are said before the score, their parts add
// up to the count, and each part with a request prints it to paste.

const failedReplies = {
  replies: 33, notCounted: 17,
  said: "17 of 33 replies did not count: 9 answered HTTP 502 at backend/app/api/resume_writing.py:91 (yours; request below), 6 refused the shape we sent to POST /api/drill/{id}/answer (HTTP 422) (ours; request below), 2 got no answer from /api/chat before we stopped waiting at 90 seconds (ours).",
  rows: [
    { kind: "failed", side: "yours", door: "/api/resume/writing", status: 502, count: 9, said: "9 answered HTTP 502 at backend/app/api/resume_writing.py:91", at: "backend/app/api/resume_writing.py:91",
      curl: "curl -X POST 'http://localhost:8004/api/resume/writing' -H 'authorization: <redacted>' -H 'content-type: application/json' --data-raw '{\"message\":\"rewrite my summary\"}'", response: "Bad Gateway", verify: "finding:1" },
    { kind: "refused", side: "ours", door: "/api/drill/{id}/answer", status: 422, count: 6, said: "6 refused the shape we sent to POST /api/drill/{id}/answer (HTTP 422)",
      curl: "curl -X POST 'http://localhost:8004/api/drill/7/answer' -H 'content-type: application/json' --data-raw '{\"message\":\"hi\"}'", response: "{\"detail\":[{\"loc\":[\"body\",\"answer\"],\"msg\":\"field required\"}]}" },
    { kind: "waited", side: "ours", door: "/api/chat", status: 0, count: 2, said: "2 got no answer from /api/chat before we stopped waiting at 90 seconds" },
  ],
  held: [{ door: "Drill stream", trials: 2, why: "no route to it was found in the read, so this run had nothing to send it" }],
};
const run = { jobId: "j", kind: "run", status: "succeeded", finished: true, played: 31, of: 31, score: 88, ci: { low: 70, high: 96 }, questionsAsked: 20, questionsOf: 40,
  replies: { total: 33, crashed: 9 }, heldBack: [{ surface: "Drill stream", trials: 2, why: "no route to it was found in the read, so this run had nothing to send it" }], failedReplies };

test("the replies that did not count lead the score, each with the request to paste, and the score says the same count", () => {
  const text = runText(run);
  const lines = text.split("\n");
  const said = lines.indexOf(failedReplies.said);
  const score = lines.findIndex((l) => /^20 of 40 checks measured; score 88/.test(l));
  assert.ok(said > 0 && said < score, "said before the score");
  assert.match(lines[score], /; the 17 of 33 replies that did not count are not in it\.$/);
  assert.equal(lines[said + 1], `  Request for the 9 at backend/app/api/resume_writing.py:91: ${failedReplies.rows[0].curl}`);
  assert.equal(lines[said + 2], "    Answered: Bad Gateway");
  assert.equal(lines[said + 3], "    verify finding:1 replays them.");
  assert.match(lines[said + 4], /^ {2}Request for the 6 from \/api\/drill\/\{id\}\/answer: curl -X POST /);
  assert.doesNotMatch(text, /Request for the 2 /, "a wait of ours has no request to paste");
  assert.equal(text.match(/Held back: 2 trials on Drill stream/g)?.length, 1, "the doors held back are said once, with the replies");
  assert.ok(lines.indexOf("Held back: 2 trials on Drill stream, no route to it was found in the read, so this run had nothing to send it.") < score);
  assert.doesNotMatch(text, /\u2014/);
});

test("findings say the replies that did not count before the score too, apart from the code-audit gates", () => {
  const text = findingsText({ runId: "r", ...run, findings: [{ id: "access:1", kind: "access-open", says: "The admin route answers with no sign-in.", request: { method: "GET", path: "/admin" }, status: 200 }] });
  const lines = text.split("\n");
  assert.ok(lines.indexOf(failedReplies.said) > 0 && lines.indexOf(failedReplies.said) < lines.findIndex((l) => /^20 of 40 checks measured/.test(l)));
  assert.doesNotMatch(failedReplies.said, /admin/);
});

test("an older answer with no failed replies prints as before", () => {
  const { failedReplies: _none, ...older } = run;
  const text = runText(older);
  assert.match(text, /; 9 of 33 replies were failures and are not in it\./);
  assert.match(text, /\nHeld back: 2 trials on Drill stream, /);
  const clean = runText({ ...older, replies: { total: 33, crashed: 0 }, heldBack: [] });
  assert.doesNotMatch(clean, /did not count|not in it|Held back/, "a run with nothing that failed prints nothing extra");
});
