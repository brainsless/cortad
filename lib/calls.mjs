// What Cortad counts about its own tools: which one an agent called, from which client, how long it
// took, how much text came back and, when it failed, under which code. The arguments and the answer
// stay on this machine. Sent with the machine's own key. A count that is lost is not sent again: it
// must not cost the tool call it describes. One kind of call is: the agent's own test request
// (`reach`), which Cortad counts as a try at fixing whatever holds Run. Lost, that try would go
// uncounted, so its report is sent again, a few times and no more, always under the call's own id
// (`callId`, made when the call arrived): the server takes an id once however often it arrives.
import { randomUUID } from "node:crypto";

const text = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

const RETRIES = 3;
const RETRY_MS = 400;

export function makeReport({ api, token, version, fetchImpl = fetch, sessionId = randomUUID(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return async ({ tool, callId, durationMs, outputChars, errorCode, error, clientName, clientVersion }) => {
    const key = token();
    if (!key) return;
    const call = { tool, ...(callId ? { callId } : {}), durationMs, outputChars, errorCode, error: text(error?.split("\n")[0], 512), clientName: text(clientName, 80), clientVersion: text(clientVersion, 40), serverVersion: version, sessionId };
    const tries = tool === "reach" && callId ? RETRIES : 1;
    for (let n = 1; n <= tries; n++) {
      try {
        const res = await fetchImpl(`${api}/mcp/calls`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify([call]),
          signal: AbortSignal.timeout(3000),
        });
        // Taken, or refused for good: either way it is not sent again.
        if (!res || res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
      } catch { /* lost */ }
      if (n < tries) await wait(n * RETRY_MS);
    }
  };
}
