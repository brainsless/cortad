// Your app's database servers, kept out of the run's way. A run creates people, conversations and
// records by the hundred; an app pointed at Postgres or Redis kept every one of them. So each store
// the app's settings name on this machine is copied on its own server, under a name of ours, the app
// is started pointed at the copy through the same settings, and the copy is deleted when this
// command ends. The original is only ever read. What is not copied is said before a run: which
// store, and that what trials create stays in it.
import { ledger } from "./ledger.mjs";
import { clonePg, dropPg } from "./pg.mjs";
import { cloneRedis, dropRedis } from "./redis.mjs";

export const ENGINE = { postgres: "Postgres", mysql: "MySQL", mongo: "MongoDB", redis: "Redis", qdrant: "Qdrant", chroma: "Chroma", milvus: "Milvus", weaviate: "Weaviate", elasticsearch: "Elasticsearch", meilisearch: "Meilisearch", typesense: "Typesense", neo4j: "Neo4j", sqlserver: "SQL Server", supabase: "Supabase", pinecone: "Pinecone", firestore: "Firestore" };
// Where each listens when nothing else is said. Also how a connection the hook saw is named.
export const PORT_OF = { postgres: 5432, mysql: 3306, mongo: 27017, redis: 6379, qdrant: 6333, chroma: 8000, milvus: 19530, weaviate: 8080, elasticsearch: 9200, meilisearch: 7700, typesense: 8108, neo4j: 7687, sqlserver: 1433 };
// A connection is named by its port only where the port is the store's own: 8000 and 8080 are
// every other web server's too.
const ENGINE_AT = { ...Object.fromEntries(Object.entries(PORT_OF).filter(([e]) => e !== "chroma" && e !== "weaviate").map(([e, p]) => [p, e])), 6334: "qdrant" };
export const isStorePort = (port) => Boolean(ENGINE_AT[port]);
// Stores reached through their maker's SDK, which a setting rarely names: the hook sees the host.
const HOSTED = [["supabase", /\.supabase\.(?:co|in|com)$/], ["mongo", /\.mongodb\.net$/], ["redis", /\.upstash\.io$|\.redis-cloud\.com$|\.redislabs\.com$/], ["postgres", /\.neon\.tech$/], ["pinecone", /\.pinecone\.io$/], ["qdrant", /\.qdrant\.io$/], ["firestore", /^firestore\.googleapis\.com$/]];
const COPIED = new Set(["postgres", "redis"]);

const SCHEME = /^(postgres(?:ql)?|mysql|mariadb|mongodb|rediss?|valkeys?|sqlserver|mssql)((?:\+\w+)*):\/\/([^/?#]*)(\/[^?#]*)?([?#].*)?$/i;
const SCHEME_ENGINE = { postgres: "postgres", postgresql: "postgres", mysql: "mysql", mariadb: "mysql", mongodb: "mongo", redis: "redis", rediss: "redis", valkey: "redis", valkeys: "redis", sqlserver: "sqlserver", mssql: "sqlserver" };
// A search or vector store is named by what its setting is called, since it speaks plain HTTP.
const BY_NAME = [["qdrant", /QDRANT/], ["chroma", /CHROMA/], ["milvus", /MILVUS|ZILLIZ/], ["weaviate", /WEAVIATE/], ["elasticsearch", /ELASTIC|OPENSEARCH/], ["meilisearch", /MEILI/], ["typesense", /TYPESENSE/], ["neo4j", /NEO4J/], ["supabase", /SUPABASE/]];
const WORD_ENGINE = [["postgres", /^(?:PG|POSTGRES|PSQL)|POSTGRES/], ["mysql", /MYSQL|MARIA/], ["mongo", /MONGO/], ["redis", /REDIS|VALKEY/]];
const SECRETISH = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)$/;
const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|::1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)?$/i;
// A socket path (host=/var/run/postgresql) is this machine too.
export const onThisMachine = (host) => LOOPBACK.test(String(host ?? "")) || String(host).startsWith("/");
const hostKey = (host) => (onThisMachine(host) ? "localhost" : String(host).toLowerCase());
const at = (s) => `${s.engine}|${hostKey(s.host)}|${s.port}`;

const authority = (a) => {
  const cut = a.lastIndexOf("@");
  const cred = cut >= 0 ? a.slice(0, cut) : "";
  // A replica set lists its hosts; the first answers for all of them.
  const hostPort = (cut >= 0 ? a.slice(cut + 1) : a).split(",")[0];
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(hostPort);
  if (!m) return null;
  const [user, ...pass] = cred ? cred.split(":") : [];
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  return { host: m[1].replace(/^\[|\]$/g, ""), port: m[2] ? Number(m[2]) : null, user: user ? dec(user) : "", password: pass.length ? dec(pass.join(":")) : "" };
};

// One setting that is a whole address: postgresql+asyncpg://u:p@localhost:5432/app, redis://localhost/2.
function fromUrl(name, value) {
  const m = SCHEME.exec(value);
  if (!m) return null;
  const engine = SCHEME_ENGINE[m[1].toLowerCase()];
  const a = authority(m[3]);
  if (!a) return null;
  const query = new URLSearchParams((m[5] ?? "").replace(/^[?#]/, ""));
  const path = decodeURIComponent((m[4] ?? "").replace(/^\//, ""));
  const db = engine === "redis" ? Number(path || 0) : path;
  const host = a.host || query.get("host") || "";
  const port = a.port ?? PORT_OF[engine] ?? null;
  return {
    engine, host, port, db,
    conn: { host, port, user: a.user, password: a.password, sslmode: query.get("sslmode") ?? "", tlsOn: /^(?:rediss|valkeys)$/i.test(m[1]) },
    point: (to) => ({ [name]: `${m[1]}${m[2]}://${m[3]}/${encodeURIComponent(String(to))}${m[5] ?? ""}` }),
  };
}

// A search or vector store's address: QDRANT_URL=http://localhost:6333, MILVUS_URI=localhost:19530.
function fromNamed(name, value) {
  const engine = BY_NAME.find(([, re]) => re.test(name))?.[0];
  if (!engine || SECRETISH.test(name)) return null;
  const m = /^(?:(https?|grpc|bolt|neo4j):\/\/)?([\w.-]+|\[[:\w]+\]):?(\d+)?(?:[/?#].*)?$/i.exec(value);
  if (!m || (!m[1] && !m[3])) return null;
  const host = m[2].replace(/^\[|\]$/g, "");
  return { engine, host, port: m[3] ? Number(m[3]) : m[1] === "https" ? 443 : PORT_OF[engine] ?? 80, db: null };
}

// Settings that name one store in parts, grouped by what they share before the part:
// POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB; DB_HOST, DB_NAME, DB_CONNECTION=pgsql; PGHOST, PGDATABASE.
const HOST_PART = /^(.+?)_?(?:HOST(?:NAME)?|SERVER)$/;
const PARTS = { port: /^PORT$/, user: /^USER(?:NAME)?$/, password: /^(?:PASS(?:WORD)?|PWD)$/, db: /^(?:DB|DATABASE|DBNAME|DB_?NAME|DATABASE_?NAME|NAME|INDEX)$/, kind: /^(?:ENGINE|DRIVER|DIALECT|CONNECTION|TYPE|CLIENT)$/ };
const KIND_ENGINE = [["postgres", /pg|postgres/], ["mysql", /mysql|maria/], ["mongo", /mongo/], ["redis", /redis|valkey/]];
function fromParts(values) {
  const hosts = new Map();
  for (const name of Object.keys(values)) { const m = HOST_PART.exec(name); if (m && !hosts.has(m[1])) hosts.set(m[1], name); }
  // libpq's own settings need no host: without one it is the local socket.
  if (!hosts.has("PG") && ["PGDATABASE", "PGUSER", "PGPORT"].some((n) => values[n])) hosts.set("PG", null);
  const out = [];
  for (const [p, hostName] of hosts) {
    const parts = {};
    for (const name of Object.keys(values)) {
      if (!name.startsWith(p) || name === hostName) continue;
      const rest = name.slice(p.length).replace(/^_/, "");
      const part = Object.keys(PARTS).find((k) => PARTS[k].test(rest));
      if (part && !parts[part]) parts[part] = name;
    }
    const [host = "", inline] = String(hostName ? values[hostName] : "").split(":");
    const named = Number(values[parts.port] || inline) || null;
    const kind = String(values[parts.kind] ?? "").toLowerCase();
    const engine = WORD_ENGINE.find(([, re]) => re.test(p))?.[0] ?? KIND_ENGINE.find(([, re]) => re.test(kind))?.[0] ?? ENGINE_AT[named];
    if (!engine) continue;
    const port = named ?? PORT_OF[engine];
    const db = parts.db ? (engine === "redis" ? Number(values[parts.db] || 0) : values[parts.db]) : engine === "redis" ? 0 : "";
    out.push({
      engine, host, port, db,
      conn: { host, port, user: values[parts.user] ?? "", password: values[parts.password] ?? "", sslmode: p === "PG" ? values.PGSSLMODE ?? "" : "" },
      names: [hostName ?? parts.user ?? parts.port, parts.db].filter(Boolean),
      // Only a setting that holds the database can point the app at another one.
      point: parts.db ? (to) => ({ [parts.db]: String(to) }) : null,
    });
  }
  return out;
}

// Every store the app's settings name, one entry per database however many settings name it
// (DATABASE_URL and DIRECT_URL, or DATABASE_URL beside POSTGRES_HOST and POSTGRES_DB). A setting
// that names the server but no database (POSTGRES_USER for a container's first start) is the same
// store as the one database its settings do name there.
export function storesOf(values) {
  const found = [];
  for (const [name, raw] of Object.entries(values)) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    const url = fromUrl(name, value);
    if (url) { found.push({ ...url, names: [name] }); continue; }
    const named = fromNamed(name, value);
    if (named) found.push({ ...named, names: [name], point: null });
  }
  found.push(...fromParts(values));
  const byKey = new Map();
  const merge = (held, s) => {
    held.names = [...new Set([...held.names, ...s.names])];
    if (s.point) held.points.push(s.point);
    held.conn ??= s.conn;
  };
  const whole = found.filter((s) => s.db !== "" && s.db !== null);
  for (const s of [...whole, ...found.filter((x) => !whole.includes(x))]) {
    const key = `${at(s)}|${s.db ?? ""}`;
    const held = byKey.get(key) ?? (s.db === "" || s.db === null ? [...byKey.values()].find((h) => at(h) === at(s)) : undefined);
    if (held) { merge(held, s); continue; }
    byKey.set(key, { ...s, key, points: s.point ? [s.point] : [] });
  }
  return [...byKey.values()];
}

// At most three by name, so a sentence stays one sentence.
const listed = (names) => (names.length === 1 ? names[0] : names.length <= 3 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more settings`);
const whatOf = (s) => (s.engine === "redis" ? `Redis database ${s.db}` : s.db ? `${ENGINE[s.engine]} database ${s.db}` : `${ENGINE[s.engine]} server`);

// Why no copy was made, in a sentence of theirs, and what to do about it. The store's own words are
// never quoted: they name users and hosts.
const REASONS = {
  auth: ["the password its settings carry was refused", "Check that setting before a run"],
  rights: ["the user it signs in as may not create databases", "Give that user the right to create databases, or point it at a scratch database, before a run"],
  big: ["it is over the size a run copies", "Point it at a smaller scratch copy before a run if it holds real data"],
  missing: ["Postgres's own psql and pg_dump are not on this machine's PATH", "Install the Postgres client tools, or point it at a scratch database, before a run"],
  version: ["this machine's copy of the store's own tools is older than the server", "Update them, or point it at a scratch database, before a run"],
  full: ["it has no empty database left to copy into", "Point it at a scratch database before a run if it holds real data"],
  cluster: ["it runs as a cluster, which has one database only", "Point it at a scratch server before a run if it holds real data"],
  other: ["the copy did not go through", "Point it at a scratch database before a run if it holds real data"],
};
const risk = (s, why) => {
  const lead = `What trials create in the ${whatOf(s)} that ${listed(s.names)} ${s.names.length === 1 ? "names" : "name"} stays there`;
  if (why === "started") return `${lead}: your app was already running when this command started. Stop it and run the command again to run against a copy.`;
  if (why === "remote") return `${lead}: it is on a server off this machine, and a copy is only made on this machine. Point ${s.names[0]} at a local or scratch database before a run if that one holds real data.`;
  if (why === "engine") return `${lead}: we copy Postgres and Redis for a run, not ${ENGINE[s.engine]}. Point ${s.names[0]} at a scratch ${s.db ? "database" : "server"} before a run if that one holds real data.`;
  if (why === "fixed") return `${lead}: the ${s.engine === "redis" ? "database number" : "database name"} is not among its settings, so the app cannot be pointed at a copy. Put it in one before a run if that one holds real data.`;
  const [reason, fix] = REASONS[why] ?? REASONS.other;
  return `${lead}: ${reason}, so no copy was made. ${fix}.`;
};
const kept = (s, clone) => (s.engine === "redis"
  ? `Your app runs against a copy of its Redis data in database ${clone} of the same server, through ${listed(s.names)}; database ${s.db} is not touched, and database ${clone} is emptied when this command ends.`
  : `Your app runs against a copy of its Postgres database ${s.db}, made on the same server, through ${listed(s.names)}; the original is not touched, and the copy is deleted when this command ends.`);

const drop = (s, clone, marker) => (s.engine === "postgres" ? dropPg(s.conn, clone) : dropRedis(s.conn, clone, marker));
const copy = (s, clone, marker) => (s.engine === "postgres" ? clonePg(s.conn, s.db, clone) : cloneRedis(s.conn, s.db, marker));
const cloneName = (db) => `${String(db).slice(0, 40)}_cortad_${process.pid}`;

// One session's copies. keep() copies the stores given that answer and says what it did; a store
// nothing answers at yet is left out, unsaid, since trials cannot write into it: once it is started
// (lib/backing.mjs), keep() is asked again for it. drop() deletes every copy, and copies a session
// that died left behind are deleted by the next one, through the ledger.
export function storeKeeper({ ledgerFile }) {
  const book = ledger(ledgerFile);
  const made = [];
  const done = new Set();
  return {
    async keep(stores, { started = true, down = () => false } = {}) {
      for (const row of book.orphans("copy")) {
        const s = stores.find((x) => x.key === row.key);
        if (s && (await drop(s, row.made, row.marker))) book.remove(row);
      }
      const env = {};
      const risks = [];
      const copies = [];
      for (const s of stores) {
        if (done.has(s.key)) continue;
        if (!started) { done.add(s.key); risks.push(risk(s, "started")); continue; }
        if (!onThisMachine(s.host)) { done.add(s.key); risks.push(risk(s, "remote")); continue; }
        if (await down(s)) continue;
        done.add(s.key);
        if (!COPIED.has(s.engine)) { risks.push(risk(s, "engine")); continue; }
        if (!s.points.length || (s.engine === "postgres" && !s.db)) { risks.push(risk(s, "fixed")); continue; }
        const marker = `${process.pid}-${Date.now()}`;
        const got = await copy(s, cloneName(s.db), marker);
        if (got.why) { risks.push(risk(s, got.why)); continue; }
        const clone = got.index ?? cloneName(s.db);
        const row = { kind: "copy", key: s.key, made: clone, marker };
        book.add(row);
        made.push({ s, row });
        for (const point of s.points) Object.assign(env, point(clone));
        copies.push(kept(s, clone));
      }
      return { env, risks, copies };
    },
    drop: async () => { for (const { s, row } of made.splice(0)) if (await drop(s, row.made, row.marker)) book.remove(row); },
  };
}

// The stores the app reached that no setting names, as the hook saw each connection: a store written
// into a config file rather than the environment, or one its maker's SDK finds by itself. One
// sentence per store, said once.
export function unnamedLines(connections, stores, told) {
  const lines = [];
  for (const { host, port } of connections) {
    const local = onThisMachine(host);
    const engine = local ? ENGINE_AT[port] : HOSTED.find(([, re]) => re.test(String(host).toLowerCase()))?.[0];
    const key = local ? `localhost:${port}` : `${engine}:${String(host).toLowerCase()}`;
    if (!engine || told.has(key) || stores.some((s) => (local ? `${hostKey(s.host)}:${s.port}` === key : s.engine === engine && !onThisMachine(s.host)))) continue;
    told.add(key);
    lines.push(local
      ? `Your app connects to a ${ENGINE[engine]} server on this machine that none of its settings names, so it cannot be pointed at a copy: what trials create there stays there.`
      : `Your app reaches ${ENGINE[engine]} on a server off this machine, and a copy is only made on this machine: what trials create there stays there.`);
  }
  return lines;
}
