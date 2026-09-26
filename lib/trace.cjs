// Loaded into your app by the command that started it (node --require), and only then. It watches
// for two things. First, a request to your app during which your app called a model: that request is
// your AI's door, with the exact body it takes and the sign-in it carried, learned from a message you
// sent yourself rather than guessed from code. Second, every model call your app makes: the host, the
// model it asked for, the status and the token counts the provider sent back, so a run can say which
// model answered and what it cost you. Reply text is never written down. Both go to a file only you
// can read, in the command's own folder on this machine. Nothing here talks to a network.
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
    const row = (value) => { try { fs.appendFileSync(FILE, JSON.stringify(value) + "\n", { mode: 0o600 }); } catch { /* the command is gone */ } };
    const isBun = typeof Bun !== "undefined" && typeof Bun.serve === "function";
    row({ hello: isBun ? "bun" : "node", pid: process.pid });
    // Which port this process serves. Every process the start command spawns loads this file, turbo's
    // own launcher included, so "loaded" is not "watching your app": only a listener on the app's port is.
    const listening = (port) => { if (Number.isInteger(port) && port > 0) row({ listen: port, pid: process.pid }); };
    const MAX = 65536;
    // Where models are served, by host, and the paths every OpenAI-shaped or vendor endpoint ends with.
    const MODEL_HOST = /(?:^|\.)(?:openai\.com|anthropic\.com|fireworks\.ai|openrouter\.ai|groq\.com|mistral\.ai|together\.xyz|together\.ai|deepseek\.com|cohere\.ai|cohere\.com|perplexity\.ai|x\.ai|googleapis\.com|openai\.azure\.com|cognitiveservices\.azure\.com|amazonaws\.com|replicate\.com|huggingface\.co|cerebras\.ai|deepinfra\.com|novita\.ai|moonshot\.cn|dashscope\.aliyuncs\.com|bigmodel\.cn|ai-gateway\.vercel\.sh|gateway\.ai\.cloudflare\.com|helicone\.ai|portkey\.ai)$/i;
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
      const write = (chunks) => row({ at: Date.now(), method: ctx.method, path: ctx.path, headers: ctx.headers, body: Buffer.concat(chunks).toString("utf8").slice(0, MAX), sent: String(sent || "").slice(0, MAX) });
      if (ctx.body) ctx.body.then((b) => write([b]));
      else write(ctx.chunks);
    };

    // Inbound: each request is handled inside its own context, and its body is seen as it arrives
    // without reading it, so your own body parser is untouched.
    const emit = http.Server.prototype.emit;
    http.Server.prototype.emit = function (type, req, ...rest) {
      if (type === "listening") { try { listening(this.address()?.port); } catch { /* not a TCP server */ } }
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

    // Bun serves through Bun.serve, never node:http, so the patch above saw no request at all: an
    // Elysia API on Bun took the customer's messages and nothing was written. Bun.serve is wrapped
    // instead, both the fetch handler and the per-route handlers Bun can dispatch to directly. The body
    // is read from a clone, so the app's own reader is untouched.
    if (isBun) {
      const inside = (handler, self) => function (req, server) {
        if (!req || /^(?:GET|HEAD|OPTIONS)$/.test(req.method)) return handler.call(self, req, server);
        let path = "/";
        try { const u = new URL(req.url); path = u.pathname + u.search; } catch { /* keep "/" */ }
        const ctx = { method: req.method, path, headers: Object.fromEntries(req.headers), chunks: [], size: 0, noted: false };
        // ponytail: a body is copied only when it is small or says it is text; an upload is left alone.
        const size = Number(req.headers.get("content-length") || 0);
        if (size <= MAX || /json|text|form/i.test(req.headers.get("content-type") || "")) {
          try { ctx.body = req.clone().arrayBuffer().then((b) => Buffer.from(b).subarray(0, MAX), () => Buffer.alloc(0)); } catch { /* unread */ }
        }
        return als.run(ctx, () => handler.call(self, req, server));
      };
      const routes = (table) => {
        if (!table || typeof table !== "object") return table;
        const out = {};
        for (const [route, value] of Object.entries(table)) {
          if (typeof value === "function") out[route] = inside(value, table);
          else if (value && typeof value === "object" && !(value instanceof Response)) {
            out[route] = {};
            for (const [verb, fn] of Object.entries(value)) out[route][verb] = typeof fn === "function" ? inside(fn, value) : fn;
          } else out[route] = value;
        }
        return out;
      };
      const serve = Bun.serve;
      Bun.serve = function (options, ...rest) {
        let wrapped = options;
        try {
          if (options && typeof options === "object") {
            wrapped = Object.assign(Object.create(Object.getPrototypeOf(options)), options);
            if (typeof options.fetch === "function") wrapped.fetch = inside(options.fetch, options);
            if (options.routes) wrapped.routes = routes(options.routes);
          }
        } catch { wrapped = options; }
        const server = serve.call(this, wrapped, ...rest);
        try { listening(server && server.port); } catch { /* not ours to fail */ }
        return server;
      };
    }

    // The meter. One row per model call: host, model id, status, and the provider's own token counts.
    const zlib = require("node:zlib");
    const REPLY_MAX = 8 * 1024 * 1024;
    const decoded = (buf, encoding) => {
      try {
        const e = String(encoding || "").toLowerCase();
        return (e === "gzip" ? zlib.gunzipSync(buf) : e === "br" ? zlib.brotliDecompressSync(buf) : e === "deflate" ? zlib.inflateSync(buf) : buf).toString("utf8");
      } catch { return ""; }
    };
    const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
    // The shapes the providers answer in. promptTokens is the whole input, cache included, so totals add up.
    const tokensOf = (u) => {
      if (!u || typeof u !== "object") return null;
      if (u.tokens && typeof u.tokens === "object") return tokensOf(u.tokens);
      if ("prompt_tokens" in u) return { promptTokens: n(u.prompt_tokens), cachedTokens: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens), completionTokens: n(u.completion_tokens) };
      if ("input_tokens" in u && u.input_tokens_details) return { promptTokens: n(u.input_tokens), cachedTokens: n(u.input_tokens_details.cached_tokens), completionTokens: n(u.output_tokens) };
      if ("input_tokens" in u) { const read = n(u.cache_read_input_tokens); return { promptTokens: n(u.input_tokens) + read + n(u.cache_creation_input_tokens), cachedTokens: read, completionTokens: n(u.output_tokens) }; }
      if ("inputTokens" in u) { const read = n(u.cacheReadInputTokens); return { promptTokens: n(u.inputTokens) + read + n(u.cacheWriteInputTokens), cachedTokens: read, completionTokens: n(u.outputTokens) }; }
      if ("promptTokenCount" in u) return { promptTokens: n(u.promptTokenCount), cachedTokens: n(u.cachedContentTokenCount), completionTokens: n(u.candidatesTokenCount) };
      return null;
    };
    // A stream spreads its counts over events (Anthropic's input in the first, output in the last);
    // later values win, so the fold ends on the final figures.
    const readReply = (type, text) => {
      const events = /event-stream/i.test(type || "")
        ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => parse(l.slice(5).trim()))
        : [].concat(parse(text));
      const usage = {};
      let model = null;
      for (const e of events) {
        if (!e || typeof e !== "object") continue;
        const part = e.usage || (e.message && e.message.usage) || (e.response && e.response.usage) || e.usageMetadata;
        if (part && typeof part === "object") Object.assign(usage, part);
        model = e.model || (e.message && e.message.model) || (e.response && e.response.model) || e.modelVersion || model;
      }
      return { tokens: tokensOf(Object.keys(usage).length ? usage : null), model };
    };
    // The model asked for, from what was sent; Gemini and Bedrock put it in the path instead.
    const askedFor = (path, sent) => {
      const body = parse(sent);
      if (body && typeof body.model === "string") return body.model;
      const m = /\/models\/([^/:]+):|\/model\/([^/]+)\/(?:invoke|converse)/.exec(path || "");
      return m ? decodeURIComponent(m[1] || m[2]) : "";
    };
    const meter = ({ host, path, sent, status, type, body }) => {
      try {
        const reply = readReply(type, String(body || "").slice(0, REPLY_MAX));
        const row = { at: Date.now(), host: String(host).replace(/:443$/, ""), model: String(askedFor(path, sent) || reply.model || "").slice(0, 160), status, ...(reply.tokens || { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }), usage: Boolean(reply.tokens) };
        fs.appendFileSync(FILE, JSON.stringify({ call: row }) + "\n", { mode: 0o600 });
      } catch { /* the command is gone */ }
    };

    // Outbound to a service their own settings name (a vector store, a database API, a search
    // host): which setting, which host and whether it answered. No body, no headers, no query. A
    // run that tested a tutoring app while every lookup failed inside Node never knew; this is
    // the witness that lets the run say retrieval was not tested instead of grading without it.
    let depHosts = null, depSeen = -1;
    const depOf = (input) => {
      try {
        const keys = Object.keys(process.env);
        if (keys.length !== depSeen) {
          depSeen = keys.length; depHosts = new Map();
          for (const k of keys) {
            const v = process.env[k];
            if (!v || !/^https?:\/\//i.test(v) || /(^|_)(KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)) continue;
            try { depHosts.set(new URL(v).host.replace(/:443$/, ""), k); } catch { /* not a URL */ }
          }
        }
        const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
        const name = depHosts.get(u.host.replace(/:443$/, "")) || depHosts.get(u.hostname);
        return name ? { env: name, host: u.hostname } : null;
      } catch { return null; }
    };
    const depRow = (dep, status, code) => {
      try { fs.appendFileSync(FILE, JSON.stringify({ dep: { at: Date.now(), ...(dep.env ? { env: dep.env } : {}), host: dep.host, status, code: code ? String(code).slice(0, 40) : undefined } }) + "\n", { mode: 0o600 }); } catch { /* the command is gone */ }
    };

    // Outbound: the model call your app makes while it handles that request.
    const bodyText = (body) => (typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : "");
    if (typeof globalThis.fetch === "function") {
      const realFetch = globalThis.fetch;
      globalThis.fetch = function (input, init) {
        let url = null;
        try {
          const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input));
          if (isModelCall(u.host, u.pathname)) url = u;
        } catch { /* not a URL we can read */ }
        if (!url) {
          // Every outbound host, named by the setting that points at it when one does, and by the
          // host alone otherwise: the search provider behind TAVILY_API_KEY has no URL setting.
          let dep = depOf(input);
          if (!dep) { try { const u = new URL(typeof input === "string" ? input : input && input.url ? input.url : String(input)); if (/^https?:$/.test(u.protocol) && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) dep = { host: u.hostname }; } catch { /* not a URL */ } }
          if (!dep) return realFetch.apply(this, arguments);
          return realFetch.apply(this, arguments).then(
            (res) => { depRow(dep, res.status); return res; },
            (err) => { depRow(dep, 0, err && err.cause && err.cause.code); throw err; },
          );
        }
        const sent = bodyText(init && init.body);
        note(als.getStore(), sent);
        const call = { host: url.host, path: url.pathname, sent };
        return realFetch.apply(this, arguments).then((res) => {
          try {
            // A clone is a tee: your app's branch gets every byte as fast as it reads, this one is read to the end.
            res.clone().text().then(
              (text) => meter({ ...call, status: res.status, type: res.headers.get("content-type"), body: text }),
              () => meter({ ...call, status: res.status, type: "", body: "" }),
            );
          } catch { meter({ ...call, status: res.status, type: "", body: "" }); }
          return res;
        }, (err) => { meter({ ...call, status: 0, type: "", body: "" }); throw err; });
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
            let sent = "";
            const write = req.write;
            const end = req.end;
            req.write = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); return write.call(this, chunk, ...r); };
            req.end = function (chunk, ...r) { if (chunk && typeof chunk !== "function") parts.push(Buffer.from(chunk)); sent = Buffer.concat(parts).toString("utf8"); note(ctx, sent); return end.call(this, chunk, ...r); };
            const call = { host: String(host || ""), path: String(path || "").split("?")[0] };
            let done = false;
            const once = (row) => { if (!done) { done = true; meter({ ...call, sent, ...row }); } };
            req.once("error", () => once({ status: 0, type: "", body: "" }));
            req.once("response", (res) => {
              // The reply's bytes as the parser hands them over, without reading the stream: your
              // app's own listeners and pipes see exactly what they would have.
              const got = [];
              let size = 0;
              const push = res.push;
              res.push = function (chunk, encoding) {
                if (chunk && size < REPLY_MAX) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding); got.push(b); size += b.length; }
                return push.call(this, chunk, encoding);
              };
              const finish = () => once({ status: res.statusCode || 0, type: res.headers["content-type"] || "", body: decoded(Buffer.concat(got), res.headers["content-encoding"]) });
              res.once("end", finish);
              res.once("close", finish);
            });
          }
        } catch { /* leave the request alone */ }
        return req;
      };
    }
  } catch { /* an app must never fail to start because of this file */ }
}
