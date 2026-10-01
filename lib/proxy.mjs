// For an app the hook cannot load into (Go, Ruby, Java, Rust, PHP, Deno, or a Node or Python app
// that would not take it): what the hook sees from inside the process is seen from outside it, on
// this machine. Two servers on 127.0.0.1. The front sits before the app's own port: the agent's
// request and every conversation of a run go through it, and it writes the exchange rows the hook
// writes. The model proxy is where the app's model settings point (OPENAI_BASE_URL and the others):
// it hands each call to the provider the app's own settings name and writes the call rows the hook
// writes. Both write into the same trace file, so the command reads them as it reads the hook's
// (lib/replay.mjs). The line of code that made a call is not known here. Header values are never
// written, and nothing goes anywhere the app would not have sent it.
import { appendFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import wire from "./wire.cjs";

const { MAX, REPLY_MAX, MODEL_HOST, scrubbed, turnOf, decoded, cookieNames, makeRecorder } = wire;

// Where each SDK sends its calls when the app's settings name nowhere else.
const DEFAULTS = { OPENAI_BASE_URL: "https://api.openai.com/v1", ANTHROPIC_BASE_URL: "https://api.anthropic.com", GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com" };
// Another setting of the app's that addresses a model: a URL on a model host, or a base URL named for one.
const MODEL_SETTING = /OPENAI|ANTHROPIC|GEMINI|LLM|OLLAMA|LITELLM|VLLM/i;
const ADDRESS_SETTING = /BASE|URL|ENDPOINT|HOST/i;
const SECRET_SETTING = /KEY|TOKEN|SECRET|PASSWORD/i;
// Said by one connection, never passed on. A provider's reply is passed on decoded, so its encoding goes too.
const HOP = /^(?:host|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|content-length|accept-encoding)$/i;
const REPLY_HOP = /^(?:connection|keep-alive|transfer-encoding|content-length|content-encoding)$/i;

const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };

// `file`: the trace file the command reads. `target()`: where the app answers now, { host, port };
// it moves when the app is started again on another port. `onSeen`: the first model call came through.
// `onUnseen`: a request the app answered before any model call came through, said once.
export async function openProxy({ file, rulesFile, target, onSeen = () => {}, onUnseen = () => {} }) {
  const row = (value) => { try { appendFileSync(file, JSON.stringify(scrubbed(value)) + "\n", { mode: 0o600 }); } catch { /* the command is gone */ } };
  const rec = makeRecorder({ row, rulesFile });
  // The requests in flight through the front that a model call can be made for.
  const open = new Set();
  let calls = 0, unseen = false;

  const front = createServer((req, res) => {
    const { "x-cortad-turn": _turn, ...headers } = req.headers;
    const ctx = /^(?:HEAD|OPTIONS)$/.test(req.method) ? null : rec.requestCtx(req.method, req.url || "/", headers, turnOf(req.headers));
    if (ctx && req.method !== "GET") open.add(ctx);
    const finish = (reply) => {
      if (!ctx) return;
      open.delete(ctx);
      rec.ended(ctx, reply);
      if (req.method !== "GET" && reply.status && !calls && !unseen) { unseen = true; onUnseen(); }
    };
    const { host, port } = target();
    const up = request({ host, port, method: req.method, path: req.url, headers: { ...headers, host: `${host.includes(":") ? `[${host}]` : host}:${port}` } });
    if (ctx && req.method !== "GET") req.on("data", (c) => { if (ctx.size < MAX) { ctx.chunks.push(c); ctx.size += c.length; } });
    req.pipe(up);
    res.on("close", () => up.destroy());
    // Nothing answered: the caller sees the connection close, as it would at the app's own port.
    up.on("error", () => { finish({ status: 0, type: "", text: "", cookies: [], cut: true }); res.destroy(); });
    up.on("response", (r) => {
      const got = [];
      let size = 0, writes = 0;
      r.on("data", (c) => { writes += 1; if (size < MAX) { got.push(c); size += c.length; } });
      const text = () => decoded(Buffer.concat(got), r.headers["content-encoding"]);
      r.on("end", () => { if (ctx) rec.tied.replied(ctx, r.statusCode, text); });
      r.on("error", () => res.destroy());
      const done = () => finish({ status: r.statusCode, type: String(r.headers["content-type"] || ""), writes: r.headers["content-length"] ? 1 : writes, text: text(), cookies: cookieNames(r.headers["set-cookie"]), cut: !res.writableFinished });
      res.once("finish", done);
      res.once("close", done);
      res.writeHead(r.statusCode, r.statusMessage, r.rawHeaders);
      r.pipe(res);
    });
  });
  // A socket the page opens (live reload, a chat over a WebSocket) is passed through as it is, unrecorded.
  front.on("upgrade", (req, socket, head) => {
    const { host, port } = target();
    const up = connect({ host, port }, () => {
      const lines = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const end = () => { socket.destroy(); up.destroy(); };
    up.on("error", end);
    socket.on("error", end);
  });

  // Each upstream the app's settings name, by its place: /u/<n>/<the SDK's own path>.
  const slots = [];
  const model = createServer(async (req, res) => {
    const m = /^\/u\/(\d+)([/?][^]*)?$/.exec(req.url || "");
    const base = m && slots[Number(m[1])];
    if (!base) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":{"message":"cortad: no model setting points here"}}'); return; }
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = Buffer.concat(parts);
    const sent = body.toString("utf8");
    const url = new URL(base.replace(/\/+$/, "") + (m[2] ?? ""));
    // A listing of models answers nobody; a call that sends a prompt does.
    const metered = !/^(?:GET|HEAD)$/.test(req.method);
    const ctx = metered ? rec.note(undefined, sent, open.size === 1 ? [...open][0] : undefined) : undefined;
    const t0 = Date.now();
    const meter = (status, type, text) => { if (!metered) return; if (++calls === 1) onSeen(); rec.meter({ host: url.host, path: url.pathname, sent, status, type, body: text, ctx, t0 }); };
    let got;
    try {
      got = await fetch(url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.test(k))), body: metered && body.length ? body : undefined, redirect: "manual" });
    } catch (e) {
      meter(0, "", "");
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `cortad could not reach ${url.host}: ${e.cause?.code ?? e.message}` } }));
      return;
    }
    if (ctx) ctx.heard = true;
    const headers = {};
    for (const [k, v] of got.headers) if (!REPLY_HOP.test(k) && k !== "set-cookie") headers[k] = v;
    const cookies = got.headers.getSetCookie();
    res.writeHead(got.status, cookies.length ? { ...headers, "set-cookie": cookies } : headers);
    const kept = [];
    let size = 0;
    try {
      for await (const c of got.body ?? []) {
        res.write(c);
        if (size < REPLY_MAX) { kept.push(Buffer.from(c)); size += c.length; }
      }
    } catch { /* broken off: what arrived stands */ }
    res.end();
    meter(got.status, got.headers.get("content-type") ?? "", Buffer.concat(kept).toString("utf8"));
  });

  const frontPort = await listen(front);
  const modelPort = await listen(model);
  row({ hello: "proxy", pid: process.pid });
  const via = (upstream) => {
    if (!slots.includes(upstream)) slots.push(upstream);
    return `http://127.0.0.1:${modelPort}/u/${slots.indexOf(upstream)}`;
  };
  return {
    port: frontPort,
    modelPort,
    // The app's model settings, pointed here: each SDK's own, and any other of the app's that addresses a model.
    env(base) {
      const out = {};
      for (const [name, fallback] of Object.entries(DEFAULTS)) out[name] = via(base[name] || fallback);
      for (const [name, value] of Object.entries(base)) {
        if (name in out || SECRET_SETTING.test(name) || typeof value !== "string") continue;
        let u;
        try { u = new URL(value); } catch { continue; }
        if (/^https?:$/.test(u.protocol) && (MODEL_HOST.test(u.hostname) || (MODEL_SETTING.test(name) && ADDRESS_SETTING.test(name)))) out[name] = via(value);
      }
      return out;
    },
    // Whether a model call has come through yet.
    seen: () => calls > 0,
    close: () => { for (const s of [front, model]) { s.closeAllConnections(); s.close(); } },
  };
}
