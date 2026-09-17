// The lock on the shell a world may run on your machine. Enforced by the operating system, not by
// reading the command: on a Mac the same Seatbelt sandbox Codex and Claude Code use, on Linux
// bubblewrap. Inside it a shell line can read your project and run your tests, and it can write
// only where your own .gitignore already says files are disposable (caches, build output, coverage)
// and in temp. It cannot write a tracked file, cannot read your keys or environment files, and on a
// Mac cannot reach the network beyond this machine. With neither tool present there is no shell.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const q = (p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// Dependencies are not disposable even though git ignores them; their caches are.
const CACHES = [".cache", ".vite", ".vitest", ".bin/.cache"];

async function disposableDirs(root) {
  const out = await run("git", ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], { maxBuffer: 16 * 1024 * 1024 })
    .then((r) => r.stdout.split("\n"), () => []);
  const dirs = [];
  for (const line of out) {
    if (!line.endsWith("/")) continue;
    const rel = line.slice(0, -1);
    if (/(^|\/)\.git($|\/)/.test(rel)) continue;
    if (/(^|\/)node_modules$/.test(rel)) { for (const c of CACHES) dirs.push(join(root, rel, c)); continue; }
    dirs.push(join(root, rel));
    if (dirs.length >= 200) break;
  }
  return dirs;
}

const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".docker", ".kube"];
const SECRET_FILES = [".netrc", ".npmrc", ".pypirc"];

export async function makeLock({ root, work }) {
  const home = homedir();
  // Temp is writable, unless the project itself lives under it: a folder that contains your code is
  // never opened whole, whatever it is called.
  const home0 = real(root) ?? root;
  const holdsProject = (dir) => home0 === dir || home0.startsWith(`${dir}/`);
  const writable = [work, tmpdir(), "/tmp", ...(await disposableDirs(root))].map((p) => real(p) ?? p).filter((dir) => !holdsProject(dir));
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const profile = [
      "(version 1)(allow default)",
      "(deny network*)",
      // This machine only. Unix sockets stay shut: through one, a request rides out to the internet
      // by name on a system network helper even with every direct connection refused.
      '(allow network-outbound (remote ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))',
      "(deny file-write*)",
      `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(" ")} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (subpath "/dev/fd"))`,
      `(deny file-read* ${SECRET_DIRS.map((d) => `(subpath ${q(join(home, d))})`).join(" ")} ${SECRET_FILES.map((f) => `(literal ${q(join(home, f))})`).join(" ")} (regex #"/\\.env$") (regex #"/\\.env\\.(local|staging|stage|development|dev|test|production|prod)$"))`,
    ].join("");
    return { name: "seatbelt", wrap: (cmd) => ({ file: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", cmd] }) };
  }
  const bwrap = process.platform === "linux" ? ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync) : null;
  if (bwrap) {
    // ponytail: writes and secrets are locked on Linux, the network is not; add a network
    // namespace with a loopback bridge when a customer's threat model asks for it.
    const binds = writable.filter(existsSync).flatMap((p) => ["--bind", p, p]);
    const hidden = [...SECRET_DIRS.map((d) => join(home, d)).filter(existsSync).flatMap((p) => ["--tmpfs", p])];
    return { name: "bubblewrap", wrap: (cmd) => ({ file: bwrap, args: ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...binds, ...hidden, "/bin/sh", "-c", cmd] }) };
  }
  return null;
}

// One line proving the lock holds here, before any world is allowed a shell.
export function lockHolds(lock, root) {
  const probe = join(root, `.bl-lock-probe-${process.pid}`);
  const { file, args } = lock.wrap(`touch ${JSON.stringify(probe)}`);
  try { execFileSync(file, args, { stdio: "ignore" }); } catch { /* refused, as it must be */ }
  if (!existsSync(probe)) return true;
  try { execFileSync("rm", ["-f", probe]); } catch { /* best effort */ }
  return false;
}
