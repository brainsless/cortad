// A store's whole server copied into a Docker container of ours for one session, for an app that
// names its databases or indexes in its code, so no setting can point it at a copy on the same
// server. Ours runs the image the original runs where the original is a container, else the
// engine's own image at the original's version. It listens on one port of this machine's loopback,
// the same inside the container and out, so an address the server gives of itself (a replica set's
// member, a search node's) is one the app reaches. It is removed with its volumes at the end.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

// `env` reaches the docker command only: `-e NAME` with no value hands a container that value
// without it ever sitting on a command line another process can read.
export const docker = (args, { env = {}, timeout = 120_000 } = {}) => new Promise((done) => {
  execFile("docker", args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } }, (err, out, errText) => done({ ok: !err, code: err?.code === "ENOENT" ? "missing" : err?.code ?? 0, out: String(out ?? ""), err: String(errText ?? err?.message ?? "") }));
});

let up = null;
export const dockerUp = () => (up ??= docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 }).then((r) => r.ok));

export const freePort = () => new Promise((ok, no) => {
  const s = createServer().once("error", no).listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});

// The container publishing this port of the machine, with the network it sits on and its address
// there, which ours joins to read from it: a port published only on loopback is out of reach of
// another container on Linux.
export async function servedBy(port) {
  const ps = await docker(["ps", "--format", "{{.ID}}\t{{.Image}}\t{{.Ports}}"], { timeout: 15_000 });
  for (const line of ps.out.split("\n")) {
    const [id, image, ports = ""] = line.split("\t");
    const inner = new RegExp(`(?:^|,\\s*)\\S*:${port}->(\\d+)/tcp`).exec(ports)?.[1];
    if (!inner) continue;
    const nets = await docker(["inspect", "-f", "{{range $n, $e := .NetworkSettings.Networks}}{{$n}} {{$e.IPAddress}}\n{{end}}", id], { timeout: 15_000 });
    const [net, ip] = nets.out.trim().split("\n")[0]?.split(" ") ?? [];
    return { image, inner: Number(inner), ...(net && ip ? { net, ip } : {}) };
  }
  return null;
}

export const copyName = (engine) => `cortad-${engine}-${process.pid}-${randomBytes(3).toString("hex")}`;

// Started detached; a first pull of the image is part of the start. Answers true when it runs.
// `secrets` reach the container by name only, their values through the docker command's environment.
export async function runCopy({ name, image, port, env = {}, secrets = {}, entrypoint, args = [], network }) {
  const placed = network ? ["--network", network] : ["--add-host", "host.docker.internal:host-gateway"];
  const settings = [...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), ...Object.keys(secrets).flatMap((k) => ["-e", k])];
  return (await docker(["run", "-d", "--name", name, "--label", "cortad.copy=1", ...placed, "-p", `127.0.0.1:${port}:${port}`, ...settings, ...(entrypoint ? ["--entrypoint", entrypoint] : []), image, ...args], { env: secrets, timeout: 900_000 })).ok;
}

export const removeCopy = async (name) => {
  const r = await docker(["rm", "-f", "-v", name], { timeout: 60_000 });
  return r.ok || /No such container/i.test(r.err);
};

export async function until(ok, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1000))) {
    try { if (await ok()) return true; } catch { /* not yet */ }
  }
  return false;
}
