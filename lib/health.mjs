// Whether the app a run is using is alive, read the way a person would: is its process still there,
// does anything still hold its port, and only then does it answer. An app slow to answer because it
// is answering our own requests is working, not dead: resumeforge held sixteen of them on a database
// pool of five, missed two probes of 2.5 seconds, and was restarted in the middle of the run.
import { connect } from "node:net";

const FLOOR_MS = 10_000;
const CAP_MS = 120_000;
const url = (host, port) => `http://${host === "::1" ? "[::1]" : host}:${port}/`;

// Opens the socket and sends nothing. Only a refusal means nobody holds the port: a listener too
// busy to accept still holds it.
export const portHeld = (host, port, ms = 3000) => new Promise((done) => {
  const socket = connect({ host, port });
  const end = (held) => { socket.destroy(); done(held); };
  socket.once("connect", () => end(true));
  socket.once("error", (e) => end(e.code !== "ECONNREFUSED"));
  socket.setTimeout(ms, () => end(true));
});

// `gone`: the process this command started has exited. `inFlight`: the run's requests the app has
// not answered yet. The probe waits three times the app's last reply to it, never under ten seconds
// or over two minutes.
export function makeHealth({ host, gone, inFlight }) {
  let took = 0;
  const timeout = () => Math.min(CAP_MS, Math.max(FLOOR_MS, took * 3));
  return {
    timeout,
    // "up", "busy" (slow while the run's requests are open: never restarted), or why it is down:
    // "exited", "released" (nothing holds its port) or "quiet" (no answer with nothing of ours open).
    async check(port) {
      if (gone()) return "exited";
      if (!(await portHeld(host(), port))) return "released";
      const started = Date.now();
      try {
        const res = await fetch(url(host(), port), { method: "GET", signal: AbortSignal.timeout(timeout()), redirect: "manual" });
        await res.body?.cancel();
        took = Date.now() - started;
        return "up";
      } catch {
        return inFlight() > 0 ? "busy" : "quiet";
      }
    },
  };
}

// The runner's own line for a restart, in the person's words.
export function downLine(state, { port, downMs, crashed = false }) {
  if (crashed) return "your app crashed, starting it again";
  if (state === "exited") return "your app exited, starting it again";
  if (state === "released") return `nothing is listening on port ${port} any more, starting your app again`;
  return `your app has not answered for ${Math.round(downMs / 1000)} seconds while no test conversation was waiting on it, starting it again`;
}
