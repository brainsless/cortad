// Some apps keep their sign-in on a different service than the one that serves the AI: one app
// serves chat from apps/api and mounts better-auth in apps/dashboard, and the command starts only
// apps/api. A recipe that names such a service (src/setup/road-identities.ts) is minted against
// that service instead, so nobody is asked to send a message by hand. Cookies set on localhost
// apply to every port, which is what makes the session work on the AI service after.
import { existsSync, readFileSync } from "node:fs";
import { relative, join } from "node:path";
import { startPlan } from "./start.mjs";

export const serviceBase = (port) => `http://127.0.0.1:${port}`;

const PORT_IN_SCRIPT = /(?:^|\s)(?:PORT=|-p[ =]|--port[ =])(\d{2,5})\b/;
// The port a framework serves on when nobody names one. sveltekit and astro before vite: both bring
// vite with them and neither uses its port.
const FRAMEWORK_PORT = [["next", 3000], ["nuxt", 3000], ["@remix-run/serve", 3000], ["@remix-run/dev", 3000], ["@sveltejs/kit", 5173], ["astro", 4321], ["vite", 5173]];
// No scan of the usual ports: whatever answers on 3000 or 8080 on this machine is very often not
// this workspace, and a test account made against somebody else's service is the worst kind of
// wrong. Only the port this workspace itself names, and if nothing is there, it is started.

// What a workspace serves on: its own script says so, or the framework it is written in does.
export function servicePort(cwd) {
  let pkg = null;
  try { pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); } catch { /* not a Node workspace */ }
  const script = ["dev", "develop", "start:dev", "serve", "start"].map((s) => pkg?.scripts?.[s]).find(Boolean) ?? "";
  const named = Number(PORT_IN_SCRIPT.exec(script)?.[1]);
  if (named) return named;
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  const framework = FRAMEWORK_PORT.find(([dep]) => deps.includes(dep))?.[1];
  if (framework) return framework;
  if (existsSync(join(cwd, "manage.py"))) return 8000;
  if (existsSync(join(cwd, "Gemfile"))) return 3000;
  const py = ["requirements.txt", "pyproject.toml"].map((f) => { try { return readFileSync(join(cwd, f), "utf8"); } catch { return ""; } }).join("\n");
  return /\bdjango\b/i.test(py) ? 8000 : /\bflask\b/i.test(py) ? 5000 : null;
}

// The recipes to mint against a service other than the running app, grouped by that service's
// workspace, each with how it starts itself. A recipe whose service is the app's own dir stays with
// the app and is not returned here.
export function servicesFor({ recipes, root, appDir, onPath }) {
  const here = relative(root, appDir) || ".";
  const byDir = new Map();
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    const dir = typeof recipe?.service === "string" ? recipe.service.replace(/^\.\//, "").replace(/\/+$/, "") : "";
    if (!dir || dir === here) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(recipe);
  }
  return [...byDir].map(([dir, group]) => ({
    dir,
    cwd: join(root, dir),
    plan: startPlan({ root: join(root, dir), onPath }),
    recipes: group,
  }));
}

// One sign-in per port: recipes whose sign-in is mounted in another workspace are minted against
// that workspace, the rest against the app, and the rows come back as one list. A repository whose
// sign-in is where the app is mints once, against the app, as it always did.
export async function mintAcross({ recipes, root, appDir, onPath, appPort, portFor, mint, originFor = () => undefined }) {
  const groups = servicesFor({ recipes, root, appDir, onPath });
  if (!groups.length) return mint(recipes, appPort);
  const elsewhere = new Set(groups.flatMap((g) => g.recipes));
  const rows = [];
  for (const group of groups) {
    const port = (await portFor(group)) ?? appPort;
    rows.push(...((await mint(group.recipes, port, originFor(port)))?.identities ?? []));
  }
  const rest = (Array.isArray(recipes) ? recipes : []).filter((r) => !elsewhere.has(r));
  if (rest.length) rows.push(...((await mint(rest, appPort))?.identities ?? []));
  return { identities: rows };
}

// Wait for a service to answer on its port, bounded so a service that never comes up cannot hold
// the whole raise. Any HTTP reply means the port is up; a connection refused means keep waiting.
export async function waitForPort(port, deadlineMs = 90_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      await fetch(serviceBase(port) + "/", { method: "GET", signal: AbortSignal.timeout(2500), redirect: "manual" });
      return true;
    } catch (e) {
      if (!/aborted|timeout|ECONNREFUSED|ECONNRESET|fetch failed|other side closed/i.test(String(e?.cause?.code ?? e?.message ?? e))) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

// The page a sign-in believes it is being asked from. Nearly every auth library refuses a request
// whose Origin it does not trust: better-auth answered one app's own sign-up with 403
// INVALID_ORIGIN because the ask went to 127.0.0.1 with no page behind it. Their own settings name
// the page; where they do not, it is that port on localhost, which is what their own browser sends.
export function originFor(port, origins = []) {
  const named = origins.find((o) => { try { return new URL(o).port === String(port); } catch { return false; } });
  return named ?? `http://localhost:${port}`;
}
