import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { emulatorToken } from "./mint.mjs";

// Against a real Firebase Auth emulator (npx firebase-tools emulators:start --only auth), named by
// FIREBASE_AUTH_EMULATOR_HOST as an app names it; skipped where none runs.
const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9199";
const up = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

test("a test account is made at the Auth emulator once and signed in every time after", { skip: !up && `no Auth emulator at ${host}` }, async () => {
  const account = { email: `cortad-${randomBytes(4).toString("hex")}@example.invalid`, password: "a-test-password-1A!" };
  const first = await emulatorToken(host, account);
  assert.match(first.idToken ?? "", /^[\w-]+\.[\w-]+\./, JSON.stringify(first));
  const again = await emulatorToken(host, account);
  assert.match(again.idToken ?? "", /^[\w-]+\.[\w-]+\./, "an account that exists is signed in, never refused");
  assert.equal((await emulatorToken("not a host", account)).status, "refused");
  assert.equal((await emulatorToken("auth.example.com:9099", account)).status, "refused", "a password never goes to another host over http");
});
