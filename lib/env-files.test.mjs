import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appEnv, localEnv, parseEnv, rankedFiles, valuesOf } from "./env-files.mjs";
import { connect } from "./connect-kit.mjs";

test("an env file is read as dotenv reads it: quotes across lines, comments, ${NAME}", () => {
  const got = parseEnv([
    "# a comment",
    "export A=plain # trailing",
    'PEM="-----BEGIN KEY-----',
    "abc",
    '-----END KEY-----"',
    "Q='single $A'",
    'D="line\\nnext ${A}"',
    "URL=postgres://${USER_X}@h/db",
    "EMPTY=",
  ].join("\n"), { USER_X: "me" });
  assert.equal(got.A, "plain");
  assert.equal(got.PEM, "-----BEGIN KEY-----\nabc\n-----END KEY-----");
  assert.equal(got.Q, "single $A");
  assert.equal(got.D, "line\nnext plain");
  assert.equal(got.URL, "postgres://me@h/db");
  assert.equal(got.EMPTY, "");
});

const tree = (files) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "env-files-")));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); }
  return { root, files: Object.keys(files).filter((f) => /(^|\/)\.env/.test(f)).map((f) => join(root, f)) };
};

test("the app is handed only what .env gives it and no other file there contradicts", () => {
  const { root, files } = tree({
    ".env": "PORT=8000\nOPENAI_API_KEY=sk-base\nONLY_BASE=1\n",
    ".env.test": "OPENAI_API_KEY=sk-test-placeholder\n",
    ".env.local": "OPENAI_API_KEY=sk-real\nONLY_LOCAL=1\n",
    ".env.example": "OPENAI_API_KEY=your-key\nONLY_BASE=2\n",
    "web/.env": "NEXT_ONLY=1\n",
  });
  assert.deepEqual(appEnv(files, root, root), { PORT: "8000", ONLY_BASE: "1" });
  assert.deepEqual(appEnv(files.filter((f) => !f.endsWith("/.env")), root, root), {});
});

test("a local start's files rank .env under .env.local, and a test file under both unless the mode is test", () => {
  const { root, files } = tree({ ".env": "K=base\n", ".env.test": "K=test\nDB_URI=mongodb://localhost:27018/t\n", ".env.local": "K=local\n", ".env.example": "K=x\nZ=1\n", "api/.env": "K=api\n" });
  assert.equal(localEnv(files, root, root, { ENV: "local" }).K, "local");
  assert.equal(localEnv(files, root, root, { ENV: "local" }).DB_URI, "mongodb://localhost:27018/t", "a store only the test file names is still the app's");
  assert.equal(localEnv(files, root, root, { ENV: "local" }).Z, undefined, "a placeholder is nobody's setting");
  assert.equal(localEnv(files, root, root, { ENV: "test" }).K, "test");
  assert.equal(localEnv(files, join(root, "api"), root, {}).K, "api");
  assert.deepEqual(rankedFiles(files, root, root, "local").map((f) => f.slice(root.length + 1)), [".env.test", ".env", ".env.local"]);
});

test("a provider key is tried with the shell's value alone, else with every distinct file value", () => {
  const { root, files } = tree({ ".env.test": "KEY=a\n", ".env.local": "KEY=b\n", ".env.example": "KEY=c\n", "other/.env": "KEY=d\n" });
  assert.deepEqual(valuesOf("KEY", files, root, root, {}).sort(), ["a", "b"]);
  assert.deepEqual(valuesOf("KEY", files, root, root, { KEY: "shell" }), ["shell"]);
});

// Nitham, 2026-10-14: an app that reads .env.test then .env.local itself, with the process winning,
// was handed the test file's key by the connector and OpenAI refused all of its calls.
test("an app that loads its own env files keeps the value its own loader picks", { timeout: 90_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "env-loader-")));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "layered", scripts: { start: "node server.js" } }));
  writeFileSync(join(root, "server.js"), `
    const fs = require("node:fs");
    const http = require("node:http");
    const load = (f) => { try { for (const l of fs.readFileSync(__dirname + "/" + f, "utf8").split("\\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) out[m[1]] = m[2]; } } catch {} };
    const out = {};
    load(".env.test"); load(".env.local");
    const key = process.env.OPENAI_API_KEY || out.OPENAI_API_KEY;
    fs.writeFileSync(__dirname + "/key.seen", key + "\\n" + (process.env.GREETING || ""));
    http.createServer((_q, res) => res.end("ok")).listen(Number(process.env.PORT) || 4641, "127.0.0.1");
  `);
  writeFileSync(join(root, ".env"), "GREETING=hello\n");
  writeFileSync(join(root, ".env.test"), "OPENAI_API_KEY=sk-test-placeholder\n");
  writeFileSync(join(root, ".env.local"), "OPENAI_API_KEY=sk-real-key\n");
  const kit = await connect(root);
  try {
    await kit.announced((a) => a.port > 0);
    const [key, greeting] = readFileSync(join(root, "key.seen"), "utf8").split("\n");
    assert.equal(key, "sk-real-key", kit.out);
    assert.equal(greeting, "hello", "a name only .env sets still reaches an app with no loader of its own");
  } finally { await kit.stop(); kit.close(); }
});
