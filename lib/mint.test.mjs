import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refusal } from "./mint.mjs";
import { identityScript } from "./identities.mjs";

const env = { ADMIN_API_KEY: "sk-admin-very-private", NEXT_PUBLIC_CHAT_KEY: "pk-public-1234", APP_KEY: "shipped-in-client", JWT_SECRET: "x".repeat(32) };
const shipped = (v) => v === "shipped-in-client";

test("an admin role is never signed in", () => {
  assert.match(refusal({ kind: "login", role: "admin", steps: [] }, env, shipped), /admin/);
  assert.match(refusal({ kind: "login", role: "staff", roles: ["owner"], steps: [] }, env, shipped), /admin/);
  assert.equal(refusal({ kind: "login", role: "user", steps: [] }, env, shipped), null);
});

test("a private key is never sent as the caller's own", () => {
  assert.match(refusal({ kind: "header", role: "service", env: ["ADMIN_API_KEY"] }, env, shipped), /private key/);
  assert.equal(refusal({ kind: "header", role: "client", env: ["NEXT_PUBLIC_CHAT_KEY"] }, env, shipped), null);
  assert.equal(refusal({ kind: "header", role: "client", env: ["APP_KEY"] }, env, shipped), null);
});

test("an existing account is never logged into, a new one is", () => {
  const existing = { kind: "login", role: "user", steps: [{ route: "/login", body: { email: "env:ADMIN_EMAIL", password: "env:ADMIN_PASSWORD" } }] };
  const fresh = { kind: "login", role: "user", steps: [{ route: "/signup", body: { email: "gen:email", password: "gen:password", invite: "env:INVITE_CODE" } }] };
  assert.match(refusal(existing, env, shipped), /existing account/);
  assert.equal(refusal(fresh, env, shipped), null);
});

test("a token carries only the user's id, and that id is nobody's", () => {
  assert.match(refusal({ kind: "jwt", role: "user", env: ["JWT_SECRET"], claim: "isAdmin" }, env, shipped), /token field/);
  const dir = mkdtempSync(join(tmpdir(), "mint-test-"));
  writeFileSync(join(dir, ".env"), `JWT_SECRET=${env.JWT_SECRET}\n`);
  const script = identityScript([{ kind: "jwt", role: "user", header: "authorization", where: "src/auth.ts", env: ["JWT_SECRET"], claim: "userId" }], { envPath: join(dir, ".env"), base: "http://127.0.0.1:9" })
    .split("/tmp/bl-identit").join(join(dir, "bl-identit"));
  writeFileSync(join(dir, "mint.py"), script);
  execFileSync("python3", [join(dir, "mint.py")], { cwd: dir });
  const line = readFileSync(join(dir, "bl-identity-user.header"), "utf8");
  const claims = JSON.parse(Buffer.from(line.split(".")[1], "base64url").toString());
  assert.equal(claims.sub, "cortad-test-user");
  assert.equal(claims.userId, "cortad-test-user");
  assert.notEqual(claims.id, 1);
});
