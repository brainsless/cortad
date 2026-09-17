// The other half of lib/trace.cjs: the command's side. It hands the hook to the app it starts,
// reads what the hook wrote, keeps the sign-in that request carried on this machine, and tells the
// cloud only what it needs to ask again: the route, the method and the body.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "trace.cjs");
const PYHOOK = join(HERE, "pyhook");
export const CAPTURED = "captured";
// Never replayed: they describe one connection, not the caller.
const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as)$/i;

export function makeCapture({ work, keepSecret, onDoor }) {
  const file = join(work, "trace.jsonl");
  let read = 0;
  let held = null;
  let alive = false;
  // Both hooks are handed to whatever is started: a Node app loads the first, a Python app the
  // second, and each ignores the other's variable.
  // ponytail: Node and Python. Go, Ruby, Java and PHP apps are asked for their route on the screen.
  const env = (base) => ({
    CORTAD_TRACE_FILE: file,
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --require ${JSON.stringify(HOOK)}`.trim(),
    PYTHONPATH: [PYHOOK, base.PYTHONPATH].filter(Boolean).join(":"),
  });

  function poll() {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size <= read) return;
    const fresh = readFileSync(file, "utf8").slice(read);
    read = size;
    for (const line of fresh.split("\n").filter(Boolean)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.hello) { alive = true; continue; }
      let body; try { body = JSON.parse(row.body); } catch { continue; }
      if (!body || typeof body !== "object" || typeof row.path !== "string" || !row.path.startsWith("/")) continue;
      const headers = Object.fromEntries(Object.entries(row.headers ?? {}).filter(([k, v]) => !HOP.test(k) && typeof v === "string"));
      for (const [k, v] of Object.entries(headers)) if (/authorization|cookie|token|secret|session|csrf|api-?key/i.test(k)) keepSecret(String(v).replace(/^Bearer\s+/i, ""));
      held = { headers, at: Date.now() };
      onDoor({ method: String(row.method || "POST").toUpperCase(), path: row.path, body, headerNames: Object.keys(headers).sort() });
    }
  }
  const timer = setInterval(poll, 700);
  timer.unref();
  return { env, headers: () => held?.headers ?? null, alive: () => { poll(); return alive; } };
}
