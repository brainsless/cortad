// Some apps keep their sign-in on a different service than the one that serves the AI: databuddy
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
