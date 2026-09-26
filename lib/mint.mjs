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
import { identityScript, parseIdentityReport } from "./identities.mjs";

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

export function makeIdentities({ root, work, envFiles, sourceFiles = () => [], say, keepSecret, appDir = () => root }) {
  const dir = join(work, "identities");
  const headerFile = (role) => join(dir, `bl-identity-${slug(role)}.header`);
  const firebaseRoles = new Map();
  const envs = () => {
    // The app's own folder first: in a monorepo the root's env file is not the backend's.
    const homes = [appDir(), root];
    const own = homes.flatMap((h) => [envFiles.find((f) => dirname(f) === h && basename(f) === ".env"), envFiles.find((f) => dirname(f) === h)]).find(Boolean) ?? envFiles[0];
    return { path: own ?? join(root, ".env"), all: [process.env, ...envFiles.map(readEnv)] };
  };
  const keep = (role, header, value) => { writeFileSync(headerFile(role), `${header}: ${value}\n`, { mode: 0o600 }); keepSecret(value.replace(/^Bearer\s+/i, "")); };

  async function firebase(row) {
    const { all } = envs();
    const merged = Object.assign({}, ...[...all].reverse());
    if (merged.FIREBASE_AUTH_EMULATOR_HOST) return row;
    const account = serviceAccountOf(merged);
    const apiKey = webApiKeyOf(all);
    if (!account || !apiKey) return { ...row, status: "absent", note: !account ? "no Firebase admin credential in your environment" : "no Firebase web API key in your environment" };
    const got = await firebaseIdToken(account, apiKey).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
    if (!got.idToken) return { ...row, status: "refused", note: `your Firebase project refused the sign-in: ${got.error}` };
    keep(row.role, row.header, `Bearer ${got.idToken}`);
    if (!firebaseRoles.has(row.role)) say(`signed in to your app as a test user it can tell apart (${TEST_UID}, in your own Firebase project)`);
    firebaseRoles.set(row.role, { header: row.header, at: Date.now() });
    return { ...row, status: "minted", door: "your Firebase project", expires: Math.floor(Date.now() / 1000) + 3600 };
  }

  async function mint(body, port) {
    const recipes = Array.isArray(body?.recipes) ? body.recipes.slice(0, 12) : [];
    if (!recipes.length || !port) return { identities: [] };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = join(dir, "bl-identities.json");
    rmSync(out, { force: true });
    // ponytail: the program is Python, as it is in the sandbox. A machine without python3 mints
    // nothing and says so; port the program to this file if that turns out to be common.
    // A Firebase caller with no emulator on this machine is signed in at their real project, below.
    // Handed to the program it waited its whole deadline on an emulator that was never there, and
    // one app's sign-in arrived after the world had given up waiting for it.
    const merged = Object.assign({}, ...[...envs().all].reverse());
    const emulated = Boolean(merged.FIREBASE_AUTH_EMULATOR_HOST);
    const refused = new Map();
    for (const r of recipes) { const why = refusal(r, merged, (value) => inSource(root, sourceFiles(), value)); if (why && typeof r?.role === "string") refused.set(r.role, why); }
    const forProgram = recipes.filter((r) => !refused.has(r?.role) && (r?.kind !== "firebase" || emulated));
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
      const row = known.get(recipe.role) ?? (recipe.kind === "firebase" && !emulated ? { ...blank, status: "upstream" } : { ...blank, status: ran ? "unreachable" : "absent", ...(ran ? {} : { note: "python3 is not installed on this machine" }) });
      rows.push(recipe.kind === "firebase" && row.status !== "minted" ? await firebase(row) : row);
    }
    for (const row of rows) if (row.status === "minted" && existsSync(headerFile(row.role))) keepSecret(readFileSync(headerFile(row.role), "utf8").split(": ").slice(1).join(": ").trim().replace(/^Bearer\s+/i, ""));
    return { identities: rows };
  }

  // The header a role speaks with, or nothing. A Firebase token lives an hour; it is renewed here
  // when a run outlasts it.
  async function headerFor(role) {
    if (!ROLE.test(role)) return null;
    const fb = firebaseRoles.get(role);
    if (fb && Date.now() - fb.at > 50 * 60_000) await firebase({ role, header: fb.header, kind: "firebase" }).catch(() => null);
    // A token the app's door issued, or a credential that is itself one of their secrets (an admin
    // key). In the sandbox the second never leaves the box; here it never leaves this machine, which
    // is the same promise, because this is where the request is sent from.
    const file = [headerFile(role), headerFile(role).replace(/\.header$/, ".sealed")].find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
    if (!file) return null;
    const line = readFileSync(file, "utf8").split("\n")[0] ?? "";
    const at = line.indexOf(": ");
    return at > 0 ? { name: line.slice(0, at).trim().toLowerCase(), value: line.slice(at + 2).trim() } : null;
  }

  return { mint, headerFor };
}
