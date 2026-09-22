import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lockRoot, installPlan, missingDependency, startPlan } from "./start.mjs";

const tree = (files) => { const root = mkdtempSync(join(tmpdir(), "start-")); for (const [rel, text] of Object.entries(files)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); } return root; };
const onPath = (bin) => bin === "npm";

test("a monorepo root starts the workspace that serves the AI, not the frontend", () => {
  const root = tree({
    "package.json": JSON.stringify({ private: true, workspaces: ["backend", "frontend"], scripts: { "dev:backend": "yarn workspace be dev" } }),
    "backend/package.json": JSON.stringify({ scripts: { dev: "strapi develop" }, dependencies: { "@strapi/strapi": "4", openai: "4" } }),
    "backend/yarn.lock": "",
    "frontend/package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "18" } }),
  });
  const plan = startPlan({ root, onPath });
  assert.equal(plan.within, "backend");
  assert.equal(plan.cmd, "npm run dev", "yarn is not on this machine, so npm runs the same script");
});

test("a plain app starts from its own folder", () => {
  const root = tree({ "package.json": JSON.stringify({ scripts: { dev: "nodemon server.js" }, dependencies: { express: "4" } }) });
  assert.deepEqual(startPlan({ root, onPath }), { cmd: "npm run dev", cwd: root });
});

test("a Python app is started the way it starts itself, from its own virtualenv", () => {
  const root = tree({ "requirements.txt": "fastapi\nopenai\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n", ".venv/bin/python": "" });
  assert.equal(startPlan({ root, onPath }).cmd, `${JSON.stringify(join(root, ".venv/bin/python"))} -m uvicorn main:app --host 127.0.0.1 --port 8000`);
  const own = tree({ "requirements.txt": "fastapi\n", "server.py": "import uvicorn\nif __name__ == \"__main__\":\n    uvicorn.run(app, port=8000)\n" });
  assert.equal(startPlan({ root: own, onPath }).cmd, "python3 server.py");
});

test("what they typed wins", () => {
  assert.deepEqual(startPlan({ root: "/x", typed: "make dev", onPath }), { cmd: "make dev", cwd: "/x" });
});

// agent-service-toolkit: the app is src/run_service.py, beside src/run_agent.py and
// src/run_client.py, and the fixed list of entry names knew none of the three.
test("the entry file is found by what it does, not by a list of twelve names", () => {
  const root = tree({
    "pyproject.toml": "[project]\ndependencies = [\"fastapi\", \"langgraph\"]\n",
    "src/run_agent.py": "if __name__ == \"__main__\":\n    asyncio.run(main())\n",
    "src/run_service.py": "import uvicorn\nif __name__ == \"__main__\":\n    uvicorn.run(\"service:app\", port=8080)\n",
  });
  assert.equal(startPlan({ root, onPath }).cmd, "python3 src/run_service.py");
});

// camel, swarm and the crewai examples: packages and terminal scripts, no server anywhere. Starting
// the best-looking script put a chat loop on no port and reported a missing import as the reason.
test("a repository with nothing that serves says so instead of starting a script", () => {
  const scripts = tree({
    "pyproject.toml": "[project]\nname = \"lib\"\n",
    "examples/bot/requirements.txt": "qdrant-client\n",
    "examples/bot/main.py": "import qdrant_client\nif __name__ == \"__main__\":\n    run_demo_loop()\n",
  });
  assert.deepEqual(startPlan({ root: scripts, onPath }), { cmd: null, cwd: scripts, noServer: true });
  const lib = tree({ "pyproject.toml": "[project]\nname = \"camel-ai\"\n" });
  assert.equal(startPlan({ root: lib, onPath }).noServer, true);
});

test("what is missing is named, and installed the way the project locked it", () => {
  assert.equal(missingDependency("Error: Cannot find package 'next' imported from /app"), "next");
  assert.equal(missingDependency("ModuleNotFoundError: No module named 'qdrant_client'"), "qdrant_client");
  assert.equal(missingDependency("sh: line 1: next: command not found"), "next");
  assert.equal(missingDependency("ready on http://localhost:3000"), "");
  const pnpm = tree({ "package.json": "{}", "pnpm-lock.yaml": "" });
  assert.equal(installPlan(pnpm, (b) => b === "pnpm"), "pnpm install");
  assert.equal(installPlan(pnpm, () => false), "npx --yes pnpm install", "the manager the repository locked is fetched rather than swapped for npm");
  const npm = tree({ "package.json": "{}", "package-lock.json": "{}" });
  assert.equal(installPlan(npm, onPath), "npm ci || npm install --legacy-peer-deps");
  const py = tree({ "requirements.txt": "qdrant-client\n" });
  assert.match(installPlan(py, () => false), /^python3 -m venv \.venv/, "nothing is installed outside the project");
});

test("a workspace member is installed from the repository that holds the lockfile", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const app = join(root, "apps", "web");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true }));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "web", dependencies: { ui: "workspace:^" } }));
  assert.equal(lockRoot(app, root), root);
  const plan = installPlan(app, (b) => b === "pnpm", root);
  assert.match(plan, /^cd .*ws-.*&& pnpm install$/, `npm cannot read workspace: ranges; got ${plan}`);
  // Nothing above the folder the customer ran the command in is ever installed.
  assert.equal(lockRoot(app, app), app);
});
