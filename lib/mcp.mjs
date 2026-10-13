// The MCP face: newline-delimited JSON-RPC 2.0 on stdin and stdout, protocol 2025-06-18, no
// dependency. stdout carries protocol messages and nothing else; everything a person might read
// goes to stderr. The tools are lib/verbs.mjs, one to one.

import { randomUUID } from "node:crypto";
import { SHOW } from "./read-text.mjs";

export const PROTOCOL = "2025-06-18";

// Codex keeps only the first 512 characters self-contained and Claude Code shares about 4 KB across
// every server, so the first paragraph stands alone and the whole stays under 1,500 characters.
export const instructions = (spec = "cortad") => [
  "Cortad tests the AI in this repository: simulated users written from the app's code talk to the app running on this machine, and every reply is checked. Cortad sends each AI endpoint a test request itself. status says whether the app is up, what Cortad's audit of the AI code found, and what a run would play and cost. A run starts when the person presses Run in the browser or asks you.",
  `Tell the person what status found in three or four short, plain lines, leaving out file paths, endpoints, status codes and setting names unless they ask. Before you stop, start \`npx -y ${spec} wait\` as a background command: it returns when the next run or verify ends, with what it found. After a run, call findings and tell the person what their users ran into and what you would change, worst first, three problems at most; the person then says which fix to make, and nothing is edited before their go. On their go, one fix at a time: verify replays the failing conversations and says whether the failure is gone, and a further round plays only when verify is called again. findings has each failure whole and findings numbers every rate. field_connect gives the steps to connect production. dispute records a check that reads this app wrong.`,
].join("\n\n");
export const INSTRUCTIONS = instructions();

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const none = { type: "object", properties: {}, additionalProperties: false };
const readOnly = { readOnlyHint: true };
// What a note to the Cortad team may be about: a tool, the connect command, or the skill text.
const ABOUT = ["status", "reach", "run", "run_status", "findings", "verify", "dispute", "field_connect", "field", "world", "world_status", "connect", "skill"];

export const TOOLS = [
  { name: "status", title: "Cortad status", annotations: readOnly,
    description: "What Cortad found in this repository: whether the app is up and on which port, its audit of the prompts and of the code around the model, each endpoint's answer to Cortad's test request or the file and line it failed at, the plan with runs left, and the latest run. Applies at the start of a session, right after a connect, and before a commit that changes prompts, tools, models or retrieval. With show, one section in full, in pages.",
    inputSchema: { type: "object", properties: { show: { type: "string", enum: SHOW, description: "A section to list in full: rules, standards, journeys, endpoints, trials, records or reviews; or machine, what Cortad does on this machine." }, page: { type: "integer", minimum: 1, description: "The page of that list. Default 1." } }, additionalProperties: false } },
  { name: "reach", title: "Send Cortad's test requests again",
    description: "Sends Cortad's test request again to the endpoints status lists as failed or not yet answered, or to the paths named, from this machine to the app on its port. Each endpoint comes back with its HTTP status, its time and, when it is not 2xx, the start of what the app answered.",
    inputSchema: { type: "object", properties: {
      paths: { type: "array", items: { type: "string" }, description: "Only these endpoints, by path. Default: every endpoint status lists as failed or not yet answered." },
    }, additionalProperties: false } },
  { name: "run", title: "Start a run", inputSchema: none,
    description: "Starts a run of conversations against the app on this machine and answers within a second with the run id; after the first run it plays what the files saved since the last full run reach, plus new conversations written for the change, and its result leads with what moved. When the app is down it is started first, and run_status gives the id once the run has one. Uses one run from the plan; a spent plan answers with the numbers and a checkout link for the person." },
  { name: "run_status", title: "Run progress", annotations: readOnly,
    description: "Where a run or verify stands: conversations played of the total, the findings, what the app's rules and users measured, and for a verify whether the failure is gone, shows less often, stayed or cannot be told yet. The call holds up to 45 seconds until the count moves, and ends with the next call. With no jobId it follows the run this machine started last, or the latest run.",
    inputSchema: { type: "object", properties: { jobId: str("A run or verify id, or the word pending. Omit for the run this machine started last.") }, additionalProperties: false } },
  { name: "findings", title: "Findings", annotations: readOnly,
    description: "The failures of a run, worst first and grouped by file and line: the question, the conversations it failed in with the range, the exchange, what a verify replays and how many clean replays would show it gone, then where the conversations ended and how their simulated users fared. With show numbers, every number the run measured: each question and measurement by journey, simulated user and reply, with ranges and the exchange behind the worst group. Once a run has finished, a long list comes in pages.",
    inputSchema: { type: "object", properties: { jobId: str("A run id. Omit for the latest."), show: { type: "string", enum: ["numbers"], description: "numbers: every number the run measured, in pages." }, page: { type: "integer", minimum: 1, description: "The page to read. Default 1." } }, additionalProperties: false } },
  { name: "verify", title: "Verify a fix",
    description: "Replays the conversations a finding failed on, word for word, after a change, and again by itself until an exact test says the failure is gone, shows less often, stayed, or cannot tell yet with how many clean replays would decide. Replies refused or failed on the replay are said first; conversations of the same question saved to test the fix are replayed once, and where they disagree with the replays beyond chance the first sentence says so; a crash:N finding replays the requests out when the app stopped. Answers within a second, run_status follows every round, and it uses verify conversations from the plan, not a run.",
    inputSchema: { type: "object", properties: { findingId: str("The finding id from findings."), jobId: str("The run the finding came from. Omit for the latest.") }, required: ["findingId"], additionalProperties: false } },
  { name: "dispute", title: "Dispute a check",
    description: "Records that a finding's check reads this app wrong, with the reason and an optional better wording. The finding and its rate stay as they are; the note goes to the owner.",
    inputSchema: { type: "object", properties: { findingId: str("The finding id."), why: str("One or two sentences: what the check gets wrong about this app.", { maxLength: 500 }), question: str("The wording that fits this app.", { maxLength: 300 }) }, required: ["findingId", "why"], additionalProperties: false } },
  { name: "feedback", title: "A note to the Cortad team",
    description: "Sends the Cortad team a note about Cortad itself: a result that read wrong, something you needed that no tool gave, a question a result left open, or what worked. Filing one is part of using Cortad, and the team reads each note. Nothing about the run or its checks changes.",
    inputSchema: { type: "object", properties: {
      about: { type: "string", enum: ABOUT, description: "The tool the note is about, connect for the connect command, or skill for the instructions you were handed." },
      kind: { type: "string", enum: ["problem", "idea", "question", "praise"], description: "problem: wrong or failed; idea: something you needed; question: something a result left open; praise: what worked." },
      needed: str("What you were trying to do or find out.", { maxLength: 500 }),
      got: str("What came back instead, in your own words; leave out your users' text and any key.", { maxLength: 1000 }),
      tried: str("What you did about it: another call, a guess, or asked the person.", { maxLength: 500 }),
    }, required: ["about", "kind", "needed"], additionalProperties: false } },
  { name: "field_connect", title: "Connect production", inputSchema: none,
    description: "The steps to connect production, to see what real users are doing as it happens and where the AI lets them down. The owner creates the key in the browser." },
  { name: "field", title: "Production numbers", annotations: readOnly,
    description: "Production in numbers: conversations read, checks passed, resolved, frustrated, asks for a human, and the rules broken most. Message text stays out of the answer.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 180, description: "Window in days. Default 30." } }, additionalProperties: false } },
  { name: "world", title: "Test the AI in a world",
    description: "For an AI in this app that is not a chat, such as a worker that reads data and writes a verdict: Cortad builds a copy of the product's data on this machine from the app's own seed, plants problems whose answers are known, runs the app's own detection on each, and scores what it raised against the answer key, repeated for a flip rate. Answers within a second with the world's id; world_status follows it. Say what was built or what to test, and the report keeps it.",
    inputSchema: { type: "object", properties: { ask: str("What was built or what to test, in a sentence.", { maxLength: 2000 }) }, additionalProperties: false } },
  { name: "world_status", title: "Where a world stands", annotations: readOnly,
    description: "Where a world stands: planted problems found, missed, false alarms where nothing was planted, and flips between repeats, with what the app raised for each.",
    inputSchema: { type: "object", properties: { jobId: str("The world's id, from world.") }, required: ["jobId"], additionalProperties: false } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

// Serves until stdin closes. `verbs` is lib/verbs.mjs's object; `version` is the package's.
// `report` is lib/calls.mjs: handed each tool call once it has answered, and awaited before the exit.
export function serveMcp({ verbs, version, spec, input = process.stdin, output = process.stdout, log = () => {}, report = async () => {} }) {
  return new Promise((resolve) => {
    let client = {};
    const sending = new Set();
    // `callId`: this call's own name, made when it arrives and sent with every report of it (lib/calls.mjs).
    const count = (tool, began, text, failure, callId) => {
      const sent = Promise.resolve(report({ tool, callId, durationMs: Date.now() - began, outputChars: text.length, ...failure, ...client })).catch(() => {}).finally(() => sending.delete(sent));
      sending.add(sent);
    };
    let closed = false;
    const close = () => { if (!closed) { closed = true; void Promise.all(sending).then(() => resolve(0)); } };
    const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
    let buffer = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) void handle(line);
      }
    });
    input.on("end", close);
    input.on("close", close);

    async function handle(line) {
      let msg;
      try { msg = JSON.parse(line); } catch { send(error(null, -32700, "parse error")); return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) { send(error(null, -32600, "invalid request")); return; }
      const { id, method, params } = msg;
      const notification = id === undefined || id === null;
      const began = Date.now();
      const callId = randomUUID();
      try {
        switch (method) {
          case "initialize":
            client = { clientName: params?.clientInfo?.name, clientVersion: params?.clientInfo?.version };
            return send(result(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "cortad", version }, instructions: instructions(spec) }));
          case "notifications/initialized":
          case "notifications/cancelled":
            return;
          case "ping":
            return send(result(id, {}));
          case "tools/list":
            return send(result(id, { tools: TOOLS }));
          case "tools/call": {
            const name = params?.name;
            const verb = NAMES.has(name) && Object.hasOwn(verbs, name) ? verbs[name] : null;
            if (!verb) {
              count("unknown", began, "", { errorCode: "unknown_tool" }, callId);
              return send(result(id, { content: [{ type: "text", text: `No tool ${String(name)}.` }], isError: true }));
            }
            const out = await verb(params?.arguments ?? {});
            count(name, began, out.text, out.isError ? { errorCode: out.code ?? "refused", error: out.why } : {}, callId);
            const structured = out.structured && typeof out.structured === "object" && !Array.isArray(out.structured) ? { structuredContent: out.structured } : {};
            return send(result(id, { content: [{ type: "text", text: out.text }], ...structured, ...(out.isError ? { isError: true } : {}) }));
          }
          default:
            if (!notification) send(error(id, -32601, `method not found: ${String(method)}`));
        }
      } catch (err) {
        log(`mcp ${method}: ${err?.stack ?? err}`);
        if (method === "tools/call") count(NAMES.has(params?.name) ? params.name : "unknown", began, "", { errorCode: "internal" }, callId);
        if (!notification) send(result(id, { content: [{ type: "text", text: `Cortad could not answer: ${String(err?.message ?? err)}` }], isError: true }));
      }
    }
  });
}
