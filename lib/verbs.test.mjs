import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedLine, makeVerbs } from "./verbs.mjs";

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const API = "https://cortad.test/api";
const memory = (initial = null) => { let value = initial; return { read: () => value, write: (p) => { value = p; } }; };

// A clock the verbs read and a sleep that moves it, so a 45-second hold runs in no time.
function clock(start = Date.parse("2026-09-26T12:00:00Z")) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, tick: (ms) => { t += ms; } };
}

test("every call carries the machine key; without one, every verb says how to connect and calls nothing", async () => {
  const seen = [];
  const verbs = makeVerbs({ api: API, token: "ct_mcp_x", pending: memory(), fetchImpl: async (url, init) => { seen.push({ url, init }); return json(200, { plan: { name: "Free", runsLeft: 1, runsAllowed: 1 }, run: null }); } });
  const out = await verbs.status();
  assert.equal(seen[0].url, `${API}/mcp/status`);
  assert.equal(seen[0].init.headers.authorization, "Bearer ct_mcp_x");
  assert.match(out.text, /Free: 1 of 1 run left this month\./);

  const none = makeVerbs({ api: API, token: null, pending: memory(), fetchImpl: async () => { throw new Error("must not be called"); } });
  const refused = await none.findings({});
  assert.equal(refused.isError, true);
  assert.match(refused.text, /not connected to Cortad\.\nFor the person: /);
});

test("run with the app up posts at once and keeps the id; with the app down it starts the app and answers without waiting for it", async () => {
  const posted = [];
  const c = clock();
  let state = "ready-to-test";
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/mcp/status")) return json(200, { app: { state }, run: { jobId: "old", status: "succeeded" } });
    if (url.endsWith("/mcp/run") && init.method === "POST") { posted.push(JSON.parse(init.body)); return json(202, { started: true, jobId: "j1", kind: "run" }); }
    throw new Error(url);
  };
  const pending = memory();
  const started = [];
  const verbs = makeVerbs({ api: API, token: "k", fetchImpl, pending, now: c.now, startApp: async (args, kind) => { started.push([args, kind]); return { ok: true }; } });

  const up = await verbs.run();
  assert.equal(up.text, "Run started: j1.\nnext: run_status j1");
  assert.deepEqual(pending.read(), { jobId: "j1", kind: "run", startedAt: "2026-09-26T12:00:00.000Z" });
  assert.deepEqual(started, []);

  state = "starting";
  const down = await verbs.verify({ findingId: "finding:1" });
  assert.equal(down.text, "Starting your app for the run. Call run_status; it answers as soon as the run has an id.");
  assert.deepEqual(started, [[{ findingId: "finding:1" }, "verify"]]);
  assert.equal(posted.length, 1, "the verify is posted by the waiter, not here");
  assert.deepEqual(pending.read(), { kind: "verify", startedAt: "2026-09-26T12:00:00.000Z", after: "old" });
});

test("a spent plan comes back as the ledger with the checkout for the person, and 'Nothing ran.'", async () => {
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl: async (url) =>
    url.endsWith("/mcp/status") ? json(200, { app: { state: "ready-to-test" } })
      : json(402, { refused: "plan", why: "used", unit: "sweeps", allowed: 1, used: 1, plan: { name: "Free" }, plans: [{ name: "Hobby", monthlyUsd: 99 }, { name: "Growth", monthlyUsd: 499 }], checkout: "https://cortad.test/pricing?checkout=ship" }) });
  const out = await verbs.run();
  assert.equal(out.isError, true);
  assert.equal(out.text, "Refused: 1 of 1 run used on the Free plan.\nPlans: Hobby $99 a month, Growth $499 a month.\nNothing ran.\nFor the person: plans and checkout at https://cortad.test/pricing?checkout=ship");
});

test("run_status with an id holds on the server for 45 seconds and ends with the next call", async () => {
  const urls = [];
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl: async (url) => { urls.push(url); return json(200, { jobId: "j1", kind: "run", status: "running", played: 3, of: 51, finished: false }); } });
  const out = await verbs.run_status({ jobId: "j1" });
  assert.deepEqual(urls, [`${API}/mcp/run/j1?wait=45`]);
  assert.equal(out.text, "Run j1: running, 3 of 51 trials played.\nnext: run_status j1");
});

test("run_status without an id holds while the app starts, takes the id the waiter leaves, and spends only what is left of the 45 seconds", async () => {
  const c = clock();
  const pending = memory({ kind: "run", startedAt: new Date(c.now()).toISOString(), after: "old" });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith("/mcp/status")) return json(200, { run: { jobId: "old" } });
    return json(200, { jobId: "j2", kind: "run", status: "queued", played: 0, of: 51 });
  };
  let slept = 0;
  const verbs = makeVerbs({ api: API, token: "k", fetchImpl, pending, now: c.now, sleep: async (ms) => { c.tick(ms); slept += 1; if (slept === 20) pending.write({ ...pending.read(), jobId: "j2" }); } });
  const out = await verbs.run_status({});
  assert.deepEqual(urls, [`${API}/mcp/status`, `${API}/mcp/run/j2?wait=25`]);
  assert.match(out.text, /next: run_status j2$/);
});

test("run_status without an id: still starting says how long and names itself next; a failure says why; a newer run outranks the file", async () => {
  const c = clock();
  const status = (jobId) => async (url) => (url.endsWith("/mcp/status") ? json(200, { run: jobId ? { jobId } : null }) : json(200, { jobId, kind: "run", status: "running", played: 1, of: 5 }));

  const waiting = makeVerbs({ api: API, token: "k", fetchImpl: status(null), pending: memory({ kind: "run", startedAt: new Date(c.now()).toISOString(), after: null }), now: c.now, sleep: c.sleep });
  assert.equal((await waiting.run_status({ jobId: "pending" })).text, "Your app is still starting for the run: 45 of up to 240 seconds.\nnext: run_status pending");

  const failed = makeVerbs({ api: API, token: "k", fetchImpl: status(null), pending: memory({ kind: "run", startedAt: new Date(c.now()).toISOString(), after: null, error: "Your app did not answer within 4 minutes.\nNothing ran." }), now: c.now, sleep: c.sleep });
  const told = await failed.run_status({});
  assert.equal(told.isError, true);
  assert.equal(told.text, "Your app did not answer within 4 minutes.\nNothing ran.\nnext: status");

  const newer = makeVerbs({ api: API, token: "k", fetchImpl: status("fresh"), pending: memory({ kind: "run", startedAt: "2026-09-25T00:00:00Z", after: "older", error: "stale" }), now: c.now, sleep: c.sleep });
  assert.match((await newer.run_status({})).text, /^Run fresh: running/);

  const nothing = makeVerbs({ api: API, token: "k", fetchImpl: status(null), pending: memory(), now: c.now, sleep: c.sleep });
  assert.equal((await nothing.run_status({})).text, "No run yet.\nnext: status");
});

test("findings reads every server page before cutting its own, and a page past the end is the last one", async () => {
  const urls = [];
  const finding = (id) => ({ id, asks: `Question ${id}?`, file: "a.ts", line: 1, rate: { k: 1, n: 4, lo: 0.05, hi: 0.7 }, quotes: [], replay: { trials: 4 } });
  const fetchImpl = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    return json(200, { runId: "r1", page, pages: 2, findings: [finding(`finding:${page}`)], byLine: [{ path: "a.ts", line: 1, findingIds: [`finding:${page}`] }] });
  };
  const verbs = makeVerbs({ api: API, token: "k", pending: memory(), fetchImpl });
  const out = await verbs.findings({ page: 9 });
  assert.deepEqual(urls, [`${API}/mcp/findings`, `${API}/mcp/findings?jobId=r1&page=2`]);
  assert.match(out.text, /^Run r1: 2 findings\./);
  assert.match(out.text, /2 findings at a\.ts:1\nfinding:1 .*\n[\s\S]*finding:2 /);
});

test("status --changed names the cited files touched since the run started, with their findings, and nothing outside the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "cortad-changed-"));
  mkdirSync(join(root, "src"));
  for (const f of ["src/prompt.ts", "src/tools.ts", "src/old.ts"]) writeFileSync(join(root, f), "x");
  const since = "2026-09-26T12:00:00.000Z";
  const before = new Date(Date.parse(since) - 60_000);
  utimesSync(join(root, "src/old.ts"), before, before);
  const lines = [{ path: "src/prompt.ts", line: 4, findingIds: ["finding:1", "finding:3"] }, { path: "src/old.ts", line: 2, findingIds: ["finding:2"] }];
  const paths = ["src/prompt.ts", "src/old.ts", "src/tools.ts", "../outside.ts", "/etc/hosts", "src/missing.ts"];
  assert.equal(changedLine({ root, since, runId: "r1", paths, lines }), "Changed since run r1: src/prompt.ts (finding:1, finding:3), src/tools.ts.");
  assert.equal(changedLine({ root, since: null, runId: "r1", paths, lines }), "");
  assert.equal(changedLine({ root, since: "2099-01-01T00:00:00Z", runId: "r1", paths, lines }), "");
});
