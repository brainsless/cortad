import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PROTOCOL, serveMcp, TOOLS } from "./mcp.mjs";

// A client on the other end of stdin and stdout: sends one line, reads one line back.
function client(verbs) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveMcp({ verbs, version: "0.0.0-test", input, output });
  const lines = [];
  let buffer = "";
  output.on("data", (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf("\n")) >= 0) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } });
  const ask = async (msg) => {
    const before = lines.length;
    input.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
    for (let i = 0; i < 50 && lines.length === before; i += 1) await new Promise((r) => setImmediate(r));
    return lines[before];
  };
  return { ask, end: () => { input.end(); return done; }, lines };
}

test("initialize answers the protocol, the server name and the instructions; initialized is silent", async () => {
  const c = client({});
  const init = await c.ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.result.protocolVersion, PROTOCOL);
  assert.equal(init.result.serverInfo.name, "cortad");
  assert.match(init.result.instructions, /never run `npx cortad <code>` again/);
  assert.equal(await c.ask({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.equal((await c.ask({ jsonrpc: "2.0", id: 2, method: "ping" })).result !== undefined, true);
  assert.equal(await c.end(), 0);
});

test("tools/list names the eight verbs with schemas, and tools/call runs one and renders its text", async () => {
  const calls = [];
  const c = client({ status: async () => ({ text: "Cortad · app · Free", data: {} }), verify: async (args) => { calls.push(args); return { text: "Verify started", data: {} }; }, run: async () => ({ text: "refused", isError: true }) });
  const list = await c.ask({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["status", "run", "run_status", "findings", "verify", "dispute", "field_connect", "field"]);
  assert.equal(TOOLS.every((t) => t.inputSchema.type === "object"), true);
  const status = await c.ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status", arguments: {} } });
  assert.deepEqual(status.result.content, [{ type: "text", text: "Cortad · app · Free" }]);
  await c.ask({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "verify", arguments: { findingId: "finding:1" } } });
  assert.deepEqual(calls, [{ findingId: "finding:1" }]);
  const refused = await c.ask({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "run", arguments: {} } });
  assert.equal(refused.result.isError, true);
  const unknown = await c.ask({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "toString", arguments: {} } });
  assert.match(unknown.result.content[0].text, /No tool/);
  await c.end();
});

test("an unknown method with an id is a JSON-RPC error, a bad line is a parse error, and nothing else reaches stdout", async () => {
  const c = client({});
  const missing = await c.ask({ jsonrpc: "2.0", id: 8, method: "resources/list" });
  assert.equal(missing.error.code, -32601);
  const bad = await c.ask("not json");
  assert.equal(bad.error.code, -32700);
  const notAnObject = await c.ask('"a string"');
  assert.equal(notAnObject.error.code, -32600);
  await c.end();
  assert.equal(c.lines.every((line) => line.jsonrpc === "2.0"), true);
});
