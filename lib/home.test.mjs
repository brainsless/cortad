import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearRunner, homeOf, projectOf, readPending, readRunner, readToken, writePending, writeRunner, writeToken } from "./home.mjs";

test("the key is kept per project, readable by this user only, and a dead runner is no runner", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-base-"));
  const project = projectOf(base);
  assert.match(project, /^[a-f0-9]{16}$/);
  assert.equal(readToken(project, base), null);
  writeToken(project, "ct_mcp_secret", base);
  assert.equal(readToken(project, base), "ct_mcp_secret");
  assert.equal(statSync(join(homeOf(project, base), "token")).mode & 0o777, 0o600);
  assert.equal(statSync(homeOf(project, base)).mode & 0o777, 0o700);

  writeRunner(project, { pid: process.pid, by: "test" }, base);
  assert.equal(readRunner(project, base)?.pid, process.pid);
  writeRunner(project, { pid: 2 ** 22 - 7, by: "test" }, base);
  assert.equal(readRunner(project, base), null);
  clearRunner(project, base);
  assert.equal(readRunner(project, base), null);
});

test("the run this machine asked for is kept readable by this user only, and a torn file reads as none", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-base-"));
  const project = projectOf(base);
  assert.equal(readPending(project, base), null);
  writePending(project, { jobId: "j1", kind: "run", startedAt: "2026-09-26T12:00:00.000Z" }, base);
  assert.deepEqual(readPending(project, base), { jobId: "j1", kind: "run", startedAt: "2026-09-26T12:00:00.000Z" });
  assert.equal(statSync(join(homeOf(project, base), "pending.json")).mode & 0o777, 0o600);
  writeFileSync(join(homeOf(project, base), "pending.json"), "{\"jobId\":");
  assert.equal(readPending(project, base), null);
});
