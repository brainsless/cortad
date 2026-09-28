// Stops an app when the runner that started it is gone, however it went: this process's stdin is the
// runner's end of a pipe, and the kernel closes it even for a runner killed outright. The runner kills
// this process itself when the app ends first (lib/proc.mjs spawnTied).
import { stopTree } from "./proc.mjs";

const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 1) process.exit(2);
process.stdin.once("close", () => { stopTree(pid).finally(() => process.exit(0)); });
process.stdin.resume();
