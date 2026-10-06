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
