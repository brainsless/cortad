import { clip, has, num, pack, pageOf, plural } from "./words.mjs";

// The run's numbers as the agent reads them: a few lines on where its trials ended and how their
// customers fared, after the findings, and every number whole one call away (`findings numbers`),
// each group with its count by class, of how many, the interval on the share that matters, and one
// exchange from the worst group of each.

const pct = (x) => `${Math.round(x * 100)}%`;
const interval = (b) => `${pct(b.lo)} to ${pct(b.hi)}`;
const levels = (d, classes) => classes.map((c) => `${c}: ${num(d.counts?.[c] ?? 0)}`).join(", ");
const named = (d, classes) => classes.map((c) => `${c} ${num(d.counts?.[c] ?? 0)}`).join(", ");
const isScale = (t) => t.classes.every((c) => /^\d+$/.test(c));

const units = (n, unit) => (unit === "replies" ? plural(n, "reply", "replies") : plural(n, "trial"));

// One group: a question's trials broken, or a measurement's classes, of how many, the average on a
// scale, and the share named with its interval.
function distSaid(t, d) {
  const of = units(d.of, t.unit);
  const unsure = d.unsure ? ` (${num(d.unsure)} unsure)` : "";
  if (t.kind === "question") return `broke in ${num(d.counts?.broke ?? 0)} of ${of}${d.bad && d.of ? `, ${interval(d.bad)}` : ""}${unsure}`;
  const counts = isScale(t) ? levels(d, t.classes) : named(d, t.classes);
  const mean = has(d.mean) ? `, average ${d.mean.toFixed(2)}` : "";
  const bad = d.bad && t.badSaid && d.of ? `; ${num(d.bad.k)} ${t.badSaid}, ${interval(d.bad)}` : "";
  return `${counts} of ${of}${mean}${bad}${unsure}`;
}

const worstSaid = (t, w) => `${w.split} ${w.value}: ${num(w.bad?.k ?? 0)} of ${num(w.of)}`;

// After the findings: one line per measurement, the customer's side of the run.
export function overviewLines(b) {
  if (!b?.measures?.length) return [];
  const lines = b.measures.map((m) => {
    const t = { ...m, kind: "measure" };
    const head = `${m.title}: ${distSaid(t, m.all)}.`;
    const worst = m.worst && m.badSaid ? ` Most in ${worstSaid(t, m.worst)}.` : "";
    // A scale counted at each trial's end is said reply by reply too: frustration climbing is the point.
    const byReply = isScale(t) && m.unit === "trials" && m.byReply?.length > 1
      ? ` By reply: ${m.byReply.map((d) => `${d.value.replace("reply ", "")}: ${has(d.mean) ? d.mean.toFixed(2) : "-"}${d.bad ? `, ${num(d.bad.k)} of ${num(d.of)} ${m.badSaid}` : ""}`).join("; ")}.`
      : "";
    return `${head}${worst}${byReply}`;
  });
  if (has(b.questions?.measured)) lines.push(`${plural(b.questions.measured, "question")} measured, ${num(b.questions.broke)} broke in at least one trial. Every number by journey, segment, situation and reply: findings numbers.`);
  return lines;
}

const SPLIT_WORDS = { journey: "By journey", segment: "By persona segment", situation: "By situation", reply: "By reply" };

// One group as a row under its header: the counts in the header's order, of how many, the average
// on a scale, then the share named with its interval.
function row(t, d) {
  const of = units(d.of, t.unit);
  const unsure = d.unsure ? ` (${num(d.unsure)} unsure)` : "";
  const share = d.bad && d.of ? `, ${interval(d.bad)}` : "";
  if (t.kind === "question") return `${num(d.counts?.broke ?? 0)} of ${of}${share}${unsure}`;
  const counts = t.classes.map((c) => num(d.counts?.[c] ?? 0)).join(", ");
  const mean = has(d.mean) ? `, average ${d.mean.toFixed(2)}` : "";
  return `${counts} of ${of}${mean}${d.bad && t.badSaid ? `; ${num(d.bad.k)}${share}` : ""}${unsure}`;
}

// How the rows are read: a question's trials broken, or a measurement's classes and its share.
const headerOf = (t) => (t.kind === "question"
  ? `  Counted as: the ${t.unit} it broke in, of the ${t.unit} that asked it, with the 95% interval.`
  : `  Counted as: ${isScale(t) ? `levels ${t.classes.join(", ")}` : t.classes.join(", ")} of ${t.unit}${t.badSaid ? `; then how many ${t.badSaid}, with the 95% interval` : ""}.`);

function tableBlock(t) {
  const lines = [`${t.kind === "question" ? `${t.id}  ` : ""}${clip(t.title, 400)}${t.from ? ` (${t.from})` : ""}`];
  if (t.legend) lines.push(`  ${clip(t.legend, 500)}`);
  lines.push(headerOf(t), `  All: ${row(t, t.all)}`);
  for (const split of ["journey", "segment", "situation", "reply"]) {
    const groups = t.by?.[split] ?? [];
    if (!groups.length || (split !== "reply" && groups.length === 1 && groups[0].of === t.all.of)) continue;
    lines.push(`  ${SPLIT_WORDS[split]}:`, ...groups.map((d) => `    ${clip(d.value, 90)}${d.kept ? " (kept back)" : ""}: ${row(t, d)}`));
  }
  const w = t.worst;
  if (w) {
    const e = w.exchange;
    lines.push(`  Worst: ${w.split} ${clip(w.value, 90)}.${e ? ` Trial ${e.trialId}, reply ${e.reply}.` : " Its trials are kept back."}`);
    if (e?.sent) lines.push(`    Sent: "${clip(e.sent, 300)}"`);
    if (e?.answer) lines.push(`    Reply ${e.reply}: "${clip(e.answer, 300)}"`);
    if (e?.quote && e.quote !== e.answer) lines.push(`    It broke on: "${clip(e.quote, 240)}"`);
  }
  return lines.join("\n");
}

// Every number, whole, in pages under what every client shows at once.
export function numbersText(d, page = 1) {
  const n = d?.numbers;
  if (!n) return d?.why ?? "No run has finished on this repository yet.";
  const head = [
    `Run ${n.runId}: every number it measured, ${plural(n.measures.length, "measurement")} and ${plural(n.questions.length, "question")} over ${plural(n.trials, "trial")}, ${plural(n.replies, "reply", "replies")} and ${plural(n.readings, "reading")}.`,
    "A trial counts once in each group it played in; a reply split counts each trial at that reply.",
  ].join("\n");
  const blocks = [...n.measures, ...n.questions].map(tableBlock);
  const pages = pack(head, blocks.map((b) => `\n${b}`), `Run ${n.runId}, numbers continued.`);
  return pageOf(pages, page, (k) => `findings numbers with page ${k}`);
}
