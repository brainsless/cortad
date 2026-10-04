import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeKeeping } from "./keeping.mjs";

const keepingOf = (values, say = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), "keeping-"));
  return makeKeeping({
    root, work: mkdtempSync(join(tmpdir(), "keeping-work-")), ledgerFile: join(root, "made.json"), onPath: () => false, say,
    settings: () => ({ values, from: {}, appDir: root, sources: [] }), launch: async () => null, connections: () => [],
  });
};

test("past eight hosted stores the rest travel as one row that holds Run, and a yes to it lets each of them through", async () => {
  const values = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`MONGO_URL_${i + 1}`, `mongodb+srv://u:p@c${i + 1}.mongodb.net/app${i + 1}`]));
  const keeping = keepingOf(values);
  const rows = await keeping.blocked(true);
  assert.equal(rows.length, 8);
  const rest = rows[7];
  assert.match(rest.id, /^[a-f0-9]{16}$/);
  assert.deepEqual(rest.names, ["MONGO_URL_8", "MONGO_URL_9", "MONGO_URL_10"]);
  assert.match(rest.why, /^These 3 stores hold Run too\. MONGO_URL_8 points at the MongoDB database app8 off this machine/);
  assert.deepEqual(keeping.outbound({ stores: [rows[0].id] }), ["c1.mongodb.net"]);
  assert.deepEqual(keeping.outbound({ stores: [rest.id] }).sort(), ["c10.mongodb.net", "c8.mongodb.net", "c9.mongodb.net"]);
});

test("a yes that arrives before the copies are made, or after the app was attached to instead, passes only its hosts", async () => {
  const keeping = keepingOf({ MONGO_URL: "mongodb+srv://u:p@c1.mongodb.net/app" });
  assert.deepEqual(keeping.outbound({ hosts: ["hooks.example.com"], stores: ["0123456789abcdef"] }), ["hooks.example.com"]);
  const [row] = await keeping.blocked(true);
  assert.deepEqual(keeping.outbound({ stores: [row.id] }), ["c1.mongodb.net"]);
  await keeping.forget();
  assert.deepEqual(keeping.outbound({ stores: [row.id] }), []);
});

test("the terminal says a store off this machine waits for the person's yes on the card", async () => {
  const said = [];
  await keepingOf({ MONGO_URL: "mongodb+srv://u:p@c1.mongodb.net/app" }, (line) => said.push(line)).blocked(true);
  assert.deepEqual(said, ["run waits for your yes on the card in the browser: MONGO_URL points at the MongoDB database app off this machine, and Cortad cannot copy a hosted MongoDB, so the run would write into it as it is. Point MONGO_URL at a MongoDB on this machine, then run the connect command again."]);
});
