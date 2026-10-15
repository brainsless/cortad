import { execFileSync } from "node:child_process";

// Their commit history, read here and sent after the code: the commits since the newest one Cortad
// holds, oldest first, each with its message, author, dates and the paths it moved, and for the
// newest ones a diff cut to the files this program would upload anyway, with any line that carries
// a key replaced before it leaves. Git never reaches the network for this: lazy fetching is off and
// every call has a time limit, so a blobless clone sends its messages without stats or diffs.

export const LIMITS = {
  // Commits sent when nothing is held yet, or when the held tip is no longer behind HEAD.
  commits: 2000,
  // The newest commits of an upload that carry a diff.
  diffs: 200,
  // A diff larger than this, after filtering, is reported by size and not sent.
  diffBytes: 256_000,
  // All diffs of one upload together; the oldest are dropped first.
  diffTotal: 6_000_000,
  // One request to the server, under its limit.
  partBytes: 1_500_000,
  messageChars: 4000,
  paths: 2000,
};

const SHA = /^[0-9a-f]{40}$/;
const HEADER = /[0-9a-f]{40}\x1f/;
const FORMAT = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%B%x1e";
// GIT_NO_LAZY_FETCH is read by git 2.44 and later; the time limit covers the rest.
const ENV = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

const git = (root, args, maxBuffer = 256 * 1024 * 1024) =>
  execFileSync("git", ["-C", root, ...args], { env: ENV, stdio: ["ignore", "pipe", "ignore"], maxBuffer, timeout: 30_000 }).toString("utf8");

export function headOf(root) {
  try { const sha = git(root, ["rev-parse", "HEAD"]).trim(); return SHA.test(sha) ? sha : null; } catch { return null; }
}

// Everything after `since` while it is still behind HEAD; the newest commits when nothing is held
// or history was rewritten under it.
export function rangeOf(root, since) {
  if (since && SHA.test(since)) {
    try { git(root, ["merge-base", "--is-ancestor", since, "HEAD"]); return `${since}..HEAD`; } catch { /* unknown here, or rewritten */ }
  }
  return "HEAD";
}

// A rename as numstat writes it, read as the path it ended at: "{a => b}/x", "a => b".
export const renamedTo = (path) => path.replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2").replace(/^[^{]* => /, "").replace(/\/{2,}/g, "/");

function statsOf(text) {
  const changed = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) changed.push({ path: renamedTo(m[3]), added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2]) });
  }
  return changed;
}

// The commits of a range, oldest first, each with the paths it moved that `keep` allows; the rest
// are counted as hidden. One git call for everything; when the stats cannot be read without the
// network, the commits are sent without them.
export function listCommits(root, range, { keep, limit = LIMITS.commits }) {
  let out;
  let withStats = true;
  try { out = git(root, ["log", `-${limit}`, FORMAT, "--numstat", "-M", range]); } catch {
    withStats = false;
    try { out = git(root, ["log", `-${limit}`, FORMAT, range]); } catch { return { commits: [], withStats: false }; }
  }
  const segments = out.split("\x1e");
  const commits = [];
  let header = segments[0] ?? "";
  for (let i = 1; i <= segments.length; i += 1) {
    const rest = segments[i] ?? "";
    const at = rest.search(HEADER);
    const stats = at < 0 ? rest : rest.slice(0, at);
    const [sha, parents = "", name = "", email = "", authoredAt = "", committedAt = "", ...body] = header.replace(/^\n+/, "").split("\x1f");
    if (SHA.test(sha ?? "")) {
      const all = statsOf(stats);
      const shown = all.filter((c) => keep(c.path));
      commits.push({
        sha,
        parents: parents.split(" ").filter((p) => SHA.test(p)),
        author: { name: name.slice(0, 200), email: email.slice(0, 320) },
        authoredAt, committedAt,
        message: body.join("\x1f").trimEnd().slice(0, LIMITS.messageChars),
        stats: { files: all.length, insertions: all.reduce((n, c) => n + (c.added ?? 0), 0), deletions: all.reduce((n, c) => n + (c.deleted ?? 0), 0) },
        changed: shown.slice(0, LIMITS.paths),
        hidden: all.length - shown.length,
        stripped: 0,
      });
    }
    if (at < 0) break;
    header = rest.slice(at);
  }
  commits.reverse();
  return { commits, withStats };
}

// git writes a path with unusual characters C-quoted; a plain one as it is.
const unquote = (path) => (path.startsWith('"') && path.endsWith('"') ? JSON.parse(path) : path);

// The two paths of one file's diff: before and after. A rename with no edit has only the rename lines.
function pathsOf(file) {
  const line = (re) => { const m = re.exec(file); return m ? unquote(m[1]) : null; };
  const head = /^diff --git a\/(.*) b\/(.*)$/m.exec(file);
  const a = line(/^--- a\/(.*)$/m) ?? line(/^rename from (.*)$/m) ?? line(/^copy from (.*)$/m) ?? (head ? unquote(head[1]) : null);
  const b = line(/^\+\+\+ b\/(.*)$/m) ?? line(/^rename to (.*)$/m) ?? line(/^copy to (.*)$/m) ?? (head ? unquote(head[2]) : null);
  return { a, b };
}

const HELD = "[line held back on this machine: it carries a key]";

// A patch cut to the files `keep` allows, every added or removed line that carries a key replaced.
// A patch that grows past the limit is given up at that point: `over` says so, and no line of it
// is read for keys, since the key detector works line by line and a generated file's one long
// line would cost minutes.
export function filterDiff(patch, keep, holdsKey, limit = LIMITS.diffBytes) {
  let stripped = 0;
  let bytes = 0;
  const kept = [];
  for (const file of patch.split(/^(?=diff --git )/m)) {
    if (!file.startsWith("diff --git ")) continue;
    const { a, b } = pathsOf(file);
    if (!a || !b || !keep(a) || !keep(b)) continue;
    bytes += Buffer.byteLength(file);
    if (bytes > limit) return { diff: "", stripped: 0, over: true, bytes: Buffer.byteLength(patch) };
    kept.push(file.split("\n").map((line) => {
      const sign = line[0];
      if ((sign === "+" || sign === "-") && !/^(\+\+\+|---) /.test(line) && holdsKey(line.slice(1))) { stripped += 1; return sign + HELD; }
      return line;
    }).join("\n"));
  }
  const diff = kept.join("");
  return { diff, stripped, over: false, bytes: Buffer.byteLength(diff) };
}

// The newest commits' diffs in one git call, by sha. A diff over the limit is reported by size and
// not carried; when all of them weigh more than an upload may, the oldest lose theirs first.
export function diffsOf(root, range, count, { keep, holdsKey }) {
  const diffs = new Map();
  if (count <= 0) return diffs;
  let out;
  try { out = git(root, ["log", `-${count}`, "-p", "--no-color", "--no-ext-diff", "-M", "--format=%x1eCOMMIT %H", range]); } catch { return diffs; }
  for (const chunk of out.split("\x1eCOMMIT ")) {
    const sha = chunk.slice(0, 40);
    if (!SHA.test(sha)) continue;
    const { diff, stripped, over, bytes } = filterDiff(chunk.slice(41), keep, holdsKey);
    diffs.set(sha, over || !diff ? { bytes, stripped } : { bytes, stripped, diff });
  }
  // git listed the newest first; the oldest give up their diff first.
  let total = 0;
  for (const held of diffs.values()) {
    if (!held.diff) continue;
    total += held.bytes;
    if (total > LIMITS.diffTotal) delete held.diff;
  }
  return diffs;
}

// A remote address with any credential removed; an scp-like address carries none.
export function safeRemote(url) {
  if (!url) return null;
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300); } catch { return /^[\w.-]+@[\w.-]+:/.test(url) ? url.slice(0, 300) : null; }
}

// What the repository is: where it pushes, which branch, how many have written to it, when it began.
export function repoFacts(root) {
  const read = (args, f = (s) => s.trim()) => { try { return f(git(root, args)); } catch { return null; } };
  const facts = {
    remote: safeRemote(read(["config", "--get", "remote.origin.url"])),
    branch: read(["rev-parse", "--abbrev-ref", "HEAD"], (s) => s.trim().slice(0, 200)),
    contributors: read(["log", "-5000", "--format=%ae"], (s) => new Set(s.split("\n").filter(Boolean)).size),
    firstCommitAt: read(["log", "--format=%cI"], (s) => s.trim().split("\n").at(-1) || null),
  };
  return Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== null && v !== undefined));
}

// The commits to send, with the newest ones' diffs attached, cut into parts under the request limit.
export function historyParts(root, since, { keep, holdsKey }) {
  const range = rangeOf(root, since);
  const { commits } = listCommits(root, range, { keep });
  if (!commits.length) return [];
  const diffs = diffsOf(root, range, Math.min(commits.length, LIMITS.diffs), { keep, holdsKey });
  for (const c of commits) {
    const held = diffs.get(c.sha);
    if (!held) continue;
    c.stripped = held.stripped;
    c.diffBytes = held.bytes;
    if (held.diff) c.diff = held.diff;
  }
  const parts = [];
  let part = [];
  let bytes = 0;
  for (const c of commits) {
    const size = JSON.stringify(c).length;
    if (part.length && bytes + size > LIMITS.partBytes) { parts.push(part); part = []; bytes = 0; }
    part.push(c);
    bytes += size;
  }
  parts.push(part);
  return parts;
}
