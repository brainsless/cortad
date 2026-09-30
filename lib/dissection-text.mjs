import { clip, has, num, plural } from "./words.mjs";

// A finished run's dissection, as the server cut it (world-agent/dissection.ts): the run in a line,
// what only running the app showed, what a code review would also have found, the gates a knock
// found open, then what was held, not measured, and what the next run is paired against.

// The findings printed whole, in the server's order, leaders first; the rest get a line each, so the
// plan line and the next call at the end stay inside the page a client shows (PAGE_CHARS).
const WHOLE_CHARS = 4500;
// A quoted reply can hold a block of many lines; a finding's lines stay one line each.
const flat = (s, n) => clip(String(s).replace(/\s+/g, " ").trim(), n);

const LAYER_NAMES = { prompt: "prompt", flow: "flow around the model", tool: "tool", routing: "routing", limit: "model's output cap" };

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
  if (p.harm) lines.push(`  Harm: ${p.harm}.`);
  if (p.standing) lines.push(`  ${p.standing}`);
  if (p.at) lines.push(`  At ${p.at}`);
  if (p.step) lines.push(`  Written by: ${p.step.replace(/^written by /, "")}.`);
  if (p.tools) lines.push(`  Tools behind the quoted replies: ${p.tools.length ? p.tools.join(", ") : "none"}.`);
  if (p.neverRan?.length) lines.push(`  Needed by these asks and never run: ${p.neverRan.join(", ")}.`);
  if (p.layer) lines.push(`  Fix in the ${LAYER_NAMES[p.layer.name] ?? p.layer.name}: ${p.layer.said}.`);
  const e = p.exchange;
  if (e?.sent) lines.push(`  Sent: "${flat(e.sent, 200)}"`);
  if (e?.broke) lines.push(`  Broke on: "${flat(e.broke, 240)}"`);
  if (e?.after) lines.push(`  Then: "${flat(e.after, 200)}"`);
  if (e?.note) lines.push(`    ${e.note}`);
  // Where a fix belongs, not read: said after the exchange, never as a fix.
  if (p.note) lines.push(`  ${p.note}`);
  if (p.verify) lines.push(`  ${p.verify}`);
  return lines;
}

export function dissectionLines(d) {
  if (!d?.run) return [];
  const lines = [...headLines(d)];
  const room = { left: WHOLE_CHARS, short: 0 };
  const parts = (ps) => ps.flatMap((p) => partOrLine(p, room));
  if (d.runOnly?.length) lines.push("Found only by running your app:", ...parts(d.runOnly));
  else lines.push("Nothing broke that only running your app could show.");
  lines.push(...(d.also ?? []));
  if (d.inCode?.length) lines.push("Also in the code; a code review would also find these:", ...parts(d.inCode));
  if (d.gates?.length) lines.push("Open gates, found by knocking your app's routes:", ...parts(d.gates));
  if (room.short) lines.push(`findings shows the last ${plural(room.short, "finding")} whole.`);
  for (const s of [d.held, d.notMeasured, d.next]) if (s) lines.push(s);
  return lines;
}

function partOrLine(p, room) {
  const whole = partLines(p);
  const size = whole.join("\n").length;
  if (!room.short && size <= room.left) {
    room.left -= size;
    return whole;
  }
  room.short += 1;
  return [`${p.id}  ${flat(p.asks, 140)} Reach: ${p.reach}.`];
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
