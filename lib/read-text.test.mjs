import assert from "node:assert/strict";
import { test } from "node:test";
import { SHOW, showText } from "./read-text.mjs";
import { PAGE_CHARS } from "./words.mjs";

test("a full list pages under the size Copilot keeps, names the next page, and carries every item once", () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ text: `Rule ${i + 1}: ${"keep the reply to what the product states ".repeat(3)}`, path: `src/prompts/p${i % 7}.ts`, line: i + 1 }));
  const d = { read: { rules: { count: 120, files: 7, all } } };
  const first = showText(d, "rules");
  const pages = Number(first.match(/\npage 1 of (\d+), call status with show rules and page 2$/)?.[1]);
  assert.ok(pages > 1);
  const every = Array.from({ length: pages }, (_, i) => showText(d, "rules", i + 1));
  for (const page of every) assert.ok(page.length < PAGE_CHARS, `a page is ${page.length} characters`);
  assert.match(first, /^Rules in the code: 120, in 7 files\.\n  src\/prompts\/p0\.ts:1  "Rule 1: /);
  assert.match(every[1], /^Rules in the code, continued\.\n  /);
  assert.match(every.at(-1), new RegExp(`\\npage ${pages} of ${pages}$`));
  const seen = every.join("\n").match(/"Rule \d+:/g);
  assert.equal(new Set(seen).size, 120);
  assert.equal(seen.length, 120);
});

test("from an API that sent only part of a section, the part is listed and says so", () => {
  const d = { read: { rules: { count: 16, files: 5, examples: [{ text: "Cite the lesson.", path: "a.ts", line: 8 }] }, machine: { decided: 38, met: 2, missed: 36, misses: [{ standard: "The model call has a timeout", detail: "no timeout", path: "c.ts", line: 9, decidedBy: "code" }], mets: [{ standard: "Keys stay out of the code", path: "k.ts", line: 1, decidedBy: "reader" }, { standard: "Retries back off" }] } } };
  assert.equal(showText(d, "rules"), "Rules in the code: 16, in 5 files. 1 of 16 listed.\n  a.ts:8  \"Cite the lesson.\"");
  assert.equal(showText(d, "standards"), [
    "Engineering standards: 38 decided, 2 met, 36 missed.",
    "Missed (36), 1 listed:",
    "  c.ts:9  The model call has a timeout: no timeout (decided by code)",
    "Met (2):",
    "  k.ts:1  Keys stay out of the code (decided by a model)",
    "  Retries back off",
  ].join("\n"));
});

test("journeys, endpoints and trials read one line each, in the walkthrough's words", () => {
  const read = {
    journeys: { count: 2, all: [{ name: "billing question", steps: ["asks about a refund", "asks for a person"] }, { name: "first lesson", steps: [] }] },
    doors: { count: 1, all: [{ name: "Chat", method: "POST", path: "/api/chat" }] },
    trials: { written: 58, playable: 51, all: [{ surface: "Chat", written: 51, playable: 51, held: 0 }, { surface: "Upload", written: 7, playable: 0, held: 7, why: "the route needs a signed file URL", side: "theirs" }] },
  };
  assert.equal(showText({ read }, "journeys"), "Journeys (2):\n  billing question: asks about a refund; asks for a person\n  first lesson");
  assert.equal(showText({ read }, "endpoints"), "Endpoints (1):\n  Chat: POST /api/chat");
  assert.equal(showText({ read }, "trials"), "Trials: 58 written, 51 playable.\n  Chat: 51 written, 51 playable\n  Upload: 7 written, 0 playable, 7 held back, on the app's side: the route needs a signed file URL");
  assert.equal(showText({}, "rules"), "Cortad is still reading this repository.");
  assert.deepEqual(SHOW, ["rules", "standards", "journeys", "endpoints", "trials"]);
});
