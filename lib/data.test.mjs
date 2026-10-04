import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { databaseOf, keepData } from "./data.mjs";

const tree = (files) => { const root = realpathSync(mkdtempSync(join(tmpdir(), "data-"))); for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); } return root; };
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("a value names a database file, or nothing: a server is lib/stores.mjs's", () => {
  assert.equal(databaseOf("sqlite:///./bloom.db").path, "./bloom.db");
  assert.equal(databaseOf("sqlite:///./bloom.db").write("/tmp/x/bloom.db"), "sqlite:////tmp/x/bloom.db");
  assert.equal(databaseOf("sqlite+aiosqlite:///data/app.db?timeout=5").write("/w/app.db"), "sqlite+aiosqlite:////w/app.db?timeout=5");
  assert.equal(databaseOf("file:./dev.db").prisma, true);
  assert.equal(databaseOf("./data/store.sqlite3").path, "./data/store.sqlite3");
  assert.equal(databaseOf("postgresql://u:p@db.example.com:5432/app"), null);
  assert.equal(databaseOf("sqlite:///:memory:"), null);
  assert.equal(databaseOf("https://api.openai.com/v1"), null);
});

test("a file the code opens by its own path is named, and a server named only in the code is handed on as a setting", () => {
  const root = tree({ "app.py": "import os, sqlite3\nconn = sqlite3.connect(\"cache.db\")\nDB = os.getenv(\"DATABASE_URL\", \"postgres://app:secret@localhost:5432/app\")\n" });
  const out = keepData({ values: {}, appDir: root, work: join(root, ".w"), sources: [join(root, "app.py")] });
  assert.deepEqual(out.env, {});
  assert.equal(out.values.DATABASE_URL, "postgres://app:secret@localhost:5432/app");
  assert.equal(out.said.length, 1);
  assert.match(out.said[0], /opens cache\.db by a path written in app\.py.*trials write into that file/);
});

test("a database named only by a default in the code is copied too, and an app already running is told, not copied", () => {
  const root = tree({ "config.py": "import os\nDATABASE_URL = os.getenv(\"DATABASE_URL\", \"sqlite:///./local.db\")\n", "local.db": "x" });
  const copied = keepData({ values: {}, appDir: root, work: join(root, ".w"), sources: [join(root, "config.py")] });
  assert.equal(copied.env.DATABASE_URL, `sqlite:///${join(root, ".w", "data", "0", "local.db")}`);
  const attached = keepData({ values: {}, appDir: root, work: join(root, ".w2"), sources: [join(root, "config.py")], started: false });
  assert.deepEqual(attached.env, {});
  assert.match(attached.said[0], /already running.*local\.db: trials write into it/);
});

test("a folder the app keeps its database in is copied whole, and a test's scratch file is not the app's", () => {
  const root = tree({ "data/app.sqlite": "x", "data/assets/logo.txt": "y", "tests/api.test.ts": "const db = new Database(\"./scratch.sqlite\");\n" });
  const out = keepData({ values: { DATA_DIR: "./data" }, appDir: root, work: join(root, ".w"), sources: [join(root, "tests/api.test.ts")] });
  assert.equal(out.env.DATA_DIR, join(root, ".w", "data", "0", "data"));
  assert.equal(readFileSync(join(out.env.DATA_DIR, "assets", "logo.txt"), "utf8"), "y");
  assert.deepEqual(out.said, ["Your app runs against a copy of its data folder data/, through DATA_DIR; the original is not touched, and the copy is deleted when this command ends and made again from the original at the next connect."]);
});

// The whole command, with a stand-in for our API: it starts a tiny app that writes one row to the
// SQLite file its .env names on every request, the way a run's trials do, and the original file
// comes out byte for byte what it went in as.
test("the app the command starts writes to a copy of its database and the original is unchanged", { timeout: 90_000 }, async () => {
  const root = tree({
    "package.json": JSON.stringify({ name: "notes", scripts: { dev: "node server.mjs" } }),
    ".env": "DATABASE_URL=sqlite:///./notes.db\n",
    "server.mjs": [
      "import { createServer } from \"node:http\";",
      "import { DatabaseSync } from \"node:sqlite\";",
      "const db = new DatabaseSync(process.env.DATABASE_URL.replace(/^sqlite:\\/\\/\\//, \"\"));",
      "createServer((req, res) => { db.exec(\"insert into notes(body) values ('written by a trial')\"); res.end(String(db.prepare(\"select count(*) as n from notes\").get().n)); }).listen(0, \"127.0.0.1\");",
    ].join("\n"),
  });
  const original = join(root, "notes.db");
  const seed = new DatabaseSync(original);
  seed.exec("create table notes(id integer primary key, body text); insert into notes(body) values ('a real note')");
  seed.close();
  const before = sha(original);

  const home = mkdtempSync(join(tmpdir(), "data-home-"));
  const project = createHash("sha256").update(root).digest("hex").slice(0, 16);
  mkdirSync(join(home, ".cortad", project), { recursive: true });
  writeFileSync(join(home, ".cortad", project, "token"), "machine-key");

  let announced = null;
  const got = new Promise((ok) => {
    const api = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)); };
      if (req.url === "/api/local/attach") return reply(200, { box: "lo_0123456789abcdef01234567", key: "k" });
      if (req.url.startsWith("/api/local/lo_0123456789abcdef01234567/tree")) return reply(200, { id: "c", resumed: true });
      if (req.url.endsWith("/app")) { announced = JSON.parse(body); ok(announced); return reply(200, { jobId: "j" }); }
      if (req.url.includes("/jobs")) return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
      return reply(200, { ok: true });
    }).listen(0, "127.0.0.1");
    api.unref();
    api.on("listening", () => startCommand(api.address().port));
  });
  let command;
  const startCommand = (port) => {
    command = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs"), "--token"], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ["ignore", "pipe", "pipe"],
    });
    command.stdout.on("data", (d) => { out += d; });
    command.stderr.on("data", (d) => { out += d; });
  };
  let out = "";
  try {
    const app = await got;
    assert.ok(app.data.some((line) => /runs against a copy of notes\.db, through DATABASE_URL; the original is not touched/.test(line)), JSON.stringify(app.data));
    const n = await (await fetch(`http://127.0.0.1:${app.port}/`)).text();
    assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/`)).text(), String(Number(n) + 1), "the copy took the writes");
    // The command's own "is it answering" knocks are requests too, so the count is at least two.
    assert.ok(Number(n) >= 2, "the copy started with the one real note and took the writes");
    assert.equal(sha(original), before, "the original file is byte for byte what it was");
    const check = new DatabaseSync(original, { readOnly: true });
    assert.equal(check.prepare("select count(*) as n from notes").get().n, 1);
    check.close();
    assert.match(out, /your app runs against a copy of notes\.db/);
  } finally {
    command?.kill("SIGTERM");
    await new Promise((r) => (command ? command.on("exit", r) : r()));
  }
});
