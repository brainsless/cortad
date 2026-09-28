// Your app's own database, kept out of the run's way. A run creates people, conversations and
// records by the hundred; written into the file your app keeps its real data in, they stay there
// after the run. So an app started here runs against a copy of its database file, made in this
// command's own temp folder and pointed at through the same variable, and the original is never
// opened. What cannot be copied (a database server, a file your code names with no variable in
// front of it, an app that was already running) is said before the first run, in one sentence.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const FILE_DB = /\.(?:db|sqlite3?|duckdb)$/i;
// sqlite:///x.db (SQLAlchemy, relative), sqlite:////abs/x.db, sqlite+aiosqlite:///x.db, file:./dev.db (Prisma, libsql).
const FILE_URL = /^(sqlite(?:\+\w+)?:\/\/\/|file:(?:\/\/(?=\/))?)([^?]*)(\?.*)?$/i;
const SERVER_URL = /^(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|mssql|sqlserver|cockroachdb)(?:\+\w+)?:\/\//i;
const ENGINE = { postgres: "Postgres", postgresql: "Postgres", cockroachdb: "CockroachDB", mysql: "MySQL", mariadb: "MariaDB", mongodb: "MongoDB", "mongodb+srv": "MongoDB", mssql: "SQL Server", sqlserver: "SQL Server" };

// What one value names: a database file (with how to write the value again for another path), a
// database server, or nothing.
export function databaseOf(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const server = SERVER_URL.exec(v);
  if (server) return { server: ENGINE[server[1].toLowerCase()] ?? server[1] };
  const url = FILE_URL.exec(v);
  if (url) {
    const path = decodeURIComponent(url[2]);
    if (!path || path === ":memory:" || path.startsWith(":memory")) return null;
    return { path, write: (to) => `${url[1]}${to}${url[3] ?? ""}`, prisma: /^file:/i.test(url[1]) };
  }
  if (!v.includes("://") && FILE_DB.test(v)) return { path: v, write: (to) => to };
  return null;
}

// A folder the app keeps its data in, named by a variable (DATA_DIR=./data): a database file sits
// directly inside it. The whole folder is the database then, uploads and backups beside it.
const FOLDER_NAME = /DATA|DB|DATABASE|STORAGE|STORE|PERSIST|SQLITE|DUCK/i;
function dataFolder(name, value, dirs, appDir, root) {
  const v = String(value ?? "").trim();
  if (!FOLDER_NAME.test(name) || !v || v.includes("://") || FILE_DB.test(v) || !/^[.~/\w]/.test(v)) return null;
  for (const place of [appDir, ...dirs].map((d) => resolve(d, v))) {
    if (place === root || place === appDir || !place.startsWith(root + "/")) continue;
    let names;
    try { if (!statSync(place).isDirectory()) continue; names = readdirSync(place); } catch { continue; }
    if (names.some((n) => FILE_DB.test(n))) return place;
  }
  return null;
}
const sizeOf = (dir, cap) => {
  let total = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (total > cap) return; const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) total += statSync(p).size; } };
  try { walk(dir); } catch { /* counted what it could */ }
  return total;
};

// A name the code reads with a default written beside it: os.getenv("DATABASE_URL", "sqlite:///./app.db"),
// process.env.DB_PATH ?? "./data.db". With nothing in the environment, the default is the database.
const DEFAULTED = /(?:os\.(?:environ\.get|getenv)|\bgetenv)\(\s*['"]([A-Za-z_]\w*)['"]\s*,\s*['"]([^'"\n]+)['"]|process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([A-Za-z_]\w*)['"]\s*\])\s*(?:\?\?|\|\|)\s*['"]([^'"\n]+)['"]/g;
// A database file opened by a path written in the code, with no variable in front of it.
const OPENED = /(?:sqlite3\.connect|aiosqlite\.connect|duckdb\.connect|new\s+(?:sqlite3\.)?Database|create_(?:async_)?engine)\(\s*['"]([^'"\n]+)['"]/g;
export const CODE = /\.(?:[cm]?[jt]sx?|py|rb|go|php)$/;
// A test opens its own scratch file; that is not where the app keeps its data.
export const TEST = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|[._-](?:test|spec)\.[^/]+$|(?:^|\/)(?:test_[^/]+|conftest)\.py$/;
// A folder bigger than this is not copied: said instead, so the person decides.
const FOLDER_CAP = 1024 ** 3;

function scan(sources) {
  const defaults = {};
  const opened = [];
  for (const file of sources) {
    if (!CODE.test(file) || TEST.test(file)) continue;
    let text = "";
    try { if (statSync(file).size > 512_000) continue; text = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(DEFAULTED)) {
      const name = m[1] ?? m[3] ?? m[4];
      const value = m[2] ?? m[5];
      if (name && !(name in defaults) && databaseOf(value)) defaults[name] = value;
    }
    for (const m of text.matchAll(OPENED)) { const db = databaseOf(m[1]); if (db?.path) opened.push({ file, path: db.path }); }
  }
  return { defaults, opened };
}

// Where a relative path lands. The app's own folder first, which is where it runs; then the folder
// of the env file that named it, which some settings loaders resolve against; for Prisma, the folder
// its schema lives in. The first place the file exists is the one; none, and it is the app's folder.
function located(db, dirs, appDir) {
  if (isAbsolute(db.path)) return db.path;
  const prisma = db.prisma ? [join(appDir, "prisma")] : [];
  const places = [...prisma, appDir, ...dirs].map((d) => resolve(d, db.path));
  return places.find((p) => existsSync(p)) ?? places[0];
}

// values: the environment the app will start with, names to values. from: the env file each name
// was read from, when there is one. Returns the variables to start the app with, and what to say.
export function keepData({ values, from = {}, appDir, root = appDir, work, sources = [], started = true }) {
  const { defaults, opened } = scan(sources);
  const all = { ...defaults, ...values };
  const env = {};
  const copied = [];
  const said = [];
  const moved = new Set();
  const rel = (p) => relative(root, p) || basename(p);
  for (const [name, value] of Object.entries(all)) {
    const db = databaseOf(value);
    const folder = db ? null : dataFolder(name, value, from[name] ? [dirname(from[name])] : [], appDir, root);
    if (folder) {
      moved.add(folder);
      if (!started) { said.push(`Your app was already running when this command started, so it writes to its own data folder, ${rel(folder)}/: trials write into it. Stop your app and run the command again to run against a copy.`); continue; }
      if (sizeOf(folder, FOLDER_CAP) > FOLDER_CAP) { said.push(`Your data folder ${rel(folder)}/ (${name}) is over 1 GB, so it is not copied: trials write into it.`); continue; }
      const to = join(work, "data", String(copied.length), basename(folder));
      cpSync(folder, to, { recursive: true });
      env[name] = to;
      copied.push({ name, from: folder, to });
      said.push(`Your app runs against a copy of its data folder ${rel(folder)}/, through ${name}; the original is not touched.`);
      continue;
    }
    if (!db) continue;
    if (db.server) {
      said.push(`Trials write into the ${db.server} database ${name} names: a database server cannot be copied here, so what a run creates stays in it. Point ${name} at a scratch database before a run if that one holds real data.`);
      continue;
    }
    const original = located(db, from[name] ? [dirname(from[name])] : [], appDir);
    moved.add(original);
    if (!started) {
      said.push(`Your app was already running when this command started, so it writes to its own database, ${rel(original)}: trials write into it. Stop your app and run the command again to run against a copy.`);
      continue;
    }
    const to = join(work, "data", String(copied.length), basename(original));
    mkdirSync(dirname(to), { recursive: true });
    // The file and the journal beside it: SQLite keeps recent writes in -wal until a checkpoint.
    if (existsSync(original)) for (const tail of ["", "-wal", "-shm", "-journal"]) if (existsSync(original + tail)) copyFileSync(original + tail, to + tail);
    env[name] = db.write(to);
    copied.push({ name, from: original, to });
    said.push(`Your app runs against a copy of ${rel(original)}, through ${name}; the original is not touched.`);
  }
  for (const o of opened) {
    const path = resolve(dirname(o.file), o.path);
    const cwdPath = resolve(appDir, o.path);
    if ([path, cwdPath].some((p) => moved.has(p) || [...moved].some((m) => p.startsWith(m + "/")))) continue;
    moved.add(cwdPath);
    said.push(`Your app opens ${o.path} by a path written in ${rel(o.file)}, with no variable to point it at a copy: trials write into that file.`);
  }
  return { env, copied, said };
}
