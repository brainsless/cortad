// The one door a change to your files goes through. Nothing else in this program can write inside
// your repository: the shell it runs for a world is locked by the operating system, and every edit
// arrives here. Before a byte changes, what was there is saved outside the project, so any change
// can be put back and nothing here ever touches git: no commit, no stage, no stash, no branch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Never written, whoever asks: environments, keys, git's own data, and dependencies.
const ENV_FILE = /^\.env(\..*)?$/;
const KEY_FILE = /^(?:id_(?:rsa|ed25519|ecdsa).*|.*\.(?:pem|key|p12|pfx|jks|keystore)|\.npmrc|\.netrc|\.pypirc)$/;
const CLOSED_DIR = new Set([".git", "node_modules", ".ssh", ".aws", ".gnupg"]);

export function openDoor(root, { store = join(homedir(), ".cortad", "checkpoints") } = {}) {
  const realRoot = realpathSync(root);
  const dir = join(store, sha(realRoot).slice(0, 16));
  const blobs = join(dir, "blobs");
  const journalFile = join(dir, "journal.json");
  mkdirSync(blobs, { recursive: true });
  let journal = { seq: 0, entries: [] };
  try { journal = JSON.parse(readFileSync(journalFile, "utf8")); } catch { /* first session here */ }
  const save = () => { const tmp = `${journalFile}.${process.pid}`; writeFileSync(tmp, JSON.stringify(journal)); renameSync(tmp, journalFile); };

  // Where a path really lands, or why it is refused. Decided on the real filesystem, not on how the
  // path is spelled: a link inside the repository that points out of it is a way out of it.
  function target(path) {
    const abs = resolve(realRoot, String(path ?? ""));
    if (abs !== realRoot && !abs.startsWith(realRoot + sep)) return { ok: false, why: "outside your repository" };
    const rel = relative(realRoot, abs);
    if (!rel) return { ok: false, why: "not a file" };
    const parts = rel.split(sep);
    if (parts.some((p) => CLOSED_DIR.has(p))) return { ok: false, why: `inside ${parts.find((p) => CLOSED_DIR.has(p))}, which is never edited` };
    const leaf = parts.at(-1);
    if (ENV_FILE.test(leaf)) return { ok: false, why: "an environment file, which is never edited" };
    if (KEY_FILE.test(leaf)) return { ok: false, why: "a key or credential file, which is never edited" };
    let standing = abs;
    while (!existsSync(standing)) standing = dirname(standing);
    const landed = realpathSync(standing);
    if (landed !== realRoot && !landed.startsWith(realRoot + sep)) return { ok: false, why: "a link that leads outside your repository" };
    if (existsSync(abs) || isLink(abs)) {
      const info = lstatSync(abs);
      // A link or a hard-linked file cannot be put back faithfully, so it is never changed.
      if (info.isSymbolicLink()) return { ok: false, why: "a symbolic link" };
      if (!info.isFile()) return { ok: false, why: "not a regular file" };
      if (info.nlink > 1) return { ok: false, why: "hard-linked to another file" };
    }
    return { ok: true, abs, rel: parts.join("/") };
  }
  const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

  // Written beside the file and moved into place, so a failure leaves the original standing.
  function place(abs, bytes, mode) {
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.${basename(abs)}.bl-${process.pid}-${journal.seq}`);
    writeFileSync(tmp, bytes, { flag: "wx", mode });
    try { renameSync(tmp, abs); } catch (err) { rmSync(tmp, { force: true }); throw err; }
  }

  function write(path, bytes, { checkpoint = "manual", append = false, exclusive = false } = {}) {
    const t = target(path);
    if (!t.ok) return { success: false, stderr: `refused: ${path} is ${t.why}` };
    const existed = existsSync(t.abs);
    if (exclusive && existed) return { success: false, stderr: `refused: ${t.rel} already exists` };
    const before = existed ? readFileSync(t.abs) : null;
    const mode = existed ? lstatSync(t.abs).mode & 0o777 : 0o644;
    const next = append && before ? Buffer.concat([before, bytes]) : bytes;
    // The first touch inside a checkpoint holds the true "before"; later touches only move "after".
    let entry = journal.entries.find((e) => e.checkpoint === checkpoint && e.rel === t.rel);
    if (!entry) {
      journal.seq += 1;
      entry = { seq: journal.seq, checkpoint, rel: t.rel, existed, mode, blob: existed ? `${journal.seq}.before` : null, afterHash: null, at: new Date().toISOString() };
      if (before) writeFileSync(join(blobs, entry.blob), before);
      journal.entries.push(entry);
      save();
    }
    try { place(t.abs, next, mode); } catch (err) { return { success: false, stderr: `could not write ${t.rel}: ${err.code ?? err.message}` }; }
    entry.afterHash = sha(next);
    save();
    return { success: true, stderr: "" };
  }

  const currentHash = (abs) => (existsSync(abs) && !isLink(abs) ? sha(readFileSync(abs)) : null);

  // What is pending, as a person would ask it: which files, how much, and whether they have since
  // edited one themselves (in which case putting it back would erase their work, so it is said).
  function changes() {
    const byPath = new Map();
    for (const e of journal.entries) if (!byPath.has(e.rel)) byPath.set(e.rel, { first: e, last: e }); else byPath.get(e.rel).last = e;
    const files = [...byPath.entries()].map(([rel, { first, last }]) => {
      const abs = join(realRoot, rel);
      const counts = lineCounts(first.blob ? join(blobs, first.blob) : null, existsSync(abs) ? abs : null);
      return { path: rel, status: first.existed ? "modified" : "added", ...counts, conflict: currentHash(abs) !== last.afterHash };
    });
    const checkpoints = [];
    for (const e of journal.entries) {
      const held = checkpoints.find((c) => c.id === e.checkpoint);
      if (held) { if (!held.paths.includes(e.rel)) held.paths.push(e.rel); } else checkpoints.push({ id: e.checkpoint, at: e.at, paths: [e.rel] });
    }
    return { files, checkpoints };
  }

  // Back to how things stood before a checkpoint: that change and everything after it, newest
  // first. A file they edited after the change is left exactly as it is, and named.
  function restore(checkpoint) {
    const from = journal.entries.findIndex((e) => e.checkpoint === checkpoint);
    if (from < 0) return { restored: [], skipped: [], missing: true };
    const restored = [];
    const skipped = [];
    const blocked = new Set();
    const kept = journal.entries.slice(0, from);
    const stay = [];
    for (const e of journal.entries.slice(from).reverse()) {
      if (blocked.has(e.rel)) { stay.unshift(e); continue; }
      const t = target(e.rel);
      const why = !t.ok ? `it is now ${t.why}` : currentHash(t.abs) !== e.afterHash ? "you changed it after this edit, so it was left as it is" : null;
      if (why) { blocked.add(e.rel); skipped.push({ path: e.rel, why }); stay.unshift(e); continue; }
      if (e.existed) place(t.abs, readFileSync(join(blobs, e.blob)), e.mode); else unlinkSync(t.abs);
      if (e.blob) rmSync(join(blobs, e.blob), { force: true });
      if (!restored.includes(e.rel)) restored.push(e.rel);
    }
    journal.entries = [...kept, ...stay];
    save();
    return { restored, skipped };
  }

  // Accepted: the change stays and the way back is let go. Up to a checkpoint, or everything.
  function keep(checkpoint) {
    let upTo = journal.entries.length;
    if (checkpoint) { const last = journal.entries.map((e) => e.checkpoint).lastIndexOf(checkpoint); if (last < 0) return { kept: 0, missing: true }; upTo = last + 1; }
    const gone = journal.entries.slice(0, upTo);
    for (const e of gone) if (e.blob) rmSync(join(blobs, e.blob), { force: true });
    journal.entries = journal.entries.slice(upTo);
    save();
    return { kept: new Set(gone.map((e) => e.rel)).size };
  }

  // One pending file, before and after, as the unified diff an editor would show. "Before" is how
  // the file stood ahead of the first change still pending, so several edits read as one.
  function diff(path) {
    const rel = String(path ?? "").replace(/^\/+/, "");
    const first = journal.entries.find((e) => e.rel === rel);
    if (!first) return { diff: "", missing: true };
    const abs = join(realRoot, rel);
    try {
      const out = spawnDiff(first.blob ? join(blobs, first.blob) : "/dev/null", existsSync(abs) ? abs : "/dev/null", ["-u", "--label", `a/${rel}`, "--label", `b/${rel}`]);
      return { diff: out.slice(0, 120_000), truncated: out.length > 120_000 };
    } catch { return { diff: "", missing: true }; }
  }

  return { target, write, changes, restore, keep, diff, pending: () => new Set(journal.entries.map((e) => e.rel)).size };
}

// Lines added and removed, from the system's own diff. Null when it cannot say.
function lineCounts(beforeFile, afterFile) {
  try {
    const out = spawnDiff(beforeFile ?? "/dev/null", afterFile ?? "/dev/null");
    let added = 0; let removed = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    return { added, removed };
  } catch { return { added: null, removed: null }; }
}
function spawnDiff(a, b, flags = ["-U0"]) {
  try { return execFileSync("diff", [...flags, a, b], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); }
  catch (err) { if (err.status === 1 && typeof err.stdout === "string") return err.stdout; throw err; }
}
