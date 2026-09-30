import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { numbersText, overviewLines } from "./numbers-text.mjs";
import { runText } from "./text.mjs";
import { PAGE_CHARS } from "./words.mjs";

// What the server handed the agent for a recorded run of 40 trials on a chat app, its outcomes re-read
// on the Field's classes: the overview run_status carries and every number `findings numbers` pages.
const fixture = JSON.parse(readFileSync(new URL("./numbers-fixture.json", import.meta.url), "utf8"));

test("the overview is one line per measurement, with its classes, the share that matters and where it is worst", () => {
  const lines = overviewLines(fixture.overview);
  assert.equal(lines[0], "Where each trial ended, at its last reply: resolved 13, partial 21, deflected 4, unresolved 2 of 40 trials; 6 ended deflected or unresolved, 7% to 29%. Most in situation where a tool ran (src/app/api/parse-pdf/route.ts): 2 of 5.");
  assert.match(lines[1], /^How the customer sounded at the end, 0 calm to 3 angry: 0: 13, 1: 16, 2: 11, 3: 0 of 40 trials, average 0\.96; 11 frustrated, 16% to 43%\./);
  assert.match(lines[1], / By reply: 1: 0\.17, 1 of 40 frustrated; 2: 0\.93, 7 of 38 frustrated; 3: 0\.98, 7 of 20 frustrated; 4: 1\.59, 7 of 10 frustrated\.$/);
  assert.equal(lines.at(-1), "7 questions measured, 2 broke in at least one trial. Every number by journey, segment, situation and reply: findings numbers.");
});

test("a finished run says the overview after its findings, with no score", () => {
  const text = runText({ jobId: "j", status: "running", finished: true, played: 40, of: 40, findings: 0, behavior: fixture.overview, score: 90 });
  assert.match(text, /^Run j: finished, 40 of 40 trials played\./, "finished once its numbers land, while its job still writes the Lab's report");
  assert.ok(text.indexOf("Where each trial ended") > 0);
  assert.doesNotMatch(text, /[Ss]core/);
});

test("every number comes in pages under what a client keeps, each table once, and the last page names no next call", () => {
  const first = numbersText(fixture, 1);
  const pages = Number(first.match(/page 1 of (\d+), call findings numbers with page 2$/)?.[1]);
  assert.ok(pages >= 2);
  const all = Array.from({ length: pages }, (_, i) => numbersText(fixture, i + 1));
  for (const page of all) assert.ok(page.length < PAGE_CHARS, `a page is ${page.length} characters`);
  assert.match(all.at(-1), new RegExp(`page ${pages} of ${pages}$`));
  const text = all.join("\n");
  for (const t of [...fixture.numbers.measures, ...fixture.numbers.questions]) assert.equal(text.split(`\n${t.kind === "question" ? `${t.id}  ` : ""}${t.title}`).length - 1, 1, t.id);
  assert.match(first, /^Run c44c7d43-3e29-49ef-9772-e6d8d9439c4c: every number it measured, 6 measurements and 7 questions over 40 trials, 108 replies and 1,249 readings\./);
});

test("each table says how its rows read, one row per group, and the exchange behind its worst group", () => {
  const text = Array.from({ length: 3 }, (_, i) => numbersText(fixture, i + 1)).join("\n");
  assert.match(text, /\n  Counted as: resolved, partial, deflected, unresolved of trials; then how many ended deflected or unresolved, with the 95% interval\.\n  All: 13, 21, 4, 2 of 40 trials; 6, 7% to 29%\n/);
  assert.match(text, /\n  By reply:\n    reply 1: [\d, ]+ of 40 trials; /);
  assert.match(text, /\nholds-the-thread  .+\n  Counted as: the trials it broke in, of the trials that asked it, with the 95% interval\.\n  All: \d+ of \d+ trials, \d+% to \d+%/);
  assert.match(text, /\n  Worst: situation where a tool ran \(src\/app\/api\/parse-pdf\/route\.ts\)\. Trial [\w-]+, reply \d\.\n    Sent: "/);
  assert.equal(numbersText({ why: "No run has finished on this repository yet." }), "No run has finished on this repository yet.");
});
