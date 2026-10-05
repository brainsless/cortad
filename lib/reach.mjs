import { isIPv4 } from "node:net";
import { unreached } from "./contact-text.mjs";
import { plural, upper } from "./words.mjs";

// `reach`: one real request to each endpoint status lists as not reached, all sent at once from this
// machine to the app on its port, so the call takes about as long as the slowest reply. Each body is
// the one Cortad read that endpoint's client sending (the server's `request`). The headers are the
// person's sign-in, passed by the agent: they go from here to the app on this machine and nowhere
// else, and only their names are printed. Nothing here sets x-cortad-turn, so every request counts as
// the person's own. It runs only when the agent calls it: these are real requests with real effects.

// Under the 60 seconds Codex, Cursor CLI and Copilot CLI give an MCP call, with the status read first.
const REACH_MS = 55_000;
const SAID_CHARS = 200;
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const RUN_TURN = "x-cortad-turn";
const loopback = (host) => host === "::1" || (isIPv4(host) && host.startsWith("127."));

// `runner`: this machine's record of the app (lib/runner.mjs); `contact`: status's section of the same name.
export async function reach({ runner, contact, headers = {}, paths = [], fetchImpl = fetch }) {
  if (runner?.state !== "up") {
    return refused(!runner ? "No connect command is running for this repository, so no app is up on this machine."
      : runner.state === "failed" ? upper(runner.error) : "Your app is still starting.");
  }
  const host = runner.host ?? "127.0.0.1";
  if (!loopback(host)) return refused(`${host} is not this machine; reach sends only to your app on this machine.`);
  const sign = headersOf(headers);
  if (sign.error) return refused(sign.error);

  const rows = unreached(contact, runner.receipts);
  const named = new Set(Array.isArray(paths) ? paths : []);
  const picked = named.size ? rows.filter((m) => named.has(m.path) || named.has(`${m.method} ${m.path}`)) : rows.filter((m) => !m.unsure);
  const sent = picked.filter((m) => m.request);
  const app = new URL(`http://${host === "::1" ? "[::1]" : host}:${runner.port}`);
  const secrets = secretsIn(sign.headers);
  const answers = [];
  await Promise.all(sent.map(async (m) => { answers.push(await sendOne(m, app, sign.headers, fetchImpl, secrets)); }));

  const left = (named.size ? picked : rows).filter((m) => !m.excluded && !sent.includes(m));
  const unknown = [...named].filter((p) => !rows.some((m) => p === m.path || p === `${m.method} ${m.path}`));
  const names = Object.keys(sign.headers);
  return { text: [
    sent.length ? `Sent ${plural(sent.length, "request")} to your app on port ${runner.port} at once, ${names.length ? `with the headers ${names.join(", ")}` : "with no headers"}:`
      : rows.length ? "Nothing was sent." : "Nothing was sent: status lists no endpoint that no request has reached.",
    ...answers.map((a) => `  ${a.line}`),
    ...(left.length ? ["Not sent; send these by hand the way their client does:", ...left.map((m) => `  ${m.method} ${m.path}: ${whyNot(m)}`)] : []),
    unknown.length ? `Not among the endpoints no request has reached: ${unknown.join(", ")}.` : "",
    answers.some((a) => !a.ok) ? "Fix and send by hand only those that did not answer 2xx." : "",
    sent.length ? "status shows which of them reached your model." : "",
    "next: status",
  ].filter(Boolean).join("\n") };
}

const refused = (why) => ({ text: `${why} Nothing was sent.\nnext: status`, isError: true });

const whyNot = (m) => m.byHand ?? (m.request ? "Cortad is not sure it reaches your model; name its path to reach to send it." : "Cortad has no request ready for it.");

// The headers as the agent passed them, checked at this edge: never echoed back, a bad one named only
// when its name is a header name, and the run's own header dropped.
export function headersOf(given) {
  if (!given || typeof given !== "object" || Array.isArray(given)) return { error: "Headers are passed as names with their values." };
  const headers = {};
  for (const [name, value] of Object.entries(given)) {
    if (!NAME.test(name) || typeof value !== "string") return { error: "Each header is passed as a name and a value, as -H 'cookie: session=...' in a shell." };
    if (/[\r\n\0]/.test(value)) return { error: `The value of the header ${name} holds a line break.` };
    if (name.toLowerCase() !== RUN_TURN) headers[name] = value;
  }
  return { headers };
}

// What the sign-in is made of, long enough to be a secret, so it is never printed even where the app
// writes it into its answer.
// ponytail: a value the app re-encodes before writing it back (URL or JSON escaping) is not matched.
const secretsIn = (headers) => [...new Set(Object.values(headers).flatMap((v) => [v, ...v.split(/[\s;,=]+/)]))]
  .filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
const masked = (text, secrets) => secrets.reduce((t, s) => t.split(s).join("[sign-in]"), text);

// Sent only where the address, parsed, is still the app's own: a path the server sent is never trusted
// to keep the host.
async function sendOne(m, app, headers, fetchImpl, secrets) {
  const { method, path, body } = m.request;
  const label = `${m.method} ${m.path}`;
  const url = /^\/(?!\/)/.test(String(path)) ? new URL(`${app.origin}${path}`) : null;
  if (url?.origin !== app.origin || !/^(?:GET|POST)$/.test(method)) return { line: `${label}: not sent, its request is not one to this app.`, ok: false };
  const json = body !== undefined && method === "POST";
  const typed = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
  const started = performance.now();
  const seconds = () => `${((performance.now() - started) / 1000).toFixed(1)} seconds`;
  let res;
  try {
    res = await fetchImpl(url, { method, headers: json && !typed ? { "content-type": "application/json", ...headers } : headers,
      ...(json ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: AbortSignal.timeout(REACH_MS) });
  } catch (err) {
    return { line: `${label}: ${failedSaid(err, app.port || 80)}`, ok: false };
  }
  let text;
  try { text = await res.text(); } catch { return { line: `${label}: ${res.status}, and the answer had not finished after ${REACH_MS / 1000} seconds.`, ok: false }; }
  const ok = res.status >= 200 && res.status < 300;
  const said = ok ? "" : masked(text || res.headers.get("location") || "", secrets).replace(/\s+/g, " ").trim().slice(0, SAID_CHARS);
  return { line: `${label}: ${res.status} in ${seconds()}.${said ? ` Your app answered: "${said}"` : ""}`, ok };
}

// Why a request got no answer, from the error's name and code alone: its message can quote a header.
function failedSaid(err, port) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `no answer within ${REACH_MS / 1000} seconds.`;
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED") return `nothing answers on port ${port}.`;
  return `the connection failed${/^[A-Z_]{2,40}$/.test(code ?? "") ? ` (${code})` : ""}.`;
}
