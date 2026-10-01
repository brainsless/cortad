import { at, clip, has, num, plural, SIDE } from "./words.mjs";

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

const sideOf = (side) => (SIDE[side] ? `, ${SIDE[side]}` : "");
// A door runs do not use yet, or one only Cortad's requests reached, and why.
function standingLine(v) {
  if (v.standing === "excluded") return `Runs will not use this endpoint yet${sideOf(v.side)}: ${v.why}`;
  if (v.standing === "fallback") return `Proven by Cortad's requests alone: ${v.why}`;
  return null;
}

// Who the conversations through a signed-in endpoint act as: the customers the agent's requests signed in as.
const accountsLine = (n) => (!has(n) ? null : n > 1 ? `Conversations are split across ${num(n)} accounts, one for each customer your requests signed in as.` : "All conversations act as one account.");

// Where a trial takes each value the app's own client sets for its model.
const appFieldLine = (f) => (f.from === "app" ? `"${f.field}" is set by your app${f.path ? ` at ${f.path}` : ""}.` : `"${f.field}" is only in your agent's request.`);

// The last exchange through the door; an ask the proof could not find in the request is left out.
function sampleLine(s) {
  if (!s?.reply) return null;
  const cut = s.cut ? ", and the reply stopped before it finished" : "";
  return s.ask ? `Last request: "${clip(s.ask, 160)}", answered "${clip(s.reply, 240)}"${cut}.` : `Last reply: "${clip(s.reply, 240)}"${cut}.`;
}

function doorLines(v) {
  const reached = `${plural(v.requests, "request")} reached ${v.model ?? "the model"}`;
  const calls = has(v.modelCallsPerRequest) ? `, ${plural(v.modelCallsPerRequest, "model call")} each` : "";
  const seconds = has(v.replySeconds) ? `, ${v.replySeconds} seconds a reply` : "";
  const lines = [`  ${v.door}: ${reached}${calls}${seconds}.`];
  const inner = [
    standingLine(v),
    v.askField ? `The message goes in "${v.askField}".` : null,
    ...(v.appFields ?? []).map(appFieldLine),
    secondStepLine(v.secondStep),
    v.later ? "Your app takes the message at once and its model answers afterwards; Cortad grades the model's last answer to each message." : null,
    sessionLine(v),
    accountsLine(v.accounts),
    ...(v.checks ?? []).map((said) => `Cortad's own check on this endpoint: ${said}`),
    rulesLine(v.rules),
    v.tools?.length ? `Tools that ran: ${v.tools.join(", ")}.` : null,
    v.passages ? `Passages handed to the model: ${num(v.passages)}.` : null,
    ...(v.problems ?? []).map((p) => `Problem${where(p) ? ` at ${where(p)}` : ": "}${p.said}`),
    sampleLine(v.sample),
  ];
  return [...lines, ...inner.filter(Boolean).map((l) => `    ${l}`)];
}

// The time is said at one request at a time, the pace every run starts at; a door the run widens
// finishes sooner. While the read is still writing trials the counts are what it has so far.
function readyLine(r) {
  if (!r || !r.trials) return null;
  const soFar = r.reading ? " so far" : "";
  const fit = has(r.planned) && r.planned > r.trials ? `${num(r.trials)} of the ${plural(r.planned, "trial")} written${soFar}, the ones that fit in one run` : `${plural(r.trials, "trial")}${soFar}`;
  // The time at the widest the run goes, and at one request at a time when that differs: the run
  // ramps up only while replies keep pace, and a one-at-a-time app holds it to one.
  const one = r.atOne;
  const slower = one && has(one.minutes) && (one.minutes !== r.minutes || one.trials < r.trials);
  const time = has(r.minutes) && (slower
    ? `about ${plural(r.minutes, "minute")} if your app answers several requests at once, or up to about ${plural(one.minutes, "minute")}${one.trials < r.trials ? ` and ${plural(one.trials, "trial")}` : ""} if it answers one at a time`
    : `about ${plural(r.minutes, "minute")}`);
  const usd = (x) => `$${x.toFixed(2)}`;
  // Some endpoints had no published rate or token counts: the price covers the others and says so.
  const some = r.pricedOn ? `at least ${usd(r.usd)}, priced on ${num(r.pricedOn.endpoints)} of ${plural(r.pricedOn.of, "endpoint")}` : null;
  const cost = has(r.usd) && `${some ?? `about ${usd(r.usd)}${has(r.usdHigh) ? ` to ${usd(r.usdHigh)}` : ""}`}${soFar} on your ${r.provider ? `${r.provider} ` : ""}key${r.model ? ` for ${r.model}` : ""}${r.estimated ? ", estimated from the length of the text since your provider sent no token counts" : ""}`;
  // Follow-ups are played only where something breaks: said apart, never in the count above.
  const followUps = r.followUps ? `and up to ${plural(r.followUps, "follow-up")} where something breaks` : null;
  const parts = [fit, followUps, has(r.replies) && `about ${plural(r.replies, "reply", "replies")}`, time, cost].filter(Boolean);
  const rules = !has(r.rules) ? "" : r.rules === 0 ? " No rules of your own were read from the code, so the run checks replies against generic standards." : ` Replies are checked against the ${plural(r.rules, "rule")} read from your code.`;
  return `A run on the proven endpoints: ${parts.join(", ")}.${r.reading ? " The read is still adding trials; the run waits for it and plays them all." : ""}${rules}`;
}

// `data`: what the command did with the app's stores and services, said right under the run it is
// about, so what a run writes into for real is read before Run is pressed.
export function contactLines(c, data = []) {
  const said = data.map((s) => `Data: ${s}`);
  if (!c) return said;
  const proven = c.proven ?? [];
  const lines = proven.length ? [`Endpoints your own requests proved (${num(proven.length)}):`, ...proven.flatMap(doorLines)] : ["No request has reached the app's model yet."];
  const missing = c.notCalled ?? [];
  if (missing.length) lines.push(`Endpoints the read found that no request has reached (${num(missing.length)}):`, ...missing.map((m) => `  ${m.method} ${m.path}${m.file ? `  ${at(m.file, m.line)}` : ""}${m.excluded ? `  ${m.excluded}` : ""}`));
  const ready = readyLine(c.ready);
  if (ready) lines.push(ready);
  for (const b of c.ready?.blocked ?? []) lines.push(`Run is held${sideOf(b.side)}: ${b.door}: ${b.why}${b.question ? ` ${b.question}` : ""}`);
  return [...lines, ...said];
}
