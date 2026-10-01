// Your app's database servers, kept out of the run's way. A run creates people, conversations and
// records by the hundred; an app pointed at Postgres, Redis, MongoDB or a Qdrant collection kept
// every one of them. So each store the app's settings name on this machine is copied on its own
// server, under a name of ours, the app is started pointed at the copy through the same settings,
// and the copy is deleted when this command ends. The original is only ever read. What is not
// copied is said before a run: which store, and that what trials create stays in it. A store off
// this machine is copied where it can be (lib/hosted.mjs) and otherwise holds Run.
import { createHash } from "node:crypto";
import { hostedKeeper } from "./hosted.mjs";
import { ledger } from "./ledger.mjs";
import { cloneMongo, dropMongo, withDb } from "./mongo.mjs";
import { clonePg, dropPg } from "./pg.mjs";
import { cloneQdrant, dropQdrant } from "./qdrant.mjs";
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
// How each store we copy is copied and dropped: on its own server, under the name given.
const COPY = {
  postgres: { copy: (s, clone) => clonePg(s.conn, s.db, clone), drop: (s, clone) => dropPg(s.conn, clone) },
  redis: { copy: (s, clone, marker) => cloneRedis(s.conn, s.db, marker), drop: (s, clone, marker) => dropRedis(s.conn, clone, marker) },
  mongo: { copy: (s, clone) => cloneMongo(s.conn, s.db, clone), drop: (s, clone) => dropMongo(s.conn, clone, s.db) },
  qdrant: { copy: (s, clone) => cloneQdrant(s.conn, s.db, clone), drop: (s, clone) => dropQdrant(s.conn, clone) },
};
const TOOLS = { postgres: "Postgres's own psql and pg_dump are", mongo: "MongoDB's own mongodump, mongorestore and mongosh are" };

const SCHEME = /^(postgres(?:ql)?|mysql|mariadb|mongodb|rediss?|valkeys?|sqlserver|mssql)((?:\+\w+)*):\/\/([^/?#]*)(\/[^?#]*)?([?#].*)?$/i;
const SCHEME_ENGINE = { postgres: "postgres", postgresql: "postgres", mysql: "mysql", mariadb: "mysql", mongodb: "mongo", redis: "redis", rediss: "redis", valkey: "redis", valkeys: "redis", sqlserver: "sqlserver", mssql: "sqlserver" };
// A search or vector store is named by what its setting is called, since it speaks plain HTTP.
const BY_NAME = [["qdrant", /QDRANT/], ["chroma", /CHROMA/], ["milvus", /MILVUS|ZILLIZ/], ["weaviate", /WEAVIATE/], ["elasticsearch", /ELASTIC|OPENSEARCH/], ["meilisearch", /MEILI/], ["typesense", /TYPESENSE/], ["neo4j", /NEO4J/], ["supabase", /SUPABASE/]];
const WORD_ENGINE = [["postgres", /^(?:PG|POSTGRES|PSQL)|POSTGRES/], ["mysql", /MYSQL|MARIA/], ["mongo", /MONGO/], ["redis", /REDIS|VALKEY/]];
const SECRETISH = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)$/;
// Every engine's word in a setting's name, so a setting that carries one is that engine's own.
const ENGINE_WORD = new RegExp([...Object.keys(ENGINE), ...[...BY_NAME, ...WORD_ENGINE].map(([, re]) => re.source)].join("|"), "i");
// Stores that hold no collections: a bare COLLECTION setting beside one of them is still Qdrant's.
const NO_COLLECTIONS = new Set(["redis", "mysql", "sqlserver", "neo4j", "meilisearch", "pinecone"]);
const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|::1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)?$/i;
// A socket path (host=/var/run/postgresql) is this machine too.
export const onThisMachine = (host) => LOOPBACK.test(String(host ?? "")) || String(host).startsWith("/");
// A Neon endpoint's pooled host is the same database as its direct one.
const hostKey = (host) => (onThisMachine(host) ? "localhost" : String(host).toLowerCase().replace(/^(ep-[a-z0-9-]+?)-pooler\./, "$1."));
const at = (s) => `${s.engine}|${hostKey(s.host)}|${s.port}`;

// A part that is no percent-encoding (%DB%) is kept as its maker wrote it.
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const authority = (a) => {
  const cut = a.lastIndexOf("@");
  const cred = cut >= 0 ? a.slice(0, cut) : "";
  // A replica set lists its hosts; the first answers for all of them.
  const hostPort = (cut >= 0 ? a.slice(cut + 1) : a).split(",")[0];
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(hostPort);
  if (!m) return null;
  const [user, ...pass] = cred ? cred.split(":") : [];
  return { host: m[1].replace(/^\[|\]$/g, ""), port: m[2] ? Number(m[2]) : null, user: user ? dec(user) : "", password: pass.length ? dec(pass.join(":")) : "" };
};

// A template the code fills (postgresql://%s:%s@localhost/%s, {}:{}) names no user or database of
// its own: tried, it would be refused for a password the settings never carried.
const TEMPLATE = /%s|%\(\w+\)s|\$\{\w+|\{\w*\}/;

// One setting that is a whole address: postgresql+asyncpg://u:p@localhost:5432/app, redis://localhost/2.
function fromUrl(name, value) {
  const m = SCHEME.exec(value);
  if (!m || TEMPLATE.test(value)) return null;
  const engine = SCHEME_ENGINE[m[1].toLowerCase()];
  const a = authority(m[3]);
  if (!a) return null;
  const query = new URLSearchParams((m[5] ?? "").replace(/^[?#]/, ""));
  const path = dec((m[4] ?? "").replace(/^\//, ""));
  const db = engine === "redis" ? Number(path || 0) : path;
  const host = a.host || query.get("host") || "";
  const port = a.port ?? PORT_OF[engine] ?? null;
  return {
    engine, host, port, db,
    conn: { host, port, user: a.user, password: a.password, sslmode: query.get("sslmode") ?? "", tlsOn: /^(?:rediss|valkeys)$/i.test(m[1]), uri: value },
    point: engine === "mongo" ? (to) => ({ [name]: withDb(value, to, db) }) : (to) => ({ [name]: `${m[1]}${m[2]}://${m[3]}/${encodeURIComponent(String(to))}${m[5] ?? ""}` }),
  };
}

// A search or vector store's address: QDRANT_URL=http://localhost:6333, MILVUS_URI=localhost:19530.
function fromNamed(name, value) {
  const engine = BY_NAME.find(([, re]) => re.test(name))?.[0];
  if (!engine || SECRETISH.test(name)) return null;
  const m = /^(?:(https?|grpc|bolt|neo4j):\/\/)?([\w.-]+|\[[:\w]+\]):?(\d+)?(?:[/?#].*)?$/i.exec(value);
  if (!m || (!m[1] && !m[3])) return null;
  const host = m[2].replace(/^\[|\]$/g, "");
  const port = m[3] ? Number(m[3]) : m[1] === "https" ? 443 : PORT_OF[engine] ?? 80;
  return { engine, host, port, db: null, conn: { base: `${m[1] === "https" ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}` } };
}

// A vector store holds collections, and the app's settings name the ones it uses: QDRANT_COLLECTION,
// COLLECTION_NAME. Each is its own store, pointed at its copy through that setting. A setting that
// carries another engine's word (MONGODB_COLLECTION) is that engine's, and a bare one is this
// store's only when no other store the settings name could own it. The key is the setting beside
// it that ends in KEY.
function withCollections(store, values, others) {
  const word = new RegExp(store.engine, "i");
  const shared = others.some((e) => e !== store.engine && !NO_COLLECTIONS.has(e));
  const key = Object.keys(values).find((n) => word.test(n) && /KEY$/.test(n) && values[n]);
  // QDRANT_HOST and QDRANT_PORT name the same server QDRANT_URL does.
  const base = store.conn.base ?? `http://${store.host.includes(":") ? `[${store.host}]` : store.host}:${store.port}`;
  const conn = { ...store.conn, base, ...(key ? { apiKey: values[key] } : {}) };
  const named = Object.keys(values).filter((n) => /COLLECTION/.test(n) && !SECRETISH.test(n) && String(values[n] ?? "").trim() && (word.test(n) || (!ENGINE_WORD.test(n) && !shared)));
  if (!named.length) return [{ ...store, conn }];
  return named.map((n) => ({ ...store, conn, db: String(values[n]).trim(), names: [...store.names, n], point: (to) => ({ [n]: String(to) }) }));
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
    // A host setting left blank is a store the app is set up not to use (QDRANT_HOST= beside QDRANT_PATH).
    if (hostName && !String(values[hostName] ?? "").trim()) continue;
    // A host setting that holds a whole address (REDIS_HOST=redis://...) is fromUrl's, not a host.
    if (hostName && String(values[hostName]).includes("://")) continue;
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
  const engines = found.map((s) => s.engine);
  const each = found.flatMap((s) => (s.engine === "qdrant" ? withCollections(s, values, engines) : [s]));
  const byKey = new Map();
  const merge = (held, s) => {
    held.names = [...new Set([...held.names, ...s.names])];
    if (s.point) held.points.push(s.point);
    held.conn ??= s.conn;
  };
  const whole = each.filter((s) => s.db !== "" && s.db !== null);
  for (const s of [...whole, ...each.filter((x) => !whole.includes(x))]) {
    const key = `${at(s)}|${s.db ?? ""}`;
    const held = byKey.get(key) ?? (s.db === "" || s.db === null ? [...byKey.values()].find((h) => at(h) === at(s)) : undefined);
    if (held) { merge(held, s); continue; }
    byKey.set(key, { ...s, key, points: s.point ? [s.point] : [] });
  }
  return [...byKey.values()];
}

// At most three by name, so a sentence stays one sentence.
const listed = (names) => (names.length === 1 ? names[0] : names.length <= 3 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more settings`);
const unit = (s) => (s.engine === "qdrant" ? "collection" : "database");
const whatOf = (s) => (s.engine === "redis" ? `Redis database ${s.db}` : s.db ? `${ENGINE[s.engine]} ${unit(s)} ${s.db}` : `${ENGINE[s.engine]} server`);
const copied = Object.keys(COPY).map((e) => ENGINE[e]);
const copiedList = `${copied.slice(0, -1).join(", ")} and ${copied.at(-1)}`;

// Why no copy was made, in a sentence of theirs, and what to do about it. The store's own words are
// never quoted: they name users and hosts.
const REASONS = {
  auth: ["the password its settings carry was refused", "Check that setting before a run"],
  rights: ["the user it signs in as may not create databases", "Give that user the right to create databases, or point it at a scratch database, before a run"],
  down: ["nothing answered at the address its settings give", "Start it before a run"],
  big: ["it is over the size a run copies", "Point it at a smaller scratch copy before a run if it holds real data"],
  missing: [(s) => `${TOOLS[s.engine]} not on this machine's PATH`, (s) => `Install them, or point it at a scratch ${unit(s)}, before a run`],
  version: ["this machine's copy of the store's own tools is older than the server", "Update them, or point it at a scratch database, before a run"],
  oldServer: ["the server is older than Redis 6.2, which a copy needs", "Upgrade it, or point it at a scratch database, before a run"],
  full: ["it has no empty database left to copy into", "Point it at a scratch database before a run if it holds real data"],
  cluster: ["it runs as a cluster, which has one database only", "Point it at a scratch server before a run if it holds real data"],
  other: ["the copy did not go through", "Point it at a scratch database before a run if it holds real data"],
};
const risk = (s, why) => {
  const lead = `What trials create in the ${whatOf(s)} that ${listed(s.names)} ${s.names.length === 1 ? "names" : "name"} stays there`;
  if (why === "started") return `${lead}: your app was already running when this command started. Stop it and run the command again to run against a copy.`;
  if (why === "engine") return `${lead}: we copy ${copiedList} for a run, not ${ENGINE[s.engine]}. Point ${s.names[0]} at a scratch ${s.db ? unit(s) : "server"} before a run if that one holds real data.`;
  if (why === "fixed" && s.engine === "qdrant") return `${lead}: its settings do not say which collection the app keeps there, so the app cannot be pointed at a copy. Point ${s.names[0]} at a scratch server before a run if that one holds real data.`;
  if (why === "fixed") return `${lead}: the ${s.engine === "redis" ? "database number" : `${unit(s)} name`} is not among its settings, so the app cannot be pointed at a copy. Put it in one before a run if that one holds real data.`;
  const [reason, fix] = (REASONS[why] ?? REASONS.other).map((w) => (typeof w === "function" ? w(s) : w));
  return `${lead}: ${reason}, so no copy was made. ${fix}.`;
};
const kept = (s, clone, how) => (s.engine === "redis"
  ? `Your app runs against a copy of its Redis data in database ${clone} of the same server, through ${listed(s.names)}; database ${s.db} is not touched, and database ${clone} is emptied when this command ends.`
  : how === "empty"
    ? `Your app makes its ${ENGINE[s.engine]} ${unit(s)} ${s.db} under the name ${clone} on the same server, through ${listed(s.names)}; the server holds no ${s.db} yet, and ${clone} is deleted when this command ends.`
    : `Your app runs against a copy of its ${ENGINE[s.engine]} ${unit(s)} ${s.db}, made on the same server, through ${listed(s.names)}; the original is not touched, and the copy is deleted when this command ends.`);

// What holds Run for a store off this machine no copy could be made of, and the one thing to do.
// The first reason is the most useful: a Neon store with no key says the key.
const HELD = {
  "neon-key": (s) => ["there is no NEON_API_KEY in its settings to make a branch with", `Set NEON_API_KEY, or point ${s.names[0]} at a database on this machine`],
  neon: (s) => ["Neon did not make a branch of it", `Check NEON_API_KEY, or point ${s.names[0]} at a database on this machine`],
  supabase: (s) => ["a local Supabase needs supabase/config.toml, Docker and the supabase command", `Add them, or point ${s.names[0]} at a local Supabase`],
  engine: (s) => [`a hosted ${ENGINE[s.engine]} is not one we copy`, `Point ${s.names[0]} at a server on this machine`],
  parts: (s) => ["its settings name it in parts, which cannot be pointed at a copy", `Put its whole address in one setting, or point ${s.names[0]} at a database on this machine`],
  "no-migrations": (s) => ["no migrations were found to build a copy on this machine from", `Point ${s.names[0]} at a database on this machine`],
  "no-local": (s) => ["no Postgres on this machine let us make a database to build a copy in", "Start Postgres on this machine"],
  migrations: (s, tool) => [`its ${tool} migrations did not run against a copy on this machine`, `Run them against a local database once by hand, or point ${s.names[0]} at one`],
  started: () => ["your app was already running when this command started, so it cannot be pointed at a copy", "Stop it and run the command again"],
  bypassed: () => ["your app reached it anyway, since it loads its settings file over the settings it was started with", "Load that file without overriding what is already set"],
  other: (s) => ["the copy did not go through", `Point ${s.names[0]} at a database on this machine`],
};
// The other way out is the owner's yes on the card in the browser, which lets trials write into it as
// it is: an agent told only to move the store spent ten minutes on a local Qdrant the card had offered
// to do without (ulaim, 2026-10-01).
const heldWhy = (s, why, tool) => {
  const [reason, fix] = (HELD[why] ?? HELD.other)(s, tool);
  const yes = why === "started" ? "" : " Or the owner can say yes to it on the card in the browser, and trials write into it as it is.";
  return `Trials would write into the ${whatOf(s)} that ${listed(s.names)} ${s.names.length === 1 ? "names" : "name"}, on a server off this machine, and ${reason}. ${fix}, then run the command again.${yes}`;
};
const hostedKept = (s, got) => (got.how === "neon"
  ? `Your app runs against a Neon branch of its ${whatOf(s)}, made for this session through ${listed(s.names)}; the original is not touched, and the branch is deleted when this command ends.`
  : got.how === "supabase"
    ? `Your app runs against a Supabase on this machine started from supabase/config.toml, through ${listed(s.names)}; the hosted one is not touched${got.started ? ", and the local one is stopped when this command ends" : ""}.`
    : `Your app runs against an empty ${ENGINE[s.engine]} database on this machine built by its own ${got.tool} migrations, through ${listed(s.names)}; the hosted one is not touched, and the copy is deleted when this command ends.`);
// How the person's yes names a store off this machine: never its address.
export const storeId = (s) => createHash("sha256").update(s.key).digest("hex").slice(0, 16);
// A store off this machine the app was pointed at a copy of and reached anyway (dotenv's override):
// trials write into the original, so it holds Run. `blocked`: the rows already holding it.
export const bypassedOf = (connections, stores, blocked) => stores
  .filter((s) => !onThisMachine(s.host) && !blocked.some((b) => b.id === storeId(s)) && connections.some((c) => hostKey(c.host) === hostKey(s.host)))
  .map((s) => ({ id: storeId(s), names: s.names, why: heldWhy(s, "bypassed") }));

// A copy that throws is one that did not go through, said as such; it never stops the app starting.
const drop = (s, clone, marker) => COPY[s.engine].drop(s, clone, marker).catch(() => false);
const copy = (s, clone, marker) => COPY[s.engine].copy(s, clone, marker).catch(() => ({ why: "other" }));
const cloneName = (db) => `${String(db).slice(0, 40)}_cortad_${process.pid}`;

// One session's copies. keep() copies the stores given that answer and says what it did; a store
// nothing answers at yet is left out, unsaid, since trials cannot write into it: once it is started
// (lib/backing.mjs), keep() is asked again for it. drop() deletes every copy, and copies a session
// that died left behind are deleted by the next one, through the ledger. A store off this machine
// with no copy is `blocked`, and `pass` names the hosts of the copies made off it.
// `values`, `dirs`, `fetchFn` and `local` are lib/hosted.mjs's.
export function storeKeeper({ ledgerFile, values = {}, dirs = [], fetchFn, local }) {
  const book = ledger(ledgerFile);
  const hosted = hostedKeeper({ values, dirs, book, fetchFn, local });
  const made = [];
  const done = new Set();
  return {
    async keep(stores, { started = true, down = () => false } = {}) {
      for (const row of book.orphans("copy")) {
        const s = stores.find((x) => x.key === row.key);
        if (s && (await drop(s, row.made, row.marker))) book.remove(row);
      }
      await hosted.orphans();
      const env = {};
      const risks = [];
      const copies = [];
      const blocked = [];
      const pass = [];
      for (const s of stores) {
        if (done.has(s.key)) continue;
        if (!onThisMachine(s.host)) {
          done.add(s.key);
          const got = started ? await hosted.keep(s).catch(() => ({ why: ["other"] })) : { why: ["started"] };
          if (!got.env) { blocked.push({ id: storeId(s), names: s.names, why: heldWhy(s, got.why[0], got.tool) }); continue; }
          Object.assign(env, got.env);
          pass.push(...got.pass);
          copies.push(hostedKept(s, got));
          continue;
        }
        if (await down(s)) continue;
        done.add(s.key);
        if (!started) { risks.push(risk(s, "started")); continue; }
        if (!COPY[s.engine]) { risks.push(risk(s, "engine")); continue; }
        if (!s.points.length || (s.engine !== "redis" && !s.db)) { risks.push(risk(s, "fixed")); continue; }
        const marker = `${process.pid}-${Date.now()}`;
        // Recorded before the copy starts, so a session killed mid-copy leaves a row the next one
        // undoes. A Redis copy's database is found by its marker then.
        const row = { kind: "copy", key: s.key, made: s.engine === "redis" ? null : cloneName(s.db), marker };
        book.add(row);
        const got = await copy(s, cloneName(s.db), marker);
        if (got.why) {
          if (await drop(s, row.made, marker)) book.remove(row);
          // A database the server does not hold is one trials cannot write into.
          if (got.why !== "gone") risks.push(risk(s, got.why));
          continue;
        }
        const clone = got.index ?? cloneName(s.db);
        made.push({ s, row });
        for (const point of s.points) Object.assign(env, point(clone));
        copies.push(kept(s, clone, got.how));
      }
      return { env, risks, copies, blocked, pass };
    },
    drop: async () => {
      for (const { s, row } of made.splice(0)) if (await drop(s, row.made, row.marker)) book.remove(row);
      await hosted.drop();
    },
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
