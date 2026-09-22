// Switches an app reads to decide who it lets in, set for the app this command started and for
// nothing else. The customer's files are never written, and every name is printed before the app
// starts. A lockout, an attempt counter and a password rule are never touched.
import { readFileSync, statSync } from "node:fs";

const GUARDED = /(AUTH|LOGIN|PASSWORD|BREAKER|LOCKOUT|ATTEMPT|FAIL|BAN|BLOCK)/;
const ENV_READ = /(?:process\.env(?:\.|\[\s*['"])|os\.(?:environ\.get|getenv)\(\s*['"]|os\.environ\[\s*['"]|\benv\(\s*['"]|Deno\.env\.get\(\s*['"])([A-Z][A-Z0-9_]*)/g;

// A switch their own app reads to decide whether a caller has to be signed in at all. morphic's
// chat answers 401 to everyone until ENABLE_GUEST_CHAT is true; open-webui, librechat and a dozen
// others carry the same idea under their own name. Set for the app this command started and for
// nothing else: their files are not touched, and the name is printed before anything starts.
// A lockout, an attempt counter and a password rule carry the same words and are never touched.
const OPENS_AUTH = /^(?:ENABLE|REQUIRE)_AUTH(?:ENTICATION)?$|^AUTH(?:ENTICATION)?_(?:ENABLED|REQUIRED)$|^(?:REQUIRE|ENABLE)_(?:LOGIN|SIGN_?IN)$/;
const CLOSES_AUTH = /^(?:DISABLE|SKIP|NO)_AUTH(?:ENTICATION)?$|^AUTH(?:ENTICATION)?_DISABLED$/;
const OPENS_GUEST = /^(?:ENABLE|ALLOW)_(?:GUEST|ANONYMOUS|PUBLIC)(?:_[A-Z0-9_]+)?$|^(?:GUEST|ANONYMOUS|PUBLIC)_(?:MODE|ACCESS|CHAT|ENABLED|LOGIN)$/;
const CLOSES_GUEST = /^(?:DISABLE|BLOCK)_(?:GUEST|ANONYMOUS|PUBLIC)(?:_[A-Z0-9_]+)?$|^(?:GUEST|ANONYMOUS|PUBLIC)_(?:MODE|ACCESS|CHAT)_DISABLED$/;
const BOOLEAN = /^(?:true|false|1|0|yes|no|on|off)$/i;
export function openSwitches(envFiles, sources = []) {
  const out = {};
  const open = (name) => {
    if (GUARDED.test(name) && !OPENS_AUTH.test(name) && !CLOSES_AUTH.test(name)) return null;
    if (OPENS_AUTH.test(name) || CLOSES_GUEST.test(name)) return "false";
    if (CLOSES_AUTH.test(name) || OPENS_GUEST.test(name)) return "true";
    return null;
  };
  for (const file of envFiles) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      const to = open(m[1]);
      // Only a switch: a name of this shape holding a URL or a key is something else entirely.
      if (to && (value === "" || BOOLEAN.test(value))) out[m[1]] = to;
    }
  }
  for (const file of sources) {
    if (!/\.(?:[cm]?[jt]sx?|py|go|rb|php|rs)$/.test(file)) continue;
    let text = "";
    try { if (statSync(file).size > 512_000) continue; text = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(ENV_READ)) { const to = open(m[1]); if (to && !(m[1] in out)) out[m[1]] = to; }
  }
  return out;
}

