// A chat app for the proof tests, run under the hook: its own model provider on a local port, and doors
// that each hold a conversation a different way, or none. Started with `node --require trace.cjs`.
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");

const SYSTEM = "You are Ava, a travel helper. <system-reminder>Keep answers short.</system-reminder>";
// The block its prompt carries, which the model never says: the streams below hand it to the client.
const REMINDER = SYSTEM.slice(SYSTEM.indexOf("<system-reminder>"));
const byKey = new Map();
let replies = 0;
const historyOf = (key) => { if (!byKey.has(key)) byKey.set(key, []); return byKey.get(key); };

// The provider: answers with what it was asked and what it was asked before, as a model with memory
// would. "leak" in the ask makes it close the prompt's own markup in its reply; "code" makes it show
// that markup inside a code block.
const provider = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.url.includes("/broken/")) { res.writeHead(503, { "content-type": "application/json" }); return res.end('{"error":"overloaded"}'); }
    // A provider that runs a web search for the app, answered as a recorded stream did.
    if (req.url.includes("/responses")) { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(require("node:fs").readFileSync(process.env.PROVIDER_STREAM, "utf8")); }
    const sent = JSON.parse(raw);
    const asks = sent.messages.filter((m) => m.role === "user").map((m) => m.content);
    let text = `About ${asks.at(-1)}: pack light.${asks.length > 1 ? ` Earlier you asked about ${asks.slice(0, -1).join(" and ")}.` : ""}`;
    if (/leak/.test(asks.at(-1))) text += " </system-reminder>";
    if (/code/.test(asks.at(-1))) text += "\n```html\n<system-reminder>shown as code</system-reminder>\n```";
    const usage = { prompt_tokens: 40 + 10 * asks.length, completion_tokens: 12 };
    if (!sent.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ model: sent.model, choices: [{ message: { role: "assistant", content: text } }], usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const word of text.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ model: sent.model, choices: [{ delta: { content: word } }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ model: sent.model, choices: [], usage })}\n\ndata: [DONE]\n\n`);
  });
});

let base = "";
const complete = (messages, { stream = false, path = "/v1/chat/completions", system = SYSTEM, model = "fixture-model" } = {}) => fetch(`${base}${path}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, stream, messages: [{ role: "system", content: system }, ...messages] }),
});
const words = async (res) => (await res.json()).choices[0].message.content;
const pieces = async (res) => (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content).filter(Boolean);
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

// A worker the app starts with itself, outside every request: it answers queued messages in turn.
const jobs = new Map();
const queue = [];
setInterval(async () => {
  const job = jobs.get(queue.shift());
  if (!job) return;
  const history = historyOf(`job:${job.session}`);
  history.push({ role: "user", content: job.message });
  job.reply = await words(await complete(history));
  history.push({ role: "assistant", content: job.reply });
  for (const wake of job.waiting) wake(job.reply);
}, 10).unref();

const app = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, "http://x");
    // The app names the conversation in its first reply and takes it back in the body.
    if (url.pathname === "/api/chat") {
      const sessionId = body.sessionId || `s-${randomUUID()}`;
      const history = historyOf(sessionId);
      history.push({ role: "user", content: body.message });
      const reply = await words(await complete(history));
      history.push({ role: "assistant", content: reply });
      return json(res, 200, { sessionId, reply });
    }
    // The client keeps the conversation and sends it whole; the reply streams.
    if (url.pathname === "/api/stream") {
      const upstream = await complete(body.messages, { stream: true });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const line of (await upstream.text()).split("\n")) {
        const event = line.startsWith("data: {") ? JSON.parse(line.slice(6)) : null;
        const piece = event?.choices?.[0]?.delta?.content;
        if (piece) res.write(`data: ${JSON.stringify({ type: "text", content: piece })}\n\n`);
      }
      return res.end(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    }
    // The reply streams as named events, and the app sends the prompt's reminder as a hint of its own
    // before the model's words.
    if (url.pathname === "/api/hinted") {
      const said = await pieces(await complete(body.messages, { stream: true }));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event("hint", { text: REMINDER }));
      for (const text of said) res.write(event("delta", { text }));
      return res.end(event("done", {}));
    }
    // The same, as a web stream the app hands its server to pipe, the way a fetch-style framework does.
    if (url.pathname === "/api/web") {
      const upstream = await complete(body.messages, { stream: true });
      const bytes = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(bytes.encode(event("hint", { text: REMINDER })));
          for (const text of await pieces(upstream)) controller.enqueue(bytes.encode(event("delta", { text })));
          controller.close();
        },
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      return Readable.fromWeb(stream).pipe(res);
    }
    // The reminder in a JSON reply, written by a handler whose res.end the app has replaced to log each
    // reply, the way a request logger does: the replacement only hands the write on.
    if (url.pathname === "/api/logged") {
      const end = res.end;
      res.end = function (...args) { replies += 1; return end.apply(this, args); };
      const said = await words(await complete(body.messages));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ reply: `${REMINDER} ${said}` }));
    }
    // The conversation lives in the path.
    const thread = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
    if (thread) {
      const history = historyOf(thread[1]);
      history.push({ role: "user", content: body.text });
      const answer = await words(await complete(history));
      history.push({ role: "assistant", content: answer });
      return json(res, 200, { answer });
    }
    // The conversation is named by a header the app's own client sends, and the reply is plain text.
    if (url.pathname === "/api/assist") {
      const history = historyOf(req.headers["x-conversation"] || "none");
      history.push({ role: "user", content: body.q });
      const answer = await words(await complete(history, { system: "You answer questions." }));
      history.push({ role: "assistant", content: answer });
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(answer);
    }
    // The client names the conversation with an id it made up and sends only its new message, in parts
    // as the AI SDK writes one; the app keeps the turns.
    if (url.pathname === "/api/turn") {
      const history = historyOf(`turn:${body.id}`);
      history.push({ role: "user", content: body.message.parts.map((p) => p.text).join("") });
      const reply = await words(await complete(history));
      history.push({ role: "assistant", content: reply });
      return json(res, 200, { reply });
    }
    // The client picks the assistant's instructions and its model, and sends both beside the message.
    if (url.pathname === "/api/persona") return json(res, 200, { reply: await words(await complete([{ role: "user", content: body.message }], { system: body.system, model: body.model })) });
    // Writes the person's words into its own instructions as well as their turn.
    if (url.pathname === "/api/templated") return json(res, 200, { reply: await words(await complete([{ role: "user", content: body.message }], { system: `You answer one request at a time. The request: ${body.message}` })) });
    // Answers only a signed-in customer, by name and plan: the bearer is a JWT whose subject is theirs.
    if (url.pathname === "/api/account") {
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1] || "";
      let sub = "";
      try { sub = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8")).sub || ""; } catch { /* not signed in */ }
      const who = { "u-ana": { name: "Ana", plan: "free" }, "u-ben": { name: "Ben", plan: "pro" }, "u-cy": { name: "Cy", plan: "free" }, "u-dee": { name: "Dee", plan: "team" }, "u-eve": { name: "Eve", plan: "pro" } }[sub];
      if (!who) return json(res, 401, { error: "sign in first" });
      const said = await words(await complete([{ role: "user", content: body.message }], { system: `${SYSTEM} The customer is ${who.name} on the ${who.plan} plan.` }));
      return json(res, 200, { reply: `${who.name}, on ${who.plan}: ${said}` });
    }
    // Keeps nothing between requests.
    if (url.pathname === "/api/once") return json(res, 200, { reply: await words(await complete([{ role: "user", content: body.message }])) });
    // A lesson chat: the client names the lesson in every request, the app echoes it and keeps one
    // conversation per lesson. Without the lesson there is no chat (LearnHouse's activity_uuid).
    if (url.pathname === "/api/lessons") {
      if (!body.activity_uuid) return json(res, 422, { detail: [{ type: "missing", loc: ["body", "activity_uuid"], msg: "Field required" }] });
      const history = historyOf(`lesson:${body.activity_uuid}`);
      history.push({ role: "user", content: body.message });
      const reply = await words(await complete(history));
      history.push({ role: "assistant", content: reply });
      return json(res, 200, { activity_uuid: body.activity_uuid, reply });
    }
    // Hands back a session id and never reads it: every message is a new conversation.
    if (url.pathname === "/api/forgets") return json(res, 200, { sessionId: `s-${randomUUID()}`, reply: await words(await complete([{ role: "user", content: body.message }])) });
    // The provider fails and the app says so under a 200.
    if (url.pathname === "/api/broken") {
      const upstream = await complete([{ role: "user", content: body.message }], { path: "/v1/broken/chat/completions" });
      if (!upstream.ok) return json(res, 200, { error: "The assistant is unavailable right now." });
      return json(res, 200, { reply: await words(upstream) });
    }
    // Offers the model a search its provider runs.
    if (url.pathname === "/api/search") {
      const upstream = await fetch(`${base}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture-model", stream: true, tools: [{ type: "web_search_preview" }], input: [{ role: "user", content: body.message }] }),
      });
      const done = (await upstream.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).find((e) => e.type === "response.completed");
      const said = done.response.output.filter((o) => o.type === "message").flatMap((o) => o.content).map((c) => c.text).join("");
      return json(res, 200, { reply: said });
    }
    // The message is queued for the worker, the reply names the job, and the answer is fetched at an
    // address that names it.
    if (url.pathname === "/api/jobs" && req.method === "POST") {
      const jobId = `j-${randomUUID()}`;
      jobs.set(jobId, { session: body.session, message: body.message, waiting: [] });
      queue.push(jobId);
      return json(res, 200, { jobId });
    }
    const job = jobs.get(/^\/api\/jobs\/([^/]+)$/.exec(url.pathname)?.[1]);
    if (job) return json(res, 200, { reply: job.reply ?? await new Promise((wake) => job.waiting.push(wake)) });
    json(res, 404, { error: "no such route" });
  });
});

provider.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${provider.address().port}`;
  app.listen(0, "127.0.0.1", () => console.log(`PORT ${app.address().port}`));
});
