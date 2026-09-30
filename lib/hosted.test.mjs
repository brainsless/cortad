import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostedKeeper } from "./hosted.mjs";
import { ledger } from "./ledger.mjs";
import { bypassedOf, storeKeeper, storeId, storesOf } from "./stores.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "hosted-"));
const rowsOf = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return []; } };

test("a hosted database with no branch to make and no migrations to build a local copy from holds Run, and says so without its address", async () => {
  const values = { DATABASE_URL: "postgresql://app:hunter22@db.example.com:5432/shop", NEON_URL: "postgres://app:pw@ep-cool-dust-123456.us-east-2.aws.neon.tech/neondb" };
  const got = await storeKeeper({ ledgerFile: join(fresh(), "made.json"), values, dirs: [fresh()], fetchFn: () => { throw new Error("no network in this test"); } })
    .keep(storesOf(values), { down: async () => false });
  assert.deepEqual(got.env, {});
  assert.deepEqual(got.copies, []);
  assert.equal(got.blocked.length, 2);
  for (const b of got.blocked) assert.match(b.id, /^[a-f0-9]{16}$/);
  const [plain, neon] = got.blocked;
  assert.deepEqual(plain.names, ["DATABASE_URL"]);
  assert.equal(plain.why, "Trials would write into the Postgres database shop that DATABASE_URL names, on a server off this machine, and no migrations were found to build a copy on this machine from. Point DATABASE_URL at a database on this machine, then run the command again.");
  assert.match(neon.why, /there is no NEON_API_KEY in its settings to make a branch with\. Set NEON_API_KEY/);
  const said = JSON.stringify(got);
  for (const secret of ["hunter22", "db.example.com", "ep-cool-dust"]) assert.ok(!said.includes(secret), secret);
});

test("an app attached to rather than started cannot be pointed at a copy, so its hosted database holds Run", async () => {
  const values = { DATABASE_URL: "postgresql://app:pw@db.example.com/shop" };
  const got = await storeKeeper({ ledgerFile: join(fresh(), "made.json"), values }).keep(storesOf(values), { started: false });
  assert.match(got.blocked[0].why, /your app was already running when this command started/);
});

// Neon's API as its v2 documents it, answered here.
function fakeNeon() {
  const calls = [];
  const answers = {
    "GET /projects?limit=100": { projects: [{ id: "p-other" }, { id: "p-shop" }] },
    "GET /projects/p-other/endpoints": { endpoints: [{ id: "ep-else-1", branch_id: "br-x" }] },
    "GET /projects/p-shop/endpoints": { endpoints: [{ id: "ep-cool-dust-123456", branch_id: "br-main" }] },
    "POST /projects/p-shop/branches": { branch: { id: "br-cortad" }, endpoints: [{ id: "ep-new-sky-654321", host: "ep-new-sky-654321.us-east-2.aws.neon.tech" }] },
    "GET /projects/p-shop/branches/br-cortad": { branch: { id: "br-cortad", current_state: "ready" } },
    "DELETE /projects/p-shop/branches/br-cortad": { branch: { id: "br-cortad" } },
  };
  const fetchFn = async (url, init) => {
    const key = `${init.method} ${String(url).replace("https://console.neon.tech/api/v2", "")}`;
    calls.push({ key, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
    const body = answers[key];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 404 });
  };
  return { calls, fetchFn };
}

test("a Neon database is run against a branch made for the session through the same settings, and the branch is deleted at the end", async () => {
  const ledgerFile = join(fresh(), "made.json");
  const values = {
    DATABASE_URL: "postgresql://app:pw@ep-cool-dust-123456-pooler.us-east-2.aws.neon.tech/shop?sslmode=require",
    DIRECT_URL: "postgresql://app:pw@ep-cool-dust-123456.us-east-2.aws.neon.tech/shop?sslmode=require",
    NEON_API_KEY: "napi_test_key_000",
  };
  const neon = fakeNeon();
  const keeper = storeKeeper({ ledgerFile, values, dirs: [fresh()], fetchFn: neon.fetchFn });
  const got = await keeper.keep(storesOf(values), { down: async () => false });
  assert.deepEqual(got.blocked, []);
  assert.deepEqual(got.env, {
    DATABASE_URL: "postgresql://app:pw@ep-new-sky-654321-pooler.us-east-2.aws.neon.tech/shop?sslmode=require",
    DIRECT_URL: "postgresql://app:pw@ep-new-sky-654321.us-east-2.aws.neon.tech/shop?sslmode=require",
  });
  assert.deepEqual(got.pass, ["ep-new-sky-654321.us-east-2.aws.neon.tech", "ep-new-sky-654321-pooler.us-east-2.aws.neon.tech"]);
  assert.match(got.copies[0], /^Your app runs against a Neon branch of its Postgres database shop, made for this session through DATABASE_URL and DIRECT_URL/);
  const made = neon.calls.find((c) => c.key === "POST /projects/p-shop/branches");
  assert.equal(made.body.branch.parent_id, "br-main");
  assert.ok(neon.calls.every((c) => c.auth === "Bearer napi_test_key_000"));
  assert.deepEqual(rowsOf(ledgerFile).map((r) => [r.kind, r.made]), [["branch", "p-shop/branches/br-cortad"]]);
  await keeper.drop();
  assert.ok(neon.calls.some((c) => c.key === "DELETE /projects/p-shop/branches/br-cortad"));
  assert.deepEqual(rowsOf(ledgerFile), []);
});

test("a branch a session that died left behind is deleted by the next one", async () => {
  const ledgerFile = join(fresh(), "made.json");
  writeFileSync(ledgerFile, JSON.stringify([{ kind: "branch", key: "gone", made: "p-shop/branches/br-cortad", pid: 2 ** 22 + 7 }]));
  const neon = fakeNeon();
  await storeKeeper({ ledgerFile, values: { NEON_API_KEY: "napi_test_key_000" }, fetchFn: neon.fetchFn }).keep([]);
  assert.ok(neon.calls.some((c) => c.key === "DELETE /projects/p-shop/branches/br-cortad"));
  assert.deepEqual(rowsOf(ledgerFile), []);
});

test("a local Supabase started for the session is stopped with its volumes kept, and a store named in parts is never pointed at it", async () => {
  const repo = fresh();
  mkdirSync(join(repo, "supabase"));
  writeFileSync(join(repo, "supabase", "config.toml"), "project_id = \"shop\"\n");
  const asked = [];
  let up = false;
  const run = async (bin, args) => {
    asked.push([bin, ...args].join(" "));
    if (args[0] === "status") return up ? { ok: true, out: 'API_URL="http://127.0.0.1:54321"\nDB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"\nANON_KEY="local-anon"\n' } : { ok: false, out: "" };
    if (args[0] === "start") up = true;
    return { ok: true, out: "" };
  };
  const values = { SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_ANON_KEY: "hosted-anon", PGHOST: "db.abcd.supabase.co", PGDATABASE: "postgres" };
  const stores = storesOf(values);
  const hosted = hostedKeeper({ values, dirs: [repo], book: ledger(join(fresh(), "made.json")), run });
  const api = await hosted.keep(stores.find((s) => s.engine === "supabase"));
  assert.deepEqual(api.env, { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: "local-anon" });
  const parts = await hosted.keep(stores.find((s) => s.engine === "postgres"));
  assert.equal(parts.why[0], "parts");
  await hosted.drop();
  assert.equal(asked.at(-1), "supabase stop");
});

test("an app that reaches the hosted store it was pointed away from holds Run; one already holding it, or another host, adds nothing", () => {
  const values = { DATABASE_URL: "postgresql://app:pw@ep-cool-dust-123456.us-east-2.aws.neon.tech/shop" };
  const stores = storesOf(values);
  const pooled = [{ host: "ep-cool-dust-123456-pooler.us-east-2.aws.neon.tech", port: 5432 }];
  const [row] = bypassedOf(pooled, stores, []);
  assert.equal(row.id, storeId(stores[0]));
  assert.match(row.why, /your app reached it anyway, since it loads its settings file over the settings it was started with\. Load that file without overriding what is already set, then run the command again\.$/);
  assert.deepEqual(bypassedOf(pooled, stores, [row]), []);
  assert.deepEqual(bypassedOf([{ host: "ep-new-sky-654321.us-east-2.aws.neon.tech", port: 5432 }], stores, []), []);
});
