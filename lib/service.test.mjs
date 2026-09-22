import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintAcross, serviceBase, servicesFor, waitForPort } from "./service.mjs";

const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), "service-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};
const onPath = (bin) => bin === "npm";

// databuddy: the AI is apps/api, the sign-in is mounted in apps/dashboard. The command runs from
// apps/api, so the dashboard recipe names a service the command has to start on its own.
test("a recipe naming another workspace gives that workspace's dir and how it starts", () => {
  const root = tree({
    "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    "apps/api/package.json": JSON.stringify({ scripts: { dev: "bun run src/index.ts" }, dependencies: { elysia: "1", openai: "4" } }),
    "apps/dashboard/package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "15", "better-auth": "1" } }),
  });
  const recipes = [
    { kind: "login", role: "member", header: "cookie", service: "apps/dashboard", steps: [], opens: [] },
    { kind: "jwt", role: "user", header: "authorization", steps: [], opens: [] },
  ];
  const [svc, ...rest] = servicesFor({ recipes, root, appDir: join(root, "apps/api"), onPath });
  assert.equal(rest.length, 0, "only the cross-service recipe starts a service");
  assert.equal(svc.dir, "apps/dashboard");
  assert.equal(svc.cwd, join(root, "apps/dashboard"));
  assert.equal(svc.plan.cmd, "npm run dev", "started the way the dashboard starts itself");
  assert.equal(svc.plan.cwd, join(root, "apps/dashboard"));
  assert.equal(svc.recipes.length, 1);
});

test("a recipe whose service is the running app's own dir starts nothing extra", () => {
  const root = tree({
    "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    "apps/web/package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "15", "better-auth": "1" } }),
  });
  const recipes = [{ kind: "login", role: "member", header: "cookie", service: "apps/web", steps: [], opens: [] }];
  assert.deepEqual(servicesFor({ recipes, root, appDir: join(root, "apps/web"), onPath }), []);
});

// Nothing is started here: the ports are numbers the stub records, so the split is what is proved.
test("the sign-in elsewhere is minted at its own port, the rest at the app's", async () => {
  const root = tree({
    "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    "apps/api/package.json": JSON.stringify({ scripts: { dev: "bun run src/index.ts" }, dependencies: { elysia: "1", openai: "4" } }),
    "apps/dashboard/package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "15", "better-auth": "1" } }),
  });
  const recipes = [
    { kind: "login", role: "member", header: "cookie", service: "apps/dashboard", steps: [], opens: [] },
    { kind: "jwt", role: "user", header: "authorization", steps: [], opens: [] },
  ];
  const calls = [];
  const out = await mintAcross({
    recipes, root, appDir: join(root, "apps/api"), onPath, appPort: 3001,
    portFor: async (group) => (group.dir === "apps/dashboard" ? 3000 : null),
    mint: async (group, port) => {
      calls.push({ port, roles: group.map((r) => r.role) });
      return { identities: group.map((r) => ({ role: r.role, status: "minted" })) };
    },
  });
  assert.deepEqual(calls, [{ port: 3000, roles: ["member"] }, { port: 3001, roles: ["user"] }]);
  assert.deepEqual(out.identities, [{ role: "member", status: "minted" }, { role: "user", status: "minted" }]);
});

test("the base URL is the service's own loopback port", () => {
  assert.equal(serviceBase(3000), "http://127.0.0.1:3000");
});

test("waitForPort answers when the port is up and gives up when it is not", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  assert.equal(await waitForPort(port, 5_000), true);
  server.close();
  await new Promise((r) => server.on("close", r));
  assert.equal(await waitForPort(port, 700), false, "a refused port times out within the bound");
});
