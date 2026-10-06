// Signing in as the app's own callers, on the machine that holds its secrets. The cloud sends
// recipes: names of env variables, routes and body fields, never a value and never code. They are
// gated again here, the values are opened here, and what the app's own door issues is kept in a
// folder only this user can read and wiped when the command exits. A request that should speak as
// a role arrives carrying a marker; the real header is put in its place here, so neither a secret
// nor a token ever leaves this machine.
import { execFile } from "node:child_process";
import { createHmac, createSign, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { envCredentialRecipes, identityScript, parseIdentityReport } from "./identities.mjs";

const exec = promisify(execFile);
export const AS_HEADER = "x-cortad-as";
const ROLE = /^[a-z][a-z0-9_-]{0,30}(?::[a-z][a-z0-9_-]{0,30})?$/;
const slug = (role) => role.replace(/[^a-z0-9-]/g, "-");
const TEST_UID = "brainsless-test-user";

// The account each role signs in as, the same on every run from this folder: derived from a key that
// never leaves this machine, so no server holds a password to any of their accounts.
export function accountsFor(root, roles, keyFile = join(homedir(), ".cortad", "identity.key")) {
  if (!existsSync(keyFile)) { mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 }); writeFileSync(keyFile, randomBytes(32), { mode: 0o600 }); }
  const key = readFileSync(keyFile);
  const mac = (what) => createHmac("sha256", key).update(`${what}\0${root}`).digest("base64url");
  return Object.fromEntries(roles.filter((role) => ROLE.test(role)).map((role) => {
    const username = `cortad-${slug(role)}-${mac(`name\0${role}`).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
    return [role, { username, email: `${username}@example.invalid`, password: `${mac(`pw\0${role}`).slice(0, 24)}A1!`, name: `Cortad test ${role}` }];
  }));
}

// Who this machine signs in as, whatever a recipe asks: an account made for the session, or a test
// id that belongs to nobody. Never a person who already has an account, never an admin, and never a
// key the app does not already hand to every browser. The recipes come from the cloud; these rules
// are here, beside the secrets, so a recipe cannot talk its way past them.
const ELEVATED = /admin|owner|super|root/i;
const PUBLIC_NAME = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|PUBLIC_|GATSBY_)/;
const ACCOUNT_FIELD = /^(e-?mail|user(_?name)?|login|phone|account|identifier)$/i;
const ID_CLAIM = /^(sub|id|uid|user_?id|userid)$/i;

// Whether a value is already in the code the app ships: then every browser holds it, and sending it
// as the caller's key tells the app nothing a visitor could not.
function inSource(root, files, value) {
  for (const rel of files) {
    try { if (readFileSync(join(root, rel), "utf8").includes(value)) return true; } catch { /* gone */ }
  }
  return false;
}

export function refusal(recipe, env, shipped) {
  if ([recipe?.role, ...(recipe?.roles ?? [])].some((r) => ELEVATED.test(String(r ?? "")))) return "an admin role; only an ordinary test account is signed in";
  if (recipe?.kind === "jwt" && recipe.claim && !ID_CLAIM.test(recipe.claim)) return `a token field (${recipe.claim}) other than the user's id`;
  if (recipe?.kind === "header") {
    const names = recipe.env ?? [];
    const value = names.map((n) => env[n]).find(Boolean);
    if (value && !names.some((n) => PUBLIC_NAME.test(n)) && !shipped(value)) return `${names.join(" or ")} is a private key, never sent as a caller's own`;
  }
  for (const step of [...(recipe?.steps ?? []), ...(recipe?.alt ?? [])])
    for (const [field, spec] of Object.entries(step?.body ?? {}))
      if (ACCOUNT_FIELD.test(field) && String(spec).startsWith("env:")) return "an existing account from your environment; only a new test account is signed in";
  return null;
}

export function readEnv(file) {
  const out = {};
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
  return out;
}

// The admin credential the app itself runs with, under the names projects really use.
function serviceAccountOf(env) {
  const parse = (s) => { try { const j = JSON.parse(s); return j?.private_key && j?.client_email ? j : null; } catch { return null; } };
  for (const [name, value] of Object.entries(env)) {
    if (!/SERVICE_ACCOUNT|FIREBASE_ADMIN|GOOGLE_CREDENTIALS/.test(name) || !value) continue;
    const found = parse(value) ?? parse(Buffer.from(value, "base64").toString("utf8"));
    if (found) return found;
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS) { try { const found = parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")); if (found) return found; } catch { /* not a file here */ } }
  return env.FIREBASE_PRIVATE_KEY && env.FIREBASE_CLIENT_EMAIL ? { private_key: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), client_email: env.FIREBASE_CLIENT_EMAIL } : null;
}
const webApiKeyOf = (envs) => envs.flatMap((env) => Object.entries(env)).find(([name, value]) => /FIREBASE\w*API_KEY$/.test(name) && /^AIza[\w-]{20,}$/.test(value))?.[1] ?? null;

// A custom token signed with their own admin credential, exchanged at their own project for the ID
// token their app verifies. The first exchange creates the test user in that project, by that uid.
async function firebaseIdToken(account, apiKey) {
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: account.client_email, sub: account.client_email, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat: now, exp: now + 3600, uid: TEST_UID })}`;
  const token = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key).toString("base64url")}`;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, returnSecureToken: true }), signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => null);
  return res.ok && out?.idToken ? { idToken: out.idToken } : { error: String(out?.error?.message ?? `status ${res.status}`).slice(0, 120) };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// A server key goes only over TLS, or to a service on this machine (a local Supabase).
function serviceOrigin(value) {
  try { const u = new URL(value); return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)) ? u.origin : null; } catch { return null; }
}
async function send(url, { method = "POST", headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}
const saidBy = (r) => String(r.json?.errors?.[0]?.long_message ?? r.json?.msg ?? r.json?.error_description ?? r.json?.message ?? `status ${r.status}`).slice(0, 120);
const refusedBy = (who, r) => ({ status: "refused", note: `${who} refused the test account: ${saidBy(r)}` });
// An account the service already held may have been given a role since this machine made it.
const ELEVATED_ACCOUNT = { status: "refused", note: "the test account carries an admin role; only an ordinary account is signed in" };
const elevated = (...claims) => claims.some((c) => c && ELEVATED.test(JSON.stringify(c)));

// Clerk's Backend API, in their development instance only: the account, a session for it, and the
// session's token, which lives a minute and is minted again from the same session before it lapses.
export async function clerkToken(env, account, session) {
  const key = env.CLERK_SECRET_KEY;
  if (!key) return { status: "absent", note: "no CLERK_SECRET_KEY in your environment" };
  if (!key.startsWith("sk_test_")) return { status: "refused", note: "your CLERK_SECRET_KEY is a production key; test accounts are made only in a development instance" };
  const origin = serviceOrigin(env.CLERK_API_URL || "https://api.clerk.com");
  if (!origin) return { status: "refused", note: "CLERK_API_URL is not an https address" };
  const api = `${origin}/v1`;
  const auth = { authorization: `Bearer ${key}` };
  const tokenOf = async (id) => (await send(`${api}/sessions/${encodeURIComponent(id)}/tokens`, { headers: auth })).json?.jwt;
  const again = session && await tokenOf(session);
  if (again) return { token: again, session };
  // Clerk sends nothing to a +clerk_test address; it exists for exactly this.
  const email = `${account.username}+clerk_test@example.com`;
  const found = await send(`${api}/users?email_address=${encodeURIComponent(email)}`, { method: "GET", headers: auth });
  let user = Array.isArray(found.json) ? found.json[0] : null;
  if (!user) {
    // No password: a session is made through this API, and an instance that signs in only by email
    // code or OAuth refuses a user created with one.
    const made = await send(`${api}/users`, { headers: auth, body: { email_address: [email], skip_password_requirement: true } });
    if (!made.ok || !made.json?.id) return refusedBy("your Clerk instance", made);
    user = made.json;
  }
  if (elevated(user.public_metadata, user.private_metadata)) return ELEVATED_ACCOUNT;
  const opened = await send(`${api}/sessions`, { headers: auth, body: { user_id: user.id } });
  if (!opened.ok || !opened.json?.id) return refusedBy("your Clerk instance", opened);
  const token = await tokenOf(opened.json.id);
  return token ? { token, session: opened.json.id } : { status: "refused", note: "your Clerk instance issued no session token" };
}

const SUPABASE_URL = /^(?:NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|PUBLIC_)?SUPABASE_URL$/;
const SUPABASE_SERVICE = /^SUPABASE_(?:SERVICE_ROLE|SERVICE|SECRET)_KEY$/;
const SUPABASE_PUBLIC = /^(?:NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|PUBLIC_)?SUPABASE_(?:ANON|PUBLISHABLE)(?:_DEFAULT)?_KEY$/;
const named = (env, pattern) => Object.entries(env).find(([name, value]) => pattern.test(name) && value)?.[1] ?? null;

// Supabase Auth's admin API makes the account already confirmed, with the service key their server
// holds; a password sign-in then issues the session their own client would hold.
export async function supabaseSession(env, account) {
  const url = named(env, SUPABASE_URL);
  const service = named(env, SUPABASE_SERVICE);
  if (!url || !service) return { status: "absent", note: `no ${url ? "SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_URL"} in your environment` };
  const origin = serviceOrigin(url);
  if (!origin) return { status: "refused", note: "SUPABASE_URL is not an https address" };
  const made = await send(`${origin}/auth/v1/admin/users`, { headers: { apikey: service, authorization: `Bearer ${service}` }, body: { email: account.email, password: account.password, email_confirm: true } });
  if (!made.ok && !/already|exists|registered/i.test(saidBy(made))) return refusedBy("your Supabase project", made);
  const got = await send(`${origin}/auth/v1/token?grant_type=password`, { headers: { apikey: named(env, SUPABASE_PUBLIC) ?? service }, body: { email: account.email, password: account.password } });
  if (!got.ok || typeof got.json?.access_token !== "string") return refusedBy("your Supabase project", got);
  if (elevated(got.json.user?.app_metadata, got.json.user?.role)) return ELEVATED_ACCOUNT;
  return { session: got.json, origin };
}

// @supabase/ssr's own cookie: the session as base64url JSON under sb-<ref>-auth-token, cut into
// numbered chunks past 3180 characters the way the library cuts it.
export function supabaseCookie(origin, session) {
  const name = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  if (value.length <= 3180) return `${name}=${value}`;
  return value.match(/.{1,3180}/g).map((part, i) => `${name}.${i}=${part}`).join("; ");
}

// Each hosted service's sign-in, as the value the role's header carries and how long it holds.
const SIGN_IN = new Map([
  ["firebase", async ({ env, all }) => {
    const account = serviceAccountOf(env);
    const apiKey = webApiKeyOf(all);
    if (!account || !apiKey) return { status: "absent", note: !account ? "no Firebase admin credential in your environment" : "no Firebase web API key in your environment" };
    const got = await firebaseIdToken(account, apiKey);
    if (!got.idToken) return { status: "refused", note: `your Firebase project refused the sign-in: ${got.error}` };
    return { value: `Bearer ${got.idToken}`, ttl: 3600, door: "your Firebase project", said: `signed in to your app as a test user it can tell apart (${TEST_UID}, in your own Firebase project)` };
  }],
  ["clerk", async ({ env, account, session }) => {
    const got = await clerkToken(env, account, session);
    return got.token ? { value: `Bearer ${got.token}`, ttl: 60, session: got.session, door: "your Clerk development instance", said: "made a test account in your Clerk development instance for the run to sign in with" } : got;
  }],
  ["supabase-admin", async ({ env, account, header }) => {
    const got = await supabaseSession(env, account);
    if (!got.session) return got;
    const s = got.session;
    return {
      value: header === "cookie" ? supabaseCookie(got.origin, s) : `Bearer ${s.access_token}`, secrets: [s.access_token, s.refresh_token],
      ttl: Number(s.expires_in) || 3600, door: "your Supabase project", said: "made a test account in your Supabase project for the run to sign in with",
    };
  }],
]);
// Renewed this long after a sign-in: Clerk's token lives 60 s, Supabase's and Firebase's an hour.
const RENEW_MS = { firebase: 50 * 60_000, clerk: 50_000, "supabase-admin": 55 * 60_000 };
const PER_PERSON = new Set(["clerk", "supabase-admin"]);
// A simulated person's own caller: the run sends `clerk:p1a2b3c4` for the person behind a trial.
const PERSONA = /^([a-z][a-z0-9_-]{0,30}):p[0-9a-f]{8}$/;

export function makeIdentities({ root, work, envFiles, sourceFiles = () => [], say, keepSecret, appDir = () => root }) {
  const dir = join(work, "identities");
  const headerFile = (role) => join(dir, `bl-identity-${slug(role)}.header`);
  const hosted = new Map();
  // The roles signed in on this machine so far, in the order they were: the connect command's own
  // test requests ask as the first when an endpoint refuses a visitor.
  const minted = new Set();
  const envs = () => {
    // The app's own folder first: in a monorepo the root's env file is not the backend's.
    const homes = [appDir(), root];
    const own = homes.flatMap((h) => [envFiles.find((f) => dirname(f) === h && basename(f) === ".env"), envFiles.find((f) => dirname(f) === h)]).find(Boolean) ?? envFiles[0];
    return { path: own ?? join(root, ".env"), all: [process.env, ...envFiles.map(readEnv)] };
  };
  const merged = () => Object.assign({}, ...[...envs().all].reverse());
  const keep = (role, header, value, secrets = []) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(headerFile(role), `${header}: ${value}\n`, { mode: 0o600 });
    for (const secret of [value.replace(/^Bearer\s+/i, ""), ...secrets]) keepSecret(secret);
  };

  // A hosted service's sign-in, kept on this machine and renewed through headerFor. Only the
  // bearer or the cookie is ever filled, whatever header a recipe names.
  async function signIn(row) {
    const header = row.header === "cookie" ? "cookie" : "authorization";
    const { all } = envs();
    const got = await SIGN_IN.get(row.kind)({ env: merged(), all, header, account: accountsFor(root, [row.role])[row.role], session: hosted.get(row.role)?.session })
      .catch((e) => ({ status: "unreachable", note: String(e?.message ?? e).slice(0, 120) }));
    if (!got.value) return { ...row, status: got.status, note: got.note };
    keep(row.role, header, got.value, got.secrets);
    if (!hosted.has(row.role) && !PERSONA.test(row.role)) say(got.said);
    hosted.set(row.role, { row: { ...row, header }, at: Date.now(), session: got.session });
    return { ...row, header, status: "minted", door: got.door, expires: Math.floor(Date.now() / 1000) + got.ttl };
  }

  async function mint(body, port) {
    let recipes = Array.isArray(body?.recipes) ? body.recipes.slice(0, 12) : [];
    // On a refused first pass the raise asks again with this flag: sign in with the credential the
    // app's own environment names, filling its sign-in form or a Basic header from that pair.
    if (body?.envCreds) recipes = envCredentialRecipes(recipes, Object.keys(merged()), body.loginRoutes).slice(0, 12);
    if (!recipes.length || !port) return { identities: [] };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = join(dir, "bl-identities.json");
    rmSync(out, { force: true });
    // ponytail: the program is Python, as it is in the sandbox. A machine without python3 mints
    // nothing and says so; port the program to this file if that turns out to be common.
    // A caller a hosted service verifies is signed in at that service, below; a Firebase caller goes
    // to the program only when an emulator stands in for their project. Handed to the program it
    // waited its whole deadline on an emulator that was never there, and one app's sign-in arrived
    // after the world had given up waiting for it.
    const env = merged();
    const emulated = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST);
    const signsHere = (r) => SIGN_IN.has(r?.kind) && !(r.kind === "firebase" && emulated);
    const refused = new Map();
    // A pair the environment names for the app's own account is the one credential the raise is
    // allowed to reuse: the elevation and existing-account guards do not apply to it.
    for (const r of recipes) { const why = r?.envCred ? null : refusal(r, env, (value) => inSource(root, sourceFiles(), value)); if (why && typeof r?.role === "string") refused.set(r.role, why); }
    const forProgram = recipes.filter((r) => !refused.has(r?.role) && !signsHere(r));
    // The program signs in once per role value ("staff" as sales, support, marketing), each named
    // role:value; an account made for "staff" alone was never the one it asked for.
    const accounts = accountsFor(root, forProgram.flatMap((r) => (Array.isArray(r.roles) && r.roles.length ? r.roles.map((v) => `${r.role}:${v}`) : [r.role])));
    const script = identityScript(forProgram, { envPath: envs().path, base: `http://127.0.0.1:${port}`, headers: body?.headers ?? {} }, accounts).split("/tmp/bl-identit").join(join(dir, "bl-identit"));
    const file = join(dir, "mint.py");
    writeFileSync(file, script, { mode: 0o600 });
    const ran = forProgram.length ? await exec("python3", [file], { cwd: root, timeout: 115_000, maxBuffer: 1 << 20 }).then(() => true, (e) => e?.code !== "ENOENT") : true;
    rmSync(file, { force: true });
    const report = parseIdentityReport(existsSync(out) ? readFileSync(out, "utf8") : "");
    const known = new Map((report?.identities ?? []).map((r) => [r.role, r]));
    const rows = [];
    for (const recipe of recipes) {
      if (typeof recipe?.role !== "string" || !ROLE.test(recipe.role)) continue;
      const blank = { role: recipe.role, kind: recipe.kind, header: recipe.header, opens: [], door: recipe.header, where: recipe.where };
      if (refused.has(recipe.role)) { rows.push({ ...blank, status: "refused", note: refused.get(recipe.role) }); continue; }
      if (signsHere(recipe)) { rows.push(await signIn({ ...blank, status: "upstream" })); continue; }
      rows.push(known.get(recipe.role) ?? { ...blank, status: ran ? "unreachable" : "absent", ...(ran ? {} : { note: "python3 is not installed on this machine" }) });
    }
    for (const row of rows.filter((r) => r.status === "minted")) {
      minted.add(row.role);
      if (existsSync(headerFile(row.role))) keepSecret(readFileSync(headerFile(row.role), "utf8").split(": ").slice(1).join(": ").trim().replace(/^Bearer\s+/i, ""));
    }
    return { identities: rows };
  }

  // A hosted token renewed before it lapses, and a simulated person's own account signed in the
  // first time that person speaks. One sign-in per role at a time: lanes asking together share it.
  const renewing = new Map();
  const tried = new Set();
  const shared = new Set();
  async function due(role) {
    const held = hosted.get(role);
    if (held) { if (Date.now() - held.at > RENEW_MS[held.row.kind]) await signIn(held.row); return; }
    const owner = hosted.get(PERSONA.exec(role)?.[1]);
    if (!owner || !PER_PERSON.has(owner.row.kind) || tried.has(role)) return;
    tried.add(role);
    const got = await signIn({ ...owner.row, role });
    if (got.status !== "minted" && !shared.has(owner.row.role)) {
      shared.add(owner.row.role);
      say(`a simulated person's own test account could not be made (${got.note ?? got.status}), so that person signs in as the shared test account`);
    }
  }
  const renewed = (role) => {
    if (!renewing.has(role)) renewing.set(role, due(role).catch(() => null).finally(() => renewing.delete(role)));
    return renewing.get(role);
  };

  // A token the app's door issued, or a credential that is itself one of their secrets (an admin
  // key). In the sandbox the second never leaves the box; here it never leaves this machine, which
  // is the same promise, because this is where the request is sent from.
  function held(role) {
    const file = [headerFile(role), headerFile(role).replace(/\.header$/, ".sealed")].find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
    if (!file) return null;
    const line = readFileSync(file, "utf8").split("\n")[0] ?? "";
    const at = line.indexOf(": ");
    return at > 0 ? { name: line.slice(0, at).trim().toLowerCase(), value: line.slice(at + 2).trim() } : null;
  }

  // The header a role speaks with, or nothing. A person whose own account could not be made speaks
  // as the role that person belongs to, the one account every trial used before.
  async function headerFor(role) {
    if (!ROLE.test(role)) return null;
    await renewed(role);
    const base = PERSONA.exec(role)?.[1];
    return held(role) ?? (base ? held(base) : null);
  }

  return { mint, headerFor, roles: () => [...minted] };
}
