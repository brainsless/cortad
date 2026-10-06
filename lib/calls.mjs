// What Cortad counts about its own tools: which one an agent called, from which client, how long it
// took, how much text came back and, when it failed, under which code. The arguments and the answer
// stay on this machine. Sent with the machine's own key, and a count that is lost is never retried:
// it must not cost the tool call it describes.
import { randomUUID } from "node:crypto";

const text = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

export function makeReport({ api, token, version, fetchImpl = fetch, sessionId = randomUUID() }) {
  return async ({ tool, durationMs, outputChars, errorCode, error, clientName, clientVersion }) => {
    const key = token();
    if (!key) return;
    const call = { tool, durationMs, outputChars, errorCode, error: text(error?.split("\n")[0], 512), clientName: text(clientName, 80), clientVersion: text(clientVersion, 40), serverVersion: version, sessionId };
    try {
      await fetchImpl(`${api}/mcp/calls`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify([call]),
        signal: AbortSignal.timeout(3000),
      });
    } catch { /* lost */ }
  };
}
