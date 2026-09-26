import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runWhenUp, startApp } from "./cli.mjs";
import { homeOf, projectOf, readPending, writePending, writeRunner } from "./home.mjs";

// A project whose ~/.cortad folder lives in a temp directory: HOME is pointed there for the test.
function project() {
  const home = mkdtempSync(join(tmpdir(), "cortad-cli-"));
  process.env.HOME = home;
  const id = projectOf(home);
  writePending(id, { kind: "run", startedAt: "2026-09-26T12:00:00.000Z", after: null });
  return { root: home, id, pending: { read: () => readPending(id), write: (p) => writePending(id, p) } };
}

test("the waiter posts the run the moment the app answers, and a refusal lands in pending.json as said", async () => {
  const p = project();
  writeRunner(p.id, { pid: process.pid });
  const states = ["starting", "starting", "ready-to-test"];
  const posted = [];
  const verbs = { post: async (args, kind) => { posted.push([args, kind]); return { text: "Refused: 1 of 1 run used on the Free plan.\nNothing ran.", data: { refused: "plan" }, isError: true }; } };
  await runWhenUp({ verbs, project: p.id, env: {}, pending: p.pending, request: { kind: "verify", args: { findingId: "finding:1" } }, poll: async () => ({ state: states.shift() }), sleep: async () => {} });
  assert.deepEqual(posted, [[{ findingId: "finding:1" }, "verify"]]);
  assert.equal(readPending(p.id).error, "Refused: 1 of 1 run used on the Free plan.\nNothing ran.");
});

test("the waiter says why nothing ran: the runner ended, or the app never answered in the time allowed", async () => {
  const gone = project();
  await runWhenUp({ verbs: {}, project: gone.id, env: {}, pending: gone.pending, request: { kind: "run", args: {} }, poll: async () => ({ state: "stopped", said: "Your app exited with code 1." }), sleep: async () => {} });
  assert.equal(readPending(gone.id).error, `The process holding your app up ended before the app answered. Your app exited with code 1. Its output is in ${join(homeOf(gone.id), "runner.log")}.\nNothing ran.`);

  const slow = project();
  writeRunner(slow.id, { pid: process.pid });
  let t = 0;
  await runWhenUp({ verbs: {}, project: slow.id, env: {}, pending: slow.pending, request: { kind: "run", args: {} }, poll: async () => ({ state: "starting" }), now: () => t, sleep: async (ms) => { t += ms; } });
  assert.match(readPending(slow.id).error, /^Your app did not answer within 4 minutes\. Its output is in .*runner\.log\.\nNothing ran\.$/);
  assert.equal(t, 240_000);
});

test("startApp returns at once: the runner only when none is alive, and always a detached waiter that carries the request", () => {
  const p = project();
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => { spawned.push({ args: args.slice(1), detached: opts.detached, cwd: opts.cwd }); return { pid: process.pid, unref() {} }; };
  const children = [];
  assert.deepEqual(startApp({ root: p.root, project: p.id, env: {}, keep: false, children, args: { findingId: "finding:2" }, kind: "verify", spawnImpl }), { ok: true });
  assert.deepEqual(spawned.map((s) => [s.args, s.detached]), [
    [["--token", "--until-idle"], true],
    [["run-when-up", JSON.stringify({ kind: "verify", args: { findingId: "finding:2" } })], true],
  ]);
  startApp({ root: p.root, project: p.id, env: {}, keep: true, children, args: {}, kind: "run", spawnImpl });
  assert.equal(spawned.length, 3, "a live runner is not started twice");
});
