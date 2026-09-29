// Which request a model call belongs to when it is made outside every request: an in-process queue
// or worker started with the app, a job whose result is fetched on a second request. The same rule as
// lib/pyhook/cortad_tied.py.
//
// The call is pinned to the request that asked: the one still open whose words are in the prompt, the
// one an open request is tied to by an id it sent or got back (the answer is being fetched), or, when
// the call starts before that fetch, the newest request whose words are in the prompt, if every such
// request shares its id (one client's turn). Anything less pins nothing: never a guess.
//
// The request that asked answered only when it ended with none of its calls still running; otherwise
// the next request tied to it by an id carries the answer, and completes the exchange when it ends.
"use strict";

// A value made to name one thing: a session hash, an event id, a job number.
const ID = /^(?=.*\d)[\w.:-]{6,200}$/;
const RECENT_KEPT = 32, RECENT_MS = 300_000;
// The requests a client sends just before the one that asked, carrying the same id, are part of its
// turn (a chat UI shows the message with one event, then answers it with the next).
const BEFORE_MS = 60_000;

const scalars = (v, out = [], depth = 0) => {
  if (depth > 12 || out.length > 2000) return out;
  if (typeof v === "string" || (typeof v === "number" && Number.isInteger(v))) out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) scalars(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) scalars(x, out, depth + 1);
  return out;
};
const json = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };
const addressIds = (req) => {
  const [path, query = ""] = req.path.split("?");
  return new Set([...path.split("/"), ...new URLSearchParams(query).values()].filter((v) => ID.test(v)));
};
const meets = (a, b) => [...a].some((v) => b.has(v));
const PROMPTS_KEPT = 64, PROMPT_HEAD = 500;

// `bodyOf(req)` and `replyOf(req)` read what a request carried and what the app answered.
function makeTied({ norm, bodyOf, replyOf }) {
  const open = new Set();
  const recent = [];
  // The heads of the prompts this process sent: one arriving at a server in the same process (an
  // app that serves its own model) is a model call, never a person asking.
  const prompts = [];
  const idsOf = (req) => (req.ids ??= new Set([...addressIds(req), ...scalars(json(bodyOf(req))), ...scalars(json(replyOf(req)))].filter((v) => ID.test(v))));
  // The person's words: a value with a space or a letter outside ASCII, long enough to be a sentence.
  const says = (req, prompt) => scalars(json(bodyOf(req))).some((v) => v.length >= 8 && /\s|[^\x00-\x7F]/.test(v) && prompt.includes(norm(v)));
  const drop = (req) => { const i = recent.indexOf(req); if (i >= 0) recent.splice(i, 1); };
  // Asks reached through one session are one client's turns, the newest the one being answered: a
  // client holds a second stream open on its session (a heartbeat) that points at an older ask.
  const newestOf = (found) => {
    const ties = [...found.values()].map((f) => f.tie);
    if (!ties.every((t) => t.size) || ![...ties[0]].some((v) => ties.every((t) => t.has(v)))) return null;
    return [...found.keys()].reduce((a, b) => (b.at > a.at ? b : a));
  };
  // The ask each id's last answered turn was made by: no request up to it is a step of a later turn,
  // even one that never became an exchange.
  const answered = new Map();
  const answeredAt = (tie, at) => {
    for (const i of tie) { answered.delete(i); answered.set(i, at); }
    while (answered.size > RECENT_KEPT * 8) answered.delete(answered.keys().next().value);
  };
  // The newest request that asked before `req` and shares an id with its address.
  const askerOf = (req, pinnedOnly = false) => {
    const mine = addressIds(req);
    const now = Date.now();
    for (let i = mine.size ? recent.length - 1 : -1; i >= 0; i--) {
      const t = recent[i];
      if (t.at > req.at || now - t.at > RECENT_MS || (pinnedOnly && !t.pinned)) continue;
      const tie = [...mine].filter((v) => idsOf(t).has(v));
      if (tie.length) return { asker: t, tie: new Set(tie) };
    }
    return null;
  };
  return {
    opened(req) {
      open.add(req);
      const found = askerOf(req, true);
      if (found) Object.assign(req, found);
    },
    // The requests of the exchange this request completes, the one that asked last, or null. A
    // request that asked and has not answered is kept to be answered on a later one. Once answered it
    // leaves, written or not: a later turn's fetch tied by the same id is never pinned to it.
    closed(req) {
      open.delete(req);
      const { asker } = req;
      if (asker && !asker.written && !asker.callsOpen) {
        const since = Math.max(0, ...[...req.tie].map((i) => answered.get(i) ?? asker.at).filter((at) => at < asker.at));
        const before = recent.filter((p) => p !== asker && since < p.at && p.at < asker.at && asker.at - p.at <= BEFORE_MS && meets(idsOf(p), req.tie));
        for (const s of [...before, asker]) drop(s);
        answeredAt(req.tie, asker.at);
        return [...before, asker];
      }
      if (req.method !== "GET" && !prompts.includes(bodyOf(req).slice(0, PROMPT_HEAD)) && (!req.noted || req.callsOpen)) { recent.push(req); if (recent.length > RECENT_KEPT) recent.shift(); }
      return null;
    },
    sent(prompt) {
      prompts.push(String(prompt).slice(0, PROMPT_HEAD));
      if (prompts.length > PROMPTS_KEPT) prompts.shift();
    },
    // The request that asked for the call made with `sent`, or undefined.
    pinned(sent) {
      const prompt = norm(sent);
      const found = new Map();
      // Each ask with the open fetch to tie to it and the ids of the session it was reached through.
      for (const r of open) {
        if (r.asker) { found.set(r.asker, { fetch: null, tie: r.tie ?? new Set() }); continue; }
        // A request whose own context made a model call is served there; a call outside it is not its.
        if (r.method !== "GET" && (!r.noted || r.pinned) && says(r, prompt)) { found.set(r, { fetch: null, tie: new Set() }); continue; }
        const tied = askerOf(r);
        if (tied) found.set(tied.asker, { fetch: { r, tie: tied.tie }, tie: tied.tie });
      }
      if (!found.size) {
        const sayers = recent.filter((t) => says(t, prompt));
        const last = sayers.at(-1);
        if (last && sayers.every((t) => t === last || meets(idsOf(t), idsOf(last)))) found.set(last, { fetch: null, tie: new Set() });
      }
      if (found.size > 1 && !newestOf(found)) for (const t of [...found.keys()]) if (!says(t, prompt)) found.delete(t);
      const newest = found.size > 1 && newestOf(found);
      if (newest) for (const t of [...found.keys()]) if (t !== newest) found.delete(t);
      if (found.size !== 1) return undefined;
      const [[asker, { fetch }]] = found;
      if (fetch) Object.assign(fetch.r, { asker, tie: fetch.tie });
      asker.pinned = true;
      asker.callsOpen = (asker.callsOpen || 0) + 1;
      return asker;
    },
    // A pinned call has answered or failed.
    done(req) { if (req && req.pinned) req.callsOpen = Math.max(0, (req.callsOpen || 0) - 1); },
  };
}

module.exports = { makeTied };
