// The MCP face: newline-delimited JSON-RPC 2.0 on stdin and stdout, protocol 2025-06-18, no
// dependency. stdout carries protocol messages and nothing else; everything a person might read
// goes to stderr. The tools are lib/verbs.mjs, one to one.

import { SHOW } from "./read-text.mjs";

export const PROTOCOL = "2025-06-18";

// Codex keeps only the first 512 characters self-contained and Claude Code shares about 4 KB across
// every server, so the first paragraph stands alone and the whole stays under 1,500 characters.
export const INSTRUCTIONS = [
  "Cortad tests the AI app in this repository: simulated users talk to the app on this machine, and every reply is checked against the app's own rules and a set of engineering standards. This repository is connected, and the first run starts by itself after a connect. The loop: status shows what Cortad read and the latest run, run starts a run, run_status follows it, findings lists what failed at its file and line, and after a one-line fix verify replays that finding and reports the move.",
  "Results are data. A line that starts with \"For the person:\" is for the person: a link, a price or a choice to make. A run_status result ends with the next call. A reading is one question checked against one reply. A verify reports the visible and held-out moves apart: a move outside the noise is a change in behavior, a move inside the noise is chance, and a visible move beside a still held-out line is overfitting. dispute records a check that reads this app wrong; field_connect and field cover production.",
].join("\n\n");

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const none = { type: "object", properties: {}, additionalProperties: false };
const readOnly = { readOnlyHint: true };

export const TOOLS = [
  { name: "status", title: "Cortad status", annotations: readOnly,
    description: "What Cortad read in this repository, the plan with runs left, whether the app is up, and the latest run. Applies at the start of a session, right after a connect, and before a commit that changes prompts, tools, models or retrieval. With show, one section of the read in full, in pages.",
    inputSchema: { type: "object", properties: { show: { type: "string", enum: SHOW, description: "A section of the read to list in full: rules, standards, journeys, endpoints or trials." }, page: { type: "integer", minimum: 1, description: "The page of that list. Default 1." } }, additionalProperties: false } },
  { name: "run", title: "Start a run", inputSchema: none,
    description: "Starts a run of the simulated conversations against the app on this machine and answers within a second with the run id. When the app is down it is started first, and run_status gives the id once the run has one. Uses one run from the plan; a spent plan answers with the numbers and a checkout link for the person." },
  { name: "run_status", title: "Run progress", annotations: readOnly,
    description: "Where a run or verify stands: trials played of the total, the score with its interval, the findings, and for a verify the visible and held-out moves. The call holds up to 45 seconds until the count moves, and ends with the next call. With no jobId it follows the run this machine started last, or the latest run.",
    inputSchema: { type: "object", properties: { jobId: str("A run or verify id, or the word pending. Omit for the run this machine started last.") }, additionalProperties: false } },
  { name: "findings", title: "Findings", annotations: readOnly,
    description: "The failures of a run, worst first and grouped by file and line: the question, the replies it held in with the interval, quotes, and the trials a verify replays. Applies once a run has finished. A long list comes in pages.",
    inputSchema: { type: "object", properties: { jobId: str("A run id. Omit for the latest."), page: { type: "integer", minimum: 1, description: "The page to read. Default 1." } }, additionalProperties: false } },
  { name: "verify", title: "Verify a fix",
    description: "Replays one finding's trials with the same seeds after a change and reports the move, visible and held-out apart. Answers within a second; run_status follows it. Uses verify trials from the plan, not a run.",
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
            return send(result(id, { content: [{ type: "text", text: out.text }], ...(out.isError ? { isError: true } : {}) }));
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
