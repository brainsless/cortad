import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startPlan } from "./start.mjs";

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
