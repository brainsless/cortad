import { at, clip, has, num, pack, pageOf, plural, SIDE } from "./words.mjs";

// What Cortad read of the repository: the walkthrough `status` carries, and one section in full
// for `status` with show. Both use the same lines, so the full list reads like the walkthrough.
//
// The full list comes back from GET /mcp/status?show=<name>: read.rules.all, read.machine.misses
// complete with read.machine.mets, read.journeys.all, read.doors.all, read.trials.all. Where the API
// has not sent it, what it did send is listed with "n of N listed".
export const SHOW = ["rules", "standards", "journeys", "endpoints", "trials"];

const rulesHead = (rules) => {
  const files = Array.isArray(rules.files) ? rules.files.length : rules.files;
  return `Rules in the code: ${num(rules.count)}${has(files) ? `, in ${plural(files, "file")}` : ""}.`;
};
const ruleLine = (e) => `  ${at(e.path, e.line)}  "${clip(e.text, 300)}"`;
const headOf = (label, parts) => (parts.some(Boolean) ? `${label}: ${parts.filter(Boolean).join(", ")}.` : `${label}:`);
const standardsHead = (m) => headOf("Engineering standards", [has(m.decided) && `${num(m.decided)} decided`, has(m.met) && `${num(m.met)} met`, has(m.missed) && `${num(m.missed)} missed`]);
const standardLine = (x) => `  ${x.path ? `${at(x.path, x.line)}  ` : ""}${x.standard}${x.detail ? `: ${clip(x.detail, 240)}` : ""}${x.decidedBy ? ` (decided by ${x.decidedBy === "code" ? "code" : "a model"})` : ""}`;
const trialsHead = (t) => headOf("Trials", [has(t.written) && `${num(t.written)} written`, has(t.playable) && `${num(t.playable)} playable`]);
const heldWhy = (h) => `${SIDE[h.side] ? `, ${SIDE[h.side]}` : ""}${h.why ? `: ${clip(h.why, 300)}` : ""}`;
const named = (label, group, max = 12) => {
  if (!group) return null;
  const names = group.names ?? [];
  const more = (group.count ?? names.length) - Math.min(names.length, max);
  const list = names.slice(0, max).join(", ");
  return `${label} (${num(group.count ?? names.length)})${list ? `: ${list}${more > 0 ? `, and ${more} more` : ""}` : ""}.`;
};
// "Journeys (6):" when every one is here, "Journeys (6), 4 listed:" when not.
const counted = (label, count, n) => `${label} (${num(count ?? n)})${has(count) && n < count ? `, ${num(n)} listed` : ""}:`;

// The walkthrough, in the order the person is walked through it.
export function readLines(r) {
  const lines = ["What Cortad read:"];
  if (r.rules) {
    const examples = (r.rules.examples ?? []).slice(0, 3);
    lines.push(`${rulesHead(r.rules)}${examples.length ? ` ${examples.length} of them:` : ""}`, ...examples.map(ruleLine));
  }
  for (const line of [named("Journeys", r.journeys), named("Simulated users", r.profiles), named("Endpoints", r.doors)]) if (line) lines.push(line);
  const m = r.machine;
  if (m) {
    const misses = m.misses ?? [];
    lines.push(standardsHead(m), ...misses.slice(0, 12).map(standardLine));
    if (misses.length > 12) lines.push(`  and ${misses.length - 12} more.`);
  }
  const q = r.questions;
  if (q) lines.push(`Questions: ${num(q.total)}${has(q.everywhere) ? `; ${num(q.everywhere)} asked in every conversation` : ""}${has(q.placed) ? `, ${num(q.placed)} placed in the situations they fit` : ""}.`);
  const t = r.trials;
  if (t) lines.push(trialsHead(t), ...(t.held ?? []).map((h) => `  ${h.surface}: ${plural(h.n, "trial")} held back${heldWhy(h)}`));
  return lines;
}

export function showText(d, show, page = 1) {
  if (!d.read) return "Cortad is still reading this repository.";
  const { head, lines, continued } = sectionOf(d.read, show);
  return pageOf(pack(head, lines, continued), page, (n) => `status with show ${show} and page ${n}`);
}

function sectionOf(r, show) {
  switch (show) {
    case "rules": {
      const rules = r.rules ?? { count: 0 };
      const all = rules.all ?? rules.examples ?? [];
      return { head: `${rulesHead(rules)}${all.length < rules.count ? ` ${num(all.length)} of ${num(rules.count)} listed.` : ""}`, lines: all.map(ruleLine), continued: "Rules in the code, continued." };
    }
    case "standards": {
      const m = r.machine ?? {};
      const misses = m.misses ?? [];
      const mets = m.mets ?? [];
      return {
        head: standardsHead(m),
        lines: [misses.length && counted("Missed", m.missed, misses.length), ...misses.map(standardLine), mets.length && counted("Met", m.met, mets.length), ...mets.map(standardLine)].filter(Boolean),
        continued: "Engineering standards, continued.",
      };
    }
    case "journeys": {
      const all = r.journeys?.all ?? (r.journeys?.names ?? []).map((name) => ({ name }));
      return { head: counted("Journeys", r.journeys?.count, all.length), lines: all.map((j) => `  ${j.name}${j.steps?.length ? `: ${clip(j.steps.join("; "), 600)}` : ""}`), continued: "Journeys, continued." };
    }
    case "endpoints": {
      const all = r.doors?.all ?? (r.doors?.names ?? []).map((name) => ({ name }));
      return { head: counted("Endpoints", r.doors?.count, all.length), lines: all.map((e) => `  ${e.name}${e.path ? `: ${[e.method, e.path].filter(Boolean).join(" ")}` : ""}`), continued: "Endpoints, continued." };
    }
    case "trials":
    default: {
      const t = r.trials ?? {};
      const all = t.all ?? (t.held ?? []).map((h) => ({ surface: h.surface, held: h.n, why: h.why, side: h.side }));
      const line = (x) => `  ${x.surface}: ${[has(x.written) && `${num(x.written)} written`, has(x.playable) && `${num(x.playable)} playable`, x.held && `${num(x.held)} held back`].filter(Boolean).join(", ")}${x.held ? heldWhy(x) : ""}`;
      return { head: trialsHead(t), lines: all.map(line), continued: "Trials, continued." };
    }
  }
}
