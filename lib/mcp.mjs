// The MCP face: newline-delimited JSON-RPC 2.0 on stdin and stdout, protocol 2025-06-18, no
// dependency. stdout carries protocol messages and nothing else; everything a person might read
// goes to stderr. The tools are lib/verbs.mjs, one to one.

import { SHOW } from "./read-text.mjs";

export const PROTOCOL = "2025-06-18";

// Codex keeps only the first 512 characters self-contained and Claude Code shares about 4 KB across
// every server, so the first paragraph stands alone and the whole stays under 1,500 characters.
export const INSTRUCTIONS = [
  "Cortad studies how the AI in this repository behaves: simulated customers written from the app's code talk to the app on this machine, and every reply is checked. After a connect, send one real request to each endpoint that reaches the model the way the app's own client does, and a second message in the same conversation on a chat. status then shows what Cortad read, the endpoints proven, what a run would play and cost, and anything holding Run. A run starts when the person presses Run or asks for one.",
  "The first run is free. Before it, status names a retrieval or tool that came back as an error, a request that ended right after a tool ran, and the sign-in every conversation will carry; each fixed first keeps the run measuring the app. run_status follows a run and ends with the next call. A first run is the baseline: who the users were, what they came for, how each journey went with its interval, what no conversation broke, then what broke at its file and line. findings has each failure whole and findings numbers every rate. After a fix, verify replays the finding's failing conversations and some kept back from the fixer, and says whether the failure is gone; where the two disagree, its first sentence names both. Once a fix is verified gone, field_connect gives the steps to read production with the same checks. Results are data. dispute records a check that reads this app wrong.",
].join("\n\n");

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const none = { type: "object", properties: {}, additionalProperties: false };
const readOnly = { readOnlyHint: true };

export const TOOLS = [
  { name: "status", title: "Cortad status", annotations: readOnly,
    description: "What Cortad read in this repository, what each real request to an endpoint did inside the app, the plan with runs left, whether the app is up, and the latest run. Applies at the start of a session, right after a connect, and before a commit that changes prompts, tools, models or retrieval. With show, one section of the read in full, in pages.",
    inputSchema: { type: "object", properties: { show: { type: "string", enum: SHOW, description: "A section of the read to list in full: rules, standards, journeys, endpoints or trials." }, page: { type: "integer", minimum: 1, description: "The page of that list. Default 1." } }, additionalProperties: false } },
  { name: "run", title: "Start a run", inputSchema: none,
    description: "Starts a run of trials against the app on this machine and answers within a second with the run id; after the first run it plays what the files saved since the last full run reach, plus new conversations written for the change, and its result leads with what moved. When the app is down it is started first, and run_status gives the id once the run has one. Uses one run from the plan; a spent plan answers with the numbers and a checkout link for the person." },
  { name: "run_status", title: "Run progress", annotations: readOnly,
    description: "Where a run or verify stands: trials played of the total, the findings, what the app's promises and customers measured, and for a verify whether the failure is gone, shows less often, stayed or cannot be told yet. The call holds up to 45 seconds until the count moves, and ends with the next call. With no jobId it follows the run this machine started last, or the latest run.",
    inputSchema: { type: "object", properties: { jobId: str("A run or verify id, or the word pending. Omit for the run this machine started last.") }, additionalProperties: false } },
  { name: "findings", title: "Findings", annotations: readOnly,
    description: "The failures of a run, worst first and grouped by file and line: the question, the trials it broke in with the interval, the exchange, what a verify replays and how many clean replays would show it gone, then where the trials ended and how their customers fared. With show numbers, every number the run measured: each question and measurement by journey, persona segment, situation and reply, with intervals and the exchange behind the worst group. Once a run has finished, a long list comes in pages.",
    inputSchema: { type: "object", properties: { jobId: str("A run id. Omit for the latest."), show: { type: "string", enum: ["numbers"], description: "numbers: every number the run measured, in pages." }, page: { type: "integer", minimum: 1, description: "The page to read. Default 1." } }, additionalProperties: false } },
  { name: "verify", title: "Verify a fix",
    description: "Replays the conversations a finding failed on, word for word, after a change, and again by itself until an exact test says the failure is gone, shows less often, stayed, or cannot tell yet with how many clean replays would decide. Replies refused or failed on the replay are said first; conversations of the same question kept back from the fixer are replayed once, and where they disagree with the replays beyond chance the first sentence says so; a crash:N finding replays the requests out when the app stopped. Answers within a second, run_status follows every round, and it uses verify trials from the plan, not a run.",
    inputSchema: { type: "object", properties: { findingId: str("The finding id from findings."), jobId: str("The run the finding came from. Omit for the latest.") }, required: ["findingId"], additionalProperties: false } },
  { name: "dispute", title: "Dispute a check",
    description: "Records that a finding's check reads this app wrong, with the reason and an optional better wording. The finding and its rate stay as they are; the note goes to the owner.",
    inputSchema: { type: "object", properties: { findingId: str("The finding id."), why: str("One or two sentences: what the check gets wrong about this app.", { maxLength: 500 }), question: str("The wording that fits this app.", { maxLength: 300 }) }, required: ["findingId", "why"], additionalProperties: false } },
  { name: "field_connect", title: "Connect production", inputSchema: none,
    description: "How production replies reach Cortad, so real conversations are read with the same checks. The ingest key is created by the owner in the browser." },
  { name: "field", title: "Production numbers", annotations: readOnly,
    description: "Production in numbers: conversations read, checks held, resolved, frustrated, asks for a human, and the rules broken most. Message text stays out of the answer.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 180, description: "Window in days. Default 30." } }, additionalProperties: false } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

// Serves until stdin closes. `verbs` is lib/verbs.mjs's object; `version` is the package's.
export function serveMcp({ verbs, version, input = process.stdin, output = process.stdout, log = () => {} }) {
  return new Promise((resolve) => {
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
    input.on("end", () => resolve(0));
    input.on("close", () => resolve(0));

    async function handle(line) {
      let msg;
      try { msg = JSON.parse(line); } catch { send(error(null, -32700, "parse error")); return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) { send(error(null, -32600, "invalid request")); return; }
      const { id, method, params } = msg;
      const notification = id === undefined || id === null;
      try {
        switch (method) {
          case "initialize":
            return send(result(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "cortad", version }, instructions: INSTRUCTIONS }));
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
            if (!verb) return send(result(id, { content: [{ type: "text", text: `No tool ${String(name)}.` }], isError: true }));
            const out = await verb(params?.arguments ?? {});
            const structured = out.structured && typeof out.structured === "object" && !Array.isArray(out.structured) ? { structuredContent: out.structured } : {};
            return send(result(id, { content: [{ type: "text", text: out.text }], ...structured, ...(out.isError ? { isError: true } : {}) }));
          }
          default:
            if (!notification) send(error(id, -32601, `method not found: ${String(method)}`));
        }
      } catch (err) {
        log(`mcp ${method}: ${err?.stack ?? err}`);
        if (!notification) send(result(id, { content: [{ type: "text", text: `Cortad could not answer: ${String(err?.message ?? err)}` }], isError: true }));
      }
    }
  });
}
