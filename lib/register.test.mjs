import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectClients, registerAll } from "./register.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillSrc = join(here, "..", "skill");
const noPath = { PATH: "" };

test("the skill and its references ship in the package: register.mjs loads them by path, which the import test cannot see", () => {
  const shipped = new Set(JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).files);
  assert.ok(shipped.has("skill/SKILL.md") && shipped.has("skill/references/results.md"));
  const skill = readFileSync(join(skillSrc, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: cortad\ndescription: /);
  assert.ok(skill.length < 5000 * 4, "the body loads whole when the skill is used; keep it short");
});

test("only the clients on this machine are written to, each in its own home, and twice adds nothing twice", async () => {
  const home = mkdtempSync(join(tmpdir(), "cortad-home-"));
  assert.deepEqual(detectClients({ home, env: noPath }), { claude: false, codex: false, cursor: false, copilot: false });
  assert.deepEqual(await registerAll({ home, env: noPath, skillSrc }), []);

  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: {}, mcpServers: { other: { type: "http", url: "https://x" } } }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n");
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, ".copilot"));

  const added = await registerAll({ home, env: noPath, skillSrc });
  assert.deepEqual(added, ["Claude Code", "Codex", "Cursor", "Copilot"]);
  const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(claude.mcpServers.cortad, { type: "stdio", command: "npx", args: ["-y", "cortad@latest", "mcp"] });
  assert.equal(claude.mcpServers.other.url, "https://x");
  assert.ok(existsSync(join(home, ".claude", "skills", "cortad", "SKILL.md")));
  assert.ok(existsSync(join(home, ".claude", "skills", "cortad", "references", "results.md")));
  const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^model = "gpt-5"\n\n\[mcp_servers\.cortad\]\ncommand = "npx"\nargs = \["-y","cortad@latest","mcp"\]\n$/);
  assert.ok(existsSync(join(home, ".agents", "skills", "cortad", "SKILL.md")));
  const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.cortad.command, "npx");

  await registerAll({ home, env: noPath, skillSrc });
  assert.equal((readFileSync(join(home, ".codex", "config.toml"), "utf8").match(/mcp_servers\.cortad/g) ?? []).length, 1);
});

test("with the client's own binary on PATH its add command is used, and 'already exists' is not a failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "");
  const ran = [];
  const run = async (cmd, args) => { ran.push([cmd, ...args]); if (ran.length > 1) throw Object.assign(new Error("x"), { stderr: "MCP server cortad already exists" }); };
  await registerAll({ home, env: { PATH: bin }, run, skillSrc });
  await registerAll({ home, env: { PATH: bin }, run, skillSrc });
  assert.deepEqual(ran[0], ["claude", "mcp", "add", "--scope", "user", "cortad", "--", "npx", "-y", "cortad@latest", "mcp"]);
  assert.equal(ran.length, 2);
  assert.ok(!existsSync(join(home, ".claude.json")), "the file is not written when the binary did the work");
});
