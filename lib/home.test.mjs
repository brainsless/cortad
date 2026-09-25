import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearRunner, homeOf, projectOf, readRunner, readToken, writeRunner, writeToken } from "./home.mjs";

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
