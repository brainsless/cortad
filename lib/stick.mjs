import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { cliSpec, npxName } from "./spec.mjs";

// `npx cortad stick`: one line in each coding agent's own instructions file in this repository, and
// a hook in the two clients that run one after an edit. `unstick` takes out exactly what stick put
// in. Both are idempotent, print what they changed, and never touch git.
//
// The hook command carries --hook: Claude Code and Codex both drop plain stdout from a PostToolUse
// hook, and read only hookSpecificOutput.additionalContext. The command follows lib/spec.mjs, and
// unstick knows the line and the hook under any spec.
export const lineFor = (name) => `After changing prompts, tools, models or retrieval, check with Cortad before committing: npx ${name} status`;
export const hookFor = (name) => `npx ${name} status --changed --hook`;
const IS_LINE = /^After changing prompts, tools, models or retrieval, check with Cortad before committing: npx \S+ status$/;
const IS_HOOK = /^npx \S+ status --changed --hook$/;
const hasLine = (text) => text.split("\n").some((l) => IS_LINE.test(l.trim()));
const ours = (entry) => entry?.hooks?.some((h) => IS_HOOK.test(h.command ?? ""));
const LINE_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const HOOK_FILES = [".claude/settings.json", ".codex/hooks.json"];
const RULE_FILE = ".cursor/rules/cortad.mdc";

export const hookOutput = (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });

export function stick(root, { spec = cliSpec() } = {}) {
  const line = lineFor(npxName(spec));
  const hook = hookFor(npxName(spec));
  const rule = `---\ndescription: Checking AI behavior with Cortad\nalwaysApply: true\n---\n${line}\n`;
  const said = LINE_FILES.map((rel, i) => write(root, rel, (text) => {
    if (hasLine(text)) return null;
    return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${line}\n`;
  }, i === 0 ? `added "${line}"` : "added the same line"));
  said.push(write(root, RULE_FILE, (text) => (hasLine(text) ? null : rule), "written, with the same line, applied always"));
  said.push(...HOOK_FILES.map((rel, i) => write(root, rel, (text) => {
    const config = parse(text);
    if (config === undefined) return undefined;
    const list = config.hooks?.PostToolUse ?? [];
    if (list.some(ours)) return null;
    config.hooks = { ...config.hooks, PostToolUse: [...list, { matcher: "Edit|Write", hooks: [{ type: "command", command: hook }] }] };
    return `${JSON.stringify(config, null, 2)}\n`;
  }, i === 0 ? `added a PostToolUse hook on Edit|Write that runs ${hook}` : "added the same hook")));
  return said;
}

export function unstick(root) {
  const said = LINE_FILES.map((rel) => write(root, rel, (text) => {
    if (!hasLine(text)) return null;
    return text.split("\n").filter((l) => !IS_LINE.test(l.trim())).join("\n").replace(/\n+$/, "\n");
  }, "removed the line"));
  said.push(write(root, RULE_FILE, (text) => (text ? "" : null), "removed"));
  said.push(...HOOK_FILES.map((rel) => write(root, rel, (text) => {
    const config = parse(text);
    if (config === undefined) return undefined;
    const list = config.hooks?.PostToolUse;
    if (!list?.some(ours)) return null;
    const kept = list.map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !IS_HOOK.test(h.command ?? "")) })).filter((e) => e.hooks.length);
    if (kept.length) config.hooks.PostToolUse = kept;
    else delete config.hooks.PostToolUse;
    if (!Object.keys(config.hooks).length) delete config.hooks;
    return Object.keys(config).length ? `${JSON.stringify(config, null, 2)}\n` : "";
  }, "removed the hook")));
  return said;
}

// One file: `change` gets its text ("" when absent) and returns the new text, null for nothing to
// do, or undefined when it cannot be read. An empty result removes the file, and the folders it
// leaves empty. A path that leaves the repository, through a symbolic link or otherwise, is left alone.
function write(root, rel, change, done) {
  const file = resolve(root, rel);
  if (!inside(root, file)) return `${rel}: left alone, it points outside this repository`;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = change(text);
  if (next === undefined) return `${rel}: left alone, it is not valid JSON`;
  if (next === null) return `${rel}: nothing to change`;
  if (next.trim() === "") {
    rmSync(file);
    for (let dir = dirname(file); dir.startsWith(`${resolve(root)}${sep}`) && !readdirSync(dir).length; dir = dirname(dir)) rmdirSync(dir);
    return `${rel}: removed, it held only what stick wrote`;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return `${rel}: ${done}`;
}

function inside(root, file) {
  const base = realpathSync(root);
  let dir = dirname(file);
  while (!existsSync(dir)) dir = dirname(dir);
  const real = realpathSync(dir);
  if (real !== base && !real.startsWith(base + sep)) return false;
  try { return !lstatSync(file).isSymbolicLink(); } catch { return true; }
}

function parse(text) {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}
