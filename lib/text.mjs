import { contactLines } from "./contact-text.mjs";
import { costSaid, dissectionLines, verifyOnceAPage } from "./dissection-text.mjs";
import { failedLines, heldLines } from "./failed-text.mjs";
import { readLines } from "./read-text.mjs";
import { at, clip, has, num, PAGE_CHARS, pageOf, plural, SIDE, upper } from "./words.mjs";

// What each verb prints. A result is data for the coding agent: a line meant for the person starts
// with "For the person:", and a run_status result ends with the next call. A field the API leaves
// out prints nothing, so the text follows the API as it grows.

const DONE = new Set(["succeeded", "failed", "canceled"]);
const UNIT = { sweeps: ["run", "runs"], runs: ["run", "runs"], trials: ["verify trial", "verify trials"] };
export const STARTING = "Starting your app for the run. Call run_status; it answers as soon as the run has an id.";
// The runner's own record (lib/runner.mjs): an app it could not start, and one that answers while
// the server cannot play it yet.
export const notStartedText = (r) => [upper(r.error), r.said ? `Its last lines:\n${r.said}` : null, "Nothing ran."].filter(Boolean).join("\n");
// The server's reason it cannot play an app the runner has up: what it has found of the app's AI
// endpoints, or the request it asks for. It names the port it saw, so it stands in for the runner's
// line rather than beside a copy of it. The server's other words on an app it cannot play yet ("Your
// app is starting.") are its guess at what the runner already knows, and are not said.
const doorsSaid = (r, app) => (app && app.state !== "ready-to-test" && app.port === r.port && app.said) || null;
export const answeringText = (r, app) => doorsSaid(r, app) ?? `Your app answers on port ${r.port}.`;
export const upWaitingText = (r, app) => `${answeringText(r, app)}\nCall run_status; it answers as soon as the run has an id.`;

const units = (n, unit) => { const [one, many] = UNIT[unit] ?? [unit, unit]; return `${num(n)} ${n === 1 ? one : many}`; };
const kn = (x) => (has(x?.k) ? `${num(x.k)} of ${num(x.n)}` : num(x));

export const finished = (run) => Boolean(run) && (run.finished ?? DONE.has(run.status));

export function statusText(d) {
  const lines = [];
  if (d.repository?.name) lines.push(`Cortad · ${d.repository.name}`);
  const plan = planLine(d.plan);
  if (plan) lines.push(plan);
  lines.push(...appLines(d));
  lines.push(...contactLines(d.contact, d.app?.data));
  if (d.read?.complete === false) lines.push("The read of your repository is still running; the lists below fill in as it finishes.");
  if (d.read) lines.push(...readLines(d.read));
  if (d.run === null) lines.push("No run yet.");
  else if (d.run) lines.push(...runLines(d.run, "latest "));
  // Trials the read wrote after this run chose its own: the one count that is not the run's.
  const since = (d.read?.trials?.written ?? 0) - (d.run?.trials?.written ?? Infinity);
  if (since > 0 && d.run?.kind !== "verify") lines.push(`${plural(since, "more trial")} written since this run; the next run chooses from them too.`);
  if (d.field) lines.push(`Production: ${d.field.connected ? "connected" : "not connected"}.`);
  if (d.next) lines.push(d.next);
  if (d.links?.lab && (d.read || d.run)) lines.push(`For the person: ${d.links.lab} shows this in the browser.`);
  if (d.run && !finished(d.run)) lines.push(`next: run_status ${d.run.jobId}`);
  return lines.join("\n");
}

// An app seen through the local proxy (lib/proxy.mjs): where to send, and what is not known.
const proxiedLine = (r) => `Model calls are seen through a local proxy, so the line of code that made each call is not known. Send requests to port ${r.port}; requests sent straight to your app on port ${r.proxied} are not seen.${r.unseen ? " A request reached your app and no model call came through the proxy: if your app sets its model's address in its code, have it read OPENAI_BASE_URL (or ANTHROPIC_BASE_URL or GOOGLE_GEMINI_BASE_URL), then save." : ""}`;

// The app as the runner holding it up on this machine says it is. The server's word stands only
// where no runner is here, and beside it when the server is asking for a request at the app's door.
function appLines(d) {
  const r = d.runner;
  if (!r) return d.app?.said ? [`App: ${d.app.said}`] : [];
  if (r.state === "up") return [`App: ${doorsSaid(r, d.app) ?? `answering on port ${r.port}.`}`, ...(r.proxied ? [proxiedLine(r)] : [])];
  return [r.state === "failed" ? `App: ${r.error}` : "App: starting."];
}

// What this month has used of the plan, and what the plan above it costs and buys, in the numbers
// checkout sells.
export function planLine(p) {
  if (!p?.name) return null;
  const parts = [];
  if (has(p.runsLeft) && has(p.runsAllowed)) parts.push(runsSaid(p.runsLeft, p.runsAllowed));
  if (has(p.verifyTrialsLeft)) parts.push(`${plural(p.verifyTrialsLeft, "verify trial")} left`);
  const head = parts.length ? `${p.name}: ${parts.join("; ")}.` : `Plan: ${p.name}.`;
  const n = p.next;
  return n ? `${head} ${n.name} $${num(n.monthlyUsd)} a month: runs and reruns included, ${num(n.productionReplies)} production replies read.` : head;
}

const runsSaid = (left, allowed) => (left > 0 ? `${num(left)} of ${plural(allowed, "run")} left this month`
  : allowed === 1 ? "this month's 1 run is used" : `all ${plural(allowed, "run")} of this month are used`);

// After the findings: what was measured of the app's own promises, in its own words, then the checks
// measured and why the rest were not, then how many trials kept every promise. Counts, never a score.
// The replies that did not count sit before the count: a clean count beside 62 error replies read as a clean bill.
function measuredLines(d) {
  const lines = [...promiseLines(d.promises), ...failedLines(d.failedReplies)];
  const of = has(d.questionsAsked) && has(d.questionsOf) && d.questionsOf > 0;
  if (of) lines.push(`${num(d.questionsAsked)} of ${plural(d.questionsOf, "check")} measured.`);
  // The dissection says what was not measured in its own line.
  const groups = d.dissection ? [] : (d.notMeasured?.groups ?? []).filter((g) => g.count > 0 && g.said);
  if (groups.length) lines.push(`${num(d.notMeasured.total)} not measured: ${groups.map((g) => clip(g.said, 240)).join("; ")}.`);
  // An answer from before failedReplies says its failures here, never folded into a number.
  if (!d.failedReplies && d.replies?.crashed > 0) lines.push(`${num(d.replies.crashed)} of ${plural(d.replies.total, "reply", "replies")} were failures and are not counted.`);
  // The server's own sentence already says the count.
  if (d.promises && !d.promises.said && has(d.promises.decided)) lines.push(promiseLine(d));
  return lines;
}

function promiseLines(p) {
  if (!p?.said) return [];
  return [p.said, ...(p.measured ?? []).map((m) => `  "${clip(m.words, 200)}"${m.at ? ` (${m.at})` : ""}: broke in ${num(m.failed)} of ${plural(m.of, "trial")}.`)];
}

const promiseLine = (d) => `${upper(`${num(d.promises.held)} of the ${plural(d.promises.decided, "trial")}`)} that asked your app's own promises kept every one.`;

const haltLine = (h) => `${h.side === "ours" ? `Stopped ${SIDE.ours}` : "Your app stopped answering"} after ${plural(h.after, "turn")}${h.why ? `: ${clip(h.why, 240)}` : ""}. The numbers cover the turns before that.`;
// The pace a slow app was played at, and the replies our own wait cut off: both said as ours. A
// verify says the second among the replays it could not read.
const waitLines = (d) => [d.pace?.said, d.kind === "verify" ? null : d.waited?.said].filter(Boolean);
const LAYER_WORDS = {
  retrieval: "what the store returned behind the reply, not how the reply was written",
  tools: "the tool call behind the reply",
  memory: "what the app kept between turns",
  application: "an error in the app around the model",
  instructions: "the model against its own instructions",
  upsell: "what the reply offered beyond the ask",
};

function runLines(d, prefix = "") {
  const done = finished(d);
  const played = d.of ? `${num(d.played ?? 0)} of ${plural(d.of, "trial")} played` : "no trial played yet";
  // A run is finished once its numbers land, while its job may still be writing the Lab's report.
  const state = d.status === "failed" || d.status === "canceled" ? d.status : done ? "finished" : d.status && d.status !== "succeeded" ? d.status : "running";
  const lines = [`${upper(`${prefix}${d.kind === "verify" ? "verify" : "run"}`)} ${d.jobId}: ${state}, ${played}.`];
  if (d.tested) lines.push(testedLine(d.tested));
  // Each endpoint's first conversation, played alone before the others: whether it held and why not.
  lines.push(...(d.first ?? []));
  // Between two counts, what the run is doing now: four minutes of "0 of 15" read as nothing happening.
  if (!done && d.now?.doing) lines.push(d.now.doing);
  lines.push(...waitLines(d));
  // A field the app sets for its model that went out as the agent's own request had it.
  lines.push(...(d.recordedValues ?? []));
  // A finished run leads with its dissection: what only running the app showed, then what a code
  // review would also find, then what was measured of the app's promises. Status and an answer from
  // before the dissection say the run's counts. A verify is a move and says only the move.
  if (done && d.kind !== "verify" && d.dissection) {
    lines.push(...dissectionLines(d.dissection));
    if (has(d.findings)) lines.push(findingsCount(d.findings, d.settled, false));
    lines.push(...measuredLines(d));
  } else if (done && d.kind !== "verify") {
    if (d.top) lines.push("Top finding:", findingBlock(d.top));
    if (has(d.findings)) lines.push(findingsCount(d.findings, d.settled, Boolean(d.top)));
    if (d.model) lines.push(`Your app answered on ${d.model}, as its own model calls show.`);
    const cost = costSaid(d);
    if (cost) lines.push(cost);
    lines.push(...measuredLines(d));
  }
  if (done && d.blocked) lines.push(d.blocked);
  if (done && d.notCounted) lines.push(d.notCounted);
  if (done && d.halted) lines.push(haltLine(d.halted));
  const trials = trialsLine(d);
  if (trials) lines.push(trials);
  // Every row, or six and the rest in one line, so the rows always sum to the held-back count. A
  // finished run says them with the replies that did not count, above the counts.
  if (!(done && (d.failedReplies || d.dissection))) lines.push(...heldLines(d.heldBack));
  if (d.stopped) lines.push(stoppedLine(d));
  for (const f of d.faults ?? []) lines.push(`Fault${SIDE[f.side] ? ` ${SIDE[f.side]}` : ""}: ${f.what}${f.fix ? ` ${f.fix}` : ""}`);
  for (const s of d.data ?? []) lines.push(`Data: ${s}`);
  // A run the stop line already explains is not said twice as an error.
  if (d.error && !(d.stopped && d.error.startsWith(d.stopped.why))) lines.push(`Error: ${d.error}`);
  if (d.verify) lines.push(...verifyLines(d.verify));
  return lines;
}

// Settled: failed in enough trials to say it fails at least one visit in five; findings lists those first.
const findingsCount = (n, settled, shown) => `${shown ? `${plural(n, "finding")} in all` : plural(n, "finding")}${has(settled) && n > 0 ? `, ${num(settled)} settled (enough trials to say each fails at least one visit in five; findings lists them first)` : ""}.`;

// The run's trials in one sentence that adds up: written = chosen + held back + not planned, and
// chosen = played + not played. Three counts from three places never met before.
function trialsLine(d) {
  const t = d.trials;
  // A verify replays the trials it names, so it has no written count of its own to add up.
  if (!t || !has(t.written) || d.kind === "verify") return null;
  const parts = [`${num(t.chosen)} chosen for this run`, t.heldBack && `${num(t.heldBack)} held back`, t.notPlanned && `${num(t.notPlanned)} not planned`].filter(Boolean);
  const rest = t.notPlayed ? `; ${num(t.played)} played, ${num(t.notPlayed)} ${finished(d) ? "not played" : "still to play"}` : "";
  return `Trials: ${num(t.written)} written: ${parts.join(", ")}${rest}.`;
}

// A run that stopped before its last trial says where; one that stopped after it is a note. A stop
// before the first turn has no turn to name, and a reason written as a sentence keeps one full stop.
function stoppedLine(d) {
  const s = d.stopped;
  // A stop before the trials, on the endpoints' first conversations, names each one instead of a turn.
  const turn = s.after > 0 && !s.first ? ` at turn ${s.after}` : "";
  const why = String(s.why).replace(/\.$/, "");
  const fix = s.fix ? ` ${s.fix}` : "";
  if (d.of && d.played < d.of) return `Stopped at ${num(d.played)} of ${plural(d.of, "trial")}${SIDE[s.side] ? `, ${SIDE[s.side]}` : ""}: ${why}${turn}.${fix}`;
  return `${upper(why)}${turn}${SIDE[s.side] ? `, ${SIDE[s.side]}` : ""}.${fix}`;
}

// A verify is its verdict on the finding's own trials, in the server's words: what came back broken,
// gone, less often, stayed or cannot tell yet with the counts behind it, and the held-out line.
function verifyLines(v) {
  // An access verify is a re-knock, not a trial move: the routes side by side, then the count. Only
  // a route knocked and answered both times is compared; one the app no longer has or did not answer
  // is named as such, never read as a closed gate.
  if (v.access) {
    const lines = [`Verify of ${v.findingId}.`];
    for (const r of v.routes ?? []) {
      // A 2xx handed the data over; a 400, 404 or 422 reached the handler's own checks with no sign-in asked.
      const open = (status, when) => (status >= 200 && status < 300 ? `${when === "then" ? "answered" : "now answers"} ${status} with no sign-in` : `${when === "then" ? "reached its own checks" : "now reaches its own checks"} with no sign-in (HTTP ${status})`);
      const then = r.wasOpen ? open(r.before, "then") : `refused (${r.before})`;
      const now =
        r.state === "answered" ? (r.nowOpen ? open(r.after, "now") : `now refuses (${r.after})`)
        : r.state === "gone" ? "your app no longer has this route"
        : r.state === "no-answer" ? "your app did not answer this time"
        : "was not knocked again";
      lines.push(`  ${r.method} ${r.route}: ${then}, ${now}.`);
    }
    if (v.said) lines.push(v.said);
    return lines;
  }
  return [`Verify of ${v.findingId}${v.file ? ` at ${at(v.file, v.line)}` : ""}.`, ...(v.said ? [v.said] : [])];
}

export function nextCall(d) {
  if (!finished(d)) return `run_status ${d.jobId}`;
  return d.kind === "verify" || d.findings > 0 ? "findings" : "status";
}

export function runText(d) {
  const lines = runLines(d);
  const plan = finished(d) ? planLine(d.plan) : null;
  if (plan) lines.push(plan);
  if (finished(d) && d.url) lines.push(`For the person: the report is at ${d.url}`);
  lines.push(`next: ${nextCall(d)}`);
  return verifyOnceAPage(lines.join("\n"));
}

export function startedText(d, kind, findingId, said = []) {
  const verify = (d.kind ?? kind) === "verify";
  const what = verify ? `Verify${findingId && !d.joined ? ` of ${findingId}` : ""}` : "Run";
  return [`${what} ${d.joined ? "already playing" : "started"}: ${d.jobId}.`, ...said, d.note, `next: run_status ${d.jobId}`].filter(Boolean).join("\n");
}

export const restartedText = (paths) =>
  `Your app was started again so this run plays your change (${plural(paths.length, "file")} changed since it started: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""}).`;

// Which code the run played: the app's start against the last change to its source (lib/fresh.mjs).
const clock = (iso) => new Date(iso).toTimeString().slice(0, 8);
export function testedLine(t) {
  const started = clock(t.startedAt);
  if (t.stale) return `Your app was already running when this command started and has been running since ${started}; ${t.change.path} changed at ${clock(t.change.at)}, so this run may have played the old code. Stop your app and run the command again.`;
  if (!t.change) return `App started ${started}.`;
  if (Date.parse(t.change.at) <= Date.parse(t.startedAt)) return `App started ${started}, after your last change at ${clock(t.change.at)}.`;
  return `App started ${started}${t.reloads ? " and reloads itself on save" : ""}; your last change was at ${clock(t.change.at)}.`;
}

// `runner`: the app's state as the process holding it up wrote it; `app`: the server's. An app that
// already answers is said to: an agent read "still starting" beside "your app is answering".
export function waitingText(p, now, limitMs, runner, app) {
  const kind = p.kind === "verify" ? "verify" : "run";
  const waited = `${num((now - Date.parse(p.startedAt)) / 1000)} of up to ${num(limitMs / 1000)} seconds`;
  const head = runner?.state === "up" ? `${answeringText(runner, app)}\nThe ${kind} has waited ${waited}.` : `Your app is still starting for the ${kind}: ${waited}.`;
  return `${head}\nnext: run_status pending`;
}

// A spent plan: what the last run found, what was fixed since, what the next run would play.
export function refusedText(d) {
  const lines = [];
  if (has(d.used) && has(d.allowed) && d.unit) lines.push(`Refused: ${num(d.used)} of ${units(d.allowed, d.unit)} used${d.plan?.name ? ` on the ${d.plan.name} plan` : ""}.`);
  else if (d.why) lines.push(`Refused: ${d.why}`);
  if (d.ledger) lines.push(...ledgerLines(d.ledger));
  if (!d.ledger?.plan && d.plans?.length) lines.push(`Plans: ${d.plans.map((p) => `${p.name} $${p.monthlyUsd} a month`).join(", ")}.`);
  lines.push("Nothing ran.");
  if (d.checkout) lines.push(`For the person: plans and checkout at ${d.checkout}`);
  return lines.join("\n");
}

// The conversations kept back from the fixer, in the words the verify says them: a fix whose own
// replays are gone can still have made the failure worse there.
const KEPT_MOVE = { gone: "the failure is gone on", "less often": "the failure shows less often on", worse: "the fix made the failure worse on" };
function keptSaid(h) {
  if (!h?.before?.trials || !h?.after?.trials) return "";
  const counts = `${num(h.before.failed)} of ${num(h.before.trials)} failed before, ${num(h.after.failed)} of ${num(h.after.trials)} after`;
  return KEPT_MOVE[h.moved] ? `; ${KEPT_MOVE[h.moved]} the conversations kept back from you (${counts})` : `; on the conversations kept back from you, ${counts}, not beyond chance`;
}

function ledgerLines(l) {
  const lines = [];
  const r = l.lastRun;
  if (r) {
    const parts = [has(r.findings) && plural(r.findings, "finding"), r.of && `${num(r.played ?? 0)} of ${plural(r.of, "trial")} played`].filter(Boolean);
    lines.push(`Last run ${r.jobId}: ${parts.join(", ")}.`);
  }
  if (l.fixed) {
    lines.push(`${plural(l.fixed.length, "fix", "fixes")} verified since that run${l.fixed.length ? ":" : "."}`);
    // A fix on a finding with no file (a crash, a standard) is named by its id, never "undefined".
    for (const f of l.fixed) lines.push(`  ${f.path ? `${at(f.path, f.line)} (${f.findingId})` : f.findingId}: ${f.verdict}; ${num(f.after.failed)} of ${plural(f.after.replays, "replay")} failed, against ${num(f.before.failed)} of ${num(f.before.trials)} before${keptSaid(f.heldOut)}.`);
  }
  const n = l.nextRun;
  if (n) lines.push(`The next run would play ${[plural(n.trials, "trial"), has(n.heldOut) && `${num(n.heldOut)} held out`, has(n.newFromChanges) && `${num(n.newFromChanges)} new from the changes`].filter(Boolean).join(", ")}.`);
  const p = l.plan;
  if (p) lines.push(`The ${p.name} plan, $${p.monthlyUsd} a month${has(p.allowed) ? `, includes ${units(p.allowed, p.unit)}` : ""}.`);
  if (l.field === null) lines.push("Production: not connected.");
  else if (l.field) lines.push(`Production, last ${plural(l.field.days, "day")}: ${plural(l.field.conversations, "conversation")}${has(l.field.brokenRate) ? `, ${Math.round(l.field.brokenRate * 100)}% of them broke a rule` : ""}.`);
  return lines;
}

// Findings grouped by the line they live at: the server's byLine, or the findings' own file and
// line when it sends none. The same line from two server pages is one group.
export function linesOf(d) {
  const rows = (d.byLine ?? (d.findings ?? []).map((f) => ({ path: f.file, line: f.line, findingIds: [f.id] }))).filter((r) => r.path);
  const merged = new Map();
  for (const r of rows) {
    const key = at(r.path, r.line);
    if (merged.has(key)) merged.get(key).findingIds.push(...r.findingIds);
    else merged.set(key, { path: r.path, line: r.line, findingIds: [...r.findingIds] });
  }
  return [...merged.values()];
}

export const findingsText = (d, page = 1) => pageOf(findingsPages(d), page, (n) => `findings with page ${n}`);

function findingsHead(d) {
  if (!d.runId) return "No run has finished on this repository yet.";
  const settled = (d.findings ?? []).filter((f) => f.trials && !f.unsettled).length;
  const lines = [`Run ${d.runId}: ${plural(d.findings?.length ?? 0, "finding")}${settled ? `, ${num(settled)} settled` : ""}.`];
  const cost = costSaid(d);
  if (cost) lines.push(cost);
  if (d.tested) lines.push(testedLine(d.tested));
  return lines.join("\n");
}

// After the findings: what the app's promises measured and how the run went.
function findingsTail(d) {
  const lines = measuredLines(d);
  if (d.blocked) lines.push(d.blocked);
  if (d.halted) lines.push(haltLine(d.halted));
  lines.push(...waitLines(d));
  if (d.baseRunId) lines.push(`Compared with run ${d.baseRunId}.`);
  for (const s of [d.read, d.heldBack, d.findings?.length ? null : d.why]) if (s) lines.push(s);
  // A finding in a situation the run keeps back: what failed and where, so the rule can be fixed;
  // its inputs and trials stay unseen, and verify replays it all the same.
  for (const k of d.keptBack ?? []) lines.push(`Kept back ${k.id}: "${clip(k.asks, 160)}"${k.file ? ` at ${at(k.file, k.line)}` : ""}, ${k.trials ? `failed in ${num(k.trials.failed)} of ${plural(k.trials.of, "trial")}` : `held ${kn(k.rate)}${has(k.reply) ? ` at reply ${num(k.reply)}` : ""}`}${k.quote ? `; the reply said "${clip(k.quote, 120)}"` : ""}. Its inputs are not shown; verify ${k.id} replays them.`);
  return lines.join("\n");
}

// Whole findings in the order the server ranks them (settled first, the app's own promises first),
// then the tail, packed into pages that stay under PAGE_CHARS.
function findingsPages(d, budget = PAGE_CHARS - 60) {
  const blocks = [...(d.findings ?? []).map((f) => findingBlock(f)), findingsTail(d)].filter(Boolean);
  const pages = [];
  let page = findingsHead(d);
  let filled = false;
  for (const block of blocks) {
    if (filled && page.length + block.length + 2 > budget) {
      pages.push(page);
      page = `Run ${d.runId}, findings continued.`;
    }
    page += `\n\n${block}`;
    filled = true;
  }
  pages.push(page);
  return pages.map(verifyOnceAPage);
}

function findingBlock(f) {
  // A gate the run knocked open: the route, the address, the request sent and the status it answered
  // with no sign-in. Its own words, then how to prove the fix.
  if (f.kind === "access-open") {
    const lines = [`${f.id}  ${f.says}`];
    if (f.path) lines.push(`  At ${at(f.path, f.line)}`);
    if (f.standard) lines.push(`  Standard: ${clip(f.standard, 200)}`);
    lines.push(`  Sent: ${f.request.method} ${f.request.path}${f.request.body ? ` ${clip(f.request.body, 200)}` : ""}${f.as === "another-user" ? " as another user" : " with no sign-in"}`);
    lines.push(`  Answered: ${f.status}${has(f.response) && f.response ? `, ${clip(f.response, 400)}` : ""}`);
    lines.push(`  Replay: verify ${f.id}`);
    return lines.join("\n");
  }
  // What broke, in how many trials, the exchange it broke in, and the line; then the rest.
  const lines = [`${f.id}  ${f.asks}`, shareLine(f)].filter(Boolean);
  if (f.sentAway?.said) lines.push(`  Of them, ${f.sentAway.said}.`);
  if (f.baseline) lines.push(`  Played again: ${plural(f.baseline.trials, "fresh trial")} of the same ask in other words; it broke again in ${num(f.baseline.failed)}.`);
  const logs = { shown: new Set(), room: 30 };
  const [first, ...more] = (f.quotes ?? []).slice(0, 3);
  if (first) lines.push(...quoteLines(first, f, logs));
  if (f.file) lines.push(`  At ${at(f.file, f.line)}${f.addressed ? `: ${f.addressed}` : ""}`);
  if (f.criteria) lines.push(`  Criteria: ${clip(f.criteria, 600)}`);
  if (f.door) lines.push(`  Endpoint: ${f.door}`);
  else if (f.doors?.length) lines.push(`  Endpoints: ${f.doors.join(", ")}`);
  if (f.where) lines.push(`  Situation: ${f.where}`);
  if (f.fix) lines.push(`  Fix: ${f.fix}`);
  if (f.sentAway?.neverRan?.length) lines.push(`  Needed by these asks and never run: ${f.sentAway.neverRan.join(", ")}.`);
  lines.push(...alsoLines(f));
  if (f.layer && LAYER_WORDS[f.layer]) lines.push(`  Layer: ${f.layer}, ${LAYER_WORDS[f.layer]}.`);
  const read = f.decidedBy?.reader ?? f.decidedBy?.model;
  const by = [f.decidedBy?.code && `code on ${plural(f.decidedBy.code, "quoted reply", "quoted replies")}`, read && `a model on ${plural(read, "quoted reply", "quoted replies")}`].filter(Boolean);
  if (by.length) lines.push(`  Decided by ${by.join(", by ")}.`);
  for (const q of more) lines.push(...quoteLines(q, f, logs));
  if (f.sentAway?.note) lines.push(`  ${f.sentAway.note}`);
  for (const line of (f.log ?? []).slice(0, 8)) lines.push(`  Log: ${clip(line, 300)}`);
  // A finding read from the customer's own words has nothing a verify can replay; its plan says so.
  if (f.replay?.trials) lines.push(`  Replay: ${plural(f.replay.trials, "trial")}, verify ${f.id}`);
  // What a verify of it can show at most, read before the allowance is spent: an agent paid for two
  // verifies of a finding resting on six readings, and neither could have left the noise.
  if (f.replay?.plan) lines.push(`  ${f.replay.plan}`);
  return lines.join("\n");
}

const pct = (x) => `${Math.round(x * 100)}%`;

// The break count in trials, the unit a finding forms in. A finding from before trials counted says
// its replies, whichever way the question is phrased: "held in 21 of 33" under a question that asks
// whether the passages MISS the point left an agent unable to tell pass from fail.
function shareLine(f) {
  const t = f.trials;
  if (t) return `  Failed in ${num(t.failed)} of ${plural(t.of, "trial")}, between ${pct(t.lo)} and ${pct(t.hi)} of trials${f.unsettled ? "; unsettled: too few trials yet to say it fails in one visit in five" : ""}.`;
  const r = f.rate;
  if (!r) return "";
  return `  Broke in ${num(r.n - r.k)} of ${plural(r.n, "reply", "replies")}${r.n ? `, ${Math.round((100 * (r.n - r.k)) / r.n)}%` : ""}${has(r.lo) ? `, interval ${Math.round((1 - r.hi) * 100)}% to ${Math.round((1 - r.lo) * 100)}%` : ""}.${f.unsettled ? " Unsettled." : ""}`;
}

// One quoted break: what the trial sent, the reply, the sentence it broke on, what the reply was
// checked against, and what a developer reproduces it from: the request as sent, the body back, the
// app's own log. The same log twice is said once, and a finding prints thirty log lines at most.
function quoteLines(q, f, logs) {
  const lines = [];
  const about = [q.trialId && `trial ${String(q.trialId).slice(0, 8)}`, q.door && `at ${q.door}`].filter(Boolean).join(", ");
  if (q.asked) lines.push(`  Sent: "${clip(q.asked, 300)}"`);
  lines.push(`  Reply ${q.reply}: "${clip(q.answer ?? q.quote, 400)}"${about ? ` (${about})` : ""}`);
  if (q.answer && q.quote && q.quote !== q.answer) lines.push(`    It broke on: "${clip(q.quote, 300)}"`);
  if (q.after) lines.push(`    Then the customer: "${clip(q.after, 300)}"`);
  if (q.checked) lines.push(`    ${q.checked}`);
  for (const p of (q.passages ?? []).slice(0, 3)) lines.push(`    Passage${p.source ? ` (${clip(p.source, 60)})` : ""}: "${clip(p.text, 240)}"`);
  if (q.request) lines.push(`    Request: ${q.request.method} ${q.request.path}${q.request.body ? ` ${clip(q.request.body, 600)}` : ""}`);
  if (has(q.response)) lines.push(`    Response: ${q.response ? clip(q.response, 600) : "(empty body)"}`);
  const log = (q.log ?? []).join("\n");
  if (log && logs.shown.has(log)) lines.push("    Log: the same lines as the reply above.");
  else for (const line of (q.log ?? []).slice(0, logs.room)) { lines.push(`    Log: ${clip(line, 240)}`); logs.room -= 1; }
  if (log) logs.shown.add(log);
  if (q.at && q.at !== at(f.file, f.line)) lines.push(`    At ${q.at}`);
  return lines;
}

// One question, one finding: the other situations it failed in are listed under it, and so are the
// other checks the same reply sentence broke, which are not findings of their own.
function alsoLines(f) {
  const broke = (a) => (a.trials ? `broke in ${num(a.trials.failed)} of ${plural(a.trials.of, "trial")}` : `broke in ${num(a.rate.n - a.rate.k)} of ${plural(a.rate.n, "reply", "replies")}`);
  const own = (a) => Boolean(f.questionId) && a.questionId === f.questionId;
  const same = (f.alsoIn ?? []).filter(own);
  const other = (f.alsoIn ?? []).filter((a) => !own(a));
  const lines = [];
  if (same.length) {
    lines.push(`  Failed in ${num(same.length + 1)} situations; the other ${num(same.length)}:`);
    for (const a of same.slice(0, 8)) lines.push(`    ${a.where}: ${broke(a)}`);
    if (same.length > 8) lines.push(`    and ${num(same.length - 8)} more.`);
  }
  if (other.length) {
    lines.push(`  Same cause in ${plural(other.length, "more place")}, the same reply sentence in each:`);
    for (const a of other.slice(0, 8)) lines.push(`    ${a.where}: ${clip(a.asks, 160)}, ${broke(a)}`);
    if (other.length > 8) lines.push(`    and ${num(other.length - 8)} more.`);
  }
  return lines;
}

export function fieldText(d) {
  const t = d.totals;
  const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
  const link = d.url ? [`For the person: ${d.url}`] : [];
  if (!t || !t.n) return [`No production conversations read in the last ${plural(d.days, "day")}.`, ...link].join("\n");
  const lines = [
    `Production, last ${plural(d.days, "day")}: ${plural(t.n, "conversation")}, ${num(t.read)} read.`,
    `Rule checks held: ${pct(t.rulingsHeld, t.rulings)} of ${num(t.rulings)}${t.rulingsUnsure ? ` (${num(t.rulingsUnsure)} unsure)` : ""}. Resolved ${pct(t.resolved, t.read)}, frustrated ${pct(t.frustrated, t.read)}, asked for a human ${pct(t.wantsHuman, t.read)}, unanswered ${pct(t.unanswered, t.read)}.`,
  ];
  const broke = (d.rules ?? []).filter((r) => r.broke > 0).sort((a, b) => b.broke - a.broke).slice(0, 5);
  if (broke.length) lines.push(`Rules broken most: ${broke.map((r) => `${r.id} (${num(r.broke)})`).join(", ")}.`);
  if (d.journeys?.length) lines.push(`By journey: ${d.journeys.slice(0, 6).map((j) => `${j.value} ${plural(j.n, "conversation")}, ${pct(j.rulingsHeld, j.rulings)} held`).join("; ")}.`);
  return [...lines, ...link].join("\n");
}

export const fieldConnectText = (d) => [d.connected ? "Production is connected." : "Production is not connected.", ...(d.steps ?? []).map((s, i) => `${i + 1}. ${s}`)].join("\n");
