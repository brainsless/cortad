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
  return `A later request's prompt carried an earlier one, tied by ${by}.`;
}

// A prompt with none of the rules is said with the file its call is made from, and whether Cortad
// read any rule there: "carried none" could not tell a gap in Cortad's read from one in the app.
// `inFile`, the rules read from that file, is said when the server sends it.
function rulesLine(r) {
  if (!r || !has(r.of) || r.of === 0) return null;
  if (!r.carried && r.at?.path && r.readThere === false) return `None of the ${plural(r.of, "rule")} Cortad read from your code are in the prompt this endpoint sent, and Cortad read no rule from ${r.at.path}, where the call is made; the prompt at ${at(r.at.path, r.at.line)} shows whether Cortad's read missed rules written there or your app sends this prompt without any.`;
  if (!r.carried && r.at?.path && r.readThere === true) return `The prompt this endpoint sent from ${at(r.at.path, r.at.line)} holds none of the ${has(r.inFile) ? `${plural(r.inFile, "rule")} ` : "rules "}Cortad read from that file.`;
  // A server from before `at` and `readThere` keeps its own words.
  const reader = "at" in r || "readThere" in r ? "Cortad read" : "read";
  const head = `The prompts carried ${r.carried ? num(r.carried) : "none"} of the ${plural(r.of, "rule")} ${reader} from your code`;
  const example = (r.examples ?? [])[0];
  return `${head}${example ? `, for example ${at(example.path, example.line)} "${clip(example.text, 160)}"` : ""}.`;
}

// Whose it is, as a sentence of its own: "Run waits, on the app's side:" read as a fault of the app's.
const WHOSE = { ours: "That is on Cortad's side, not your app's.", theirs: "That is in your app." };
// A door runs do not use yet, or one only Cortad's requests reached, and why.
function standingLine(v) {
  if (v.standing === "excluded") return `Runs leave this endpoint out: ${v.why}${WHOSE[v.side] ? ` ${WHOSE[v.side]}` : ""}`;
  if (v.standing === "fallback") return `Answered only Cortad's own requests: ${v.why}`;
  return null;
}

// Who the conversations through a signed-in endpoint act as: the customers the agent's requests signed in as.
const accountsLine = (n) => (!has(n) ? null : n > 1 ? `Conversations are split across ${num(n)} accounts, one for each customer your requests signed in as.` : "All conversations act as one account.");

// Where a trial takes each value the app's own client sets for its model.
const appFieldLine = (f) => (f.from === "app" ? `"${f.field}" is set by your app${f.path ? ` at ${f.path}` : ""}.` : `"${f.field}" is only in your agent's request.`);

// The message Cortad took from the last request, so a wrong field shows; the reply is the agent's
// own, already read, and ten of them were the longest part of ulaim's status. One with no message
// found keeps a short reply to know it by.
function sampleLine(s) {
  if (!s?.reply) return null;
  const cut = s.cut ? "; the reply stopped before it finished" : "";
  return s.ask ? `Last message: "${clip(s.ask, 160)}"${cut}.` : `Last reply: "${clip(s.reply, 80)}"${cut}.`;
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
    ...(v.checks ?? []).map((said) => `Cortad's test conversation here: ${said}`),
    rulesLine(v.rules),
    v.tools?.length ? `Tools that ran: ${v.tools.join(", ")}.` : null,
    v.passages ? `Passages handed to the model: ${num(v.passages)}.` : null,
    ...(v.problems ?? []).map((p) => `Problem${where(p) ? ` at ${where(p)}` : ": "}${p.said}`),
    sampleLine(v.sample),
  ];
  return [...lines, ...inner.filter(Boolean).map((l) => `    ${l}`)];
}

// What a run would play, take and cost, said to the person: the conversations it starts with (of
// those planned, the ones that fit in one run's time), the follow-ups apart, the time at the widest it
// goes and what it costs on their own keys, or that no price could be read. "Written" was said of
// conversations the run writes as it starts: "44 of the 79 trials written" beside "Trials: 39 written".
function readyLine(r) {
  if (!r || !r.trials) return null;
  const soFar = r.reading ? " so far" : "";
  const plays = has(r.planned) && r.planned > r.trials ? `${num(r.trials)} of the ${plural(r.planned, "conversation")} planned${soFar}, as many as fit in one run's time` : `${plural(r.trials, "conversation")}${soFar}`;
  // Follow-ups are played only where something breaks: said apart, never in the count above.
  const followUps = r.followUps ? `, and up to ${num(r.followUps)} more where something breaks` : "";
  // The run widens only while replies keep pace, and a one-at-a-time app holds it to one: the time is
  // a range when that is slower, and where fewer conversations fit at that pace, how many is said.
  const upTo = has(r.atOne?.minutes) && r.atOne.minutes > r.minutes ? r.atOne.minutes : null;
  const atOne = has(r.atOne?.trials) && r.atOne.trials < r.trials ? ` If your app answers one request at a time, about ${num(r.atOne.trials)} of them fit in that time.` : "";
  const minutes = has(r.minutes) && `in about ${upTo ? `${num(r.minutes)} to ${plural(upTo, "minute")}` : plural(r.minutes, "minute")}`;
  const size = [has(r.replies) && `about ${plural(r.replies, "reply", "replies")}`, minutes].filter(Boolean).join(" ");
  const usd = (x) => `$${x.toFixed(2)}`;
  // Some endpoints had no published rate or token counts: the price covers the others and says so.
  // A first run is priced at what it is expected to cost (`expected`, from factors measured on recorded
  // first runs) and the most it costs (`upTo`); a server from before `expected` sends the most alone.
  // After a run of the app's own, as what that run measured. An older server sends a range (`usdHigh`).
  // Where some endpoints had no price, on how many.
  const amount = () => `${r.upTo ? "up to" : "about"} ${usd(r.usd)}${has(r.usdHigh) ? ` to ${usd(r.usdHigh)}` : ""}`;
  const some = r.pricedOn ? `, on the ${num(r.pricedOn.endpoints)} of ${plural(r.pricedOn.of, "endpoint")} Cortad could price` : "";
  const onKey = `on your ${r.provider ? `${r.provider} ` : ""}key${r.model ? ` for ${r.model}` : ""}`;
  const both = r.upTo && has(r.expected);
  // No price is said, as the card says it (guide.ts quoteLine), never left out.
  const cost = has(r.usd)
    ? ` ${both ? `It is expected to cost ${usd(r.expected)}${soFar} ${onKey}, and the most it costs is ${usd(r.usd)}` : `It costs ${amount()}${soFar} ${onKey}`}${some}${r.estimated ? ", estimated from the length of the text since your provider sent no token counts" : ""}.`
    : " It runs on your app's own model keys; Cortad could not price it from what your app's model calls reported.";
  // No rules is a fact of a finished read: said while the code is still being read, it was false a minute later.
  const rules = !has(r.rules) || (r.reading && r.rules === 0) ? "" : r.rules === 0 ? " No rules of your own were read from the code, so replies are checked against general standards only." : ` Every reply is checked against the ${plural(r.rules, "rule")} read from your code.`;
  return `For the person: a run plays ${plays}${followUps}${size ? `: ${size}` : ""}.${atOne}${cost}${rules}${r.reading ? " Your code is still being read; the run waits for it and plays every conversation it adds." : ""}`;
}

// The endpoints no request has reached, as status lists them and reach sends them. `receipts`: doors
// the App section says answered at once with their answer out of Cortad's sight, so not said here.
export const unreached = (c, receipts = []) => {
  const answered = new Set(receipts.map((x) => x.door));
  return (c?.notCalled ?? []).filter((m) => !answered.has(`${m.method} ${m.path}`));
};

// One the server has no request for, or one listed on a field's name alone, is the agent's to send.
// `signIn` and `failed`: what Cortad's own test request met there, said as the server words it.
function unreachedLine(m) {
  const said = [m.excluded, m.signIn && `${m.signIn}.`, m.failed, !m.excluded && (m.unsure || m.byHand) ? "By hand." : "", m.byHand, m.why].filter(Boolean).join(" ");
  return `  ${m.method} ${m.path}${m.file ? `  ${at(m.file, m.line)}` : ""}${said ? `  ${said}` : ""}`;
}

// Cortad sends the rest itself, said only where the server has a request ready for one of them.
function reachLine(missing) {
  if (!missing.some((m) => m.request && !m.unsure)) return null;
  const except = [missing.some((m) => m.unsure || m.byHand) && "marked by hand", missing.some((m) => m.excluded) && "left out of runs"].filter(Boolean);
  return `Cortad sends each of them a test request${except.length ? `, except any ${except.join(" or ")}` : ""}.`;
}

// `data`: what the command did with the app's stores and services, said right under the run it is
// about, so what a run writes into for real is read before Run is pressed.
export function contactLines(c, data = [], receipts = []) {
  const said = data.map((s) => `Data: ${s}`);
  if (!c) return said;
  const proven = c.proven ?? [];
  // No request yet is said by the App line and by the next step, not a third time here. Endpoints
  // that all answered only Cortad's own test request say so once, over the list: sixteen of them
  // each said it under their own line, and the agent asked for a status it could read.
  const alike = proven.length > 1 && proven.every((v) => v.standing === "fallback") && new Set(proven.map((v) => v.why)).size === 1;
  const head = alike ? `Endpoints that answered (${num(proven.length)}), each only Cortad's own test request so far: ${proven[0].why}` : `Endpoints that answered (${num(proven.length)}):`;
  const lines = proven.length ? [head, ...proven.flatMap((v) => doorLines(alike ? { ...v, standing: null } : v))] : [];
  const missing = unreached(c, receipts);
  if (missing.length) lines.push(`Endpoints found in your code that have not answered yet (${num(missing.length)}):`, ...missing.map(unreachedLine), ...[reachLine(missing)].filter(Boolean));
  const ready = readyLine(c.ready);
  if (ready) lines.push(ready);
  // What holds Run is the server's next line (src/local/contact.ts heldLine), said once: printed here
  // as well, ulaim's hold on its Qdrant was read twice in one status.
  return [...lines, ...said];
}
