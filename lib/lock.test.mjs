// The fence around an agent's shell line, tried for real on this machine: a throwaway repository in
// the home folder, and every line below run inside the lock. macOS only (Seatbelt).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { lockHolds, makeLock } from "./lock.mjs";

test("the shell reaches the project and its tools, and nothing it should not", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(homedir(), ".cortad-lock-test-"));
  const work = mkdtempSync(join(tmpdir(), "cortad-lock-work-"));
  try {
    for (const d of ["src", "runs/secrets", "dist", "scripts"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "runs/\nAUDIT.md\ndist/\n.env\n");
    writeFileSync(join(root, "src/app.js"), "console.log(1)\n");
    writeFileSync(join(root, "runs/secrets/k.json"), '{"k":"SECRET"}\n');
    writeFileSync(join(root, "AUDIT.md"), "SECRET\n");
    writeFileSync(join(root, ".env"), "X=SECRET\n");
    writeFileSync(join(root, "scripts/books.env"), "B=SECRET\n");
    const git = (...a) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "ignore" });
    git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
    const lock = await makeLock({ root, work });
    assert.ok(lock && lockHolds(lock, root));
    const runs = (cmd) => { const { file, args } = lock.wrap(cmd); try { return execFileSync(file, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString(); } catch { return null; } };
    for (const cmd of ["node -e 'console.log(1)'", "git status --short", "cat src/app.js", "echo x > dist/o.txt"]) assert.notEqual(runs(cmd), null, cmd);
    for (const cmd of ["cat ~/.zsh_history", "ls ~/Library/Keychains", "cat runs/secrets/k.json", "cat AUDIT.md", "echo x > runs/secrets/k.json",
      "cat .env", "cat scripts/books.env", "echo x >> src/app.js", "curl -s -m 5 https://example.com"]) {
      const out = runs(cmd);
      assert.ok(out === null || (out.trim() === "" && !/SECRET/.test(out)), `${cmd} was allowed`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
