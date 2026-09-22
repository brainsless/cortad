import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSwitches } from "./switches.mjs";

const file = (text, name = ".env") => { const dir = mkdtempSync(join(tmpdir(), "sw-")); const at = join(dir, name); writeFileSync(at, text); return at; };

test("a switch that decides whether anyone has to sign in is set to let the run in", () => {
  // morphic, 2026-09-22: its chat answered 401 to every caller until this was true.
  assert.deepEqual(openSwitches([file("ENABLE_GUEST_CHAT=false\n")]), { ENABLE_GUEST_CHAT: "true" });
  assert.deepEqual(openSwitches([file("ENABLE_AUTH=true\n")]), { ENABLE_AUTH: "false" });
  assert.deepEqual(openSwitches([file("AUTH_REQUIRED=1\n")]), { AUTH_REQUIRED: "false" });
  assert.deepEqual(openSwitches([file("DISABLE_AUTH=false\n")]), { DISABLE_AUTH: "true" });
  assert.deepEqual(openSwitches([file("ALLOW_ANONYMOUS_ACCESS=no\n")]), { ALLOW_ANONYMOUS_ACCESS: "true" });
});

test("a guard on sign-in itself is never touched", () => {
  const guards = "LOGIN_ATTEMPTS=5\nAUTH_LOCKOUT_ENABLED=true\nPASSWORD_POLICY_ENABLED=true\nFAILED_LOGIN_BAN=true\n";
  assert.deepEqual(openSwitches([file(guards)]), {});
});

test("a name of this shape holding something that is not a switch is left alone", () => {
  assert.deepEqual(openSwitches([file("ENABLE_GUEST_CHAT=https://example.com\nGUEST_MODE=sk-abcdef123456\n")]), {});
});

test("a switch the code reads with no line in the env files still counts", () => {
  const src = file("if (process.env.ENABLE_GUEST_CHAT === 'true') { open() }\n", "route.ts");
  assert.deepEqual(openSwitches([], [src]), { ENABLE_GUEST_CHAT: "true" });
});
