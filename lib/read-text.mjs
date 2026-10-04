import { at, clip, has, num, pack, pageOf, plural, SIDE } from "./words.mjs";

// What Cortad read of the repository: the walkthrough `status` carries, and one section in full
// for `status` with show. Both use the same lines, so the full list reads like the walkthrough.
//
// The full list comes back from GET /mcp/status?show=<name>: read.rules.all, read.machine.misses
// complete with read.machine.mets, read.journeys.all, read.doors.all, read.trials.all. Where the API
// has not sent it, what it did send is listed with "n of N listed".
// `records` lists the plain status's own `read.records`: the server sends them with every status.
// `reviews` are the two reviews the read leaves, of the prompts and of the code around the model:
// status hands them over once as news, and this lists them again.
// `machine` is what the connect command does on this machine, from the runner's record alone.
export const SHOW = ["rules", "standards", "journeys", "endpoints", "trials", "records", "reviews", "machine"];

const rulesHead = (rules) => {
  const files = Array.isArray(rules.files) ? rules.files.length : rules.files;
  return `Rules in the code: ${num(rules.count)}${has(files) ? `, in ${plural(files, "file")}` : ""}.`;
};
// What the last run found about the rule beside it; a rule it never asked is not a rule that held.
const measuredOf = (m) => (m === null ? "; asked of no reply yet" : m ? `; asked of ${plural(m.asked, "reply", "replies")}, passed in ${num(m.held)}${m.asked > m.held ? `, broke in ${num(m.asked - m.held)}` : ""}` : "");
const ruleLine = (e) => `  ${e.path ? `${at(e.path, e.line)}  ` : ""}"${clip(e.text, 300)}"${"measured" in e ? measuredOf(e.measured) : ""}`;
const headOf = (label, parts) => (parts.some(Boolean) ? `${label}: ${parts.filter(Boolean).join(", ")}.` : `${label}:`);
// "28 decided, 28 met, 0 missed, from 0 problems" was four counts for one fact.
// A review that decided nothing (it failed, or no standard applied) makes no claim: "meets all 0".
const standardsHead = (m) => (!has(m.met) || !(m.met + (m.missed ?? 0)) ? "Engineering standards:"
  : m.missed ? `Engineering standards: your code misses ${num(m.missed)} of the ${num(m.decided ?? m.met + m.missed)} Cortad checks${has(m.problems) ? `, through ${plural(m.problems, "problem")}` : ""}.`
    : `Engineering standards: your code meets all ${num(m.met)} that Cortad checks.`);
const decided = (x) => (x.decidedBy ? ` (decided by ${x.decidedBy === "code" ? "code" : "a model"})` : "");
// A miss is one problem with the standards it fails beneath it; an older API sent one standard a row.
// A problem their own documents waive says so, with the line; the server lists it last.
const designed = (x) => (x.byDesign ? `\n    By design here, per ${x.byDesign.at}: "${clip(x.byDesign.said, 200)}"` : "");
const standardLine = (x) => Array.isArray(x.standards)
  ? `  ${x.path ? `${at(x.path, x.line)}  ` : ""}${clip(x.problem, 240)}${decided(x)}${x.fix ? `\n    ${clip(x.fix, 300)}` : ""}\n    ${x.standards.length === 1 ? "Fails" : `Fails ${num(x.standards.length)}`}: ${x.standards.join("; ")}${designed(x)}`
  : `  ${x.path ? `${at(x.path, x.line)}  ` : ""}${x.standard}${x.detail ? `: ${clip(x.detail, 240)}` : ""}${decided(x)}`;
// Which trials can be played is decided when a run knocks: a read that said "21 playable, none held
// back" was followed by a run that held 28 back, and three agents called the counts contradictory.
const trialsHead = (t) => headOf("Trials", [has(t.written) && `${num(t.written)} written`]);
const heldWhy = (h) => `${SIDE[h.side] ? `, ${SIDE[h.side]}` : ""}${h.why ? `: ${clip(h.why, 300)}` : ""}`;
const named = (label, group, max = 12) => {
  if (!group) return null;
  const names = group.names ?? [];
  const more = (group.count ?? names.length) - Math.min(names.length, max);
  // A name may hold commas ("A student, Grade 10 Sem 2 (Jordan), English"): one name ends at a semicolon.
  const list = names.slice(0, max).join("; ");
  return `${label} (${num(group.count ?? names.length)})${list ? `: ${list}${more > 0 ? `; and ${more} more` : ""}` : ""}.`;
};
// "Journeys (6):" when every one is here, "Journeys (6), 4 listed:" when not.
const counted = (label, count, n) => `${label} (${num(count ?? n)})${has(count) && n < count ? `, ${num(n)} listed` : ""}:`;

// The records the app already holds, read from its own data files, that a trial may name: an agent
// that sees a trial ask about SO20260810001 can tell it is a real order, not an invented one.
// Listed with show records, never in the walkthrough: ulaim's was 45 ids in one line.
const recordLines = (records) => (records?.collections ?? []).filter((c) => c?.name && c.examples?.length)
  .map((c) => `  ${c.name}: ${c.examples.slice(0, 3).map((e) => clip(e, 40)).join(", ")}`);

// The walkthrough, in the order the person is walked through it.
// The endpoints are listed above it, proven or not reached, and the questions are the rules and
// standards counted again: neither is said here, and status with show lists every section in full.
export function readLines(r) {
  const lines = ["What Cortad read:"];
  if (r.rules) {
    const examples = (r.rules.examples ?? []).slice(0, 3);
    // "Asked of no reply yet" on each rule before any run is a fact about no run.
    const ran = has(r.rules.measured);
    lines.push(`${rulesHead(r.rules)}${examples.length ? ` ${examples.length} of them:` : ""}`, ...examples.map((e) => ruleLine(ran ? e : { text: e.text, path: e.path, line: e.line })));
  }
  for (const line of [named("Journeys", r.journeys), named("Simulated users", r.profiles)]) if (line) lines.push(line);
  const m = r.machine;
  if (m && (m.met || m.missed || (m.misses ?? []).length)) {
    const misses = m.misses ?? [];
    // "3 missed" was read off a list of three under a head that said thirteen: the list says it is a part.
    lines.push(standardsHead(m), ...(misses.length > 3 && has(m.missed) && m.missed > 3 ? [`  3 of the ${num(m.missed)} missed:`] : []), ...misses.slice(0, 3).map(standardLine));
    const more = (m.problems ?? misses.length) - Math.min(misses.length, 3);
    if (more > 0) lines.push(`  and ${plural(more, "more problem")}; status with show standards lists them all.`);
  }
  if (r.reviews?.lines.length) lines.push("The reviews of your prompts and of the code around your model are listed whole by status with show reviews.");
  // What a run plays is the quote's to say; here only conversations set aside, and why.
  const held = r.trials?.held ?? [];
  if (held.length) lines.push("Conversations set aside:", ...held.map((h) => `  ${h.surface}: ${plural(h.n, "conversation")}${heldWhy(h)}`));
  return lines.length > 1 ? lines : [];
}

// Where each coding agent keeps the entry the connect command writes for Cortad, in the home folder.
const CLIENT_FILES = { "Claude Code": "~/.claude.json", Codex: "~/.codex/config.toml", Cursor: "~/.cursor/mcp.json", Copilot: "~/.copilot/mcp-config.json" };
const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]);

// What the connect command does on this machine, from the facts it keeps in the runner's record:
// what it started and stops, the database copies, the settings its app runs with, what it loads,
// what a run holds and puts back, and what it keeps and writes outside this repository. At most
// eight lines, the two for the person first.
export function machineText(f) {
  if (!f) return ["No connect command is running for this repository now, so nothing Cortad started is running here."];
  const lines = [
    f.started
      ? `For the person: Cortad started your app with "${f.cmd}" in ${f.dir} and stops it, with everything it started for it, when you press Ctrl-C in its terminal; your code and settings files are never edited.`
      : `For the person: Cortad uses your app already running on port ${f.port} and leaves it running when you press Ctrl-C in its terminal; your code and settings files are never edited.`,
    f.copies === "made"
      ? "For the person: Where Cortad could copy a database, your app runs on the copy, made from your own at every connect and deleted when this command ends, so records created in a copy are gone at the next connect; keep records every run needs in your own database. Each Data line in status says what happens to one store."
      : "For the person: No copy of a database was made for this session, so what trials create stays where your app keeps its data; each Data line in status names one store.",
  ];
  // Env values reach only a process the command started itself.
  if (f.started) lines.push(f.changed?.length ? `Your env file values go into your app's process alone, with ${listed(f.changed)} set for this session only; no value is sent to Cortad.` : "Your env file values go into your app's process alone, unchanged; no value is sent to Cortad.");
  lines.push(f.hooked ? "A hook loaded into your app records each request that reaches a model and the model calls it makes; the sign-in each request carried is kept on this machine for the session and deleted at Ctrl-C."
    : f.proxy ? `A local proxy on port ${f.proxy} sees each request sent to it and the model calls your app makes through it; the sign-in each request carried is kept on this machine for the session and deleted at Ctrl-C.`
      : "Nothing is loaded into your app, since Cortad did not start it, so its model calls are not seen.");
  // Only the hook holds a write or records a file: through the proxy, or with nothing loaded, both go as the app does them.
  lines.push(f.hooked ? "During a run, a write your app sends to a service off this machine, such as a payment or an email, is answered inside your app and never sent, unless it carries a test key, goes to a provider's sandbox, or goes to a host you said yes to on the card; a call named as a read where every call is a POST, such as customers.get, goes out."
    : "During a run, a write your app sends to a service off this machine, such as a payment or an email, is sent for real.");
  lines.push(f.hooked ? "Files your app writes in its own folder during a run are put back when run_status reads the run's end; its log files are left as they are." : "Files your app writes in its own folder stay as it writes them.");
  lines.push("Kept between connects in ~/.cortad on this machine: this repository's key for later runs, the key the test accounts' passwords are made from, the files to put back, a list of what to undo, and your app's output from the last session with the values from your env files masked, which the next connect starts over.");
  const clients = (f.clients ?? []).filter((c) => CLIENT_FILES[c]);
  if (clients.length) lines.push(`${listed(clients)} on this machine have a Cortad entry and skill in their own settings in your home folder (${clients.map((c) => CLIENT_FILES[c]).join(", ")}); nothing in this repository was changed for them.`);
  return lines;
}

export function showText(d, show, page = 1) {
  if (!d.read || (d.read.complete === false && show !== "reviews")) return "Cortad is still reading this repository.";
  const { head, lines, continued } = sectionOf(d.read, show);
  // A heading with nothing under it ("Endpoints (0):") reads as a list that failed to print.
  const said = lines.length || !head.endsWith(":") ? head : `${head.replace(/ \(0\):$|:$/, "")}: none yet.`;
  return pageOf(pack(said, lines, continued), page, (n) => `status with show ${show} and page ${n}`);
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
        lines: [misses.length && (has(m.problems) ? counted("Problems", m.problems, misses.length) : counted("Missed", m.missed, misses.length)), ...misses.map(standardLine), mets.length && counted("Met", m.met, mets.length), ...mets.map(standardLine)].filter(Boolean),
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
    case "records":
      return recordLines(r.records).length
        ? { head: "Records the trials can name, three of each:", lines: recordLines(r.records), continued: "Records, continued." }
        : { head: "The read found no records a trial can name.", lines: [], continued: "" };
    case "reviews":
      return { head: "The reviews of your prompts and of the code around your model:", lines: r.reviews?.lines.length ? r.reviews.lines : [r.complete === false ? "Your code is still being read; the reviews come when that is done." : r.reviews ? "The read left no review of this app's prompts or code." : "This status carries no reviews."], continued: "The reviews, continued." };
    case "trials":
    default: {
      const t = r.trials ?? {};
      const all = t.all ?? (t.held ?? []).map((h) => ({ surface: h.surface, held: h.n, why: h.why, side: h.side }));
      const line = (x) => `  ${x.surface}: ${[has(x.written) && `${num(x.written)} written`, has(x.playable) && `${num(x.playable)} playable`, x.held && `${num(x.held)} set aside`].filter(Boolean).join(", ")}${x.held ? heldWhy(x) : ""}`;
      return { head: trialsHead(t), lines: all.map(line), continued: "Trials, continued." };
    }
  }
}
