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
  // Digits only, so an integer account column accepts it and the app's own database does not raise.
  assert.match(claims.sub, /^\d+$/);
  assert.equal(claims.userId, claims.sub);
  assert.notEqual(claims.id, 1);
});

test("a role signs in as the same account on every run from one folder, and a new one elsewhere", async () => {
  const { accountsFor } = await import("./mint.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const key = join(mkdtempSync(join(tmpdir(), "idkey-")), "identity.key");
  const a = accountsFor("/app/one", ["staff:sales", "owner"], key);
  const b = accountsFor("/app/one", ["staff:sales", "owner"], key);
  const c = accountsFor("/app/two", ["staff:sales"], key);
  assert.deepEqual(a, b);
  assert.notEqual(a["staff:sales"].username, c["staff:sales"].username);
  assert.match(a.owner.password, /A1!$/);
});

// Hosted sign-in services, served on this machine the way the real APIs answer the calls the mint makes.
import { createServer } from "node:http";
import { makeIdentities } from "./mint.mjs";

function serve(handle) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const [status, body] = handle(req, raw ? JSON.parse(raw) : null, new URL(req.url, "http://x"));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// An instance that signs in only by email code: a user created with a password is refused.
function fakeClerk(key, metadata = {}, room = Infinity) {
  const users = new Map();
  const state = { sessions: 0, tokens: [] };
  return serve((req, body, url) => {
    if (req.headers.authorization !== `Bearer ${key}`) return [401, { errors: [{ message: "bad key" }] }];
    if (req.method === "GET" && url.pathname === "/v1/users") { const u = users.get(url.searchParams.get("email_address")); return [200, u ? [u] : []]; }
    if (url.pathname === "/v1/users" && (body.password !== undefined || users.size >= room)) return [422, { errors: [{ long_message: body.password !== undefined ? "password is not a valid parameter for this instance" : "user limit reached" }] }];
    if (url.pathname === "/v1/users") { const u = { id: `user_${users.size + 1}`, public_metadata: metadata, private_metadata: {} }; users.set(body.email_address[0], u); return [200, u]; }
    if (url.pathname === "/v1/sessions") { state.sessions += 1; return [200, { id: `sess_${state.sessions}_${body.user_id}` }]; }
    const m = /^\/v1\/sessions\/([^/]+)\/tokens$/.exec(url.pathname);
    if (m) { const jwt = `clerk-token-${m[1]}-${state.tokens.length}`; state.tokens.push(jwt); return [200, { object: "token", jwt }]; }
    return [404, {}];
  }).then((s) => ({ ...s, users, state }));
}

function fakeSupabase(service) {
  const users = new Map();
  const state = { tokens: [] };
  return serve((req, body, url) => {
    if (url.pathname === "/auth/v1/admin/users") {
      if (req.headers.apikey !== service) return [401, { msg: "bad key" }];
      if (users.has(body.email)) return [422, { msg: "A user with this email address has already been registered" }];
      users.set(body.email, { id: `u${users.size + 1}`, password: body.password, confirmed: body.email_confirm });
      return [200, { id: users.get(body.email).id }];
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      const u = users.get(body.email);
      if (!u || u.password !== body.password || !u.confirmed) return [400, { error_description: "Invalid login credentials" }];
      const access = `sb-access-${u.id}-${state.tokens.length}`;
      state.tokens.push(access);
      return [200, { access_token: access, refresh_token: `sb-refresh-${u.id}-${state.tokens.length}`, token_type: "bearer", expires_in: 3600, user: { id: u.id, role: "authenticated", app_metadata: { provider: "email" } } }];
    }
    return [404, {}];
  }).then((s) => ({ ...s, users, state }));
}

function identitiesWith(envText) {
  const root = mkdtempSync(join(tmpdir(), "hosted-"));
  process.env.HOME = root;
  writeFileSync(join(root, ".env"), envText);
  const kept = [];
  const said = [];
  const ids = makeIdentities({ root, work: join(root, "work"), envFiles: [join(root, ".env")], say: (s) => said.push(s), keepSecret: (v) => kept.push(v) });
  return { ids, kept, said };
}
const recipe = (kind, role, header = "authorization") => ({ kind, role, header, env: [], opens: [], where: "src/middleware.ts:1" });

test("each simulated person signs in to Clerk as an account of its own, and no token rides the reply to the cloud", async () => {
  const clerk = await fakeClerk("sk_test_fake_key_123");
  try {
    const { ids, kept } = identitiesWith(`CLERK_SECRET_KEY=sk_test_fake_key_123\nCLERK_API_URL=${clerk.url}\n`);
    const out = await ids.mint({ recipes: [recipe("clerk", "clerk")] }, 1);
    assert.equal(out.identities[0].status, "minted");
    const a = await ids.headerFor("clerk:p1a2b3c4d");
    const b = await ids.headerFor("clerk:p9f8e7d6c");
    assert.equal(a.name, "authorization");
    assert.notEqual(a.value, b.value);
    assert.equal(clerk.users.size, 3);
    for (const token of clerk.state.tokens) {
      assert.ok(!JSON.stringify(out).includes(token));
      assert.ok(kept.includes(token));
    }
  } finally { clerk.server.close(); }
});

test("a Clerk token is minted again from its session before its minute runs out", async (t) => {
  const clerk = await fakeClerk("sk_test_fake_key_123");
  try {
    const { ids } = identitiesWith(`CLERK_SECRET_KEY=sk_test_fake_key_123\nCLERK_API_URL=${clerk.url}\n`);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await ids.mint({ recipes: [recipe("clerk", "clerk")] }, 1);
    const first = await ids.headerFor("clerk");
    assert.equal((await ids.headerFor("clerk")).value, first.value);
    t.mock.timers.tick(51_000);
    const second = await ids.headerFor("clerk");
    assert.notEqual(second.value, first.value);
    assert.equal(clerk.state.sessions, 1);
  } finally { clerk.server.close(); }
});

test("an account Clerk holds as an admin is refused, and so is a production key", async () => {
  const clerk = await fakeClerk("sk_test_fake_key_123", { role: "admin" });
  try {
    const { ids } = identitiesWith(`CLERK_SECRET_KEY=sk_test_fake_key_123\nCLERK_API_URL=${clerk.url}\n`);
    const [row] = (await ids.mint({ recipes: [recipe("clerk", "clerk")] }, 1)).identities;
    assert.equal(row.status, "refused");
    assert.match(row.note, /admin/);
    assert.equal(await ids.headerFor("clerk"), null);
    assert.equal((await ids.mint({ recipes: [recipe("clerk", "admin")] }, 1)).identities[0].status, "refused");
    const live = identitiesWith(`CLERK_SECRET_KEY=sk_live_fake_key_123\nCLERK_API_URL=${clerk.url}\n`);
    assert.match((await live.ids.mint({ recipes: [recipe("clerk", "clerk")] }, 1)).identities[0].note, /production key/);
  } finally { clerk.server.close(); }
});

test("Supabase signs each person in through its admin API, into the cookie @supabase/ssr reads, renewed within the hour", async (t) => {
  const supa = await fakeSupabase("service-role-key-123");
  try {
    const { ids, kept } = identitiesWith(`NEXT_PUBLIC_SUPABASE_URL=${supa.url}\nSUPABASE_SERVICE_ROLE_KEY=service-role-key-123\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key-123456\n`);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const out = await ids.mint({ recipes: [recipe("supabase-admin", "supabase", "cookie")] }, 1);
    assert.equal(out.identities[0].status, "minted");
    const a = await ids.headerFor("supabase:p1a2b3c4d");
    const b = await ids.headerFor("supabase:p9f8e7d6c");
    assert.equal(a.name, "cookie");
    const session = (cookie) => JSON.parse(Buffer.from(cookie.replace(/^sb-127-auth-token=base64-/, ""), "base64url").toString());
    assert.notEqual(session(a.value).user.id, session(b.value).user.id);
    assert.equal(supa.users.size, 3);
    t.mock.timers.tick(56 * 60_000);
    assert.notEqual(session((await ids.headerFor("supabase:p1a2b3c4d")).value).access_token, session(a.value).access_token);
    for (const token of supa.state.tokens) {
      assert.ok(!JSON.stringify(out).includes(token));
      assert.ok(kept.includes(token));
    }
  } finally { supa.server.close(); }
});

test("a person whose own Clerk account cannot be made speaks as the shared one, and the terminal is told once", async () => {
  const clerk = await fakeClerk("sk_test_fake_key_123", {}, 1);
  try {
    const { ids, said } = identitiesWith(`CLERK_SECRET_KEY=sk_test_fake_key_123\nCLERK_API_URL=${clerk.url}\n`);
    await ids.mint({ recipes: [recipe("clerk", "clerk")] }, 1);
    const base = await ids.headerFor("clerk");
    assert.equal((await ids.headerFor("clerk:p1a2b3c4d")).value, base.value);
    assert.equal((await ids.headerFor("clerk:p9f8e7d6c")).value, base.value);
    assert.deepEqual(said.filter((s) => /shared test account/.test(s)).length, 1);
    assert.match(said.find((s) => /shared/.test(s)), /user limit reached/);
  } finally { clerk.server.close(); }
});
