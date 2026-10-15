import { readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { listingUrl } from "./listing.mjs";

// An env file read the way dotenv and python-dotenv read one: comments and `export` dropped, a quoted
// value kept whole across lines, an unquoted one cut at " #", ${NAME} filled from the names above it
// and then from `outer`. A bare $ is kept as written, as dotenv keeps it: "pa$$word" and a bcrypt hash
// are values, not references. A quote that never closes is the line as written. A line-by-line read
// handed an app the first line of a quoted PEM key and an unquoted value with its comment still on it.
export function parseEnv(text, outer = {}) {
  const out = {};
  const fill = (value) => value.replace(/(\\?)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, escaped, name) => (escaped ? whole.slice(1) : out[name] ?? outer[name] ?? ""));
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[2];
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let body = rest.slice(1);
      let j = i;
      while (!closes(body, quote) && j + 1 < lines.length) body += `\n${lines[++j]}`;
      const end = closes(body, quote);
      if (end) {
        i = j;
        const raw = body.slice(0, end - 1);
        out[m[1]] = quote === "'" ? raw : fill(raw).replace(/\\n/g, "\n").replace(/\\(["\\$])/g, "$1");
        continue;
      }
    }
    out[m[1]] = fill(rest.replace(/\s+#.*$/, "").trim());
  }
  return out;
}
// One past the closing quote, or 0 when the value has none yet. A double quote escaped by a backslash
// does not close it.
function closes(body, quote) {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") { i++; continue; }
    if (body[i] === quote) return i + 1;
  }
  return 0;
}

const read = (file, outer) => { try { return parseEnv(readFileSync(file, "utf8"), outer); } catch { return {}; } };
const PLACEHOLDERS = /\.(?:example|sample)$/;

// The folders from the app's own up to the repository root, nearest first.
const upFrom = (appDir, root) => {
  const dirs = [];
  for (let d = appDir; ; d = dirname(d)) {
    dirs.push(d);
    if (d === root || !d.startsWith(root + sep) || dirname(d) === d) return dirs;
  }
};

// What a start by hand gives the app from its env files: the `.env` nearest the app, as `source .env`
// does for an app with no loader of its own. A name another env file there sets to another value is
// left to the app's own loader, which reads its files by its own mode and order: put in the process,
// it outranks that loader (the process wins in dotenv, python-dotenv, pydantic-settings, Next and
// Vite). Nitham's app reads .env.test then .env.local; the test file's key, handed over this way,
// was refused on every call it made under Cortad and on none started by hand.
export function appEnv(envFiles, appDir, root, outer = {}) {
  const base = upFrom(appDir, root).map((d) => join(d, ".env")).find((f) => envFiles.includes(f));
  if (!base) return {};
  const values = read(base, outer);
  const beside = envFiles.filter((f) => f !== base && !PLACEHOLDERS.test(f) && (dirname(f) === dirname(base) || dirname(f) === appDir));
  for (const file of beside) {
    for (const [name, value] of Object.entries(read(file, outer))) if (name in values && values[name] !== value) delete values[name];
  }
  return values;
}

// The real env files in the app's folders, lowest first, the way dotenv-flow, Next and Vite rank them
// in development: .env, then the development file, then .env.local, and the file of the mode the shell
// names above all. A test, staging or stage file of another mode goes under them all and still counts:
// Nitham's app reads .env.test in its local mode, and a store only it names is a store the app writes
// into. Placeholders are left out.
const RANK = { ".env": 1, ".env.development": 2, ".env.dev": 2, ".env.local": 3, ".env.development.local": 4 };
const MODE_FILE = /^\.env\.(test|staging|stage)$/;
export function rankedFiles(envFiles, appDir, root, mode = "") {
  const dirs = upFrom(appDir, root).reverse();
  const want = mode.toLowerCase() === "staging" ? "stage" : mode.toLowerCase();
  const rank = (f) => {
    const name = basename(f);
    const m = MODE_FILE.exec(name);
    if (m) return (m[1] === "staging" ? "stage" : m[1]) === want ? 5 : 0;
    return RANK[name] ?? -1;
  };
  return envFiles.filter((f) => dirs.includes(dirname(f)) && !PLACEHOLDERS.test(f) && rank(f) >= 0)
    .sort((a, b) => dirs.indexOf(dirname(a)) - dirs.indexOf(dirname(b)) || rank(a) - rank(b));
}

// The values the app's settings could settle on, ranked as above: for reading which stores and ports
// the app names, and for a shell that cannot read the files itself. `outer` names the mode and fills ${NAME}.
export function localEnv(envFiles, appDir, root, outer = {}) {
  const mode = outer.ENV ?? outer.APP_ENV ?? outer.NODE_ENV ?? outer.ENVIRONMENT ?? "";
  return Object.assign({}, ...rankedFiles(envFiles, appDir, root, mode).map((f) => read(f, outer)));
}

// Each real env file in the app's folders, read whole: a key is only ever sent with the address the
// same file gives it, or one the app's development files give every key.
export function fileValues(envFiles, appDir, root, outer = {}) {
  const dirs = upFrom(appDir, root);
  return envFiles.filter((f) => dirs.includes(dirname(f)) && !PLACEHOLDERS.test(f)).map((f) => read(f, outer));
}

// The values a development start reads whatever its mode: .env, the development files and .env.local,
// never a test, staging or stage file.
export function devEnv(envFiles, appDir, root, outer = {}) {
  return Object.assign({}, ...rankedFiles(envFiles, appDir, root).filter((f) => !MODE_FILE.test(basename(f))).map((f) => read(f, outer)));
}

// The key and address pairs a provider's model listing is asked with: the shell's key, else each
// distinct key a file holds. A key goes only to the address the shell or its own file names, else the
// one the development files name, else the provider's own; where only a test or staging file names
// an address, which the app may not use, the key is not sent at all.
export function keyTries(name, canonical, { shell, files, dev }) {
  const prefix = name.replace(/_API_KEY$/, "");
  const named = (v) => Boolean(v[`${prefix}_BASE_URL`] || v[`${prefix}_API_BASE`]);
  const addressFor = (own) => (named(shell) || named(own) || named(dev) || !files.some(named) ? listingUrl(name, canonical, { ...dev, ...own, ...shell }) : null);
  return [...new Map((shell[name] ? [shell] : files.filter((v) => v[name]))
    .map((v) => ({ key: v[name], url: addressFor(v) })).filter((t) => t.url).map((t) => [`${t.url} ${t.key}`, t])).values()];
}
