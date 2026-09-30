import { clip, has, num, plural } from "./words.mjs";

// A finished run's dissection, as the server cut it (world-agent/dissection.ts): the run in a line,
// what only running the app showed, what a code review would also have found, then what was held,
// not measured, and what the next run is paired against.

const LAYER_NAMES = { prompt: "prompt", flow: "flow around the model", tool: "tool", routing: "routing" };

// "9 min 40 s", "45 s".
export const durationSaid = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

// What the run cost on their key and how long it took, in one sentence; empty when neither was measured.
export function costSaid(d) {
  const parts = [has(d.durationS) && `took ${durationSaid(d.durationS)}`, d.spent && spentSaid(d.spent)].filter(Boolean);
  return parts.length ? `The run ${parts.join(" and ")}.` : "";
}

const spentSaid = (s) => (has(s.usd)
  ? `spent $${s.usd.toFixed(2)} on your key over ${plural(s.calls, "model call")}`
  : `made ${plural(s.calls, "model call")} on your key, not all of them priced`);

function headLines(d) {
  const r = d.run;
  // The trials played are the run's own first line; this says what they ran on and what they cost.
  const head = [r.model && `Your app answered on ${r.model}.`, costSaid(r)].filter(Boolean).join(" ");
  const lines = head ? [head] : [];
  if (r.replies?.n && has(r.replies.medianS)) lines.push(`Replies took ${r.replies.medianS} s at the median and ${r.replies.slowestS} s at the slowest, over ${plural(r.replies.n, "reply", "replies")}.`);
  const t = d.tools;
  if (t) lines.push(`${num(t.ran)} of ${plural(t.offered, "tool")} your app offers its model ran${t.neverRan.length ? `; never ran: ${t.neverRan.join(", ")}` : ""}.`);
  return lines;
}

function partLines(p) {
  const lines = [`${p.id}  ${p.asks}`, `  Reach: ${p.reach}.`];
  if (p.standing) lines.push(`  ${p.standing}`);
  if (p.at) lines.push(`  At ${p.at}`);
  if (p.step) lines.push(`  Written by: ${p.step.replace(/^written by /, "")}.`);
  if (p.tools) lines.push(`  Tools behind the quoted replies: ${p.tools.length ? p.tools.join(", ") : "none"}.`);
  if (p.layer) lines.push(`  Fix in the ${LAYER_NAMES[p.layer.name] ?? p.layer.name}: ${p.layer.said}.`);
  const e = p.exchange;
  if (e?.sent) lines.push(`  Sent: "${clip(e.sent, 200)}"`);
  if (e?.broke) lines.push(`  Broke on: "${clip(e.broke, 240)}"`);
  if (e?.note) lines.push(`    ${e.note}`);
  if (p.verify) lines.push(`  ${p.verify}`);
  return lines;
}

export function dissectionLines(d) {
  if (!d?.run) return [];
  const lines = [...headLines(d)];
  if (d.runOnly?.length) lines.push("Found only by running your app:", ...d.runOnly.flatMap(partLines));
  else lines.push("Nothing broke that only running your app could show.");
  lines.push(...(d.also ?? []));
  if (d.inCode?.length) lines.push("Also in the code; a code review would also find these:", ...d.inCode.flatMap(partLines));
  for (const s of [d.held, d.notMeasured, d.next]) if (s) lines.push(s);
  return lines;
}

// A verify's plan says the same clause on every finding; a page says it once.
const BOILER = / word for word((?:, and [\d,]+ held-out trials? once)?), round after round until it decides, up to [\d,]+ replays/g;
export function verifyOnceAPage(page) {
  let first = true;
  return page.replace(BOILER, (all, held) => {
    if (!first) return held;
    first = false;
    return all;
  });
}
