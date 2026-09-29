// A Qdrant collection copied for a session into a new collection of the same server, point by point
// over Qdrant's own HTTP API with the vectors, payloads and payload indexes it holds, and deleted
// after. The key, when the server has one, travels in its header.
export const QDRANT_CAP = 200_000;
const BATCH = 256;
const at = (name) => `/collections/${encodeURIComponent(name)}`;

async function call(conn, method, path, body) {
  const res = await fetch(`${conn.base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(conn.apiKey ? { "api-key": conn.apiKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { why: res.status === 401 || res.status === 403 ? "auth" : res.status === 404 ? "gone" : "other" });
  return data?.result;
}
const whyOf = (e) => e?.why ?? (/ECONNREFUSED|fetch failed|timeout/i.test(String(e?.cause?.code ?? e?.message)) ? "down" : "other");

// A collection the server does not hold yet is one the app makes on first use: pointed at the copy's
// name, it makes that one instead, and it is deleted like any copy.
export async function cloneQdrant(conn, source, clone) {
  let info;
  try { info = await call(conn, "GET", at(source)); } catch (e) { return e?.why === "gone" ? { how: "empty" } : { why: whyOf(e) }; }
  if ((info.points_count ?? 0) > QDRANT_CAP) return { why: "big" };
  let made = false;
  try {
    const { vectors, sparse_vectors, on_disk_payload } = info.config.params;
    await call(conn, "PUT", at(clone), { vectors, ...(sparse_vectors ? { sparse_vectors } : {}), ...(on_disk_payload === undefined ? {} : { on_disk_payload }) });
    made = true;
    for (const [field_name, schema] of Object.entries(info.payload_schema ?? {})) await call(conn, "PUT", `${at(clone)}/index?wait=true`, { field_name, field_schema: schema.params ?? schema.data_type });
    for (let offset; ;) {
      const page = await call(conn, "POST", `${at(source)}/points/scroll`, { limit: BATCH, with_payload: true, with_vector: true, ...(offset === undefined ? {} : { offset }) });
      if (page.points.length) await call(conn, "PUT", `${at(clone)}/points?wait=true`, { points: page.points.map(({ id, vector, payload }) => ({ id, vector, payload })) });
      offset = page.next_page_offset;
      if (offset === null || offset === undefined) return { how: "points" };
    }
  } catch (e) {
    if (made) await dropQdrant(conn, clone);
    return { why: whyOf(e) };
  }
}

export async function dropQdrant(conn, clone) {
  try { await call(conn, "DELETE", at(clone)); return true; } catch (e) { return e?.why === "gone"; }
}
