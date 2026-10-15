import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { holdsKeys } from "./keys.mjs";
import { diffsOf, filterDiff, headOf, historyParts, LIMITS, listCommits, rangeOf, renamedTo, repoFacts, safeRemote } from "./commits.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_NAME: "Dana Dev", GIT_AUTHOR_EMAIL: "dana@example.test", GIT_COMMITTER_NAME: "Dana Dev", GIT_COMMITTER_EMAIL: "dana@example.test", GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z" } }).toString().trim();

// The rules the connector applies to every file that leaves: env files and keys stay.
const ENV_OR_KEY = /^\.env(\..*)?$|\.(pem|key)$/;
const keep = (rel) => !ENV_OR_KEY.test(rel.split("/").at(-1));
const holdsKey = (line) => holdsKeys(line, ["supersecretvalue1234567890"]);

function repo() {
  const root = mkdtempSync(join(tmpdir(), "cortad-commits-"));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git(root, "init", "-q", "-b", "main");
  put("src/app.js", "console.log(1)\n");
  put(".env", "OPENAI_API_KEY=sk-live-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1234\n");
  put("prompts/system.md", "Answer in one line.\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "First: the app, its prompt and its env");
  put("src/app.js", "console.log(2)\nconst key = 'sk-proj-aB3dE6fG9hJ2kL5mN8pQ1rS4tU7vW0xY3zA6bC9d';\nconst other = 'supersecretvalue1234567890';\n");
  put("prompts/system.md", "Answer in one line.\nNever promise a refund.\n");
  put(".env", "OPENAI_API_KEY=sk-live-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb5678\n");
  put("certs/server.key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Second: a rule, a key in code, a new env value\n\nThe body says why.");
  git(root, "mv", "prompts/system.md", "prompts/answerer.md");
  git(root, "commit", "-q", "-m", "Third: the prompt moves");
  return root;
}

test("every commit is listed oldest first with its message, author, dates and the paths it moved; env and key files are counted, never named", () => {
  const root = repo();
  try {
    const { commits, withStats } = listCommits(root, rangeOf(root, null), { keep });
    assert.equal(withStats, true);
    assert.equal(commits.length, 3);
    assert.deepEqual(commits.map((c) => c.message.split("\n")[0]), ["First: the app, its prompt and its env", "Second: a rule, a key in code, a new env value", "Third: the prompt moves"]);
    assert.equal(commits[1].message, "Second: a rule, a key in code, a new env value\n\nThe body says why.");
    assert.deepEqual(commits[0].parents, []);
    assert.deepEqual(commits[1].parents, [commits[0].sha]);
    assert.equal(commits[0].author.email, "dana@example.test");
    assert.equal(Date.parse(commits[0].authoredAt), Date.parse("2026-10-01T10:00:00Z"));
    assert.deepEqual(commits[0].changed.map((c) => c.path).sort(), ["prompts/system.md", "src/app.js"]);
    assert.equal(commits[0].hidden, 1);
    assert.deepEqual(commits[0].stats, { files: 3, insertions: 3, deletions: 0 });
    assert.deepEqual(commits[1].changed.map((c) => c.path).sort(), ["prompts/system.md", "src/app.js"]);
    assert.equal(commits[1].hidden, 2);
    assert.deepEqual(commits[2].changed, [{ path: "prompts/answerer.md", added: 0, deleted: 0 }]);
    assert.equal(headOf(root), commits[2].sha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the range starts after the commit held; a held commit that is no longer behind HEAD sends the whole history", () => {
  const root = repo();
  try {
    const all = listCommits(root, "HEAD", { keep }).commits;
    assert.equal(rangeOf(root, all[0].sha), `${all[0].sha}..HEAD`);
    assert.equal(listCommits(root, rangeOf(root, all[0].sha), { keep }).commits.length, 2);
    assert.equal(listCommits(root, rangeOf(root, all[2].sha), { keep }).commits.length, 0);
    assert.equal(rangeOf(root, "0000000000000000000000000000000000000000"), "HEAD");
    assert.equal(rangeOf(root, "not a sha"), "HEAD");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a diff carries only files that may leave, with every line that holds a key replaced", () => {
  const root = repo();
  try {
    const commits = listCommits(root, "HEAD", { keep }).commits;
    const diffs = diffsOf(root, commits.map((c) => c.sha), { keep, holdsKey });
    const second = diffs.get(commits[1].sha);
    assert.ok(second.diff.includes("+Never promise a refund."));
    assert.ok(!second.diff.includes("sk-proj-"), "a provider key never leaves");
    assert.ok(!second.diff.includes("supersecretvalue"), "a value from the env file never leaves");
    assert.ok(!second.diff.includes("OPENAI_API_KEY"), "the env file is not in the diff at all");
    assert.ok(!second.diff.includes("BEGIN PRIVATE KEY"), "a key file is not in the diff at all");
    assert.ok(second.diff.includes("+[line held back on this machine: it carries a key]"));
    assert.equal(second.stripped, 2);
    const third = diffs.get(commits[2].sha);
    assert.ok(third.diff.includes("rename from prompts/system.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a diff over the limit is reported by size and not sent, and no line of it is read for keys", () => {
  const big = `diff --git a/vendor.js b/vendor.js\n--- a/vendor.js\n+++ b/vendor.js\n@@ -0,0 +1 @@\n+${"x".repeat(LIMITS.diffBytes)}\n`;
  let read = 0;
  const { diff, over, bytes } = filterDiff(big, () => true, () => { read += 1; return false; });
  assert.equal(diff, "");
  assert.equal(over, true);
  assert.ok(bytes > LIMITS.diffBytes);
  assert.equal(read, 0);
  const root = repo();
  try {
    writeFileSync(join(root, "vendor.js"), "x".repeat(LIMITS.diffBytes + 10));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "Fourth: a vendored file");
    const parts = historyParts(root, null, { keep, holdsKey });
    const fourth = parts.flat().at(-1);
    assert.equal(fourth.diff, undefined);
    assert.ok(fourth.diffBytes > LIMITS.diffBytes);
    assert.deepEqual(fourth.changed, [{ path: "vendor.js", added: 1, deleted: 0 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a blobless clone sends its messages without stats or diffs and never reaches the network", () => {
  const root = repo();
  const clone = mkdtempSync(join(tmpdir(), "cortad-partial-"));
  try {
    git(root, "config", "uploadpack.allowFilter", "true");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${root}`, join(clone, "r")], { stdio: "ignore" });
    const partial = join(clone, "r");
    const { commits, withStats } = listCommits(partial, "HEAD", { keep });
    assert.equal(withStats, false);
    assert.equal(commits.length, 3);
    assert.deepEqual(commits.map((c) => c.changed), [[], [], []]);
    assert.equal(diffsOf(partial, commits.map((c) => c.sha), { keep, holdsKey }).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }); }
});

test("the parts stay under the request limit and the repository's facts carry no credential", () => {
  const root = repo();
  try {
    git(root, "remote", "add", "origin", "https://user:secrettoken@github.com/acme/app.git");
    const parts = historyParts(root, null, { keep, holdsKey });
    assert.equal(parts.length, 1);
    assert.ok(parts.every((part) => JSON.stringify(part).length <= LIMITS.partBytes));
    assert.deepEqual(parts[0].map((c) => c.message.split("\n")[0]), ["First: the app, its prompt and its env", "Second: a rule, a key in code, a new env value", "Third: the prompt moves"]);
    const facts = repoFacts(root);
    assert.equal(facts.remote, "https://github.com/acme/app.git");
    assert.equal(facts.branch, "main");
    assert.equal(facts.contributors, 1);
    assert.equal(Date.parse(facts.firstCommitAt), Date.parse("2026-10-01T10:00:00Z"));
    assert.equal(safeRemote("git@github.com:acme/app.git"), "git@github.com:acme/app.git");
    assert.equal(safeRemote("not a url"), null);
    assert.equal(renamedTo("src/{old => new}/file.ts"), "src/new/file.ts");
    assert.equal(renamedTo("old.md => new.md"), "new.md");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
