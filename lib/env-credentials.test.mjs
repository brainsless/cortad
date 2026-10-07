import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialPairs, envCredentialRecipes, identityScript, parseIdentityReport } from "./identities.mjs";

test("a credential pair is the user and password names that share a prefix", () => {
  const pair = (names) => credentialPairs(names).map((p) => `${p.user}+${p.secret}`);
  assert.deepEqual(pair(["USER_USERNAME", "USER_PASSWORD"]), ["USER_USERNAME+USER_PASSWORD"]);
  assert.deepEqual(pair(["AUTH_USERNAME", "AUTH_PASSWORD"]), ["AUTH_USERNAME+AUTH_PASSWORD"]);
  assert.deepEqual(pair(["BOOTSTRAP_ADMIN_USERNAME", "BOOTSTRAP_ADMIN_PASSWORD"]), ["BOOTSTRAP_ADMIN_USERNAME+BOOTSTRAP_ADMIN_PASSWORD"]);
  assert.deepEqual(pair(["TUDUDI_USER_EMAIL", "TUDUDI_USER_PASSWORD"]), ["TUDUDI_USER_EMAIL+TUDUDI_USER_PASSWORD"]);
  assert.deepEqual(pair(["ADMIN_USER", "ADMIN_PASSWORD"]), ["ADMIN_USER+ADMIN_PASSWORD"]);
  assert.deepEqual(pair(["BASIC_AUTH_USER", "BASIC_AUTH_PASSWORD"]), ["BASIC_AUTH_USER+BASIC_AUTH_PASSWORD"]);
});

test("a store's or a mail server's sign-in is never offered as the app's account", () => {
  const names = ["PG_DB_USER", "PG_DB_PASSWORD", "DB_USERNAME", "DB_PASSWORD", "MONGO_USER", "MONGO_PASS", "SMTP_USER", "SMTP_PASSWORD", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"];
  assert.deepEqual(credentialPairs(names), []);
  assert.deepEqual(credentialPairs([...names, "ADMIN_EMAIL", "ADMIN_PASSWORD"]).map((p) => p.prefix), ["ADMIN"]);
});

test("a lone signing secret never pairs, and an env with no user name has no pair", () => {
  assert.deepEqual(credentialPairs(["JWT_SECRET", "SESSION_SECRET", "OPENAI_API_KEY"]), []);
  // A secret whose prefix matches no user-side name is not half of a pair.
  assert.deepEqual(credentialPairs(["TUDUDI_SESSION_SECRET", "OPENAI_API_KEY"]), []);
});

test("a login form of username and password is filled from the pair, not a generated account", () => {
  const login = { kind: "login", role: "auth", header: "authorization", env: ["AUTH_PASSWORD"],
    steps: [{ route: "/api/auth/login", body: { username: "gen:username", password: "env:AUTH_PASSWORD" } }], opens: [], where: "auth.py:1" };
  const [out] = envCredentialRecipes([login], ["AUTH_USERNAME", "AUTH_PASSWORD"]);
  assert.equal(out.envCred, true);
  assert.deepEqual(out.steps[0].body, { username: "env:AUTH_USERNAME", password: "env:AUTH_PASSWORD" });
});

test("a register step keeps its fresh account; only the sign-in step is filled", () => {
  const login = { kind: "login", role: "member", header: "cookie", env: [], steps: [
    { route: "/api/register", body: { email: "gen:email", password: "gen:password" } },
    { route: "/api/login", body: { email: "gen:email", password: "gen:password" } },
  ], opens: [], where: "auth.ts:1" };
  const [out] = envCredentialRecipes([login], ["TUDUDI_USER_EMAIL", "TUDUDI_USER_PASSWORD"]);
  assert.deepEqual(out.steps[0].body, { email: "gen:email", password: "gen:password" });
  assert.deepEqual(out.steps[1].body, { email: "env:TUDUDI_USER_EMAIL", password: "env:TUDUDI_USER_PASSWORD" });
});

test("a discovered sign-in route with no recipe becomes a login filled from the pair", () => {
  const out = envCredentialRecipes([], ["TUDUDI_USER_EMAIL", "TUDUDI_USER_PASSWORD"], ["/api/login"]);
  const login = out.find((r) => r.kind === "login");
  assert.ok(login, "a login recipe was synthesized");
  assert.equal(login.steps[0].route, "/api/login");
  assert.deepEqual(login.steps[0].body, { email: "env:TUDUDI_USER_EMAIL", password: "env:TUDUDI_USER_PASSWORD" });
});

test("no sign-in route and a Basic-auth pair yields one Basic identity", () => {
  const out = envCredentialRecipes([], ["USER_USERNAME", "USER_PASSWORD"]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "basic");
  assert.deepEqual(out[0].env, ["USER_USERNAME", "USER_PASSWORD"]);
});

// The raise always offers candidate sign-in routes, so a Basic-only app must still get its Basic
// identity even when login candidates are tried alongside it.
test("a Basic identity is minted even when candidate sign-in routes are offered", () => {
  const out = envCredentialRecipes([], ["USER_USERNAME", "USER_PASSWORD"], ["/api/login", "/login"]);
  assert.ok(out.some((r) => r.kind === "basic"), "the Basic identity survives the candidates");
});

test("no pair leaves the recipes untouched", () => {
  const recipes = [{ kind: "jwt", role: "user", header: "authorization", env: ["JWT_SECRET"], opens: [], where: "x" }];
  assert.deepEqual(envCredentialRecipes(recipes, ["JWT_SECRET"]), recipes);
});

test("the basic identity is Authorization: Basic base64(user:password), from the env file only", () => {
  const dir = mkdtempSync(join(tmpdir(), "basic-"));
  writeFileSync(join(dir, ".env"), "USER_USERNAME=alice\nUSER_PASSWORD=s3cret pass!\n");
  const recipe = { kind: "basic", role: "user", header: "authorization", env: ["USER_USERNAME", "USER_PASSWORD"], opens: [], where: "env", envCred: true };
  const script = identityScript([recipe], { envPath: join(dir, ".env"), base: "http://127.0.0.1:9" }).split("/tmp/bl-identit").join(join(dir, "bl-identit"));
  writeFileSync(join(dir, "mint.py"), script);
  const report = parseIdentityReport(execFileSync("python3", [join(dir, "mint.py")], { cwd: dir }).toString());
  assert.equal(report.identities[0].status, "minted");
  const line = readFileSync(join(dir, "bl-identity-user.header"), "utf8").split("\n")[0];
  const expected = `authorization: Basic ${Buffer.from("alice:s3cret pass!").toString("base64")}`;
  assert.equal(line, expected);
});
