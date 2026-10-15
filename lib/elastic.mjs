// An Elasticsearch or OpenSearch server copied for a session into a container of ours
// (lib/container.mjs): every index the app can see, with its settings, mappings, aliases and
// documents, read over the server's own HTTP API and written into ours. The app names its indexes in
// its code, so it is the server that is copied, and the app is pointed at ours through its address.
import { randomBytes } from "node:crypto";
import { dockerUp, freePort, runCopy, servedBy, until } from "./container.mjs";

// A server holding more than this on its primaries is not copied: held instead, so the person decides.
export const ELASTIC_CAP = 1024 ** 3;
const PAGE = 500;
// Index settings the server makes for itself, or that tie the index to the original's cluster.
const OWN = new Set(["uuid", "creation_date", "creation_date_string", "version", "provided_name", "routing", "resize", "history", "verified_before_close", "blocks", "lifecycle", "replication", "frozen", "store", "shrink", "downsample"]);
const IMAGE = { elasticsearch: (v) => `docker.elastic.co/elasticsearch/elasticsearch:${v}`, opensearch: (v) => `opensearchproject/opensearch:${v}` };
// Each kind as one node that asks for no sign-in.
const SETTINGS = {
  elasticsearch: { "xpack.security.enabled": "false", ES_JAVA_OPTS: "-Xms512m -Xmx512m" },
  opensearch: { DISABLE_SECURITY_PLUGIN: "true", DISABLE_INSTALL_DEMO_CONFIG: "true", OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m" },
};
// A server the app signs in to is copied into one that asks for a password too, over plain HTTP on
// this machine's loopback.
const SECURED = { "xpack.security.enabled": "true", "xpack.security.http.ssl.enabled": "false", "xpack.security.transport.ssl.enabled": "false" };

const headersOf = (conn) => ({
  "content-type": "application/json",
  ...(conn.apiKey ? { authorization: `ApiKey ${conn.apiKey}` } : conn.user ? { authorization: `Basic ${Buffer.from(`${conn.user}:${conn.password ?? ""}`).toString("base64")}` } : {}),
});
async function call(conn, method, path, body, type) {
  const res = await fetch(`${conn.base}${path}`, {
    method,
    headers: { ...headersOf(conn), ...(type ? { "content-type": type } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { why: res.status === 401 || res.status === 403 ? "auth" : "other" });
  return data;
}
const whyOf = (e) => e?.why ?? (/ECONNREFUSED|ECONNRESET|fetch failed|timeout/i.test(String(e?.cause?.code ?? e?.message)) ? "down" : "other");
const at = (index) => `/${encodeURIComponent(index)}`;

const ownSettings = (index) => Object.fromEntries(Object.entries(index ?? {}).filter(([k]) => !OWN.has(k)).map(([k, v]) => [k, k === "number_of_replicas" ? "0" : v]));

// One index: made on ours as the original holds it, then its documents a page at a time.
async function copyIndex(from, to, index) {
  const held = (await call(from, "GET", at(index)))[index];
  await call(to, "PUT", at(index), { settings: { index: ownSettings(held.settings?.index) }, mappings: held.mappings ?? {}, aliases: held.aliases ?? {} });
  let page = await call(from, "POST", `${at(index)}/_search?scroll=2m`, { size: PAGE, sort: ["_doc"] });
  try {
    while (page.hits.hits.length) {
      const lines = page.hits.hits.flatMap((h) => [JSON.stringify({ index: { _index: index, _id: h._id, ...(h._routing ? { routing: h._routing } : {}) } }), JSON.stringify(h._source ?? {})]);
      const done = await call(to, "POST", "/_bulk", `${lines.join("\n")}\n`, "application/x-ndjson");
      if (done.errors) throw Object.assign(new Error("bulk"), { why: "other" });
      page = await call(from, "POST", "/_search/scroll", { scroll: "2m", scroll_id: page._scroll_id });
    }
  } finally {
    await call(from, "DELETE", "/_search/scroll", { scroll_id: page._scroll_id }).catch(() => {});
  }
  await call(to, "POST", `${at(index)}/_refresh`);
}

// Answers { port } or { why }. `conn`: base and port, and user and password or apiKey when the server asks.
export async function serveElastic(conn, name) {
  let info, indexes;
  try {
    info = await call(conn, "GET", "/");
    indexes = (await call(conn, "GET", "/_cat/indices?format=json&bytes=b&h=index,pri.store.size&expand_wildcards=open")).filter((i) => !i.index.startsWith("."));
  } catch (e) { return { why: whyOf(e) }; }
  if (indexes.reduce((n, i) => n + Number(i["pri.store.size"] ?? 0), 0) > ELASTIC_CAP) return { why: "big" };
  const kind = info.version?.distribution === "opensearch" ? "opensearch" : "elasticsearch";
  // An API key cannot be made again on another server, and OpenSearch keeps its users in a plugin.
  if (conn.apiKey || (conn.user && kind === "opensearch")) return { why: "login" };
  if (!(await dockerUp())) return { why: "docker" };
  const image = (await servedBy(conn.port))?.image ?? IMAGE[kind](info.version?.number);
  const ours = await freePort();
  // The app's own user and password work on ours: the superuser's where it signs in as that, else
  // a user of the same name made there.
  const elastic = conn.user ? (conn.user === "elastic" ? conn.password : randomBytes(24).toString("hex")) : null;
  // No shard is left unplaced on a laptop whose disk is nearly full.
  const env = { ...SETTINGS[kind], ...(elastic ? SECURED : {}), "discovery.type": "single-node", "http.port": String(ours), "cluster.routing.allocation.disk.threshold_enabled": "false" };
  if (!(await runCopy({ name, image, port: ours, env, secrets: elastic ? { ELASTIC_PASSWORD: elastic } : {} }))) return { why: "container" };
  const to = { base: `http://127.0.0.1:${ours}`, ...(elastic ? { user: "elastic", password: elastic } : {}) };
  if (!(await until(async () => Boolean(await call(to, "GET", "/_cluster/health?wait_for_status=yellow&timeout=1s")), 180_000))) return { why: "other" };
  try {
    if (elastic && conn.user !== "elastic") await call(to, "PUT", `/_security/user/${encodeURIComponent(conn.user)}`, { password: conn.password, roles: ["superuser"] });
    for (const { index } of indexes) await copyIndex(conn, to, index);
  } catch (e) { return { why: whyOf(e) }; }
  return { port: ours };
}
