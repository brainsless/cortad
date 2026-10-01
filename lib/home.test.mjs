import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addNews, homeOf, projectOf, readPending, readToken, takeNews, writePending, writeToken } from "./home.mjs";

test("the key is kept per project, readable by this user only", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-base-"));
  const project = projectOf(base);
  assert.match(project, /^[a-f0-9]{16}$/);
  assert.equal(readToken(project, base), null);
  writeToken(project, "ct_mcp_secret", base);
  assert.equal(readToken(project, base), "ct_mcp_secret");
  assert.equal(statSync(join(homeOf(project, base), "token")).mode & 0o777, 0o600);
  assert.equal(statSync(homeOf(project, base)).mode & 0o777, 0o700);
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

test("news the server said while no agent listened is kept per project and said once", () => {
  const base = mkdtempSync(join(tmpdir(), "cortad-base-"));
  const project = projectOf(base);
  assert.deepEqual(takeNews(project, base), []);
  addNews(project, "Run 55ee432b finished: 4 findings in 37 conversations. Call findings.", base);
  addNews(project, "Verify of finding:1 finished. Call run_status j2 for whether the failure is gone.", base);
  assert.equal(statSync(join(homeOf(project, base), "news.txt")).mode & 0o777, 0o600);
  assert.deepEqual(takeNews(project, base), [
    "Run 55ee432b finished: 4 findings in 37 conversations. Call findings.",
    "Verify of finding:1 finished. Call run_status j2 for whether the failure is gone.",
  ]);
  assert.deepEqual(takeNews(project, base), []);
});
