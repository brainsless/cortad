import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { INSTRUCTIONS, PROTOCOL, serveMcp, TOOLS } from "./mcp.mjs";

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
  assert.equal(init.result.instructions, INSTRUCTIONS);
  assert.equal(await c.ask({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.equal((await c.ask({ jsonrpc: "2.0", id: 2, method: "ping" })).result !== undefined, true);
  assert.equal(await c.end(), 0);
});

test("tools/list names the eight verbs with schemas, and tools/call runs one and renders its text", async () => {
  const calls = [];
  const c = client({ post: async () => ({ text: "posted" }), status: async () => ({ text: "Cortad · app · Free", data: {} }), verify: async (args) => { calls.push(args); return { text: "Verify started", data: {} }; }, run: async () => ({ text: "refused", isError: true }) });
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
  const internal = await c.ask({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "post", arguments: {} } });
  assert.match(internal.result.content[0].text, /No tool post/, "a verb that is not in TOOLS is not callable");
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

// Codex keeps the first 512 characters of server instructions self-contained; Claude Code shares
// about 4 KB across every server. Tool text says what a tool does, never how the agent should act.
test("the instructions stand alone in their first 512 characters and the tool text carries no orders", () => {
  const [first] = INSTRUCTIONS.split("\n\n");
  assert.ok(first.length <= 512, `the first paragraph is ${first.length} characters`);
  assert.match(first, /^Cortad studies how the AI in this repository behaves/);
  assert.match(first, /send one real request to each endpoint that reaches the model/);
  assert.ok(!/starts by itself|For the person/.test(INSTRUCTIONS), "no run starts unasked, and nothing is scripted for the person");
  assert.ok(INSTRUCTIONS.length < 1500, `the instructions are ${INSTRUCTIONS.length} characters`);
  // The session in order: the two reviews the read leaves, what to check before the free run, the first
  // run as a baseline, the loop after a finding, and production only once a fix is verified gone.
  assert.match(INSTRUCTIONS.split("\n\n")[1], /^When the read finishes, status leads with a review of the prompts and one of the code around the model; tell the person what each found in a few lines\. The first run is free\. /);
  assert.ok(!INSTRUCTIONS.includes("run_status follows a run"), "run_status says what it does in its own description");
  const at = ["When the read finishes, status leads with a review", "The first run is free. Before it, status names", "A first run is the baseline", "After a fix, verify replays", "Once a fix is verified gone, field_connect"].map((s) => INSTRUCTIONS.indexOf(s));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `in order: ${at}`);
  const words = [INSTRUCTIONS, ...TOOLS.flatMap((t) => [t.title, t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description)])].join("\n");
  assert.doesNotMatch(words, /\b(?:do not|don't|never|stay quiet|wait|poll|every 30 seconds|what good looks like|about 100)\b|\u2014/i);
  for (const t of TOOLS) {
    assert.ok(t.title, `${t.name} has a title`);
    assert.ok(t.description.split(/(?<=\.)\s+/).length <= 3, `${t.name} says it in three sentences at most`);
  }
  const readOnly = TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
  assert.deepEqual(readOnly, ["status", "run_status", "findings", "field"]);
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.equal(byName.run_status.inputSchema.required, undefined);
  assert.equal(byName.findings.inputSchema.properties.page.type, "integer");
  assert.deepEqual(byName.findings.inputSchema.properties.show.enum, ["numbers"]);
  assert.deepEqual(byName.status.inputSchema.properties.show.enum, ["rules", "standards", "journeys", "endpoints", "trials", "records", "reviews"]);
  assert.equal(byName.status.inputSchema.properties.show.description, "A section of the read to list in full: rules, standards, journeys, endpoints, trials, records or reviews.");
  assert.equal(byName.status.inputSchema.properties.page.type, "integer");
});

test("a result that carries structured data hands it over as structuredContent beside the text, and one without has none", async () => {
  const dissection = { run: { id: "r", played: 3, planned: 3 }, runOnly: [{ id: "finding:1", reach: "failed in 3 of 3 trials" }], inCode: [] };
  const c = client({ run_status: async () => ({ text: "Run r: finished", data: { dissection }, structured: dissection }), status: async () => ({ text: "Cortad", data: {} }) });
  const done = await c.ask({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_status", arguments: {} } });
  assert.deepEqual(done.result.content, [{ type: "text", text: "Run r: finished" }]);
  assert.deepEqual(done.result.structuredContent, dissection);
  const plain = await c.ask({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
  assert.equal("structuredContent" in plain.result, false);
  await c.end();
});
