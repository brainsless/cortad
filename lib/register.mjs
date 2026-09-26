import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Making Cortad known to the coding agents on this machine: an MCP entry in each client that is
// here, and the skill that teaches the loop. Nothing is written into the repository; everything
// lands in the client's own home folders, the way the client's own `add` command would put it.
// Idempotent: run twice, it adds nothing twice.
const exec = promisify(execFile);
const SERVER = { command: "npx", args: ["-y", "cortad@latest", "mcp"] };
const SKILL_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "skill");

export const onPath = (bin, env = process.env) =>
  (env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));

export function detectClients({ home = homedir(), env = process.env } = {}) {
  return {
    claude: onPath("claude", env) || existsSync(join(home, ".claude")),
    codex: onPath("codex", env) || existsSync(join(home, ".codex")),
    cursor: existsSync(join(home, ".cursor")),
    copilot: onPath("copilot", env) || existsSync(join(home, ".copilot")),
  };
}

// Returns the names of the clients that now know Cortad, for the one line the command prints.
export async function registerAll({ home = homedir(), env = process.env, run = exec, skillSrc = SKILL_SRC } = {}) {
  const found = detectClients({ home, env });
  const added = [];
  if (found.claude) {
    await registerClaude({ home, env, run });
    installSkill(join(home, ".claude", "skills", "cortad"), skillSrc);
    added.push("Claude Code");
  }
  if (found.codex) {
    await registerCodex({ home, env, run });
    added.push("Codex");
  }
  if (found.cursor) {
    registerCursor({ home });
    added.push("Cursor");
  }
  if (found.copilot) {
    registerCopilot({ home });
    added.push("Copilot");
  }
  // The one skills folder Codex, Cursor and Copilot all read.
  if (found.codex || found.cursor || found.copilot) installSkill(join(home, ".agents", "skills", "cortad"), skillSrc);
  return added;
}

// The client's own command when it is here, so its config is written the way it writes it; the file
// itself only when the folder exists without the binary on this PATH.
async function registerClaude({ home, env, run }) {
  if (onPath("claude", env)) {
    try { await run("claude", ["mcp", "add", "--scope", "user", "cortad", "--", SERVER.command, ...SERVER.args], { env }); return; }
    catch (err) { if (/already exists/i.test(String(err?.stderr ?? err?.message))) return; }
  }
  const file = join(home, ".claude.json");
  const config = readJson(file) ?? {};
  config.mcpServers = { ...(config.mcpServers ?? {}), cortad: { type: "stdio", ...SERVER } };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function registerCodex({ home, env, run }) {
  if (onPath("codex", env)) {
    try { await run("codex", ["mcp", "add", "cortad", "--", SERVER.command, ...SERVER.args], { env }); return; }
    catch (err) { if (/already exists/i.test(String(err?.stderr ?? err?.message))) return; }
  }
  const file = join(home, ".codex", "config.toml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^\[mcp_servers\.cortad\]/m.test(text)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n[mcp_servers.cortad]\ncommand = "${SERVER.command}"\nargs = ${JSON.stringify(SERVER.args)}\n`);
}

function registerCursor({ home }) {
  const file = join(home, ".cursor", "mcp.json");
  const config = readJson(file) ?? {};
  if (config.mcpServers?.cortad) return;
  config.mcpServers = { ...(config.mcpServers ?? {}), cortad: { type: "stdio", ...SERVER } };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

// Copilot CLI keeps its servers in its own home, in its own shape: a "local" server with every tool.
function registerCopilot({ home }) {
  const file = join(home, ".copilot", "mcp-config.json");
  const config = readJson(file) ?? {};
  if (config.mcpServers?.cortad) return;
  config.mcpServers = { ...(config.mcpServers ?? {}), cortad: { type: "local", ...SERVER, tools: ["*"] } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

// SKILL.md and its references, copied whole so a newer package refreshes the words.
export function installSkill(dir, src = SKILL_SRC) {
  mkdirSync(join(dir, "references"), { recursive: true });
  copyFileSync(join(src, "SKILL.md"), join(dir, "SKILL.md"));
  copyFileSync(join(src, "references", "results.md"), join(dir, "references", "results.md"));
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
