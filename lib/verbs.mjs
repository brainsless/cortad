import { realpathSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { fieldConnectText, fieldText, findingsText, linesOf, refusedText, runText, STARTING, startedText, statusText, waitingText } from "./text.mjs";

// The eight things a coding agent may ask of Cortad, each a call to the API with this machine's key
// and a rendering from lib/text.mjs. The MCP tools and the `npx cortad <verb>` commands are the same
// functions, so both faces say the same thing.
//
// Codex, Cursor CLI and Copilot CLI cut an MCP call at about 60 seconds. `run` and `verify` answer
// within a second; `run_status` holds for up to 45 seconds on the server and 58 in all.

const NOT_CONNECTED = "This folder is not connected to Cortad.\nFor the person: sign in at cortad.com and run the command the connect screen shows, in this folder.";
const HOLD_S = 45;
// What the process that starts a run for an app that is still coming up allows it; lib/cli.mjs.
export const READY_MS = 240_000;

// `pending` keeps the run this machine asked for in ~/.cortad/<project>/pending.json: { kind,
// startedAt, after } while the app comes up, then its jobId, or the error that ended it. `after` is
// the latest run at the time, so a newer run on the server outranks a stale file.
export function makeVerbs({ api, token, fetchImpl = fetch, startApp, pending, root, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const call = async (method, path, body, timeoutMs = 30_000) => {
    const key = typeof token === "function" ? token() : token;
    if (!key) return { status: 0, ok: false, data: { error: NOT_CONNECTED } };
    let res;
    try {
      res = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { status: 0, ok: false, data: { error: `Could not reach Cortad: ${err?.name === "TimeoutError" ? "it did not answer in time" : "the connection failed"}.` } };
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    return { status: res.status, ok: res.ok, data };
  };
  const failed = (res) => ({ text: res.data?.why ?? res.data?.error ?? `Cortad answered ${res.status}.`, data: res.data, isError: true });
  const iso = () => new Date(now()).toISOString();

  const status = async () => {
    const res = await call("GET", "/mcp/status");
    return res.ok ? { text: statusText(res.data), data: res.data } : failed(res);
  };

  // Asks the server for the run and keeps its id here, so run_status finds it without one.
  const post = async (args, kind) => {
    const res = await call("POST", "/mcp/run", args);
    if (res.status === 202 || (res.ok && res.data?.joined)) {
      pending.write({ jobId: res.data.jobId, kind: res.data.kind ?? kind, startedAt: iso() });
      return { text: startedText(res.data, kind, args.findingId), data: res.data };
    }
    if (res.status === 402) return { text: refusedText(res.data), data: res.data, isError: true };
    if (res.status === 409) return { text: `${res.data?.why ?? "The run could not start."}\nNothing ran.`, data: res.data, isError: true };
    return failed(res);
  };

  // An app that is up gets the run now. One that is not is started in the background, and the run
  // is posted from there once it answers.
  const start = async (args, kind) => {
    const before = await call("GET", "/mcp/status");
    if (!before.ok) return failed(before);
    if (before.data.app?.state === "ready-to-test") return post(args, kind);
    pending.write({ kind, startedAt: iso(), after: before.data.run?.jobId ?? null });
    const began = await startApp(args, kind);
    if (!began.ok) {
      pending.write({ kind, startedAt: iso(), error: began.why });
      return { text: began.why, isError: true };
    }
    return { text: STARTING, data: { pending: true } };
  };
  const run = () => start({}, "run");
  const verify = ({ findingId, jobId } = {}) => start({ findingId, ...(jobId ? { jobId } : {}) }, "verify");

  // With no id: the run this machine is still starting, held here until it has an id, or else the
  // latest run on the server.
  const resolve = async (until) => {
    const latest = await call("GET", "/mcp/status");
    if (!latest.ok) return failed(latest);
    const newest = latest.data.run?.jobId ?? null;
    let p = pending.read();
    if (!p || p.jobId || (p.after ?? null) !== newest) return newest ? { id: newest } : { text: "No run yet.\nnext: status" };
    const stale = () => now() - Date.parse(p.startedAt) > READY_MS + 30_000;
    while (!p.jobId && !p.error && !stale() && now() < until) {
      await sleep(1000);
      p = pending.read() ?? p;
    }
    if (p.jobId) return { id: p.jobId };
    if (p.error) return { text: `${p.error}\nnext: status`, isError: true };
    if (stale()) return { text: "The process starting your app for the run ended without a result.\nNothing ran.\nnext: status", isError: true };
    return { text: waitingText(p, now(), READY_MS) };
  };

  const runStatus = async ({ jobId } = {}) => {
    const began = now();
    let id = jobId && jobId !== "pending" ? String(jobId) : null;
    if (!id) {
      const found = await resolve(began + HOLD_S * 1000);
      if (!found.id) return found;
      id = found.id;
    }
    const hold = Math.max(0, HOLD_S - Math.ceil((now() - began) / 1000));
    const res = await call("GET", `/mcp/run/${encodeURIComponent(id)}${hold ? `?wait=${hold}` : ""}`, undefined, (hold + 13) * 1000);
    if (!res.ok) {
      const out = failed(res);
      return { ...out, text: `${out.text}\nnext: run_status ${id}` };
    }
    return { text: runText(res.data), data: res.data };
  };

  // Every server page of a run's findings, so the pages the agent reads are cut by size here.
  const gather = async (jobId) => {
    const path = (page, id) => {
      const q = new URLSearchParams({ ...(id ? { jobId: id } : {}), ...(page > 1 ? { page: String(page) } : {}) }).toString();
      return `/mcp/findings${q ? `?${q}` : ""}`;
    };
    const first = await call("GET", path(1, jobId));
    if (!first.ok) return first;
    const d = first.data;
    for (let page = 2; page <= Math.min(d.pages ?? 1, 20); page += 1) {
      const more = await call("GET", path(page, d.runId ?? jobId));
      if (!more.ok) return more;
      d.findings = [...(d.findings ?? []), ...(more.data.findings ?? [])];
      if (more.data.byLine) d.byLine = [...(d.byLine ?? []), ...more.data.byLine];
    }
    return first;
  };

  const findings = async ({ jobId, page } = {}) => {
    const res = await gather(jobId);
    return res.ok ? { text: findingsText(res.data, page), data: res.data } : failed(res);
  };

  const dispute = async ({ findingId, why, question, jobId }) => {
    const res = await call("POST", "/mcp/dispute", { findingId, why, ...(question ? { question } : {}), ...(jobId ? { jobId } : {}) });
    return res.ok ? { text: res.data.said, data: res.data } : failed(res);
  };

  const fieldConnect = async () => {
    const res = await call("POST", "/mcp/field/connect");
    return res.ok ? { text: fieldConnectText(res.data), data: res.data } : failed(res);
  };

  const field = async ({ days } = {}) => {
    const res = await call("GET", `/mcp/field${days ? `?days=${Number(days)}` : ""}`);
    return res.ok ? { text: fieldText(res.data), data: res.data } : failed(res);
  };

  // `status --changed`: the files Cortad cites that changed since the latest run started, with the
  // findings at them. Empty when there is nothing to say, or nothing could be asked.
  const changed = async () => {
    const [s, f] = await Promise.all([call("GET", "/mcp/status"), gather()]);
    const r = s.ok ? s.data?.run : null;
    if (!r) return { text: "" };
    const kept = pending.read();
    const since = r.startedAt ?? (kept?.jobId === r.jobId ? kept.startedAt : null);
    const lines = f.ok ? linesOf(f.data) : [];
    const read = s.data.read ?? {};
    const paths = [
      ...lines.map((l) => l.path),
      ...(read.rules?.examples ?? []).map((e) => e.path),
      ...(read.machine?.misses ?? []).map((m) => m.path),
      ...(Array.isArray(read.rules?.files) ? read.rules.files : []),
    ].filter((p) => typeof p === "string" && p);
    return { text: changedLine({ root, since, runId: r.jobId, paths, lines }) };
  };

  // `post` and `changed` serve lib/cli.mjs; the MCP answers only the names in TOOLS.
  return { status, run, run_status: runStatus, findings, verify, dispute, field_connect: fieldConnect, field, post, changed };
}

// Only paths inside the repository are looked at; a path from the server never reaches outside it.
export function changedLine({ root, since, runId, paths, lines }) {
  const t = Date.parse(since ?? "");
  if (!Number.isFinite(t)) return "";
  const base = realpathSync(root);
  const changedFiles = [...new Set(paths)].filter((rel) => {
    const abs = resolvePath(base, rel);
    if (!abs.startsWith(base + sep)) return false;
    try { return statSync(abs).mtimeMs > t; } catch { return false; }
  });
  if (!changedFiles.length) return "";
  const at = (rel) => lines.filter((l) => l.path === rel).flatMap((l) => l.findingIds);
  return `Changed since run ${runId}: ${changedFiles.map((rel) => (at(rel).length ? `${rel} (${at(rel).join(", ")})` : rel)).join(", ")}.`;
}
