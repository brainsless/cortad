// Copied from brainsless-backend src/harness/identities.mjs. Keep the two in step: the recipes the
// cloud sends are gated here again, on the machine that holds the secrets.
// Signing in as the customer's own callers, from inside the box, through their own doors.
//
// A recipe (src/setup/road-identities.ts) names env variables, routes and body fields; never a
// value. This program runs where the app's environment file is, opens the values itself, creates
// an account through their admin door or exchanges their shared password for a token, and keeps
// what their door issued in a header file only the box can read. What it prints is roles and
// statuses: a token the run needs is fetched from the box when a turn first speaks as that role,
// and a credential that IS a sealed value (an admin key) is marked sealed and never leaves. A
// caller Firebase verifies is signed up at the Auth emulator the boot raised in place of their
// project; without that emulator the role stays upstream, verified outside the box.

export const IDENTITY_PATH = "/tmp/bl-identities.py";
export const IDENTITY_OUT = "/tmp/bl-identities.json";
const HEADER_FILE = "/tmp/bl-identity-%s.%s";

const ROLE = /^[a-z][a-z0-9_-]{0,30}(?::[a-z][a-z0-9_-]{0,30})?$/;
const HEADER = /^[a-z][a-z0-9-]{0,40}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ROUTE = /^\/[\w./-]{0,200}$/;
const OPENS = /^\/[\w./{}-]{0,200}$/;
const SOURCE = /^(?:env:[A-Z_][A-Z0-9_]*(?:\|[A-Z_][A-Z0-9_]*)*|gen:(?:username|email|password|name)|role)$/;
// A Next.js route file is spelled with brackets and route groups with parentheses: `app/api/auth/
// [...all]/route.ts (better-auth)` failed the old gate and every catch-all auth recipe was dropped
// before the program saw it. Still no quote, angle bracket, `$`, backtick or semicolon.
const WHERE = /^[\w./:@()[\] -]{1,300}$/;
const BASE = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d{2,5}$/;
const KINDS = new Set(["header", "login", "jwt", "upstream", "firebase"]);
const STATUSES = new Set(["minted", "sealed", "absent", "refused", "unreachable", "upstream"]);

const slug = (role) => role.replace(/[^a-z0-9-]/g, "-");
export const identityHeaderFile = (role) => (ROLE.test(role) ? HEADER_FILE.replace("%s.%s", `${slug(role)}.header`) : null);
// The curl argument a probe inside the box adds to speak as a role: the header line is read there,
// so the value never rides in a command this process composes.
export function identityCurlArg(as) {
  if (as === "browser" || as === "bare" || !ROLE.test(as)) return "";
  return `-H "$(cat ${HEADER_FILE.replace("%s.%s", `${slug(as)}.header`)} ${HEADER_FILE.replace("%s.%s", `${slug(as)}.sealed`)} 2>/dev/null)"`;
}

// Every string the recipes carry reaches the program as base64 JSON, never as source, and only
// after the charset gate: a route or a role is read from a repository.
export function identityScript(recipes, target) {
  const safe = recipes.filter(safeRecipe).slice(0, 12);
  const headers = Object.fromEntries(Object.entries(target.headers ?? {}).filter(([k, v]) => HEADER.test(k) && typeof v === "string" && v.length <= 300 && !/[\r\n]/.test(v)));
  const plan = { envPath: /^[\w./-]+$/.test(target.envPath) ? target.envPath : "/workspace/repo/.env", base: BASE.test(target.base) ? target.base : "http://127.0.0.1:0", headers, recipes: safe };
  return PROGRAM
    .replace("__PLAN__", Buffer.from(JSON.stringify(plan), "utf8").toString("base64"))
    .replace("__OUT__", IDENTITY_OUT)
    .replace("__FILE__", HEADER_FILE);
}

function safeRecipe(r) {
  const step = (s) => s && ROUTE.test(s.route)
    && Object.entries(s.headers ?? {}).every(([k, v]) => HEADER.test(k) && SOURCE.test(v))
    && Object.entries(s.body ?? {}).every(([k, v]) => /^[A-Za-z_][\w]{0,40}$/.test(k) && SOURCE.test(v));
  return r && KINDS.has(r.kind) && ROLE.test(r.role) && HEADER.test(r.header) && WHERE.test(r.where)
    && (r.env ?? []).every((n) => ENV_NAME.test(n))
    && (r.roles ?? []).every((v) => /^[a-z][a-z0-9_-]{0,30}$/.test(v))
    && (r.opens ?? []).every((o) => OPENS.test(o))
    && (r.steps ?? []).every(step) && (r.alt ?? []).every(step)
    && (r.claim === undefined || /^[a-z_][a-z0-9_]{0,30}$/i.test(r.claim));
}

const PROGRAM = String.raw`import base64, hashlib, hmac, http.cookiejar, json, os, re, secrets, time, urllib.error, urllib.request

PLAN = json.loads(base64.b64decode("__PLAN__").decode("utf-8"))
OUT = "__OUT__"
FILE = "__FILE__"
TTL = 6 * 3600
# Digits only: an account column is an integer in Strapi, Django and Rails, and a word here makes
# the database itself raise. Nonerds crashed its whole process on "cortad-test-user". Digits are a
# valid string id too, so this one value fits both kinds of account table.
TEST = "9000001"
# A dev server compiles its auth route on the first request: better-chatbot's sign-in timed out at 10s
# and the caller was filed unreachable. The whole program stays inside the step's two minutes.
DEADLINE = time.time() + 100
SIGNUP = "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=standin"


def read_env(path):
    out = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
                if not m:
                    continue
                v = m.group(2).strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[m.group(1)] = v
    except OSError:
        pass
    return out


def slug(role):
    return re.sub(r"[^a-z0-9-]", "-", role)


def gen(role):
    tag = secrets.token_hex(4)
    return {
        "username": "cortad-%s-%s" % (slug(role), tag),
        "email": "cortad-%s-%s@example.invalid" % (slug(role), tag),
        "password": secrets.token_urlsafe(18) + "A1!",
        "name": "Cortad test %s" % role,
    }


def source(spec, env, g, role):
    if spec.startswith("env:"):
        for name in spec[4:].split("|"):
            if env.get(name):
                return env[name]
        return None
    return {"gen:username": g["username"], "gen:email": g["email"], "gen:password": g["password"], "gen:name": g["name"], "role": role}.get(spec)


def names(spec):
    return spec[4:].replace("|", " or ") if spec.startswith("env:") else spec


def call(path, headers, body, jar, base=None):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request((base or PLAN["base"]) + path, data=json.dumps(body).encode("utf-8"), method="POST")
    for k, v in list(PLAN["headers"].items()) + list(headers.items()):
        req.add_header(k, v)
    req.add_header("content-type", "application/json")
    try:
        with opener.open(req, timeout=40) as r:
            return r.status, r.read(200000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        # The door's own sentence rides the refusal: a 500 with no body told nobody what the
        # sign-up died on.
        try:
            return e.code, e.read(4000).decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return 0, type(e).__name__


def token_in(value, depth=0):
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, str) and v and re.fullmatch(r"(?i)(access_?token|token|jwt|session_?token|id_?token|api_?key)", k):
                return v
        if depth < 2:
            for v in value.values():
                found = token_in(v, depth + 1)
                if found:
                    return found
    return None


def bearer(header, value):
    if header == "authorization" and not value.lower().startswith("bearer "):
        return "Bearer " + value
    return value


def minted(header, value, ttl=TTL):
    return {"status": "minted", "header": header, "line": "%s: %s" % (header, bearer(header, value)), "expires": int(time.time()) + ttl}


# The account is named after the identity, not the role slot: staff:sales and sales are two callers
# at two doors, and their door reads the name back on every login.
def login(recipe, role, role_value, env):
    g = gen(role)
    ways = [recipe["steps"]] + ([recipe["alt"]] if recipe.get("alt") else [])
    for way in ways:
        last = ways[-1] is way
        got = walk(way, recipe, env, g, role_value)
        if got.get("status") != "refused" or last:
            return got
    return got


def walk(steps, recipe, env, g, role_value):
    jar = http.cookiejar.CookieJar()
    status, token = 0, None
    for step in steps:
        headers = {}
        # A token the previous step minted signs this one: the key route wants the session that
        # just logged in, and a cookie jar alone does not carry a bearer.
        if token:
            headers[recipe["header"]] = bearer(recipe["header"], token)
        for h, spec in step.get("headers", {}).items():
            v = source(spec, env, g, role_value)
            if v is None:
                return {"status": "absent", "note": names(spec)}
            headers[h] = v
        body = {}
        unset = None
        for field, spec in step["body"].items():
            v = source(spec, env, g, role_value)
            if v is None:
                if not spec.startswith("env:"):
                    return {"status": "absent", "note": names(spec)}
                # A switch in their code may make this one optional: ask without it, and a refusal
                # is then the variable they did not seal, not their door.
                unset = names(spec)
                continue
            body[field] = v
        status, text = call(step["route"], headers, body, jar)
        if status == 0:
            return {"status": "unreachable", "note": text}
        if status >= 400 and unset:
            return {"status": "absent", "note": unset}
        if status >= 400:
            said = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text or "")).strip()[:160]
            return {"status": "refused", "note": "HTTP %d at %s%s" % (status, step["route"], (": " + said) if said else "")}
        try:
            found = token_in(json.loads(text))
        except ValueError:
            found = None
        # A step that mints nothing keeps what the step before it minted.
        token = found or token
    cookies = "; ".join("%s=%s" % (c.name, c.value) for c in jar)
    # A cookie door reads its cookie by name. better-auth's sign-in answers a token AND sets
    # better-auth.session_token; sending the bare token as the cookie header named nothing, so its
    # proxy redirected every signed-in knock to the sign-in page.
    if recipe["header"] == "cookie" and cookies:
        return minted("cookie", cookies)
    if token:
        return minted(recipe["header"], token)
    if cookies:
        # ponytail: the cookie alone; a CSRF token their form also wants is the next thing to carry.
        return minted("cookie", cookies)
    return {"status": "refused", "note": "HTTP %d with no token in the reply" % status}


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def jwt(recipe, env):
    secret = source("env:" + "|".join(recipe["env"]), env, None, None)
    if not secret:
        return {"status": "absent", "note": " or ".join(recipe["env"])}
    now = int(time.time())
    # On their own machine the database is theirs and live: the token names a test id that belongs
    # to nobody, never account 1, which is usually the person who built the app. (The sandbox copy
    # of this program signs account 1 of a restored copy; this one differs on purpose.)
    claims = {"sub": TEST, "id": TEST, "iat": now, "exp": now + TTL}
    claim = recipe.get("claim") or "sub"
    if claim not in claims:
        claims[claim] = TEST
    head = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode("utf-8"))
    body = b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    sig = b64url(hmac.new(secret.encode("utf-8"), ("%s.%s" % (head, body)).encode("ascii"), hashlib.sha256).digest())
    return minted("authorization", "%s.%s.%s" % (head, body, sig))


# The Auth emulator the boot raised in place of their Firebase project: it signs any address up
# under any key, and firebase-admin accepts its tokens while FIREBASE_AUTH_EMULATOR_HOST is set.
def firebase(recipe, role, env):
    host = env.get("FIREBASE_AUTH_EMULATOR_HOST", "")
    if not re.fullmatch(r"[\w.-]+:\d{2,5}", host):
        return {"status": "upstream", "note": "Firebase"}
    g = gen(role)
    status, text = call(SIGNUP, {}, {"email": g["email"], "password": g["password"], "returnSecureToken": True}, http.cookiejar.CookieJar(), "http://" + host)
    if status == 0:
        return {"status": "unreachable", "note": text}
    try:
        reply = json.loads(text)
    except ValueError:
        reply = {}
    token = reply.get("idToken") if isinstance(reply, dict) else None
    if not isinstance(token, str) or not token:
        return {"status": "refused", "note": "HTTP %d at the Firebase emulator" % status}
    return minted(recipe["header"], token, int(reply.get("expiresIn") or 3600))


def sealed(recipe, env):
    v = source("env:" + "|".join(recipe["env"]), env, None, None)
    if not v:
        return {"status": "absent", "note": " or ".join(recipe["env"])}
    return {"status": "sealed", "header": recipe["header"], "line": "%s: %s" % (recipe["header"], bearer(recipe["header"], v)), "note": " or ".join(recipe["env"])}


def keep(path, line):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(line + "\n")


# A token their door issued earlier and still honours is reused: sign-in doors are rate limited,
# and a run re-minting on every boot would spend that budget on itself.
def previous():
    try:
        with open(OUT, encoding="utf-8") as f:
            rows = json.load(f)["identities"]
    except Exception:
        return {}
    now = time.time()
    out = {}
    for r in rows:
        if r.get("status") not in ("minted", "sealed"):
            continue
        if not os.path.exists(FILE % (slug(r["role"]), "header" if r["status"] == "minted" else "sealed")):
            continue
        if r.get("expires") is not None and r["expires"] < now + 60:
            continue
        out[r["role"]] = r
    return out


def main():
    env = read_env(PLAN["envPath"])
    kept = previous()
    rows = []
    for recipe in PLAN["recipes"]:
        for role_value in recipe.get("roles") or [None]:
            role = "%s:%s" % (recipe["role"], role_value) if role_value else recipe["role"]
            steps = recipe.get("steps") or []
            base = {
                "role": role, "kind": recipe["kind"], "header": recipe["header"], "where": recipe["where"],
                "opens": [o.replace("{role}", role_value or "") for o in recipe.get("opens", [])],
                "door": steps[-1]["route"] if steps else SIGNUP if recipe["kind"] == "firebase" else recipe["header"],
            }
            if role in kept:
                rows.append(dict(base, **{k: v for k, v in kept[role].items() if k in ("status", "header", "expires", "note")}))
                continue
            if time.time() > DEADLINE:
                rows.append(dict(base, status="unreachable", note="out of time"))
                continue
            try:
                if recipe["kind"] == "header":
                    got = sealed(recipe, env)
                elif recipe["kind"] == "jwt":
                    got = jwt(recipe, env)
                elif recipe["kind"] == "login":
                    got = login(recipe, role, role_value, env)
                elif recipe["kind"] == "firebase":
                    got = firebase(recipe, role, env)
                else:
                    got = {"status": "upstream", "note": " or ".join(recipe["env"]) or recipe["role"]}
            except Exception as err:
                got = {"status": "unreachable", "note": type(err).__name__}
            line = got.pop("line", None)
            if line:
                keep(FILE % (slug(role), "header" if got["status"] == "minted" else "sealed"), line)
            rows.append(dict(base, **got))
    report = {"identities": rows}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f)
    print("BL_IDENTITIES " + json.dumps(report))


main()
`;

// The one line the program wrote, as typed rows. Anything malformed is dropped rather than read,
// and nothing here is a value: a role, a header name, a status, a door.
export function parseIdentityReport(text) {
  const line = String(text ?? "").split("\n").find((l) => l.startsWith("BL_IDENTITIES {")) ?? (String(text ?? "").trim().startsWith("{") ? `BL_IDENTITIES ${String(text).trim()}` : null);
  if (!line) return null;
  let raw;
  try {
    raw = JSON.parse(line.slice("BL_IDENTITIES ".length));
  } catch {
    return null;
  }
  if (!Array.isArray(raw?.identities)) return null;
  const identities = raw.identities.flatMap((r) => {
    if (!r || !ROLE.test(String(r.role)) || !KINDS.has(r.kind) || !HEADER.test(String(r.header)) || !STATUSES.has(r.status)) return [];
    if (typeof r.where !== "string" || !WHERE.test(r.where) || typeof r.door !== "string" || r.door.length > 200) return [];
    const opens = (Array.isArray(r.opens) ? r.opens : []).filter((o) => typeof o === "string" && OPENS.test(o)).slice(0, 8);
    return [{
      role: r.role, kind: r.kind, header: r.header, status: r.status, opens, door: r.door, where: r.where,
      ...(Number.isFinite(r.expires) ? { expires: Number(r.expires) } : {}),
      ...(typeof r.note === "string" ? { note: r.note.slice(0, 200) } : {}),
    }];
  });
  return { identities };
}

// What each row means to the person whose app this is.
export function identitySentence(row) {
  switch (row.status) {
    case "minted": return row.kind === "firebase"
      ? `signed in as ${row.role} through the Firebase emulator standing in for your project; the token stays inside the sandbox`
      : `signed in as ${row.role} through your own door ${row.door}; the token stays inside the sandbox`;
    case "sealed": return `${row.role} is the sealed ${row.note} value itself; it never leaves the sandbox, so only the compile's own probe can speak as it`;
    case "absent": return `could not sign in as ${row.role}: ${row.note} is not in the environment you sealed`;
    case "refused": return `your door refused the ${row.role} sign-in (${row.note}), so cases behind it are counted and not driven`;
    case "unreachable": return `the ${row.role} sign-in at ${row.door} did not answer (${row.note}); that is ours to look at`;
    default: return `${row.role} callers are verified by ${row.note}, outside this sandbox; their doors are counted and not driven`;
  }
}

// Write the program, run it detached, read the report back, and leave only the header files and
// the report the next mint reuses.
export async function mintInBox(box, recipes, target) {
  if (!(await box.write(IDENTITY_PATH, identityScript(recipes, target)))) return null;
  await box.run("bl-identities", `python3 ${IDENTITY_PATH}`).catch(() => null);
  const out = await box.exec(`cat ${IDENTITY_OUT} 2>/dev/null; rm -f ${IDENTITY_PATH}`).catch(() => "");
  return parseIdentityReport(out);
}
