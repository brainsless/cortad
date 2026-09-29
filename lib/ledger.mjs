// What this command made on the person's machine and has not yet undone: a database copied, a
// service started. Kept in the project's folder under ~/.cortad, so a session that died (a killed
// terminal, a closed lid) is undone by the next one. Rows name what was made, never an address or
// a password.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };

export function ledger(file) {
  const read = () => { try { const rows = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(rows) ? rows : []; } catch { return []; } };
  const write = (rows) => { try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(rows), { mode: 0o600 }); } catch { /* undone by hand then */ } };
  const same = (a, b) => a.kind === b.kind && a.key === b.key && a.made === b.made;
  return {
    add: (row) => write([...read().filter((r) => !same(r, row)), { ...row, pid: process.pid }]),
    remove: (row) => write(read().filter((r) => !same(r, row))),
    // Rows of `kind` whose session has ended.
    orphans: (kind) => read().filter((r) => r.kind === kind && !alive(r.pid)),
  };
}
