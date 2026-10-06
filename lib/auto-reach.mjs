// The connect command tests the endpoints the read lists by itself, as soon as status lists them:
// no agent, no headers from anyone. Each endpoint is sent once per connection, and again only when
// the file it is written in changes or the agent asks with `reach`. The agent's ask reaches this
// process through two files beside the runner record, since the identities this machine signed in
// live here and nowhere else.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notUp, picked, reachText, REACH_MS, sendOurs, testedLine } from "./reach.mjs";

const ASK = "reach-ask.json";
const answerFile = (home, id) => join(home, `reach-${id}.json`);
const ID = /^[a-z0-9]{8,32}$/;
const keyOf = (m) => `${m.method} ${m.path}`;

// `status()`: status's data, or null. `runner()`: the app's record while it is up and not restarting.
// `stampOf(row)`: what the row's file is now, so an edit to it sends the row again.
export function makeAutoReach({ status, runner, origin, signIn, stampOf, say, fetchImpl = fetch }) {
  const sent = new Map();
  let n = 0;
  const next = () => ++n;
  // `ask`: the agent's call, { paths }: sent whatever was sent before, and answered with each line.
  return async function round(ask = null) {
    const here = runner();
    const down = notUp(here);
    if (down) return { text: `${down} Nothing was sent.\nnext: status`, settled: false };
    const d = await status();
    if (!d) return { text: "Cortad did not answer with the list of endpoints. Nothing was sent.\nnext: status", settled: false };
    const pick = picked(d.contact, here.receipts, ask?.paths);
    const due = pick.sent.filter((m) => !m.excluded && (ask || sent.get(keyOf(m)) !== stampOf(m)));
    for (const m of due) sent.set(keyOf(m), stampOf(m));
    const answers = due.length ? await sendOurs(due, { runner: here, origin: origin(), signIn, next, fetchImpl }) : [];
    // An app restarting under a request is no answer of the endpoint's: it is sent again next round.
    due.forEach((m, i) => { if (answers[i].down) sent.delete(keyOf(m)); });
    if (answers.length) say(testedLine(answers));
    return { text: reachText({ ...pick, sent: due }, answers, `${here.port}, one at a time`), settled: d.read?.complete !== false };
  };
}

// The agent's side: the ask is left for the connect command, and its answer waited on.
export async function askReach(home, paths, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = REACH_MS } = {}) {
  const id = Math.random().toString(36).slice(2, 12).padEnd(8, "0");
  const tmp = join(home, `${ASK}.${id}`);
  writeFileSync(tmp, JSON.stringify({ id, paths: Array.isArray(paths) ? paths.filter((p) => typeof p === "string").slice(0, 50) : [] }), { mode: 0o600 });
  renameSync(tmp, join(home, ASK));
  const file = answerFile(home, id);
  for (const end = Date.now() + waitMs; Date.now() < end; await sleep(250)) {
    if (!existsSync(file)) continue;
    try { const { text } = JSON.parse(readFileSync(file, "utf8")); rmSync(file, { force: true }); return { text }; } catch { /* still being written */ }
  }
  return { text: `The requests are still being sent after ${waitMs / 1000} seconds; the connect command prints each batch as it ends.\nnext: status` };
}

// The connect command's side: the agent's ask, taken once, and its answer left where the agent waits.
export function takeAsk(home) {
  const file = join(home, ASK);
  if (!existsSync(file)) return null;
  let ask = null;
  try { ask = JSON.parse(readFileSync(file, "utf8")); } catch { /* half-written asks are not taken */ return null; }
  rmSync(file, { force: true });
  return ID.test(String(ask?.id)) ? { id: ask.id, paths: Array.isArray(ask.paths) ? ask.paths.filter((p) => typeof p === "string") : [] } : null;
}
export const answerAsk = (home, id, text) => {
  const tmp = `${answerFile(home, id)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ text }), { mode: 0o600 });
  renameSync(tmp, answerFile(home, id));
};
