import { at, clip, has, num, plural } from "./words.mjs";

// What `status` says between connect and a run: each endpoint a real request proved, with what the
// hook saw inside those requests; each endpoint the read found that no request has reached; what a
// run on the proven ones would be, and what it would write into. Every figure is one the agent can
// check against its own request or a line of the code. A field the API leaves out prints nothing.

const CARRIER = {
  body: (k) => `the body field "${k}"`,
  cookie: (k) => `the cookie "${k}"`,
  header: (k) => `the header "${k}"`,
  path: (k) => `the path segment {${k}}`,
  history: (k) => `the earlier messages the client sends in "${k}"`,
};
const where = (x) => (x?.file || x?.path ? `${at(x.file ?? x.path, x.line)}: ` : "");
const TIED = { sent: "the first request sent", got: "the first request got back" };

// A door whose answer came on a second request: that request, what tied the two, and what the client
// sent first in each turn, each as the agent's own requests showed it.
function secondStepLine(s) {
  if (!s?.request) return null;
  const tie = s.tie?.key && TIED[s.tie.from] ? `, tied by the "${s.tie.key}" ${TIED[s.tie.from]}` : "";
  const before = s.before?.length ? `; each turn first sent ${s.before.join(", ")}` : "";
  return `The answer came on a second request, ${s.request}${tie}${before}.`;
}

function sessionLine(v) {
  const s = v.session;
  if (!s || !(v.requests > 1)) return null;
  if (!s.held) return "No later request's prompt carried an earlier one.";
  const by = CARRIER[s.carrier] && s.key ? CARRIER[s.carrier](s.key) : "nothing the request sent, so every caller shares what the app keeps";
  return `A later request's prompt carried an earlier one, held by ${by}.`;
}

function rulesLine(r) {
  if (!r || !has(r.of) || r.of === 0) return null;
  const head = r.carried ? `The prompts carried ${num(r.carried)} of the ${plural(r.of, "rule")} read from your code` : `The prompts carried none of the ${plural(r.of, "rule")} read from your code`;
  const example = (r.examples ?? [])[0];
  return `${head}${example ? `, for example ${at(example.path, example.line)} "${clip(example.text, 160)}"` : ""}.`;
}

function doorLines(v) {
  const reached = `${plural(v.requests, "request")} reached ${v.model ?? "the model"}`;
  const calls = has(v.modelCallsPerRequest) ? `, ${plural(v.modelCallsPerRequest, "model call")} each` : "";
  const seconds = has(v.replySeconds) ? `, ${v.replySeconds} seconds a reply` : "";
  const lines = [`  ${v.door}: ${reached}${calls}${seconds}.`];
  const inner = [
    v.askField ? `The message goes in "${v.askField}".` : null,
    secondStepLine(v.secondStep),
    sessionLine(v),
    rulesLine(v.rules),
    v.tools?.length ? `Tools that ran: ${v.tools.join(", ")}.` : null,
    v.passages ? `Passages handed to the model: ${num(v.passages)}.` : null,
    ...(v.problems ?? []).map((p) => `Problem${where(p) ? ` at ${where(p)}` : ": "}${p.said}`),
    v.sample?.ask || v.sample?.reply ? `Last request: "${clip(v.sample.ask ?? "", 160)}", answered "${clip(v.sample.reply ?? "", 240)}"${v.sample.cut ? ", and the reply stopped before it finished" : ""}.` : null,
  ];
  return [...lines, ...inner.filter(Boolean).map((l) => `    ${l}`)];
}

function readyLine(r) {
  if (!r || !r.trials) return null;
  const parts = [plural(r.trials, "trial"), has(r.replies) && plural(r.replies, "reply", "replies"), has(r.minutes) && `about ${plural(r.minutes, "minute")}`,
    has(r.usd) && `about $${r.usd.toFixed(2)} on your ${r.provider ? `${r.provider} ` : ""}key${r.model ? ` for ${r.model}` : ""}`].filter(Boolean);
  return `A run on the proven endpoints: ${parts.join(", ")}.`;
}

// `data`: what the command did with the app's stores and services, said right under the run it is
// about, so what a run writes into for real is read before Run is pressed.
export function contactLines(c, data = []) {
  const said = data.map((s) => `Data: ${s}`);
  if (!c) return said;
  const proven = c.proven ?? [];
  const lines = proven.length ? [`Endpoints your own requests proved (${num(proven.length)}):`, ...proven.flatMap(doorLines)] : ["No request has reached the app's model yet."];
  const missing = c.notCalled ?? [];
  if (missing.length) lines.push(`Endpoints the read found that no request has reached (${num(missing.length)}):`, ...missing.map((m) => `  ${m.method} ${m.path}${m.file ? `  ${at(m.file, m.line)}` : ""}`));
  const ready = readyLine(c.ready);
  if (ready) lines.push(ready);
  return [...lines, ...said];
}
