import { readLines } from "./read-text.mjs";
import { at, clip, has, num, PAGE_CHARS, pageOf, plural, SIDE, upper } from "./words.mjs";

// What each verb prints. A result is data for the coding agent: a line meant for the person starts
// with "For the person:", and a run_status result ends with the next call. A field the API leaves
// out prints nothing, so the text follows the API as it grows.

const DONE = new Set(["succeeded", "failed", "canceled"]);
const UNIT = { sweeps: ["run", "runs"], runs: ["run", "runs"], trials: ["verify trial", "verify trials"] };
export const STARTING = "Starting your app for the run. Call run_status; it answers as soon as the run has an id.";

const signed = (x) => (Math.round(x) > 0 ? `+${num(x)}` : num(x));
const units = (n, unit) => { const [one, many] = UNIT[unit] ?? [unit, unit]; return `${num(n)} ${n === 1 ? one : many}`; };
const kn = (x) => (has(x?.k) ? `${num(x.k)} of ${num(x.n)}` : num(x));
const interval = (ci) => (ci && has(ci.low) ? `, interval ${num(ci.low)} to ${num(ci.high)}` : "");

export const finished = (run) => Boolean(run) && (run.finished ?? DONE.has(run.status));

export function statusText(d) {
  const lines = [];
  if (d.repository?.name) lines.push(`Cortad · ${d.repository.name}`);
  const plan = planLine(d.plan);
  if (plan) lines.push(plan);
  if (d.app?.said) lines.push(`App: ${d.app.said}`);
  for (const s of d.app?.data ?? []) lines.push(`Data: ${s}`);
  if (d.read?.complete === false) lines.push("The read of your repository is still running; the lists below fill in as it finishes.");
  if (d.read) lines.push(...readLines(d.read));
  if (d.run === null) lines.push("No run yet.");
  else if (d.run) lines.push(...runLines(d.run, "latest "));
  // Trials the read wrote after this run chose its own: the one count that is not the run's.
  const since = (d.read?.trials?.written ?? 0) - (d.run?.trials?.written ?? Infinity);
  if (since > 0 && d.run?.kind !== "verify") lines.push(`${plural(since, "more trial")} written since this run; the next run chooses from them too.`);
  if (d.field) lines.push(`Production: ${d.field.connected ? "connected" : "not connected"}.`);
  if (d.links?.lab && (d.read || d.run)) lines.push(`For the person: ${d.links.lab} shows this in the browser.`);
  if (d.run && !finished(d.run)) lines.push(`next: run_status ${d.run.jobId}`);
  return lines.join("\n");
}

function planLine(p) {
  if (!p?.name) return null;
  const parts = [];
  if (has(p.runsLeft) && has(p.runsAllowed)) parts.push(`${num(p.runsLeft)} of ${plural(p.runsAllowed, "run")} left this month`);
  if (has(p.verifyTrialsLeft) && has(p.verifyTrialsAllowed)) parts.push(`${num(p.verifyTrialsLeft)} of ${plural(p.verifyTrialsAllowed, "verify trial")} left`);
  return parts.length ? `${p.name}: ${parts.join(", ")}.` : `Plan: ${p.name}.`;
}

// What was measured leads and the number follows on it: "97 of 100" ahead of "26 of 78 checks"
// read as more confidence than the run had to agents on three repositories, and every one asked
// what was not measured and what would measure it. The number never stands without its
// denominator, and under the 22-reading floor it is provisional and says so.
function measuredLines(d) {
  const of = has(d.questionsAsked) && has(d.questionsOf) && d.questionsOf > 0;
  const score = typeof d.score === "number" ? scoreText(d, of) : null;
  const lines = of ? [`${num(d.questionsAsked)} of ${plural(d.questionsOf, "check")} measured${score ? `; ${score}` : ""}.`] : score ? [`${upper(score)}.`] : [];
  const groups = (d.notMeasured?.groups ?? []).filter((g) => g.count > 0 && g.said);
  if (groups.length) lines.push(`${num(d.notMeasured.total)} not measured: ${groups.map((g) => clip(g.said, 240)).join("; ")}.`);
  return lines;
}

function scoreText(d, of) {
  const floor = has(d.decided) && d.decided < 22;
  // The replies that failed stand beside the number: a 100 over the replies that answered, with 62 of
  // 89 error replies unsaid, read as a clean bill.
  const crashed = d.replies && d.replies.crashed > 0 ? `; ${num(d.replies.crashed)} of ${plural(d.replies.total, "reply", "replies")} were failures and are not in it` : "";
  return `${floor ? "provisional score" : "score"} ${num(d.score)} of 100${of ? ` on those ${num(d.questionsAsked)}` : ""}${interval(d.ci)}${floor ? `, from ${plural(d.decided, "decided reading")}: under the 22-reading floor, so not a verdict yet` : ""}${crashed}`;
}
// A row the run held back names a door and why, or, when no door could take it, only the reason.
const heldBackLine = (h) => h.why === "not testable here"
  ? `Held back: ${plural(h.trials, "trial")} cannot be played here: ${clip(h.surface, 200).replace(/\.$/, "")}.`
  : `Held back: ${plural(h.trials, "trial")} on ${h.surface}${h.why ? `, ${clip(h.why, 200)}` : ""}.`;
const haltLine = (h) => `${h.side === "ours" ? "We lost your app" : "Your app stopped answering"} after ${plural(h.after, "turn")}${h.why ? `: ${clip(h.why, 200)}` : ""}. The score covers the turns before that.`;
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
  const lines = [`${upper(`${prefix}${d.kind === "verify" ? "verify" : "run"}`)} ${d.jobId}: ${d.status === "succeeded" || !d.status ? (done ? "finished" : "running") : d.status}, ${played}.`];
  // A verify is a move, not a score: "100 of 100" on a replay whose run before decided nothing read
  // as a clean bill to bloom's agent, beside "zero verified fixes".
  if (done && d.kind !== "verify") lines.push(...measuredLines(d));
  if (done && d.blocked) lines.push(d.blocked);
  if (done && d.notCounted) lines.push(d.notCounted);
  if (done && d.halted) lines.push(haltLine(d.halted));
  if (done && has(d.readingsHeld) && has(d.readings) && d.readings > 0) lines.push(`The question readings held in ${num(d.readingsHeld)} of ${num(d.readings)}, ${Math.round((100 * d.readingsHeld) / d.readings)}%; the score is the case checks' pass rate on the checks measured.`);
  if (done && has(d.findings)) lines.push(`${plural(d.findings, "finding")}.`);
  const trials = trialsLine(d);
  if (trials) lines.push(trials);
  // Every row, or six and the rest in one line, so the rows always sum to the held-back count.
  const heldRows = (d.heldBack ?? []).filter((h) => h.trials > 0);
  for (const h of heldRows.slice(0, 6)) lines.push(heldBackLine(h));
  if (heldRows.length > 6) lines.push(`Held back: ${plural(heldRows.slice(6).reduce((n, h) => n + h.trials, 0), "more trial")} for ${plural(heldRows.length - 6, "other reason")}.`);
  const reads = readingsLine(d);
  if (reads) lines.push(reads);
  if (d.stopped) lines.push(stoppedLine(d));
  for (const f of d.faults ?? []) lines.push(`Fault${SIDE[f.side] ? ` ${SIDE[f.side]}` : ""}: ${f.what}${f.fix ? ` ${f.fix}` : ""}`);
  for (const s of d.data ?? []) lines.push(`Data: ${s}`);
  if (d.error) lines.push(`Error: ${d.error}`);
  if (d.verify) lines.push(...verifyLines(d.verify));
  return lines;
}

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

// A reading is one question checked against one reply.
function readingsLine(d) {
  if (!has(d.readings) && !has(d.questionsAsked)) return null;
  const r = has(d.readings) ? plural(d.readings, "reading") : null;
  // The line above says why the rest were not measured; without it, how many there are.
  const never = !d.notMeasured && has(d.questionsOf) && d.questionsOf > d.questionsAsked;
  const q = has(d.questionsAsked) ? `${plural(d.questionsAsked, "question")}${never ? ` (${num(d.questionsOf - d.questionsAsked)} of the ${num(d.questionsOf)} in the set never came up)` : ""}` : null;
  const split = [has(d.decided) && `${num(d.decided)} decided`, has(d.unclear) && `${num(d.unclear)} unclear`].filter(Boolean).join(", ");
  return `${r && q ? `${r} of ${q}` : r ?? `${q} asked`}${split ? `: ${split}` : ""}.`;
}

// A run that stopped before its last trial says where; one that stopped after it is a note.
function stoppedLine(d) {
  const s = d.stopped;
  const turn = has(s.after) ? ` at turn ${s.after}` : "";
  const fix = s.fix ? ` ${s.fix}` : "";
  if (d.of && d.played < d.of) return `Stopped at ${num(d.played)} of ${plural(d.of, "trial")}${SIDE[s.side] ? `, ${SIDE[s.side]}` : ""}: ${s.why}${turn}.${fix}`;
  return `${upper(s.why)}${turn}${SIDE[s.side] ? `, ${SIDE[s.side]}` : ""}.${fix}`;
}

const moveText = (m) => `held ${kn(m.before)} readings before, ${kn(m.after)} after; ${m.moved}, ${signed(m.point)} points${interval(m)}${m.insideNoise ? ", inside the noise" : ""}.`;

// Over zero pairs there is no move to print: the line says verification is unavailable and why,
// never "no change, 0 points" measured on nothing. The visible side's reason is the said line.
function verifyLines(v) {
  const lines = [`Verify of ${v.findingId}${v.path ? ` at ${at(v.path, v.line)}` : ""}.`];
  if (v.visible && !v.visible.unavailable) lines.push(`Visible trials: ${moveText(v.visible)}`);
  if (v.holdout?.unavailable) lines.push(`Held-out trials: verification unavailable: ${v.holdout.unavailable}.`);
  else if (v.holdout) lines.push(`Held-out trials: ${moveText(v.holdout)}`);
  else if (v.holdout === null) lines.push("Held-out trials: no pair for this question.");
  if (v.overfit) lines.push("Overfit: the visible trials moved and the held-out trials did not.");
  if (v.said) lines.push(v.said);
  return lines;
}

export function nextCall(d) {
  if (!finished(d)) return `run_status ${d.jobId}`;
  return d.kind === "verify" || d.findings > 0 ? "findings" : "status";
}

export function runText(d) {
  const lines = runLines(d);
  if (finished(d) && d.url) lines.push(`For the person: the report is at ${d.url}`);
  lines.push(`next: ${nextCall(d)}`);
  return lines.join("\n");
}

export function startedText(d, kind, findingId) {
  const verify = (d.kind ?? kind) === "verify";
  const what = verify ? `Verify${findingId && !d.joined ? ` of ${findingId}` : ""}` : "Run";
  return `${what} ${d.joined ? "already playing" : "started"}: ${d.jobId}.${d.note ? `\n${d.note}` : ""}\nnext: run_status ${d.jobId}`;
}

export const waitingText = (p, now, limitMs) =>
  `Your app is still starting for the ${p.kind === "verify" ? "verify" : "run"}: ${num((now - Date.parse(p.startedAt)) / 1000)} of up to ${num(limitMs / 1000)} seconds.\nnext: run_status pending`;

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

function ledgerLines(l) {
  const lines = [];
  const r = l.lastRun;
  if (r) {
    const parts = [has(r.score) && `score ${num(r.score)} of 100${interval(r.ci)}`, has(r.findings) && plural(r.findings, "finding"), r.of && `${num(r.played ?? 0)} of ${plural(r.of, "trial")} played`].filter(Boolean);
    lines.push(`Last run ${r.jobId}: ${parts.join(", ")}.`);
  }
  if (l.fixed) {
    lines.push(`${plural(l.fixed.length, "fix", "fixes")} verified since that run${l.fixed.length ? ":" : "."}`);
    // A fix on a finding with no file (a crash, a standard) is named by its id, never "undefined".
    for (const f of l.fixed) lines.push(`  ${f.path ? `${at(f.path, f.line)} (${f.findingId})` : f.findingId}: held ${kn(f.before)} readings before, ${kn(f.after)} after; ${f.moved}, ${signed(f.move)} points${interval(f)}.`);
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
  if (!d.runId) return ["No run has finished on this repository yet."];
  const lines = [`Run ${d.runId}: ${plural(d.findings?.length ?? 0, "finding")}.`];
  lines.push(...measuredLines(d));
  if (d.blocked) lines.push(d.blocked);
  if (d.halted) lines.push(haltLine(d.halted));
  const reads = readingsLine(d);
  if (reads) lines.push(reads);
  if (d.baseRunId) lines.push(`Compared with run ${d.baseRunId}.`);
  for (const s of [d.read, d.heldBack, d.findings?.length ? null : d.why]) if (s) lines.push(s);
  return lines.join("\n");
}

// Whole findings, worst first as the server orders them, packed into pages that stay under
// PAGE_CHARS. A group that crosses a page carries its header again.
function findingsPages(d, budget = PAGE_CHARS - 60) {
  const head = findingsHead(d);
  if (!d.findings?.length) return [head];
  const byId = new Map(d.findings.map((f) => [f.id, f]));
  const groups = linesOf(d).map((g) => ({ label: `${plural(g.findingIds.length, "finding")} at ${at(g.path, g.line)}`, placed: true, items: g.findingIds.map((id) => byId.get(id)).filter(Boolean) }));
  const grouped = new Set(groups.flatMap((g) => g.items.map((f) => f.id)));
  const rest = d.findings.filter((f) => !grouped.has(f.id));
  if (rest.length) groups.push({ label: `${plural(rest.length, "finding")} without a line`, placed: false, items: rest });

  const pages = [];
  let page = head;
  let filled = false;
  let open = null;
  for (const g of groups) {
    g.items.forEach((f, i) => {
      const block = findingBlock(f, g.placed);
      const label = () => (open === g ? "" : `\n\n${i === 0 ? g.label : `${g.label}, continued`}`);
      if (filled && page.length + label().length + block.length + 1 > budget) {
        pages.push(page);
        page = `Run ${d.runId}, findings continued.`;
        filled = false;
        open = null;
      }
      page += `${label()}\n${block}`;
      filled = true;
      open = g;
    });
  }
  pages.push(page);
  return pages;
}

function findingBlock(f, placed) {
  const lines = [`${f.id}  ${f.asks}`];
  if (!placed && f.file) lines.push(`  At ${at(f.file, f.line)}`);
  if (f.criteria) lines.push(`  Criteria: ${clip(f.criteria, 600)}`);
  if (f.door) lines.push(`  Endpoint: ${f.door}`);
  else if (f.doors?.length) lines.push(`  Endpoints: ${f.doors.join(", ")}`);
  if (f.where) lines.push(`  Situation: ${f.where}`);
  if (f.fix) lines.push(`  Fix: ${f.fix}`);
  // One cause, one finding: the same sentence broke these too, and they are not findings of their own.
  if (f.alsoIn?.length) {
    lines.push(`  Same cause in ${plural(f.alsoIn.length, "more place")}, the same reply sentence in each:`);
    for (const a of f.alsoIn.slice(0, 8)) lines.push(`    ${a.where}: ${clip(a.asks, 160)}, broke in ${num(a.rate.n - a.rate.k)} of ${plural(a.rate.n, "reply", "replies")}`);
    if (f.alsoIn.length > 8) lines.push(`    and ${num(f.alsoIn.length - 8)} more.`);
  }
  if (f.layer && LAYER_WORDS[f.layer]) lines.push(`  Layer: ${f.layer}, ${LAYER_WORDS[f.layer]}.`);
  const r = f.rate;
  // The break count, whichever way the question is phrased: "held in 21 of 33" under a question
  // that asks whether the passages MISS the point left an agent unable to tell pass from fail.
  if (r) lines.push(`  Broke in ${num(r.n - r.k)} of ${plural(r.n, "reply", "replies")}${r.n ? `, ${Math.round((100 * (r.n - r.k)) / r.n)}%` : ""}${has(r.lo) ? `, interval ${Math.round((1 - r.hi) * 100)}% to ${Math.round((1 - r.lo) * 100)}%` : ""}.`);
  if (f.unsettled) lines.push("  Unsettled: under the 22-reading floor.");
  const by = [f.decidedBy?.code && `code in ${plural(f.decidedBy.code, "reading")}`, f.decidedBy?.model && `a model in ${plural(f.decidedBy.model, "reading")}`].filter(Boolean);
  if (by.length) lines.push(`  Decided by ${by.join(", by ")}.`);
  const logsShown = new Set();
  let logRoom = 30;
  for (const q of (f.quotes ?? []).slice(0, 3)) {
    const about = [typeof q.p === "number" && `confidence ${q.p.toFixed(2)}`, q.trialId && `trial ${q.trialId}`, q.door && `at ${q.door}`].filter(Boolean).join(", ");
    // The request beside the reply: an agent handed "HTTP 502 happened" did the rest of the
    // investigation itself.
    if (q.asked) lines.push(`  Asked: "${clip(q.asked, 300)}"`);
    lines.push(`  Reply ${q.reply}: "${clip(q.quote, 400)}"${about ? ` (${about})` : ""}`);
    // What a developer reproduces it from: the request as sent, the body back, the app's own log.
    if (q.request) lines.push(`    Request: ${q.request.method} ${q.request.path}${q.request.body ? ` ${clip(q.request.body, 600)}` : ""}`);
    if (has(q.response)) lines.push(`    Response: ${q.response ? clip(q.response, 600) : "(empty body)"}`);
    // A page stays under what a client keeps: the same log twice is said once, and a finding
    // prints thirty log lines at most.
    const log = (q.log ?? []).join("\n");
    if (log && logsShown.has(log)) lines.push("    Log: the same lines as the reply above.");
    else for (const line of (q.log ?? []).slice(0, logRoom)) { lines.push(`    Log: ${clip(line, 240)}`); logRoom -= 1; }
    if (log) logsShown.add(log);
    if (q.at && q.at !== at(f.file, f.line)) lines.push(`    At ${q.at}`);
  }
  for (const line of (f.log ?? []).slice(0, 8)) lines.push(`  Log: ${clip(line, 300)}`);
  if (f.replay) lines.push(`  Replay: ${plural(f.replay.trials, "trial")}, verify ${f.id}`);
  return lines.join("\n");
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
