import assert from "node:assert/strict";
import { test } from "node:test";
import { findingsText, makeVerbs, refusedText, runText, statusText, verifyText } from "./verbs.mjs";

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });

test("every call carries the machine key and nothing else identifies the caller", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return json(200, { plan: { name: "Free", runs: { allowed: 1, used: 0, left: 1 }, trials: { allowed: 60, used: 0, left: 60 } }, repository: { name: "app" }, app: { said: "up" }, cases: { written: 3, ready: true }, run: null, field: { connected: false } }); };
  const verbs = makeVerbs({ api: "https://cortad.test/api", token: "ct_mcp_x", fetchImpl });
  const out = await verbs.status();
  assert.equal(seen[0].url, "https://cortad.test/api/mcp/status");
  assert.equal(seen[0].init.headers.authorization, "Bearer ct_mcp_x");
  assert.match(out.text, /1 of 1 run left/);
});

test("without a key every verb says how to connect instead of calling anything", async () => {
  const verbs = makeVerbs({ api: "https://cortad.test/api", token: null, fetchImpl: async () => { throw new Error("must not be called"); } });
  const out = await verbs.findings({});
  assert.equal(out.isError, true);
  assert.match(out.text, /not connected/);
});

test("run starts the runner when the app is not up, then starts the run; a spent plan comes back with the link", async () => {
  const started = [];
  let state = "waiting-for-start";
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/mcp/status")) return json(200, { app: { state } });
    if (url.endsWith("/mcp/run") && init.method === "POST") return json(202, { started: true, jobId: "j1", kind: "run", url: "https://cortad.test/lab" });
    throw new Error(url);
  };
  const verbs = makeVerbs({ api: "https://cortad.test/api", token: "k", fetchImpl, ensureRunner: async () => { started.push(1); state = "ready-to-test"; return { ok: true }; } });
  const out = await verbs.run();
  assert.deepEqual(started, [1]);
  assert.match(out.text, /Run started: j1/);

  const spent = makeVerbs({ api: "https://cortad.test/api", token: "k", fetchImpl: async (url, init) =>
    url.endsWith("/mcp/status") ? json(200, { app: { state: "ready-to-test" } })
      : json(402, { refused: "plan", why: "This account has used its one run this month.", plans: [{ name: "Hobby", monthlyUsd: 99 }, { name: "Growth", monthlyUsd: 499 }], checkout: "https://cortad.test/pricing?checkout=ship" }) });
  const refused = await spent.run();
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Hobby \(\$99\/month\) or Growth \(\$499\/month\)/);
  assert.match(refused.text, /checkout=ship/);
});

test("the renderings carry the four things an agent needs: rate with interval, quote, file and line, what to do next", () => {
  const findings = findingsText({ runId: "r1", read: "2 findings stand.", heldBack: "1 kept back.", url: "u", findings: [
    { id: "finding:1", asks: "Does it refuse to invent a refund policy?", file: "src/prompt.ts", line: 41, where: "plan free", reply: 2, layer: null,
      rate: { k: 3, n: 12, lo: 0.08, hi: 0.53, said: "3 of 12 held." }, quotes: [{ quote: "Refunds in 3 days.", p: 0.94, reply: 2 }], replay: { trials: 12, seeds: [] } },
  ] });
  assert.match(findings, /finding:1 · Does it refuse/);
  assert.match(findings, /held 3 of 12 \(25%, interval 8% to 50%\) · src\/prompt.ts:41/);
  assert.match(findings, /"Refunds in 3 days." \(p=0.94\)/);
  assert.match(findings, /verify finding:1/);

  const halted = runText({ kind: "run", jobId: "j", status: "succeeded", played: 11, of: 50, finished: true, score: 100, findings: 1, url: "u",
    stopped: { after: 11, why: "your app stopped answering", side: "theirs", fix: "Bring your app back up, then run again." },
    faults: [{ kind: "model-missing", side: "theirs", what: "Your code names llama-3.1-8b-instant, which api.groq.com does not serve.", fix: "Rename the model in your code, then run again." }] });
  assert.match(halted, /Stopped after 11 of 50: your app stopped answering \(their side\)\. Bring your app back up/);
  assert.match(halted, /llama-3.1-8b-instant/);

  const run = runText({ kind: "run", jobId: "j", status: "running", played: 14, of: 51, finished: false, url: "u" });
  assert.match(run, /played 14 of 51/);
  assert.match(run, /Poll again in 30 seconds/);

  const verify = verifyText({ findingId: "finding:1", file: "a.ts", line: 3, visible: { before: { k: 3, n: 12 }, after: { k: 11, n: 12 }, point: 67, low: 41, high: 85, moved: "improved", insideNoise: false }, holdout: { moved: "no change" }, overfit: true, said: "said" });
  assert.match(verify, /held 3 of 12 before, 11 of 12 after/);
  assert.match(verify, /OVERFIT/);

  assert.match(refusedText({ refused: "allowance", why: "used all 10", plans: [], checkout: "c" }), /used all 10/);
  assert.match(statusText({ plan: { name: "Hobby", runs: { allowed: 10, used: 3, left: 7 }, trials: { allowed: 600, used: 40, left: 560 } }, repository: { name: "app" }, app: { said: "up" }, cases: { written: 51, ready: true }, run: null, field: { connected: true } }), /7 of 10 runs left/);
});
