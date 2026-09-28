import { readFileSync } from "node:fs";

// A model's or provider's name is how the app is configured, not a credential: status names it and
// prices the run by it. A value under such a name that looks like a key stays masked all the same.
const NAMES_A_MODEL = /(?:^|_)(?:MODEL|MODELS|MODEL_NAME|MODEL_ID|PROVIDER)$/i;
const KEY_LIKE = /[A-Za-z0-9]{24,}/;

// Values from your env files, read here and only here, so nothing a command prints can carry one.
export function secretValues(envFiles) {
  const values = new Set();
  for (const file of envFiles) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (NAMES_A_MODEL.test(m[1]) && !KEY_LIKE.test(v)) continue;
      if (v.length >= 8 && !/^(true|false|localhost|development|production|\d+)$/i.test(v)) values.add(v);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}
