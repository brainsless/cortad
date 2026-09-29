// A Redis database copied for a session into an empty logical database of the same server, and
// emptied after. Spoken over the wire here (RESP), so nothing needs redis-cli on this machine and
// the password never sits on a command line.
import { connect as tcp } from "node:net";
import { connect as tls } from "node:tls";

// A database with more keys than this is not copied: said instead.
export const REDIS_CAP = 200_000;
// Written into the copy, so an emptying after a crash only ever empties a database this command
// filled: a database index can be taken by something else between two sessions.
export const MARKER = "__cortad_copy__";
const BATCH = 500;

// One connection, commands sent in batches and answered in order.
async function open({ host, port, tlsOn, user, password }) {
  const socket = await new Promise((ok, no) => {
    const s = (tlsOn ? tls : tcp)({ host: host || "127.0.0.1", port, ...(tlsOn ? { servername: host } : {}) });
    s.setTimeout(10_000, () => s.destroy(new Error("timeout")));
    s.once(tlsOn ? "secureConnect" : "connect", () => ok(s));
    s.once("error", no);
  });
  let buf = Buffer.alloc(0);
  const waiting = [];
  const replies = [];
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let r; (r = parse(buf, 0)); ) { buf = buf.subarray(r.end); replies.push(r.value); }
    while (waiting.length && replies.length >= waiting[0].n) { const w = waiting.shift(); w.ok(replies.splice(0, w.n)); }
  });
  socket.on("error", (e) => { for (const w of waiting.splice(0)) w.no(e); });
  const send = (cmds) => new Promise((ok, no) => {
    waiting.push({ n: cmds.length, ok, no });
    socket.write(Buffer.concat(cmds.map(encode)));
  });
  const client = { send, one: async (...cmd) => (await send([cmd]))[0], close: () => socket.end() };
  if (password) {
    const said = await client.one(...(user ? ["AUTH", user, password] : ["AUTH", password]));
    // A development server with no password set refuses AUTH itself; the app connects the same way.
    if (said instanceof Error && !/without any password configured|no password is set/i.test(said.message)) { client.close(); throw Object.assign(new Error("auth"), { why: "auth" }); }
  }
  return client;
}

// Arguments go as bytes: a key is whatever bytes the app named it with, and it is copied as such.
const encode = (cmd) => Buffer.concat([Buffer.from(`*${cmd.length}\r\n`), ...cmd.flatMap((a) => {
  const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  return [Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n")];
})]);

// One reply from buf at i, or null until the whole of it has arrived.
function parse(buf, i) {
  const eol = buf.indexOf("\r\n", i);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[i]);
  const line = buf.subarray(i + 1, eol).toString();
  if (type === "+") return { value: line, end: eol + 2 };
  if (type === "-") return { value: new Error(line), end: eol + 2 };
  if (type === ":") return { value: Number(line), end: eol + 2 };
  if (type === "$") {
    const n = Number(line);
    if (n < 0) return { value: null, end: eol + 2 };
    if (buf.length < eol + 2 + n + 2) return null;
    return { value: Buffer.from(buf.subarray(eol + 2, eol + 2 + n)), end: eol + 2 + n + 2 };
  }
  if (type === "*") {
    const n = Number(line);
    const items = [];
    let at = eol + 2;
    for (let k = 0; k < n; k++) { const r = parse(buf, at); if (!r) return null; items.push(r.value); at = r.end; }
    return { value: n < 0 ? null : items, end: at };
  }
  return { value: new Error(`unreadable reply ${type}`), end: eol + 2 };
}

const why = (e) => e?.why ?? (/NOAUTH|WRONGPASS|invalid password/i.test(String(e?.message)) ? "auth" : /ECONNREFUSED|ENOTFOUND|timeout|EHOSTUNREACH/i.test(String(e?.code ?? e?.message)) ? "down" : "other");

// COPY came in Redis 6.2. A server that hides INFO is let try: a refused COPY is said then.
export function tooOld(info) {
  const m = /redis_version:(\d+)\.(\d+)/.exec(Buffer.isBuffer(info) ? info.toString() : "");
  return Boolean(m) && (Number(m[1]) < 6 || (Number(m[1]) === 6 && Number(m[2]) < 2));
}

// The copy: the first empty database from the top of the server's range, claimed with the marker,
// then every key of the source copied into it with COPY. Answers { index } or { why }.
export async function cloneRedis(conn, source, marker) {
  let c;
  try { c = await open(conn); } catch (e) { return { why: why(e) }; }
  try {
    const [picked, size, info] = await c.send([["SELECT", source], ["DBSIZE"], ["INFO", "server"]]);
    if (picked instanceof Error) return { why: /cluster/i.test(picked.message) ? "cluster" : why(picked) };
    if (tooOld(info)) return { why: "oldServer" };
    if (size > REDIS_CAP) return { why: "big" };
    let index = null;
    for (let n = 15; n >= 1 && index === null; n--) {
      if (n === source) continue;
      const [sel, count] = await c.send([["SELECT", n], ["DBSIZE"]]);
      if (sel instanceof Error) continue;
      if (count === 0) index = n;
    }
    if (index === null) return { why: "full" };
    await c.send([["SELECT", index], ["SET", MARKER, marker], ["SELECT", source]]);
    let cursor = "0";
    do {
      const [next, keys] = await c.one("SCAN", cursor, "COUNT", BATCH);
      cursor = String(next);
      const copied = keys.length ? await c.send(keys.map((k) => ["COPY", k, k, "DB", index])) : [];
      const refused = copied.find((r) => r instanceof Error);
      if (refused) { await c.send([["SELECT", index], ["FLUSHDB"]]); return { why: "other" }; }
    } while (cursor !== "0");
    return { index };
  } catch (e) {
    return { why: why(e) };
  } finally {
    c.close();
  }
}

// Emptied only when the marker in it is this session's. With no index, the database is found by its
// marker: a session killed mid-copy recorded the copy before it knew which database it claimed.
export async function dropRedis(conn, index, marker) {
  let c;
  try { c = await open(conn); } catch { return false; }
  try {
    for (const n of index == null ? Array.from({ length: 15 }, (_, i) => 15 - i) : [index]) {
      const [sel, held] = await c.send([["SELECT", n], ["GET", MARKER]]);
      if (!(sel instanceof Error) && String(held) === marker) return (await c.one("FLUSHDB")) === "OK";
    }
    return index == null;
  } catch { return false; } finally { c.close(); }
}
