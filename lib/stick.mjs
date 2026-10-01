import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { cliSpec, npxName, SPEC } from "./spec.mjs";

// `npx cortad stick`: one line in each coding agent's own instructions file in this repository, and
// a hook in the two clients that run one after an edit. `unstick` takes out exactly what stick put
// in. Both are idempotent, print what they changed, and never touch git.
//
// Two hooks: after an edit, the changed prompt and tool files and any news; on the person's next
// prompt, the news alone (a run that ended while the agent was not listening), with no call to the
// server. Both carry --hook: Claude Code and Codex drop plain stdout from a hook and read only
// hookSpecificOutput.additionalContext. The commands follow lib/spec.mjs, and unstick knows the
// line and the hooks under any spec of ours, and no other tool's command of the same shape.
export const lineFor = (name) => `After changing prompts, tools, models or retrieval, check with Cortad before committing: npx ${name} status`;
export const hookFor = (name) => `npx ${name} status --changed --hook`;
export const newsHookFor = (name) => `npx ${name} news --hook`;
const IS_LINE = new RegExp(`^After changing prompts, tools, models or retrieval, check with Cortad before committing: npx ${SPEC} status$`);
const IS_HOOK = new RegExp(`^npx ${SPEC} (?:status --changed|news) --hook$`);
const HOOK_EVENTS = ["PostToolUse", "UserPromptSubmit"];
const hasLine = (text) => text.split("\n").some((l) => IS_LINE.test(l.trim()));
const ours = (entry) => entry?.hooks?.some((h) => IS_HOOK.test(h.command ?? ""));
const LINE_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const HOOK_FILES = [".claude/settings.json", ".codex/hooks.json"];
const RULE_FILE = ".cursor/rules/cortad.mdc";

export const hookOutput = (text, event = "PostToolUse") => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

export function stick(root, { spec = cliSpec() } = {}) {
  const line = lineFor(npxName(spec));
  const hook = hookFor(npxName(spec));
  const news = newsHookFor(npxName(spec));
  const rule = `---\ndescription: Checking AI behavior with Cortad\nalwaysApply: true\n---\n${line}\n`;
  const said = LINE_FILES.map((rel, i) => write(root, rel, (text) => {
    if (hasLine(text)) return null;
    return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${line}\n`;
  }, i === 0 ? `added "${line}"` : "added the same line"));
  said.push(write(root, RULE_FILE, (text) => (hasLine(text) ? null : rule), "written, with the same line, applied always"));
  said.push(...HOOK_FILES.map((rel) => {
    let added = [];
    return write(root, rel, (text) => {
      const config = parse(text);
      if (config === undefined) return undefined;
      const edits = config.hooks?.PostToolUse ?? [];
      const prompts = config.hooks?.UserPromptSubmit ?? [];
      added = [
        ...(edits.some(ours) ? [] : [`a PostToolUse hook on Edit|Write that runs ${hook}`]),
        ...(prompts.some(ours) ? [] : [`a UserPromptSubmit hook that runs ${news}`]),
      ];
      if (!added.length) return null;
      config.hooks = {
        ...config.hooks,
        PostToolUse: edits.some(ours) ? edits : [...edits, { matcher: "Edit|Write", hooks: [{ type: "command", command: hook }] }],
        UserPromptSubmit: prompts.some(ours) ? prompts : [...prompts, { hooks: [{ type: "command", command: news }] }],
      };
      return `${JSON.stringify(config, null, 2)}\n`;
    }, () => `added ${added.join(", and ")}`);
  }));
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
    if (!HOOK_EVENTS.some((event) => config.hooks?.[event]?.some(ours))) return null;
    for (const event of HOOK_EVENTS) {
      const list = config.hooks?.[event];
      if (!list?.some(ours)) continue;
      const kept = list.map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !IS_HOOK.test(h.command ?? "")) })).filter((e) => e.hooks.length);
      if (kept.length) config.hooks[event] = kept;
      else delete config.hooks[event];
    }
    if (!Object.keys(config.hooks).length) delete config.hooks;
    return Object.keys(config).length ? `${JSON.stringify(config, null, 2)}\n` : "";
  }, "removed the hooks")));
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
    return `${rel}: removed, it had only what stick wrote`;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return `${rel}: ${typeof done === "function" ? done() : done}`;
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
