// The whole command as a test runs it: a repository's own home with a stored key, and a stand-in
// for our API that answers the wire the command speaks (sign-in, upload, the app's announce, the
// job poll) and hands the test each announce. Not shipped.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");

export async function connect(root) {
  const home = mkdtempSync(join(tmpdir(), "cortad-kit-home-"));
  const project = homeOf(projectOf(root), join(home, ".cortad"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "token"), "machine-key");
  const announces = [];
  const waiting = [];
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply(200, { box: "lo_0123456789abcdef01234567", key: "k" });
    if (req.url.includes("/tree")) return reply(200, { id: "c", resumed: true });
    if (req.url.endsWith("/app")) {
      const app = JSON.parse(body);
      announces.push(app);
      for (const w of waiting.splice(0)) w();
      return reply(200, { jobId: "j" });
    }
    if (req.url.includes("/jobs")) return setTimeout(() => { res.writeHead(204); res.end(); }, 500);
    return reply(200, { ok: true });
  }).listen(0, "127.0.0.1");
  await once(api, "listening");
  const command = spawn(process.execPath, [LOCAL, "--token"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  const kit = { command, project, announces, out: "" };
  command.stdout.on("data", (d) => { kit.out += d; });
  command.stderr.on("data", (d) => { kit.out += d; });
  // The first announce that passes `test`, or the command's exit.
  const exited = once(command, "exit");
  kit.announced = async (test = () => true, ms = 90_000) => {
    for (const until = Date.now() + ms; Date.now() < until;) {
      const hit = announces.find(test);
      if (hit) return hit;
      if (command.exitCode !== null) break;
      await Promise.race([new Promise((r) => waiting.push(r)), exited, new Promise((r) => setTimeout(r, 1000))]);
    }
    throw new Error(`no announce matched:\n${JSON.stringify(announces)}\n${kit.out}`);
  };
  kit.stop = async () => { if (command.exitCode === null) { command.kill("SIGTERM"); await exited; } };
  kit.close = () => { command.kill("SIGKILL"); api.close(); };
  return kit;
}
