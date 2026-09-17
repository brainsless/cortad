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

function nodeStart(dir, onPath) {
  const pkg = json(join(dir, "package.json"));
  if (!pkg) return null;
  const script = ["dev", "develop", "start:dev", "serve", "start"].find((s) => pkg.scripts?.[s]);
  if (!script) return null;
  const locked = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")) ? "bun" : "npm";
  // A lockfile names the manager the repository was installed with, not one this machine has.
  return `${onPath(locked) ? locked : "npm"} run ${script}`;
}

function pythonStart(dir, onPath) {
  if (!["requirements.txt", "pyproject.toml", "manage.py", "Pipfile", "uv.lock"].some((f) => existsSync(join(dir, f)))) return null;
  const venv = [".venv/bin/python", "venv/bin/python", "env/bin/python"].map((p) => join(dir, p)).find(existsSync);
  const py = venv ? JSON.stringify(venv) : existsSync(join(dir, "uv.lock")) && onPath("uv") ? "uv run python" : existsSync(join(dir, "poetry.lock")) && onPath("poetry") ? "poetry run python" : "python3";
  if (existsSync(join(dir, "manage.py"))) return `${py} manage.py runserver`;
  for (const entry of ENTRIES) {
    const text = read(join(dir, entry));
    if (!text) continue;
    // Their own way of starting it carries their own port and settings.
    if (/if\s+__name__\s*==\s*["']__main__["']/.test(text)) return `${py} ${entry}`;
    const module = entry.replace(/\.py$/, "").split("/").join(".");
    const fast = /^(\w+)\s*=\s*(?:FastAPI|Starlette|Litestar|Quart)\(/m.exec(text);
    if (fast) return `${py} -m uvicorn ${module}:${fast[1]} --host 127.0.0.1 --port 8000`;
    const flask = /^(\w+)\s*=\s*Flask\(/m.exec(text);
    if (flask) return `${py} -m flask --app ${module} run --port 5000`;
  }
  return null;
}

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
function workspaces(root) {
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
  if (own) return { cmd: own, cwd: root };
  const ranked = workspaces(root).map((dir) => ({ dir, cmd: startOf(dir, onPath), weight: weight(dir, relative(root, dir)) })).filter((w) => w.cmd).sort((a, b) => b.weight - a.weight);
  const best = ranked[0];
  if (best && best.weight > 0 && (ranked.length === 1 || best.weight > ranked[1].weight)) return { cmd: best.cmd, cwd: best.dir, within: relative(root, best.dir) };
  // A root that does have a start of its own after all (a monorepo whose root script runs everything).
  const rootStart = startOf(root, onPath);
  return rootStart ? { cmd: rootStart, cwd: root } : best ? { cmd: best.cmd, cwd: best.dir, within: relative(root, best.dir), unsure: true } : null;
}
