import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectClients, installSkill, registerAll } from "./register.mjs";
import { cliSpec } from "./spec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillSrc = join(here, "..", "skill");
const noPath = { PATH: "" };
const latest = "cortad@latest";

test("the skill and its references ship in the package: register.mjs loads them by path, which the import test cannot see", () => {
  const shipped = new Set(JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).files);
  assert.ok(shipped.has("skill/SKILL.md") && shipped.has("skill/references/results.md"));
  const skill = readFileSync(join(skillSrc, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: cortad\ndescription: /);
  assert.ok(skill.split("\n").length < 120, "the body loads whole when the skill is used; keep it short");
  assert.match(skill, /npx \{\{cortad\}\} /, "the package keeps the placeholder; installSkill names the spec");
  assert.doesNotMatch(skill, /\b(?:do not|don't|never|stay quiet|wait|poll|every 30 seconds)\b|\u2014/i);
});

test("the spec follows the connect: CORTAD_CLI_SPEC when it is a spec, cortad@next on a prerelease, cortad@latest otherwise", () => {
  assert.equal(cliSpec({ env: {}, version: "0.3.0" }), "cortad@latest");
  assert.equal(cliSpec({ env: {}, version: "0.3.0-rc.1" }), "cortad@next");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "cortad@next" }, version: "0.3.0" }), "cortad@next");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "/Users/me/brainsless-local" }, version: "0.3.0" }), "/Users/me/brainsless-local");
  assert.equal(cliSpec({ env: { CORTAD_CLI_SPEC: "cortad; curl evil" }, version: "0.3.0" }), latest, "it lands in a shell line in the repository");
});

test("installSkill writes the spec into the skill's shell examples", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortad-skill-"));
  installSkill(dir, { src: skillSrc, spec: "cortad@next" });
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  assert.match(skill, /npx cortad@next run_status/);
  assert.doesNotMatch(skill + readFileSync(join(dir, "references", "results.md"), "utf8"), /\{\{cortad\}\}/);
});

test("only the clients on this machine are written to, each in its own home, and twice adds nothing twice", async () => {
  const home = mkdtempSync(join(tmpdir(), "cortad-home-"));
  assert.deepEqual(detectClients({ home, env: noPath }), { claude: false, codex: false, cursor: false, copilot: false });
  assert.deepEqual(await registerAll({ home, env: noPath, skillSrc, spec: latest }), []);

  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: {}, mcpServers: { other: { type: "http", url: "https://x" } } }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n");
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, ".copilot"));

  const added = await registerAll({ home, env: noPath, skillSrc, spec: latest });
  assert.deepEqual(added, ["Claude Code", "Codex", "Cursor", "Copilot"]);
  const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(claude.mcpServers.cortad, { type: "stdio", command: "npx", args: ["-y", "cortad@latest", "mcp"] });
  assert.equal(claude.mcpServers.other.url, "https://x");
  assert.ok(existsSync(join(home, ".claude", "skills", "cortad", "SKILL.md")));
  assert.ok(existsSync(join(home, ".claude", "skills", "cortad", "references", "results.md")));
  const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^model = "gpt-5"\n\n\[mcp_servers\.cortad\]\ncommand = "npx"\nargs = \["-y","cortad@latest","mcp"\]\n$/);
  assert.ok(existsSync(join(home, ".agents", "skills", "cortad", "SKILL.md")));
  assert.equal(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.cortad.command, "npx");
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8")).mcpServers.cortad, { type: "local", command: "npx", args: ["-y", "cortad@latest", "mcp"], tools: ["*"] });
  assert.match(readFileSync(join(home, ".copilot", "skills", "cortad", "SKILL.md"), "utf8"), /npx cortad@latest run_status/);

  await registerAll({ home, env: noPath, skillSrc, spec: latest });
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), codex);
});

test("an entry that names another spec is moved to this one; an absolute folder runs without -y", async () => {
  const home = mkdtempSync(join(tmpdir(), "cortad-home-"));
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { cortad: { type: "stdio", command: "npx", args: ["-y", "cortad@latest", "mcp"] }, other: { command: "x" } } }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "model = \"gpt-5\"\n\n[mcp_servers.cortad]\ncommand = \"npx\"\nargs = [\"-y\", \"cortad@latest\", \"mcp\"]\n\n[profiles.fast]\nmodel = \"gpt-5-mini\"\n");

  const folder = "/Users/me/brainsless-local";
  await registerAll({ home, env: noPath, skillSrc, spec: folder });
  const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursor.mcpServers.cortad.args, [folder, "mcp"]);
  assert.equal(cursor.mcpServers.other.command, "x");
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"),
    `model = "gpt-5"\n\n[mcp_servers.cortad]\ncommand = "npx"\nargs = ["${folder}","mcp"]\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n`);
  assert.match(readFileSync(join(home, ".agents", "skills", "cortad", "SKILL.md"), "utf8"), /npx \/Users\/me\/brainsless-local run_status/);
});

test("with the client's own binary on PATH its add command is used; an entry under another spec is removed and added again", async () => {
  const home = mkdtempSync(join(tmpdir(), "cortad-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "");
  // Behaves as `claude mcp` does: add refuses a name that exists, and both write ~/.claude.json.
  const file = join(home, ".claude.json");
  const ran = [];
  const run = async (cmd, args) => {
    ran.push([cmd, ...args]);
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { mcpServers: {} };
    if (args[1] === "remove") delete config.mcpServers.cortad;
    else if (config.mcpServers.cortad) throw Object.assign(new Error("x"), { stderr: "MCP server cortad already exists in user config" });
    else config.mcpServers.cortad = { type: "stdio", command: args[6], args: args.slice(7) };
    writeFileSync(file, JSON.stringify(config));
  };
  await registerAll({ home, env: { PATH: bin }, run, skillSrc, spec: latest });
  await registerAll({ home, env: { PATH: bin }, run, skillSrc, spec: latest });
  assert.deepEqual(ran, [
    ["claude", "mcp", "add", "--scope", "user", "cortad", "--", "npx", "-y", "cortad@latest", "mcp"],
    ["claude", "mcp", "add", "--scope", "user", "cortad", "--", "npx", "-y", "cortad@latest", "mcp"],
  ]);
  await registerAll({ home, env: { PATH: bin }, run, skillSrc, spec: "cortad@next" });
  assert.deepEqual(ran.slice(2).map((r) => r[2]), ["add", "remove", "add"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers.cortad.args, ["-y", "cortad@next", "mcp"]);
});
