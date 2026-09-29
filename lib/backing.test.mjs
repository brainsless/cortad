import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeServices, localAddresses, makeBacking, tcpOpen } from "./backing.mjs";
import { connect } from "./connect-kit.mjs";

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const tree = (files) => { const root = realpathSync(mkdtempSync(join(tmpdir(), "backing-"))); for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); } return root; };

test("a compose file's services: which run an image, which build this code, and the host ports each publishes", () => {
  const text = `
name: shop
services:
  db:
    image: "pgvector/pgvector:pg16"   # the store
    ports:
      - "\${PG_PORT:-5432}:5432"
    environment:
      POSTGRES_DB: shop
  cache:
    image: redis:7
    ports: ["127.0.0.1:6380:6379/tcp"]
  qdrant:
    image: qdrant/qdrant
    ports:
      - target: 6333
        published: "6333"
  api:
    build: .
    ports:
      - 8000:8000
  worker:
    image: shop-worker
    expose:
      - "9000"
volumes:
  data: {}
`;
  assert.deepEqual(composeServices(text, { PG_PORT: "5433" }), [
    { name: "db", image: "pgvector/pgvector:pg16", build: false, ports: [5433] },
    { name: "cache", image: "redis:7", build: false, ports: [6380] },
    { name: "qdrant", image: "qdrant/qdrant", build: false, ports: [6333] },
    { name: "api", image: null, build: true, ports: [8000] },
    { name: "worker", image: "shop-worker", build: false, ports: [] },
  ]);
});

test("the local addresses the settings call, and not the pages they are opened from", () => {
  assert.deepEqual(localAddresses({ WORKER_URL: "http://localhost:4000/jobs", SEARCH_API: "http://127.0.0.1:4000", CORS_ORIGINS: "http://localhost:5173", OPENAI_BASE_URL: "https://api.openai.com/v1", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }), [
    { port: 4000, names: ["WORKER_URL", "SEARCH_API"] },
  ]);
});

const launcher = (kids) => (plan) => { const kid = spawn("/bin/sh", ["-c", plan.cmd], { cwd: plan.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true }); kids.push(kid); return kid; };
const stopAll = (kids) => { for (const k of kids) { try { process.kill(-k.pid, "SIGKILL"); } catch { /* gone */ } } };

test("a second service of the repository is started with its own start, and one that dies is said as theirs", { timeout: 60_000 }, async () => {
  const [good, bad] = [await freePort(), await freePort()];
  const root = tree({
    "package.json": JSON.stringify({ name: "app", scripts: { dev: "node app.mjs" } }),
    "worker/package.json": JSON.stringify({ name: "worker", scripts: { dev: `PORT=${good} node worker.mjs` } }),
    "worker/worker.mjs": "import { createServer } from 'node:http';\ncreateServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
    "search/package.json": JSON.stringify({ name: "search", scripts: { dev: `PORT=${bad} node search.mjs` } }),
    "search/search.mjs": "console.error('search index missing: run npm run index first'); process.exit(3);",
  });
  const kids = [];
  const backing = makeBacking({ root, appDir: root, values: {}, onPath: () => false, ledgerFile: join(root, ".made.json"), launch: launcher(kids), serviceWaitMs: 20_000 });
  try {
    const got = await backing.up([{ port: good, names: ["WORKER_URL"] }, { port: bad }, { port: await freePort() }]);
    assert.deepEqual(got.ports, [good]);
    assert.deepEqual(got.lines, [
      `Started worker with npm run dev: WORKER_URL points at port ${good} on this machine and nothing answered there. It is stopped when this command ends.`,
      `Your app reached for port ${bad} on this machine, which search serves, and it stopped before it answered: search index missing: run npm run index first. This is on your side.`,
    ]);
    assert.ok(await tcpOpen("127.0.0.1", good));
    assert.deepEqual((await backing.up([{ port: bad }])).lines, [], "tried once");
  } finally { stopAll(kids); }
});

test("a store a compose file runs, where Docker cannot run it, is said as theirs with the service that would", async () => {
  const port = await freePort();
  const root = tree({ "docker-compose.yml": `services:\n  db:\n    image: postgres:16\n    ports:\n      - "${port}:5432"\n` });
  const backing = makeBacking({ root, appDir: root, values: {}, onPath: () => false, ledgerFile: join(root, ".made.json"), launch: () => { throw new Error("not a workspace"); } });
  assert.deepEqual((await backing.up([{ port, names: ["DATABASE_URL"], store: true }])).lines, [
    `DATABASE_URL points at port ${port} on this machine and nothing answers there. The db service in docker-compose.yml would start it, but Docker is not installed on this machine: start it yourself before a run. This is on your side.`,
  ]);
  assert.deepEqual((await makeBacking({ root, appDir: root, values: {}, onPath: () => false, ledgerFile: join(root, ".made2.json"), launch: () => null }).up([{ port }])).lines, [], "a compose image serves only a store's port");
});

// The whole command against an app that cannot start until a service of its own repository answers
// at a port written in its code: the hook sees it reach for that port, the command starts the
// service with the service's own start, starts the app again, and stops the service when it ends.
test("an app that stopped because a service of its repository was down is started again once that service is up", { timeout: 120_000 }, async () => {
  const workerPort = await freePort();
  const root = tree({
    "package.json": JSON.stringify({ name: "app", scripts: { dev: "node app.cjs" } }),
    "app.cjs": [
      "const s = require('node:net').connect(" + workerPort + ", '127.0.0.1');",
      "s.on('connect', () => { s.end(); require('node:http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1'); });",
      "s.on('error', () => { console.error('the worker is not up'); process.exit(1); });",
    ].join("\n"),
    "worker/package.json": JSON.stringify({ name: "worker", scripts: { dev: `PORT=${workerPort} node worker.cjs` } }),
    "worker/worker.cjs": "require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
  });
  const kit = await connect(root);
  try {
    const app = await kit.announced();
    assert.ok(app.data.includes(`Started worker with npm run dev: Your app reached for port ${workerPort} on this machine and nothing answered there. It is stopped when this command ends.`), `${JSON.stringify(app.data)}\n${kit.out}`);
    assert.equal(await (await fetch(`http://127.0.0.1:${app.port}/`)).text(), "ok");
    await kit.stop();
    assert.equal(await tcpOpen("127.0.0.1", workerPort), false, "the service is stopped with the command");
  } finally { kit.close(); }
});
