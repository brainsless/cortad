// Some apps keep their sign-in on a different service than the one that serves the AI: one app
// serves chat from apps/api and mounts better-auth in apps/dashboard, and the command starts only
// apps/api. A recipe that names such a service (src/setup/road-identities.ts) is minted against
// that service instead, so nobody is asked to send a message by hand. Cookies set on localhost
// apply to every port, which is what makes the session work on the AI service after.
import { relative, join } from "node:path";
import { startPlan } from "./start.mjs";

export const serviceBase = (port) => `http://127.0.0.1:${port}`;

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
