import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, test } from "node:test";
import { downLine, makeHealth } from "./health.mjs";

// A stand-in for their app, in its own process: every request waits `slowMs` before it is answered,
// the way an app does while the run's own requests hold its database pool.
async function stub(slowMs) {
  const code = `const s = require("node:http").createServer((q, r) => setTimeout(() => r.end("ok"), ${slowMs}));
    s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(child.stdout, "data");
  return { child, port: Number(String(line).trim()) };
}
const stop = async (child) => { if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } };
const checker = (inFlight, gone = () => false) => makeHealth({ host: () => "127.0.0.1", gone, inFlight });

describe("the runner's health check", { concurrency: true }, () => {
  test("an app eight seconds slow to answer is up, and the next probe waits three times as long", { timeout: 30_000 }, async () => {
    const { child, port } = await stub(8_000);
    try {
      const health = checker(() => 16);
      assert.equal(health.timeout(), 10_000);
      assert.equal(await health.check(port), "up");
      assert.ok(health.timeout() >= 24_000 && health.timeout() <= 30_000, String(health.timeout()));
    } finally { await stop(child); }
  });

  test("a probe that times out while the run's requests are open is busy, never a reason to restart", { timeout: 30_000 }, async () => {
    const { child, port } = await stub(13_000);
    try { assert.equal(await checker(() => 16).check(port), "busy"); } finally { await stop(child); }
  });

  test("the same silence with none of the run's requests open is quiet, the one a restart may follow", { timeout: 30_000 }, async () => {
    const { child, port } = await stub(13_000);
    try { assert.equal(await checker(() => 0).check(port), "quiet"); } finally { await stop(child); }
  });

  test("a process that exited or a port nobody holds is down at once, without waiting on a probe", async () => {
    const { child, port } = await stub(60_000);
    let gone = false;
    const health = checker(() => 16, () => gone);
    await stop(child);
    const started = Date.now();
    assert.equal(await health.check(port), "released");
    gone = true;
    assert.equal(await health.check(port), "exited");
    assert.ok(Date.now() - started < 2_000);
  });
});

test("each restart says why in the person's words", () => {
  assert.equal(downLine("exited", { port: 8000, downMs: 10_000 }), "your app exited, starting it again");
  assert.equal(downLine("quiet", { port: 8000, downMs: 10_000, crashed: true }), "your app crashed, starting it again");
  assert.equal(downLine("released", { port: 8000, downMs: 10_000 }), "nothing is listening on port 8000 any more, starting your app again");
  assert.equal(downLine("quiet", { port: 8000, downMs: 31_400 }), "your app has not answered for 31 seconds while no test conversation was waiting on it, starting it again");
});
