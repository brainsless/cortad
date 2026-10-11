import assert from "node:assert/strict";
import { test } from "node:test";
import { makeReport } from "./calls.mjs";

test("a count goes to Cortad with the machine's key, one line of the failure, and nothing when the folder is not connected or the send fails", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return { ok: true }; };
  const report = makeReport({ api: "https://cortad.com/api", token: () => "blm_k", version: "0.3.2", fetchImpl, sessionId: "s1" });
  await report({ tool: "run", durationMs: 40, outputChars: 12, errorCode: "http_500", error: "Cortad answered 500.\nFor the person: more", clientName: "cursor", clientVersion: "1" });
  assert.equal(sent[0].url, "https://cortad.com/api/mcp/calls");
  assert.equal(sent[0].init.headers.authorization, "Bearer blm_k");
  assert.deepEqual(JSON.parse(sent[0].init.body), [{ tool: "run", durationMs: 40, outputChars: 12, errorCode: "http_500", error: "Cortad answered 500.", clientName: "cursor", clientVersion: "1", serverVersion: "0.3.2", sessionId: "s1" }]);

  await makeReport({ api: "x", token: () => null, version: "1", fetchImpl })({ tool: "status", durationMs: 1, outputChars: 1 });
  assert.equal(sent.length, 1);
  await makeReport({ api: "x", token: () => "k", version: "1", fetchImpl: async () => { throw new Error("down"); } })({ tool: "status", durationMs: 1, outputChars: 1 });
});

// The agent's own test request is a try Cortad counts. Its report is sent again when it is lost, under
// the same id every time, and no other call's is.
test("a reach's report keeps its id across a few bounded sends; any other call is sent once", async () => {
  const sent = [];
  let fail = 2;
  const fetchImpl = async (_url, init) => { sent.push(JSON.parse(init.body)[0]); if (fail-- > 0) throw new Error("down"); return { ok: true, status: 204 }; };
  const waits = [];
  const report = makeReport({ api: "x", token: () => "k", version: "1", fetchImpl, sessionId: "s1", wait: async (ms) => { waits.push(ms); } });
  await report({ tool: "reach", callId: "11111111-1111-4111-8111-111111111111", durationMs: 5, outputChars: 9 });
  assert.equal(sent.length, 3, "sent again until it is taken");
  assert.deepEqual([...new Set(sent.map((c) => c.callId))], ["11111111-1111-4111-8111-111111111111"], "always under the call's own id");
  assert.deepEqual(waits, [400, 800]);

  sent.length = 0; fail = 99;
  await report({ tool: "reach", callId: "22222222-2222-4222-8222-222222222222", durationMs: 5, outputChars: 9 });
  assert.equal(sent.length, 3, "and no more than three times");
  sent.length = 0;
  await report({ tool: "status", callId: "33333333-3333-4333-8333-333333333333", durationMs: 5, outputChars: 9 });
  assert.equal(sent.length, 1, "a count that is not a try is not sent again");
  sent.length = 0;
  await report({ tool: "reach", durationMs: 5, outputChars: 9 });
  assert.equal(sent.length, 1, "a reach with no id has nothing to be told apart by, and is sent once");
  sent.length = 0;
  await makeReport({ api: "x", token: () => "k", version: "1", fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body)[0]); return { ok: false, status: 400 }; }, wait: async () => {} })({ tool: "reach", callId: "44444444-4444-4444-8444-444444444444", durationMs: 1, outputChars: 1 });
  assert.equal(sent.length, 1, "refused for good is not sent again");
});
