import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "./connect-kit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await done()) return true; return done(); };

// ulaim, 2026-10-01: the agent edited the app's .env, and the app ran on the old settings until the
// command was started again. An env file is rarely tracked, so a save to it never counted as a change.
test("a save to the app's env file starts it again on the new settings", { timeout: 90_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "env-restart-")));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "envy", scripts: { start: "node server.js" }, dependencies: { express: "5" } }));
  writeFileSync(join(root, "server.js"), `
    const fs = require("node:fs");
    const http = require("node:http");
    const env = Object.fromEntries(fs.readFileSync(__dirname + "/.env", "utf8").split("\\n").filter(Boolean).map((l) => l.split("=")));
    fs.appendFileSync(__dirname + "/starts.log", (process.env.GREETING || env.GREETING) + "\\n");
    http.createServer((_q, res) => res.end("ok")).listen(Number(process.env.PORT) || 4630, "127.0.0.1");
  `);
  writeFileSync(join(root, ".env"), "GREETING=hello\n");
  const kit = await connect(root);
  try {
    await kit.announced((a) => a.port > 0);
    const starts = () => { try { return readFileSync(join(root, "starts.log"), "utf8").trim().split("\n"); } catch { return []; } };
    assert.ok(await until(() => starts().length >= 1, 20_000), kit.out);
    writeFileSync(join(root, ".env"), "GREETING=bonjour\n");
    assert.ok(await until(() => starts().includes("bonjour"), 40_000), `${starts().join(",")}\n${kit.out}`);
  } finally { await kit.stop(); kit.close(); }
});
