// Loaded into your app by the command that started it (node --require), and only then. It watches
// for one thing: a request to your app during which your app called a model. That request is your
// AI's door, with the exact body it takes and the sign-in it carried, learned from a message you sent
// yourself rather than guessed from code. What it sees is written to a file only you can read, in the
// command's own folder on this machine. Nothing here talks to a network.
"use strict";
const FILE = process.env.CORTAD_TRACE_FILE;
if (FILE) {
  try {
    const { AsyncLocalStorage } = require("node:async_hooks");
    const fs = require("node:fs");
    const http = require("node:http");
    const https = require("node:https");
    const als = new AsyncLocalStorage();
    // Said once, so the command knows a message sent to this app can be seen arriving.
    try { fs.appendFileSync(FILE, JSON.stringify({ hello: "node", pid: process.pid }) + "\n", { mode: 0o600 }); } catch { /* the command is gone */ }
    const MAX = 65536;
    // Where models are served, by host, and the paths every OpenAI-shaped or vendor endpoint ends with.
    const MODEL_HOST = /(?:^|\.)(?:openai\.com|anthropic\.com|fireworks\.ai|openrouter\.ai|groq\.com|mistral\.ai|together\.xyz|together\.ai|deepseek\.com|cohere\.ai|cohere\.com|perplexity\.ai|x\.ai|googleapis\.com|openai\.azure\.com|cognitiveservices\.azure\.com|amazonaws\.com|replicate\.com|huggingface\.co|cerebras\.ai|deepinfra\.com|novita\.ai|moonshot\.cn|dashscope\.aliyuncs\.com|bigmodel\.cn)$/i;
    const MODEL_PATH = /\/(?:chat\/completions|completions|responses|messages|embeddings)$|:(?:generateContent|streamGenerateContent)|\/invoke(?:-with-response-stream)?$|\/api\/(?:chat|generate)$/i;
    const isModelCall = (host, path) => {
      const h = String(host || "").replace(/:\d+$/, "");
      const p = String(path || "").split("?")[0];
      if (/googleapis\.com$/i.test(h)) return /generativelanguage|aiplatform/i.test(h) && MODEL_PATH.test(p);
      if (/amazonaws\.com$/i.test(h)) return /^bedrock/i.test(h);
      return MODEL_HOST.test(h) ? true : MODEL_PATH.test(p) && /\/v\d|\/api\//.test(p);
    };
    const said = new Set();
    const note = (ctx, sent) => {
      if (!ctx || ctx.noted) return;
      ctx.noted = true;
      const key = `${ctx.method} ${ctx.path.split("?")[0]}`;
      if (said.has(key)) return;
      said.add(key);
      const record = { at: Date.now(), method: ctx.method, path: ctx.path, headers: ctx.headers, body: Buffer.concat(ctx.chunks).toString("utf8").slice(0, MAX), sent: String(sent || "").slice(0, MAX) };
      try { fs.appendFileSync(FILE, JSON.stringify(record) + "\n", { mode: 0o600 }); } catch { /* the command is gone */ }
    };

    // Inbound: each request is handled inside its own context, and its body is seen as it arrives
    // without reading it, so your own body parser is untouched.
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (type, req, ...rest) {
      if (type !== "request" || !req || !req.method || /^(?:GET|HEAD|OPTIONS)$/.test(req.method)) return emit.call(this, type, req, ...rest);
      const ctx = { method: req.method, path: req.url || "/", headers: { ...req.headers }, chunks: [], size: 0, noted: false };
      const push = req.push;
      req.push = function (chunk, encoding) {
        if (chunk && ctx.size < MAX) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); ctx.chunks.push(b); ctx.size += b.length; }
        return push.call(this, chunk, encoding);
      };
      // A body parser carries on from the stream's own "end" event, and that event fires from the
      // socket's context, not the request's: every Express app lost its request there. Listeners put
      // on this request run inside it, the way OpenTelemetry binds a request's emitter.
      const bound = new WeakMap();
      for (const name of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
        const add = req[name];
        req[name] = function (event, fn) {
          if (typeof fn !== "function") return add.call(this, event, fn);
          const inside = bound.get(fn) || function (...a) { return als.run(ctx, () => fn.apply(this, a)); };
          bound.set(fn, inside);
          return add.call(this, event, inside);
        };
      }
      for (const name of ["off", "removeListener"]) {
        const remove = req[name];
        req[name] = function (event, fn) { return remove.call(this, event, (typeof fn === "function" && bound.get(fn)) || fn); };
      }
      return als.run(ctx, () => emit.call(this, type, req, ...rest));
    };

    // Outbound: the model call your app makes while it handles that request.
    const bodyText = (body) => (typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "");
    if (typeof globalThis.fetch === "function") {
      const realFetch = globalThis.fetch;
      globalThis.fetch = function (input, init) {
        try {
          const url = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
          if (isModelCall(url.host, url.pathname)) note(als.getStore(), bodyText(init && init.body));
        } catch { /* not a URL we can read */ }
        return realFetch.apply(this, arguments);
      };
    }
    for (const mod of [http, https]) {
      const request = mod.request;
      mod.request = function (...args) {
        const req = request.apply(this, args);
        try {
          const o = typeof args[0] === "string" || args[0] instanceof URL ? new URL(String(args[0])) : args[0] || {};
          const host = o.host || o.hostname;
          const path = o.pathname ? o.pathname : o.path;
          if (isModelCall(host, path)) {
            const ctx = als.getStore();
            const parts = [];
            const write = req.write;
            const end = req.end;
            req.write = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); return write.call(this, chunk, ...r); };
            req.end = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); note(ctx, Buffer.concat(parts).toString("utf8")); return end.call(this, chunk, ...r); };
          }
        } catch { /* leave the request alone */ }
        return req;
      };
    }
  } catch { /* an app must never fail to start because of this file */ }
}
