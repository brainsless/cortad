// What the agent reads back from the Intelligence Layer's tools, as plain lines: numbers, ids and
// the cause, never a user's words.

const n = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? 0));
const when = (iso) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z" : "");

export function incidentLine(i) {
  const where = i.segment ? (i.segment.kind === "country" ? ` from ${i.segment.value}` : ` on release ${i.segment.value}`) : "";
  const cause = i.cause ? `; the change was ${i.cause.kind} ${i.cause.value ?? ""}`.trimEnd() + (i.cause.at ? ` at ${when(i.cause.at)}` : "") : "";
  return `Since ${when(i.since)}, ${i.kind === "reaction" ? `people${where} reacted "${i.key}" after` : `replies${where} broke "${i.key}" in`} ${n(i.now.broke)} of ${n(i.now.of)}; before, ${n(i.before.broke)} of ${n(i.before.of)}${cause}.`;
}

export function intelligenceText(d) {
  const lines = [];
  lines.push(d.wrong?.length ? `Wrong now: ${d.wrong.length}.` : "Nothing is wrong right now.");
  for (const i of d.wrong ?? []) lines.push(`- ${incidentLine(i)}`);
  const t = d.conversations ?? {};
  lines.push(`Last ${d.days} days: ${n(t.n)} conversations, ${n(t.read)} read, ${n(t.heldEvery)} kept every rule, ${n(t.got)} got what they came for, ${n(t.frustrated)} frustrated, ${n(t.wantsHuman)} asked for a person.`);
  if (d.visits?.n) {
    const r = d.visits.reactions ?? {};
    lines.push(`Visits: ${n(d.visits.n)}; after answers people ${Object.entries(r).filter(([k]) => k !== "waited").map(([k, v]) => `${k} ${n(v)}`).join(", ") || "reacted to nothing yet"} (of ${n(r.waited)} answers seen).`);
  }
  if (d.checks?.length) lines.push(`Checks broken most: ${d.checks.filter((c) => c.broke).sort((a, b) => b.broke - a.broke).slice(0, 5).map((c) => `${c.id} ${n(c.broke)} of ${n(c.held + c.broke)}`).join("; ") || "none"}.`);
  lines.push(`The page: ${d.url}`);
  return lines.join("\n");
}

export function incidentsText(d) {
  if (!d.open?.length) return `${d.said ?? "Nothing is wrong right now."}\n${d.url}`;
  return [...d.open.map((i) => `${incidentLine(i)} Conversations: ${(i.conversations ?? []).join(", ")}`), d.said, d.url].filter(Boolean).join("\n");
}

const ruleWords = (r) => r.kind === "path" ? `a page ${r.match} ${r.value}` : r.kind === "click" ? `a click on ${r.text ? `"${r.text}"` : r.selector}` : r.kind === "event" ? `the page's event "${r.name}"` : `the backend's outcome "${r.name}"`;

export function outcomesText(d) {
  if (d.proposed !== undefined) return `${n(d.proposed)} proposed. ${d.awaiting}`;
  if (!d.outcomes?.length) return `No outcome is defined yet. Propose what the code treats as a good ending (a signup route, a checkout, a "done" button) with outcomes {proposals: [{name, rules, why}]}; ${d.shape}`;
  return [...d.outcomes.map((o) => `${o.approved ? "Counted" : "Proposed, awaiting the person"}: ${o.name}: ${o.rules.map(ruleWords).join(", or ")}${o.why ? ` (${o.why})` : ""}`), d.url].join("\n");
}

export function queryText(d) {
  if (d.error) return `${d.error}${d.sql ? `\n${d.sql}` : ""}`;
  const rows = d.rows ?? [];
  if (rows.length === 0) return `No rows.\n${d.sql}`;
  const keys = Object.keys(rows[0]);
  return [keys.join("\t"), ...rows.slice(0, 200).map((r) => keys.map((k) => String(r[k] ?? "")).join("\t")), rows.length > 200 ? `${rows.length - 200} more rows` : "", d.scannedBytes != null ? `Scanned ${n(d.scannedBytes)} bytes.` : ""].filter(Boolean).join("\n");
}
