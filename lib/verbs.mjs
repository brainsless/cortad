// The eight things a coding agent may ask of Cortad, each one call to the API with this machine's
// key and one rendering as short text. The MCP tools and the `npx cortad <verb>` commands are the
// same functions, so both faces say the same thing.

const NOT_CONNECTED = "This project is not connected to Cortad yet. Ask the person to open cortad.com, sign in, and run the command the connect screen shows, from this folder.";

export function makeVerbs({ api, token, fetchImpl = fetch, ensureRunner = async () => ({ ok: true }) }) {
  const call = async (method, path, body) => {
    const key = typeof token === "function" ? token() : token;
    if (!key) return { status: 0, ok: false, data: { error: NOT_CONNECTED } };
    let res;
    try {
      res = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      return { status: 0, ok: false, data: { error: `could not reach Cortad: ${err?.name === "TimeoutError" ? "it did not answer in time" : "the connection failed"}` } };
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    return { status: res.status, ok: res.ok, data };
  };
  const failed = (res) => ({ text: res.data?.why ?? res.data?.error ?? `Cortad answered ${res.status}.`, data: res.data, isError: true });

  const status = async () => {
    const res = await call("GET", "/mcp/status");
    return res.ok ? { text: statusText(res.data), data: res.data } : failed(res);
  };

  // A run, or a verify when a finding is named. When the app is not up on this machine, the runner
  // is started first: the process that uploads the tree, starts the app and answers the knocks.
  const start = async (args, kind) => {
    const before = await call("GET", "/mcp/status");
    if (!before.ok) return failed(before);
    if (before.data.app?.state !== "ready-to-test") {
      const runner = await ensureRunner(before.data);
      if (!runner.ok) return { text: runner.why, data: runner, isError: true };
    }
    const res = await call("POST", "/mcp/run", args);
    if (res.status === 202 || (res.ok && res.data?.joined)) return { text: startedText(res.data, kind), data: res.data };
    if (res.status === 402) return { text: refusedText(res.data), data: res.data, isError: true };
    return failed(res);
  };
  const run = () => start({}, "run");
  const verify = ({ findingId, jobId }) => start({ findingId, ...(jobId ? { jobId } : {}) }, "verify");

  const runStatus = async ({ jobId }) => {
    const res = await call("GET", `/mcp/run/${encodeURIComponent(jobId)}`);
    return res.ok ? { text: runText(res.data), data: res.data } : failed(res);
  };

  const findings = async ({ jobId } = {}) => {
    const res = await call("GET", `/mcp/findings${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`);
    return res.ok ? { text: findingsText(res.data), data: res.data } : failed(res);
  };

  const dispute = async ({ findingId, why, question, jobId }) => {
    const res = await call("POST", "/mcp/dispute", { findingId, why, ...(question ? { question } : {}), ...(jobId ? { jobId } : {}) });
    return res.ok ? { text: res.data.said, data: res.data } : failed(res);
  };

  const fieldConnect = async () => {
    const res = await call("POST", "/mcp/field/connect");
    if (!res.ok) return failed(res);
    const d = res.data;
    return { text: [d.connected ? "Production is connected." : "Production is not connected yet.", ...d.steps.map((s, i) => `${i + 1}. ${s}`)].join("\n"), data: d };
  };

  const field = async ({ days } = {}) => {
    const res = await call("GET", `/mcp/field${days ? `?days=${Number(days)}` : ""}`);
    return res.ok ? { text: fieldText(res.data), data: res.data } : failed(res);
  };

  return { status, run, run_status: runStatus, findings, verify, dispute, field_connect: fieldConnect, field };
}

const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function statusText(d) {
  const p = d.plan;
  const lines = [
    `Cortad · ${d.repository.name} · ${p.name}: ${p.runs.left} of ${plural(p.runs.allowed, "run")} left this month, ${p.trials.left} of ${p.trials.allowed} verify trials.`,
    `App: ${d.app.said}`,
    `Conversations written: ${d.cases.written}.${d.cases.ready ? " A run can start." : ""}`,
  ];
  lines.push(d.run ? `Latest ${runText(d.run)}` : "No run yet.");
  lines.push(d.field.connected ? "Production: connected." : `Production: not connected. field_connect says how.`);
  return lines.join("\n");
}

export function startedText(d, kind) {
  if (d.joined) return `A ${d.kind ?? kind} is already in flight: ${d.jobId}. Poll run_status every 30 seconds. Watch it: ${d.url}`;
  return `${kind === "verify" ? "Verify" : "Run"} started: ${d.jobId}. Poll run_status every 30 seconds and stay quiet unless the count moved. Watch it: ${d.url}`;
}

export function refusedText(d) {
  const plans = (d.plans ?? []).map((p) => `${p.name} ($${p.monthlyUsd}/month)`).join(" or ");
  if (d.refused === "plan") return `The first run was free. Another needs ${plans || "a plan"}: ${d.checkout}\nShow this link to the person in one sentence and wait for them.`;
  return `${d.why} More on ${plans || "a bigger plan"}: ${d.checkout}\nShow this link to the person and wait.`;
}

export function runText(d) {
  const head = `${d.kind} ${d.jobId} ${d.status}: ${d.of ? `played ${d.played} of ${d.of}.` : "starting, nothing played yet."}`;
  const tail = [];
  if (d.finished && typeof d.score === "number") tail.push(`Score ${d.score} of 100.`);
  if (d.finished && typeof d.findings === "number") tail.push(d.findings ? `${plural(d.findings, "finding")}; call findings.` : "No findings stood out.");
  if (d.stopped) tail.push(`Stopped after ${d.stopped.after} of ${d.of}: ${d.stopped.why}${d.stopped.side === "theirs" ? " (their side)" : d.stopped.side === "ours" ? " (Cortad's side)" : ""}. ${d.stopped.fix}`);
  for (const f of d.faults ?? []) tail.push(`${f.what} ${f.fix}`);
  if (d.error) tail.push(`Error: ${d.error}`);
  if (d.verify) tail.push(verifyText(d.verify));
  if (!d.finished) tail.push("Poll again in 30 seconds.");
  return [head, ...tail, d.url].join(" ");
}

export function verifyText(v) {
  const move = v.visible;
  const line = move
    ? `${v.file}:${v.line} · held ${move.before.k} of ${move.before.n} before, ${move.after.k} of ${move.after.n} after · move ${move.point} (${move.low} to ${move.high}) · ${move.moved}${move.insideNoise ? ", inside the noise" : ""}.`
    : "";
  const held = v.holdout ? ` Held-out situations: ${v.holdout.moved}.` : " Held-out situations: no pair.";
  return `Verify of ${v.findingId}: ${line}${held}${v.overfit ? " OVERFIT: the visible cases moved and the held-out ones did not." : ""} ${v.said}`;
}

export function findingsText(d) {
  if (!d.findings?.length) return [d.why ?? `Run ${d.runId}: no question held worse in one situation than this app does everywhere else.`, d.read, d.heldBack, d.url].filter(Boolean).join(" ");
  const rows = d.findings.map((f, i) => [
    `${i + 1}. ${f.id} · ${f.asks}`,
    `   held ${f.rate.k} of ${f.rate.n} (${pct(f.rate.k, f.rate.n)}, interval ${pct(Math.round(f.rate.lo * f.rate.n), f.rate.n)} to ${pct(Math.round(f.rate.hi * f.rate.n), f.rate.n)}) · ${f.file}:${f.line} · ${f.where}`,
    ...f.quotes.slice(0, 1).map((q) => `   reply ${q.reply}: "${q.quote}" (p=${q.p.toFixed(2)})`),
    `   replay: ${plural(f.replay.trials, "trial")} · verify ${f.id}`,
  ].join("\n"));
  return [`Run ${d.runId}. ${d.read} ${d.heldBack}`, ...rows, `Fix one finding at a time, in the file it names, then verify it. ${d.url}`].join("\n");
}

export function fieldText(d) {
  const t = d.totals;
  if (!t || !t.n) return `No production conversations read in the last ${d.days} days. ${d.url}`;
  const lines = [
    `Production, last ${d.days} days: ${plural(t.n, "conversation")}, ${t.read} read.`,
    `Rulings held: ${pct(t.rulingsHeld, t.rulings)} of ${t.rulings}${t.rulingsUnsure ? ` (${t.rulingsUnsure} unsure)` : ""}. Resolved ${pct(t.resolved, t.read)}, frustrated ${pct(t.frustrated, t.read)}, asked for a human ${pct(t.wantsHuman, t.read)}, unanswered ${pct(t.unanswered, t.read)}.`,
  ];
  const broke = (d.rules ?? []).filter((r) => r.broke > 0).sort((a, b) => b.broke - a.broke).slice(0, 5);
  if (broke.length) lines.push(`Rules broken most: ${broke.map((r) => `${r.id} (${r.broke})`).join(", ")}.`);
  if (d.journeys?.length) lines.push(`By journey: ${d.journeys.slice(0, 6).map((j) => `${j.value} ${plural(j.n, "conv")}, ${pct(j.rulingsHeld, j.rulings)} held`).join("; ")}.`);
  lines.push(d.url);
  return lines.join("\n");
}
