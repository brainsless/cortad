// The MCP face: newline-delimited JSON-RPC 2.0 on stdin and stdout, protocol 2025-06-18, no
// dependency. stdout carries protocol messages and nothing else; everything a person might read
// goes to stderr. The tools are lib/verbs.mjs, one to one.

export const PROTOCOL = "2025-06-18";

export const INSTRUCTIONS = [
  "Cortad is an independent behavior test lab for the AI app in this repository. It runs simulated users through the app on this machine and grades every reply with about 100 checks. It is already connected; never run `npx cortad <code>` again. The first run starts by itself after a connect; the skill says what to tell the person then.",
  "The loop: status, then run only when the person asks (the first run is free; after that run returns a checkout link, show it in one sentence and wait), poll run_status every 30 seconds and stay quiet unless the count moved, findings, fix one finding at a time in the repo, verify <id>, read the move.",
  "Rules: a move inside the interval is not a fix. Never change or remove a case to move a number; never make the app recognise test traffic; if a check reads wrong, call dispute with why. Cases, checks, seeds and the holdout are not yours to edit, and Cortad refuses it anyway.",
].join("\n\n");

const str = (description, extra = {}) => ({ type: "string", description, ...extra });

export const TOOLS = [
  { name: "status", description: "Where this repository stands with Cortad: plan and runs left, whether the app is up, conversations written, the latest run, whether production is connected. Call first.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "run", description: "Run the whole suite of simulated conversations against the app on this machine. Only when the person asks. The first run is free; afterwards it returns a checkout link to show the person. Starts the app if it is not up.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "run_status", description: "Where a run or verify stands: played n of N, the score when finished, the paired move for a verify. Poll every 30 seconds.", inputSchema: { type: "object", properties: { jobId: str("The id run or verify returned.") }, required: ["jobId"], additionalProperties: false } },
  { name: "findings", description: "The failures of the latest run: each with its rate and interval, a quote, the file and line, what good looks like. Start from the worst.", inputSchema: { type: "object", properties: { jobId: str("A run id. Omit for the latest.") }, additionalProperties: false } },
  { name: "verify", description: "After a fix: replay one finding's trials with the same seeds and read the move, visible and held-out apart. Spends verify trials, not a run.", inputSchema: { type: "object", properties: { findingId: str("The finding id from findings."), jobId: str("The run the finding came from. Omit for the latest.") }, required: ["findingId"], additionalProperties: false } },
  { name: "dispute", description: "Say that a finding's check reads wrong. Changes nothing; the note goes to the owner.", inputSchema: { type: "object", properties: { findingId: str("The finding id."), why: str("One or two sentences: what the check gets wrong about this app.", { maxLength: 500 }), question: str("The wording you would ask instead.", { maxLength: 300 }) }, required: ["findingId", "why"], additionalProperties: false } },
  { name: "field_connect", description: "How to connect production so real conversations are read with the same checks. Returns the steps; the key is created by the owner in the browser, never here.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "field", description: "Production in numbers only: conversations read, rulings held, resolved, frustrated, asks for a human, the rules broken most. Never message text.", inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 180, description: "Window in days. Default 30." } }, additionalProperties: false } },
];

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
            const verb = Object.hasOwn(verbs, name) ? verbs[name] : null;
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
