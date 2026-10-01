import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// Which cortad the coding agents on this machine start, and the skill and stick name: the
// CORTAD_CLI_SPEC the connect ran with (cortad@next, or an absolute folder for an unpublished
// build), else this very version: under cortad@next the agents ran rc.15 while the connector they
// talked to was the rc.14 the connect command pinned. The spec ends up in a shell line in the
// repository (lib/stick.mjs), so anything else in the variable is ignored.
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SAFE = /^(?:cortad(?:@[A-Za-z0-9._-]+)?|\/[A-Za-z0-9._/-]+)$/;

export function cliSpec({ env = process.env, version = VERSION } = {}) {
  if (env.CORTAD_CLI_SPEC && SAFE.test(env.CORTAD_CLI_SPEC)) return env.CORTAD_CLI_SPEC;
  return `cortad@${version}`;
}

// npx needs -y to fetch a package without asking; a local folder is not fetched.
export const npxArgs = (spec) => (isAbsolute(spec) ? [spec] : ["-y", spec]);

// How a line a person reads names the command: plain `cortad` when that is what npx resolves anyway.
export const npxName = (spec) => (spec === "cortad@latest" ? "cortad" : spec);
