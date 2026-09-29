// What a door is proven to do, from the exchanges the hook recorded inside the app: requests that
// reached a model, what the app answered and the model calls on the way. Everything here is read off
// those rows; nothing is guessed from code. The shape is the backend's DoorProof
// (src/local/door-proof.ts). Pure: the one lookup into the repository is handed in as `find`.

const HOP = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|expect|te|trailer|accept-encoding|x-cortad-as|x-cortad-turn)$/i;
// Headers every client sends: never what holds a conversation.
const PLAIN_HEADER = /^(?:accept(?:-.*)?|content-.*|user-agent|origin|referer|cookie|cache-control|pragma|priority|dnt|sec-.*|x-forwarded-.*|x-real-ip|if-.*)$/i;
// A provider request's settings, as every provider names them: not what the model was told.
const SETTING = /^(?:model|role|type|id|object|stream|tool_choice|response_format|stop|user|name|tool_call_id|call_id|index|encoding_format|service_tier|reasoning_effort|modalities)$/;
const SAMPLE = 600;
const PROBLEMS_MAX = 12;

const str = (v) => (typeof v === "string" ? v : "");
const arr = (v) => (Array.isArray(v) ? v : []);
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
// Read once per exchange: a prompt can run to a quarter of a megabyte and is asked of many times.
const once = (fn) => { const seen = new WeakMap(); return (ex) => { if (!seen.has(ex)) seen.set(ex, fn(ex)); return seen.get(ex); }; };
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
// The hook's own normal form: JSON escapes read as the characters they stand for, case and spacing folded.
export const norm = (s) => String(s ?? "")
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  .toLowerCase().replace(/\s+/g, " ").trim();
// A value made to name one thing: a number of six digits or more, a uuid, hex, or a run of letters
// and digits too long to be a word. "gpt-4o-mini" is none of them.
const idLike = (v) => /^\d{6,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|^[0-9a-f]{12,}$/i.test(v) || v.split(/[-_.:]/).some((s) => s.length >= 12 && /\d/.test(s) && /[a-z]/i.test(s));

// Every scalar leaf, with its path: object keys, and list positions as numbers.
function leaves(v, at = [], out = [], max = 400) {
  if (out.length >= max || at.length > 10) return out;
  if (typeof v === "string" || typeof v === "number") out.push({ at, value: String(v) });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...at, i], out, max));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...at, k], out, max);
  return out;
}
// A leaf's field: its keys up to the first list. A leaf inside a list is part of that list.
const fieldOf = (at) => { const i = at.findIndex((k) => typeof k === "number"); return (i < 0 ? at : at.slice(0, i)).join("."); };
const inList = (at) => at.some((k) => typeof k === "number");

// ---- rows to exchanges

const request = (r) => (r && typeof r === "object" && typeof r.method === "string" && str(r.path).startsWith("/") ? {
  at: Number(r.at) || 0, ms: Number(r.ms) || 0, method: r.method.toUpperCase(), path: r.path, body: str(r.body), status: Number(r.status) || 0,
  reply: str(r.reply), cookies: arr(r.cookies).filter((c) => typeof c === "string"),
} : null);

// An answer that came on a second request is one exchange: the request that asked is the door, the
// second step carried the reply, and the requests sent just before it in the same turn go first.
function turnOf(ex, steps) {
  const asked = steps.at(-1);
  if (!asked) return ex;
  return {
    ...ex, at: asked.at, ms: ex.at + ex.ms - asked.at, method: asked.method, path: asked.path, body: asked.body,
    cookies: [...new Set([...steps.flatMap((s) => s.cookies), ...ex.cookies])],
    answer: { method: ex.method, path: ex.path, asked: asked.reply }, before: steps.slice(0, -1),
  };
}

// Trace rows come from inside a process this command does not control: every field is checked.
export function exchangesOf(rows) {
  const byId = new Map();
  const slot = (id) => { if (!byId.has(id)) byId.set(id, { calls: [], deps: [] }); return byId.get(id); };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.ex === "string" && request(r)) slot(r.ex).row = r;
    else if (r.call && typeof r.call.ex === "string") slot(r.call.ex).calls.push(r.call);
    else if (r.dep && typeof r.dep.ex === "string") slot(r.dep.ex).deps.push(r.dep);
  }
  return [...byId.values()].filter((x) => x.row).map(({ row, calls, deps }) => turnOf({
    id: row.ex, ...request(row), headers: row.headers && typeof row.headers === "object" ? row.headers : {}, trial: typeof row.turn === "string",
    sent: arr(row.sent).filter((s) => typeof s === "string"), type: str(row.type), writes: Number(row.writes) || 0, calls, deps,
  }, arr(row.after).map(request).filter(Boolean))).sort((a, b) => a.at - b.at);
}

// ---- which door an exchange came through

const routeRe = (template) => new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^/{}]+\}/g, "([^/]+)")}/?$`);

// The app's own route that answered, from its framework's table; without one, the path, with a
// segment that reads as an id standing for any.
export function doorOf(ex, routes = []) {
  const bare = ex.path.split("?")[0];
  const fits = routes.filter((r) => r && r.method === ex.method && typeof r.path === "string" && routeRe(r.path).test(bare))
    .sort((a, b) => (a.path.match(/\{/g) ?? []).length - (b.path.match(/\{/g) ?? []).length);
  const path = fits[0]?.path ?? bare.split("/").map((s) => (/^\d+$/.test(s) || idLike(s) ? "{id}" : s)).join("/");
  return { method: ex.method, path, key: `${ex.method} ${path}` };
}

// The value each {name} of the template took in this exchange's path.
const paramsOf = (template, path) => {
  const names = [...template.matchAll(/\{([^/{}]+)\}/g)].map((m) => m[1]);
  const m = routeRe(template).exec(path.split("?")[0]);
  return m ? Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) : {};
};

// ---- what went in, what the model was told, what came back

const headerOf = (headers, name) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
const bodyOf = once((ex) => {
  const json = parse(ex.body);
  if (json && typeof json === "object") return json;
  if (/x-www-form-urlencoded/i.test(str(headerOf(ex.headers, "content-type")))) return Object.fromEntries(new URLSearchParams(ex.body));
  return null;
});
// Every string the app sent its models in this exchange, settings left out.
const promptOf = once((ex) => norm(ex.sent.map((s) => {
  const v = parse(s);
  return v && typeof v === "object" ? leaves(v, [], [], 5000).filter((l) => !SETTING.test(String(l.at.at(-1)))).map((l) => l.value).join("\n") : s;
}).join("\n")));
const generation = (ex) => ex.calls.filter((c) => !c.embedding);
const answeredCalls = (ex) => generation(ex).filter((c) => typeof c.reply === "string" && c.reply);
// The words the model answered with on the last call that answered.
const modelWords = (ex) => str(answeredCalls(ex).at(-1)?.reply);
// How much of the pieces the model said, by length.
const overlap = (pieces, words) => pieces.reduce((n, p) => { const t = norm(p); return n + (t && words.includes(t) ? p.length : 0); }, 0);

// The reply read whole: JSON at the leaf the model's words sit in (the longest leaf when they are not
// known), a stream put back together from its events, text as it is.
export const replyOf = once((ex) => {
  const words = norm(modelWords(ex));
  const whole = parse(ex.reply);
  const stream = /event-stream|ndjson|jsonl|stream/i.test(ex.type) || (ex.writes > 1 && whole === undefined);
  if (!stream && whole && typeof whole === "object") {
    const best = leaves(whole).filter((l) => /\D/.test(l.value))
      .map((l) => ({ l, score: words ? overlap([l.value], words) : l.value.length }))
      .sort((a, b) => b.score - a.score || b.l.value.length - a.l.value.length)[0];
    return { text: best?.l.value ?? "", path: best ? best.l.at.join(".") : null, stream: false };
  }
  if (!stream) return { text: typeof whole === "string" ? whole : ex.reply, path: null, stream: false };
  const { events, loose } = eventsOf(ex.reply);
  // Any call's words: the last call of an agent can be a memory write, not the answer.
  return threaded(events, norm(answeredCalls(ex).map((c) => c.reply).join("\n"))) ?? { text: assembled(events, loose, words, ex.reply), path: null, stream: true };
});

// A stream's events: SSE data lines, JSON lines, or a JSON value behind a short prefix per line.
function eventsOf(raw) {
  const events = [];
  const loose = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || /^(?:event|id|retry):|^:/.test(line)) continue;
    const data = line.startsWith("data:") ? line.slice(5).replace(/^ /, "") : line;
    if (data.trim() === "[DONE]") continue;
    let v = parse(data);
    if (v === undefined && /^\w{1,3}:/.test(data)) v = parse(data.replace(/^\w{1,3}:/, ""));
    if (v === undefined || v === null || typeof v !== "object" && typeof v !== "string") loose.push(data);
    else events.push(v);
  }
  return { events, loose };
}

// A path read the way the run reads one: `-1` is a list's last entry.
const at = (v, path) => path.reduce((o, k) => (o === null || typeof o !== "object" ? undefined : Array.isArray(o) && k === -1 ? o.at(-1) : o[k]), v);
// A concrete path with the last entry of a list of turns written -1, so it still names the newest
// turn when the list holds more of them. A list of anything else is positional and keeps its index.
const newest = (v, path) => path.map((k, i) => { const list = at(v, path.slice(0, i)); return typeof k === "number" && isTurns(list) && k === list.length - 1 ? -1 : k; });

// A stream whose events carry the whole thread (a queue's completed event holds every turn so far)
// has the reply at one entry of a list, not spread over the events: the leaf the model's words match
// best, named by its path, and read at that path in every event. Null for any other stream.
function threaded(events, words) {
  if (!words) return null;
  let best = null;
  for (const v of events) {
    if (typeof v !== "object") continue;
    for (const l of leaves(v)) {
      const score = overlap([l.value], words);
      if (score && score >= (best?.score ?? 0)) best = { score, path: newest(v, l.at) };
    }
  }
  const thread = best?.path.some((k, i) => typeof k === "number" && arr(at(events.find((v) => at(v, best.path) !== undefined), best.path.slice(0, i))).length > 1);
  if (!thread) return null;
  const pieces = events.map((v) => at(v, best.path)).filter((s) => typeof s === "string");
  return { text: pieces.at(-1) ?? "", path: best.path.join("."), stream: true };
}

// Each JSON event's text is grouped by where it sits, and the group the model's words run through is
// the reply.
function assembled(events, loose, words, raw) {
  const groups = new Map();
  for (const v of events) {
    for (const l of typeof v === "string" ? [{ at: [], value: v }] : leaves(v)) {
      const key = l.at.map((k) => (typeof k === "number" ? "[]" : k)).join(".");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l.value);
    }
  }
  // Without the model's words, the reply is the group that reads as language: ids and event names
  // repeat on every event and outweigh the words by length, but never hold a space or a non-Latin letter.
  const prose = (pieces) => pieces.filter((v) => /\s|[^\x00-\x7F]/.test(v)).join("").length;
  const best = [...groups.values()]
    .map((pieces) => ({ text: pieces.join(""), score: words ? overlap(pieces, words) : prose(pieces) }))
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0];
  return (best?.score ? best.text : loose.join(raw.includes("data:") ? "" : "\n")) || best?.text || "";
}

// ---- the ask

// The field whose value reached the model: in the most exchanges, one that changes between them, a
// field of its own before a list, then the longest. A list holding the ask is named by its field.
function askOf(exchanges) {
  const tally = new Map();
  for (const ex of exchanges) {
    const prompt = promptOf(ex);
    const body = bodyOf(ex);
    if (!prompt || !body) continue;
    for (const l of leaves(body)) {
      const v = norm(l.value);
      if (v.length < 3 || !/[a-z\u00c0-\uffff]/.test(v) || !prompt.includes(v)) continue;
      const field = fieldOf(l.at);
      const t = tally.get(field) ?? { field, list: inList(l.at), hits: new Set(), values: new Set(), longest: 0 };
      t.hits.add(ex.id);
      t.values.add(v);
      t.longest = Math.max(t.longest, v.length);
      tally.set(field, t);
    }
  }
  const best = [...tally.values()].sort((a, b) => b.hits.size - a.hits.size || (b.values.size > 1) - (a.values.size > 1) || a.list - b.list || b.longest - a.longest)[0];
  return best?.field ? { field: best.field, list: best.list } : null;
}

// The ask in one exchange: the field's value, or the list's last entry the model was told.
function askIn(ex, ask) {
  const body = bodyOf(ex);
  if (!ask || !body) return "";
  const prompt = promptOf(ex);
  return leaves(body).filter((l) => fieldOf(l.at) === ask.field && (!ask.list || prompt.includes(norm(l.value)))).at(-1)?.value ?? "";
}

// ---- the session

// The earlier exchange's words the later prompt carried: its ask, the model's reply, the app's reply.
// Reply words the earlier prompt already held are the prompt's own text (a scripted greeting), and
// words asked twice are in the later prompt as its own ask: carried, they are there twice.
function carriedFrom(later, earlier, ask) {
  const prompt = promptOf(later);
  const before = promptOf(earlier);
  const own = norm(askIn(later, ask));
  const replies = [norm(modelWords(earlier)).slice(0, 80), norm(replyOf(earlier).text).slice(0, 80)].filter((t) => !before.includes(t));
  return [norm(askIn(earlier, ask)), ...replies].filter((t) => t.length >= 8 && (own.includes(t) ? prompt.split(t).length > 2 : prompt.includes(t)));
}

const cookiesIn = (ex) => Object.fromEntries(str(headerOf(ex.headers, "cookie")).split(";").map((c) => c.trim().split("=")).filter(([k, v]) => k && v !== undefined).map(([k, ...v]) => [k, v.join("=")]));

// What stayed the same from the earlier exchange to the later one and is not the ask: a field the app
// handed back, a path segment, a field that reads as an id, a cookie the app set, a header, another
// cookie. The first found carries the session.
function carrierOf(earlier, later, ask, door) {
  const same = (a, b) => a !== undefined && a !== "" && a === b;
  const before = new Map(leaves(bodyOf(earlier) ?? {}).map((l) => [l.at.join("."), l.value]));
  const own = leaves(bodyOf(later) ?? {}).filter((l) => !inList(l.at) && fieldOf(l.at) !== ask?.field);
  // A value the app handed back in its earlier reply: the first request had none to send.
  const handedBack = norm(earlier.reply);
  const named = own.find((l) => /^\S{6,}$/.test(l.value) && (/\d/.test(l.value) || l.value.length >= 16) && handedBack.includes(norm(l.value)));
  // `minted` says who opened the conversation: the app handed the value back (a trial opens its own by
  // sending none), or the client made it up (a trial makes up its own).
  if (named) return { carrier: "body", key: named.at.join("."), minted: "app" };
  const fields = own.filter((l) => same(l.value, before.get(l.at.join("."))));
  const params = paramsOf(door.path, later.path);
  const was = paramsOf(door.path, earlier.path);
  const segment = Object.keys(params).find((k) => same(params[k], was[k]));
  if (segment) return { carrier: "path", key: segment, minted: "client" };
  const idField = fields.find((l) => idLike(l.value));
  if (idField) return { carrier: "body", key: idField.at.join("."), minted: "client" };
  const jar = cookiesIn(later);
  const jarBefore = cookiesIn(earlier);
  // A cookie the app set on the earlier reply, sent back: the earlier request could not carry it.
  const set = Object.keys(jar).find((k) => earlier.cookies.includes(k));
  if (set) return { carrier: "cookie", key: set, minted: "app" };
  const cookies = Object.keys(jar).filter((k) => same(jar[k], jarBefore[k]));
  const header = Object.keys(later.headers).find((k) => !HOP.test(k) && !PLAIN_HEADER.test(k) && same(later.headers[k], headerOf(earlier.headers, k.toLowerCase())));
  if (header) return { carrier: "header", key: header.toLowerCase(), minted: "client" };
  if (cookies.length) return { carrier: "cookie", key: cookies[0], minted: "client" };
  return { carrier: "none", key: null };
}

// Held when a later prompt carried an earlier exchange's words. A body that carried them in a field
// other than its own ask holds the conversation itself; otherwise what stayed the same carries it.
function sessionOf(exchanges, ask, door) {
  for (let i = 1; i < exchanges.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const texts = carriedFrom(exchanges[i], exchanges[j], ask);
      if (!texts.length) continue;
      const own = norm(askIn(exchanges[i], ask));
      const history = leaves(bodyOf(exchanges[i]) ?? {}).find((l) => norm(l.value) !== own && texts.some((t) => norm(l.value).includes(t)));
      if (history) return { held: true, carrier: "history", key: fieldOf(history.at) };
      return { held: true, ...carrierOf(exchanges[j], exchanges[i], ask, door) };
    }
  }
  return { held: false, carrier: "none", key: null };
}

// ---- an answer that came on a second request

// What the hook ties the two requests on (lib/tied.cjs): a value made to name one thing.
const TIE = /^(?=.*\d)[\w.:-]{6,200}$/;
const TURN_ROLE = /^(?:role|sender|from|author|speaker)$/i;
const isTurns = (v) => Array.isArray(v) && v.length > 0 && v.every((e) => e && typeof e === "object" && !Array.isArray(e)) && v.some((e) => Object.keys(e).some((k) => TURN_ROLE.test(k)));

// Where one request of the turn holds the person's words and the conversation: the leaf the ask was
// in, and a list of turns, the one the ask sits in when it sits in one. The run writes each trial's
// turn at these paths in the recorded body.
function placesIn(body, ask) {
  if (!body || typeof body !== "object") return { askPath: null, historyPath: null };
  const own = norm(ask);
  const hit = own ? leaves(body, [], [], 5000).filter((l) => norm(l.value) === own).at(-1) : undefined;
  const lists = [];
  const walk = (v, path) => {
    if (isTurns(v)) lists.push(path);
    if (v && typeof v === "object" && path.length < 12) for (const [k, x] of Object.entries(v)) walk(x, [...path, Array.isArray(v) ? Number(k) : k]);
  };
  walk(body, []);
  const holding = hit && lists.find((p) => p.length < hit.at.length && p.every((k, i) => k === hit.at[i]));
  const history = holding ?? lists[0];
  return { askPath: hit ? newest(body, hit.at).join(".") : null, historyPath: history ? newest(body, history).join(".") : null };
}

// The second step as the run makes it: its method and address with the tying value named by where
// the asking request had it (`sent` in its body, or `got` back in its reply), where the ask and the
// turns sit in the asking request, and the requests sent before it in the same turn. Tied by the
// asking request's own address, the value is the door's own and the address is kept as it was.
function answerOf(ex, ask) {
  const { method, path, asked } = ex.answer;
  const [where, ...rest] = path.split("?");
  const query = rest.join("?");
  const address = [...where.split("/"), ...new URLSearchParams(query).values()];
  const fields = (v, from) => (v && typeof v === "object" ? leaves(v) : []).filter((l) => TIE.test(l.value) && address.includes(l.value)).map((l) => ({ key: l.at.join("."), value: l.value, from }));
  const tie = [...fields(bodyOf(ex), "sent"), ...fields(parse(asked), "got")][0];
  const slot = tie && `{${tie.key}}`;
  const named = !tie ? path : where.split("/").map((s) => (s === tie.value ? slot : s)).join("/")
    + (query ? `?${query.split("&").map((p) => { const [k, ...v] = p.split("="); return decodeURIComponent(v.join("=")) === tie.value ? `${k}=${slot}` : p; }).join("&")}` : "");
  const words = askIn(ex, ask);
  return {
    method, path: named, tie: tie ? { key: tie.key, from: tie.from } : null, ...placesIn(bodyOf(ex), words),
    before: ex.before.map((s) => { const body = parse(s.body); return { method: s.method, path: s.path, ...(body !== undefined ? { body } : {}), ...placesIn(body, words) }; }),
  };
}

// ---- problems a line of code decides

const TAG = /<\|[\w-]{1,40}\|>|<\/?([a-z][\w-]{0,40})(?:\s[^<>]{0,120})?\/?>/gi;
const FORMATTING = /^(?:a|b|i|u|s|em|strong|br|p|ul|ol|li|code|pre|span|div|table|thead|tbody|tr|td|th|h[1-6]|img|sup|sub|blockquote|hr|small|mark|del|ins|kbd|details|summary|figure|figcaption|caption|section|article|nav|header|footer|main|button|label|input|form)$/i;
const REASONING = /^(?:think|thinking|reasoning)$/i;
const PLACEHOLDER = /\{\{\s*[\w.]{1,40}\s*\}\}|\$\{\s*[\w.]{1,40}\s*\}|\{[a-z_][a-z0-9_]{1,40}\}|%\([a-z_]\w{0,40}\)s/gi;
const ERROR_OPEN = /^\s*(?:error:|exception:|traceback \(most recent call last\)|internal server error|an? (?:unexpected |internal )?error (?:has )?occurred|something went wrong)/i;
const ok = (status) => status >= 200 && status < 300;
// Markup a reply shows as code is the answer, not a leak: fenced blocks and inline code are left out.
const prose = (text) => text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, " ").replace(/`[^`\n]*`/g, " ");

// The app's error on a 2xx: an error field in its JSON, or a reply that opens as an error and is
// not the model's own words.
function errorOf(ex, reply) {
  const body = parse(ex.reply);
  const field = body && typeof body === "object" && !Array.isArray(body) ? ["error", "errors"].find((k) => body[k] && (typeof body[k] !== "object" || Object.keys(body[k]).length)) : null;
  if (field) return typeof body[field] === "string" ? body[field] : JSON.stringify(body[field]);
  const words = norm(modelWords(ex));
  return ERROR_OPEN.test(reply.text) && !(words && words.includes(norm(reply.text).slice(0, 60))) ? reply.text.trim() : "";
}

function problemsIn(ex, reply, find, frame) {
  const out = [];
  const add = (kind, said, where) => out.push({ kind, said, file: where?.file ?? null, line: where?.line ?? null });
  const prompt = promptOf(ex);
  const words = norm(modelWords(ex));
  const call = frame(generation(ex)[0]?.caller);
  const said = prose(reply.text);
  // One problem per kind of leak, every tag of that kind named once: a reply that leaked a block of
  // prompt markup is one defect, not one per tag.
  const tokens = new Set(), reasoning = new Set(), fromPrompt = new Map();
  for (const [tag, name] of said.matchAll(TAG)) {
    if (!name) tokens.add(tag);
    else if (REASONING.test(name)) reasoning.add(tag);
    else if (!FORMATTING.test(name) && prompt.includes(`<${name.toLowerCase()}`) && !fromPrompt.has(name.toLowerCase())) fromPrompt.set(name.toLowerCase(), tag);
  }
  const listed = (set) => [...set].map((t) => `"${t}"`).join(", ");
  if (tokens.size) add("leaked-markup", `The reply carried chat template tokens meant for the model: ${listed(tokens)}.`, call);
  if (reasoning.size) add("leaked-markup", `The reply carried the model's reasoning markup: ${listed(reasoning)}.`, call);
  if (fromPrompt.size) {
    const written = [...fromPrompt.keys()].map((name) => find(`<${name}`)).find(Boolean);
    const tags = listed(new Set(fromPrompt.values()));
    add("leaked-markup", written
      ? `The reply carried markup from the prompt your app sent the model: ${tags}.`
      : `The reply carried markup from the prompt your app sent the model: ${tags}. None of it is written in your code; this is the line that made the model call.`, written ?? call);
  }
  for (const [p] of said.matchAll(PLACEHOLDER)) {
    if (prompt.includes(norm(p))) add("placeholder", `The reply carried "${p}", a placeholder still unfilled in the prompt sent to the model.`, find(p) ?? call);
    else if (!words.includes(norm(p)) && find(p)) add("placeholder", `The reply carried "${p}", a placeholder your code never filled.`, find(p));
  }
  if (ex.status >= 500) add("error-status", `Your app answered ${ex.status} after it called the model.`, null);
  const error = ok(ex.status) ? errorOf(ex, reply) : "";
  if (error) {
    const flat = error.replace(/\s+/g, " ");
    add("error-under-2xx", `Your app answered ${ex.status} with an error: "${clip(flat, 160)}".`, find(flat.slice(0, 60)) ?? find(flat.slice(0, 24)) ?? call);
  }
  for (const c of ex.calls) {
    const status = Number(c.status) || 0;
    if (status === 0 || status >= 400) add("model-call-failed", `A model call to ${str(c.host)}${c.model ? ` for ${c.model}` : ""} ${status ? `answered ${status}` : "got no answer"}.`, frame(c.caller));
  }
  for (const d of ex.deps.filter((x) => x.retrieval && !arr(x.passages).length)) {
    const status = Number(d.status) || 0;
    add("retrieval-empty", `A retrieval from ${str(d.host)} ${ok(status) ? "returned nothing" : status ? `answered ${status} and returned nothing` : "got no answer"}.`, frame(d.caller));
  }
  const told = generation(ex).filter((c) => Array.isArray(c.rules));
  if (told.length && told.every((c) => !c.rules.length)) add("rules-not-carried", "The prompt your app sent the model carried none of the rules read from your code.", frame(told[0].caller));
  return out;
}

// ---- the door's proof

// What the requests did inside the app, as ids, names and counts: the provider host, the read's rules
// any prompt carried (absent when the hook had no rules to look for), the tools that ran, whether the
// model asked for them or the app's own code did, and the passages the latest request was handed.
function insideOf(exchanges) {
  const calls = exchanges.flatMap(generation);
  const hosts = calls.map((c) => str(c.host).replace(/:\d+$/, "").toLowerCase()).filter((h) => /^[a-z0-9.-]{1,200}$/.test(h));
  const told = calls.filter((c) => Array.isArray(c.rules));
  const latest = exchanges.at(-1);
  const names = (rows) => rows.flatMap((r) => arr(r.called).map((t) => str(t?.name))).filter(Boolean);
  return {
    ...(hosts.length ? { host: hosts.sort((a, b) => hosts.filter((h) => h === b).length - hosts.filter((h) => h === a).length)[0] } : {}),
    ...(told.length ? { rules: [...new Set(told.flatMap((c) => c.rules.filter((r) => typeof r === "string" && /^[\w:-]{1,64}$/.test(r))))].slice(0, 300) } : {}),
    tools: [...new Set(exchanges.flatMap((ex) => [...names(ex.calls), ...names(ex.deps)]))].slice(0, 40),
    passages: [...latest.calls, ...latest.deps].reduce((n, r) => n + arr(r.passages).length, 0),
  };
}

// `find(literal, near)` says where the repository's own code holds a literal, as { file, line }, or
// null, searching `near` (the files the exchange's model calls came from) first.
// `base` is the folder the app runs in, relative to the repository: the hook's frames start there.
export function proofOf(exchanges, door, { find = () => null, base = "" } = {}) {
  const at = (f) => {
    const m = /^(.*):(\d+)$/.exec(str(f));
    return m ? { file: base ? `${base.replace(/\/+$/, "")}/${m[1]}` : m[1], line: Number(m[2]) } : null;
  };
  const frame = (frames) => at(arr(frames)[0]);
  const near = (ex) => [...new Set(ex.calls.flatMap((c) => arr(c.caller).map(at)).filter(Boolean).map((p) => p.file))];
  const ask = askOf(exchanges);
  const replies = exchanges.map(replyOf);
  const latest = exchanges.at(-1);
  // The person's own request is the shape trials take; ours only when there is none.
  const shape = exchanges.filter((x) => !x.trial).at(-1) ?? latest;
  const session = sessionOf(exchanges, ask, door);
  const metered = exchanges.filter((ex) => generation(ex).some((c) => c.usage));
  const tokens = (key) => median(metered.map((ex) => generation(ex).reduce((n, c) => n + (Number(c[key]) || 0), 0)));
  const models = exchanges.flatMap(generation).map((c) => str(c.model)).filter(Boolean);
  const count = (m) => models.filter((x) => x === m).length;
  const seconds = median(exchanges.map((ex) => ex.ms / 1000));
  const seen = new Set();
  const problems = exchanges.flatMap((ex, i) => { const files = near(ex); return problemsIn(ex, replies[i], (literal) => find(literal, files), frame); })
    .filter((p) => !seen.has(`${p.kind}|${p.said}`) && seen.add(`${p.kind}|${p.said}`)).slice(0, PROBLEMS_MAX);
  const query = shape.path.includes("?") ? `?${shape.path.split("?").slice(1).join("?")}` : "";
  const answer = shape.answer ? answerOf(shape, ask) : null;
  return {
    door: { method: door.method, path: `${door.path}${query}` },
    template: {
      body: parse(shape.body) ?? shape.body,
      headerNames: Object.keys(shape.headers).filter((k) => !HOP.test(k)).map((k) => k.toLowerCase()).sort(),
      askField: ask?.field ?? null,
      sessionKey: session.key,
    },
    proof: {
      exchanges: exchanges.length,
      askField: ask?.field ?? null,
      session,
      replyPath: replies.at(-1).path,
      stream: replies.at(-1).stream,
      modelCalls: median(exchanges.map((ex) => generation(ex).length)) ?? 0,
      model: [...new Set(models)].sort((a, b) => count(b) - count(a))[0] ?? null,
      tokens: metered.length ? { prompt: tokens("promptTokens"), completion: tokens("completionTokens") } : null,
      replySeconds: seconds === null ? null : Math.round(seconds * 10) / 10,
      purpose: null,
      at: new Date(latest.at).toISOString(),
      ...insideOf(exchanges),
      ...(answer ? { answer } : {}),
    },
    problems,
    sample: { ask: clip(askIn(latest, ask), SAMPLE), reply: clip(replies.at(-1).text, SAMPLE) },
  };
}

// The exchanges grouped by the door they came through, keyed by door.
export function doorsOf(exchanges, routes = []) {
  const doors = new Map();
  for (const ex of exchanges) {
    const door = doorOf(ex, routes);
    if (!doors.has(door.key)) doors.set(door.key, { door, exchanges: [] });
    doors.get(door.key).exchanges.push(ex);
  }
  return doors;
}

// Every door the rows' exchanges came through, with its proof, keyed by door.
export function proofsOf(rows, { routes = [], ...opts } = {}) {
  return new Map([...doorsOf(exchangesOf(rows), routes)].map(([key, { door, exchanges }]) => [key, proofOf(exchanges, door, opts)]));
}
