// How their app is started, and from which folder, worked out from the repository itself so nobody
// is asked. A monorepo root has no app of its own: the app is the workspace that serves the AI.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
const json = (file) => { try { return JSON.parse(read(file)); } catch { return null; } };
const MODEL_SDK = /^(?:openai|ai|@ai-sdk\/.+|@anthropic-ai\/sdk|langchain|@langchain\/.+|llamaindex|@google\/generative-ai|@google\/genai|groq-sdk|@mistralai\/.+|cohere-ai|ollama|replicate|together-ai)$/;
const SERVER = /^(?:express|fastify|hono|koa|@nestjs\/core|@strapi\/strapi|next|nuxt|@remix-run\/.+|@sveltejs\/kit|@hapi\/hapi|restify|elysia)$/;
const PY_MODEL = /^\s*["']?(?:openai|anthropic|langchain|langgraph|litellm|llama[-_]index|google-generativeai|google-genai|groq|cohere|mistralai|ollama|fireworks-ai|together)\b/im;
const PY_SERVER = /^\s*["']?(?:fastapi|flask|django|starlette|quart|litestar|sanic|aiohttp|uvicorn|gunicorn)\b/im;
const ENTRIES = ["main.py", "app.py", "server.py", "run.py", "api.py", "wsgi.py", "asgi.py", "src/main.py", "app/main.py", "src/app.py", "backend/main.py", "api/main.py"];
// A twelve-name list is not how apps name their entry file: agent-service-toolkit's is
// src/run_service.py, and asking a person how their app starts because of a filename is asking
// them to do our job. Every plausibly named file beside the manifest is a candidate.
const ENTRY_NAME = /^(?:main|app|server|serve|api|run|start|service|web|backend|wsgi|asgi)[\w-]*\.py$/i;
const entriesIn = (dir) => ["", "src", "app", "backend", "api"].flatMap((sub) => {
  try { return readdirSync(join(dir, sub)).filter((f) => ENTRY_NAME.test(f)).map((f) => (sub ? `${sub}/${f}` : f)); }
  catch { return []; }
});
// What tells an entry file from a script that also runs itself: this one brings a server up.
const SERVES = /uvicorn\.run|FastAPI\(|Flask\(|Starlette\(|Litestar\(|Quart\(|app\.run\(|run_server|serve\(/;
// The same question of a package script: does this command put something on a port, or run a task
// and exit. `crewai run` and `python main.py` are tasks; `next dev` and `nodemon server.js` serve.
const SERVES_JS = /\b(?:next|nuxt|vite|nest|remix|astro|sveltekit|serve|nodemon|ts-node-dev|uvicorn|gunicorn|rails|strapi)\b/;
// The manager this repository was installed with, named by its lockfile.
const manager = (dir) => (existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun" : "npm");

function nodeStart(dir, onPath) {
  const pkg = json(join(dir, "package.json"));
  if (!pkg) return null;
  const script = ["dev", "develop", "start:dev", "serve", "start"].find((s) => pkg.scripts?.[s]);
  if (!script) return null;
  const locked = manager(dir);
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  // A lockfile names the manager the repository was installed with, not one this machine has.
  return { cmd: `${onPath(locked) ? locked : "npm"} run ${script}`, serves: deps.some((d) => SERVER.test(d)) || SERVES_JS.test(pkg.scripts[script]) };
}

function pythonStart(dir, onPath) {
  if (!["requirements.txt", "pyproject.toml", "manage.py", "Pipfile", "uv.lock"].some((f) => existsSync(join(dir, f)))) return null;
  const venv = [".venv/bin/python", "venv/bin/python", "env/bin/python"].map((p) => join(dir, p)).find(existsSync);
  const py = venv ? JSON.stringify(venv) : existsSync(join(dir, "uv.lock")) && onPath("uv") ? "uv run python" : existsSync(join(dir, "poetry.lock")) && onPath("poetry") ? "poetry run python" : "python3";
  if (existsSync(join(dir, "manage.py"))) return { cmd: `${py} manage.py runserver`, serves: true };
  const named = [...new Set([...ENTRIES, ...entriesIn(dir)])].map((entry) => [entry, read(join(dir, entry))]).filter(([, text]) => text);
  // The file that serves before the file that merely runs: src/run_agent.py runs a conversation in
  // the terminal and src/run_service.py is the app, and they sit in one folder.
  for (const [entry, text] of [...named.filter(([, text]) => SERVES.test(text)), ...named]) {
    // Their own way of starting it carries their own port and settings.
    if (/if\s+__name__\s*==\s*["']__main__["']/.test(text)) return { cmd: `${py} ${entry}`, serves: SERVES.test(text) };
    const module = entry.replace(/\.py$/, "").split("/").join(".");
    const fast = /^(\w+)\s*=\s*(?:FastAPI|Starlette|Litestar|Quart)\(/m.exec(text);
    if (fast) return { cmd: `${py} -m uvicorn ${module}:${fast[1]} --host 127.0.0.1 --port 8000`, serves: true };
    const flask = /^(\w+)\s*=\s*Flask\(/m.exec(text);
    if (flask) return { cmd: `${py} -m flask --app ${module} run --port 5000`, serves: true };
  }
  return null;
}

const KNOWN = ["package.json", "pyproject.toml", "requirements.txt", "manage.py", "Pipfile", "uv.lock"];

const startOf = (dir, onPath) => nodeStart(dir, onPath) ?? pythonStart(dir, onPath);

// How much a folder looks like the thing that serves the AI.
function weight(dir, name) {
  const pkg = json(join(dir, "package.json"));
  const deps = Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
  const py = `${read(join(dir, "requirements.txt"))}\n${read(join(dir, "pyproject.toml"))}`;
  const model = deps.some((d) => MODEL_SDK.test(d)) || PY_MODEL.test(py);
  const server = deps.some((d) => SERVER.test(d)) || PY_SERVER.test(py);
  return (model ? 4 : 0) + (server ? 2 : 0) + (/back|api|server|service/i.test(name) ? 1 : 0) - (!model && /front|web|client|ui|mobile|docs|site|landing|admin/i.test(name) ? 3 : 0);
}

const SKIP = /^(?:node_modules|\.git|dist|build|\.next|coverage|\.venv|venv|__pycache__|\.turbo|\.cache)$/;
export function workspaces(root) {
  const found = [];
  const visit = (dir, depth) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (SKIP.test(name) || name.startsWith(".")) continue;
      const at = join(dir, name);
      try { if (!statSync(at).isDirectory()) continue; } catch { continue; }
      if (["package.json", "requirements.txt", "pyproject.toml", "manage.py"].some((f) => existsSync(join(at, f)))) found.push(at);
      else if (depth < 2) visit(at, depth + 1);
    }
  };
  visit(root, 1);
  return found;
}

export function startPlan({ root, typed, onPath }) {
  if (typed) return { cmd: typed, cwd: root };
  const pkg = json(join(root, "package.json"));
  const mono = Boolean(pkg?.workspaces) || existsSync(join(root, "pnpm-workspace.yaml")) || existsSync(join(root, "turbo.json")) || existsSync(join(root, "lerna.json"));
  const own = mono ? null : startOf(root, onPath);
  if (own) return { cmd: own.cmd, cwd: root };
  const ranked = workspaces(root).map((dir) => ({ dir, start: startOf(dir, onPath), weight: weight(dir, relative(root, dir)) })).filter((w) => w.start).sort((a, b) => b.weight - a.weight);
  const best = ranked[0];
  const at = (w) => ({ cmd: w.start.cmd, cwd: w.dir, within: relative(root, w.dir) });
  if (best && best.weight > 0 && (ranked.length === 1 || best.weight > ranked[1].weight)) return at(best);
  // A root that does have a start of its own after all (a monorepo whose root script runs everything).
  const rootStart = startOf(root, onPath);
  if (rootStart) return { cmd: rootStart.cmd, cwd: root };
  // Nothing at all that we know how to start. A repository written in a language we read, holding
  // no way to serve, is a package rather than an app: camel is one. Anything else is a start
  // command we have not learned.
  if (!best) return KNOWN.some((f) => existsSync(join(root, f))) ? { cmd: null, cwd: root, noServer: true } : null;
  // Nothing here stands out, so the one that serves wins. A file that only runs in a terminal is
  // not an app: camel is a package people import, swarm and the crewai examples are scripts that
  // print to a terminal, and starting one of them puts a chat loop where nothing can knock on it.
  const serving = ranked.find((w) => w.start.serves);
  return serving ? { ...at(serving), unsure: true } : { cmd: null, cwd: root, noServer: true };
}

// What an app says when its dependencies are not installed on this machine, in every runtime we
// start, and the name of the one it named first.
const MISSING = /Cannot find module ['"]?([@\w./-]+)|Cannot find package ['"]?([@\w./-]+)|ModuleNotFoundError: No module named ['"]?([\w.]+)|ImportError: No module named ['"]?([\w.]+)|(?:^|[:/ ])([\w.-]+): (?:command )?not found|command not found: ?([\w.-]+)/m;
export const missingDependency = (said) => MISSING.exec(String(said ?? ""))?.slice(1).find(Boolean) ?? "";

// One install, with the manager the project locked. Never a global one: a Python project without an
// interpreter of its own gets a virtual environment beside its code, so nothing installed here
// reaches the rest of the machine.
export function installPlan(dir, onPath) {
  if (json(join(dir, "package.json"))) {
    // The manager the repository locked, fetched for the job when this machine has not got it: npm
    // refuses vercel's ai-chatbot outright over a peer range pnpm resolves without a word.
    const locked = manager(dir);
    if (locked !== "npm") return onPath(locked) ? `${locked} install` : `npx --yes ${locked} install`;
    return existsSync(join(dir, "package-lock.json")) ? "npm ci || npm install --legacy-peer-deps" : "npm install || npm install --legacy-peer-deps";
  }
  if (existsSync(join(dir, "uv.lock")) && onPath("uv")) return "uv sync";
  if (existsSync(join(dir, "poetry.lock")) && onPath("poetry")) return "poetry install";
  const venv = [".venv/bin/python", "venv/bin/python", "env/bin/python"].map((p) => join(dir, p)).find(existsSync);
  const py = venv ? JSON.stringify(venv) : null;
  const into = (what) => (py ? `${py} -m pip install ${what}` : `python3 -m venv .venv && .venv/bin/python -m pip install --upgrade pip && .venv/bin/python -m pip install ${what}`);
  if (existsSync(join(dir, "requirements.txt"))) return into("-r requirements.txt");
  if (existsSync(join(dir, "pyproject.toml"))) return into("-e .");
  return null;
}
