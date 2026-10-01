import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeCapture } from "./replay.mjs";

// The fixture app under the real hook, with a door that answers each signed-in customer by name and
// plan. The agent's requests sign in as different customers; each becomes an account a run's
// conversations are handed in turn, and no sign-in value is ever in what the command posts.
const settle = () => new Promise((r) => setTimeout(r, 400));
const jwt = (sub, inS) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + inS })).toString("base64url"), "c2lnbmF0dXJlLXZhbHVl"].join(".");

test("each customer the agent's requests signed in as is an account of its own, and conversations are split across them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-"));
  copyFileSync(new URL("./proof-app.cjs", import.meta.url), join(dir, "proof-app.cjs"));
  const sent = [];
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onProof: (p) => sent.push(p), root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, message, headers) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ message }) }).then((r) => r.json());
  const as = (token) => ({ authorization: `Bearer ${token}` });
  const door = () => sent.filter((p) => p.door.path === "/api/account").at(-1);
  const tokens = { ana: jwt("u-ana", 1200), anaAgain: jwt("u-ana", 3600), ben: jwt("u-ben", 900) };
  try {
    await post("/api/account", "what does my plan include", as(tokens.ana));
    await post("/api/account", "and the weekend rates", as(tokens.anaAgain));
    await post("/api/once", "a day trip to Sintra", {});
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, undefined, "Ana signed in again is still one account, and a request with no sign-in is none");
    assert.equal(capture.headers().authorization, `Bearer ${tokens.anaAgain}`, "the first account speaks with its newest sign-in");

    await post("/api/account", "what does my plan include", as(tokens.ben));
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, 2);
    assert.equal(sent.filter((p) => p.door.path === "/api/once").at(-1).proof.accounts, 2, "every door is sent again when an account is added");
    assert.deepEqual([door().proof.identity.kind, door().proof.identity.account], ["bearer", 2], "the sign-in that ends first is Ben's");
    assert.ok(Math.abs(door().proof.identity.expiresInS - 900) <= 5, `ends in ${door().proof.identity.expiresInS}s`);

    // The run hands the cast's people the accounts in turn; the command puts each one's sign-in in.
    const roles = ["captured", "captured:account2", "captured", "captured:account2"];
    const replies = [];
    for (const [i, role] of roles.entries()) replies.push((await post("/api/account", "is breakfast included", { ...capture.headers(role), "x-cortad-turn": `case_${i}:1` })).reply);
    assert.deepEqual(replies.map((r) => r.split(",")[0]), ["Ana", "Ben", "Ana", "Ben"]);
    assert.equal(capture.headers("captured:account3").authorization, `Bearer ${tokens.anaAgain}`, "an account this command no longer holds speaks as the first");
    assert.equal(capture.headers("clerk:p1a2b3c4"), null, "a test account the command signs in itself is not a captured one");
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, 2, "the run's own requests are never accounts");

    for (const sub of ["u-cy", "u-dee", "u-eve"]) await post("/api/account", "what does my plan include", as(jwt(sub, 3600)));
    await settle();
    capture.alive();
    assert.equal(door().proof.accounts, 4, "four at most");
    assert.match((await post("/api/account", "hello", capture.headers("captured:account4"))).reply, /^Dee,/, "the fifth customer is not kept");
    assert.ok(!Object.values(tokens).some((t) => JSON.stringify(sent).includes(t)), "no sign-in value is in anything posted");
  } finally { child.kill(); }
});
