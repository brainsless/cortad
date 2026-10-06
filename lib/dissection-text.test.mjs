import assert from "node:assert/strict";
import { test } from "node:test";
import { dissectionLines } from "./dissection-text.mjs";

// The app was started before the read's list of tools reached it: a tool that ran was not seen, and
// "0 of 8 ran" told the person their tools went untested.
test("tools that were not recorded are said so, never counted as never run", () => {
  const run = { id: "r1", played: 3, planned: 3 };
  const said = (tools) => dissectionLines({ run, tools }).join("\n");
  assert.match(said({ offered: 8, ran: 0, neverRan: ["a"], recorded: false }), /Calls to the 8 tools your app offers its model were not recorded in this run\./);
  assert.doesNotMatch(said({ offered: 8, ran: 0, neverRan: ["a"], recorded: false }), /ran/);
  assert.match(said({ offered: 4, ran: 3, neverRan: ["open_ticket"] }), /3 of 4 tools your app offers its model ran; never ran: open_ticket\./);
});
