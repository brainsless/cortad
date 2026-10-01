// What one session keeps out of the run's way and brings up for it: the app's database files and
// servers, copied before it starts (lib/data.mjs, lib/stores.mjs), and the stores and services it
// reaches, started when nothing answers there (lib/backing.mjs). Every sentence goes to the terminal
// and, through lines(), to the run: what trials write into for real first.
import { createHash } from "node:crypto";
import { localAddresses, makeBacking, tcpOpen } from "./backing.mjs";
import { keepData } from "./data.mjs";
import { bypassedOf, isStorePort, onThisMachine, storeId, storeKeeper, storesOf, unnamedLines } from "./stores.mjs";

// A line that opens with a setting's name keeps its case: "nEXT_PUBLIC_SUPABASE_URL" was printed.
const lower = (line) => (/^[A-Z][A-Z0-9_]/.test(line) ? line : line.charAt(0).toLowerCase() + line.slice(1));
// A store at a network address; a socket path, or no host at all, is Postgres's own socket.
const addressed = (s) => Boolean(s.host) && !s.host.startsWith("/") && Boolean(s.port);
// One nothing answers at is left for later: trials cannot write into it.
const isDown = async (s) => addressed(s) && !(await tcpOpen(s.host, s.port));
// The stores the settings name on this machine, as ports to bring up; a compose image may serve them.
const localStores = (k) => k.stores.filter((s) => addressed(s) && onThisMachine(s.host)).map((s) => ({ port: s.port, names: s.names, store: true }));
// The API keeps eight stores that hold Run. Past that, the rest travel as one row, and a yes to that
// row is a yes to each of them; a row more changes its id, so an old yes no longer covers it.
const BLOCKED_MAX = 8;
const overflow = (blocked) => blocked.slice(BLOCKED_MAX - 1);
// How a service on this machine that answers nothing is named to the API: by its port, never an address.
const downId = (port) => createHash("sha256").update(`down:${port}`).digest("hex").slice(0, 16);
const overflowId = (rest) => createHash("sha256").update(rest.map((b) => b.id).join()).digest("hex").slice(0, 16);
function blockedRows(blocked) {
  const rows = blocked.map(({ port: _port, ...b }) => ({ ...b, why: b.why.slice(0, 400) }));
  if (rows.length <= BLOCKED_MAX) return rows;
  const rest = overflow(rows);
  const names = [...new Set(rest.flatMap((b) => b.names))].slice(0, 8);
  return [...rows.slice(0, BLOCKED_MAX - 1), { id: overflowId(rest), names, why: `These ${rest.length} stores hold Run too. ${rest[0].why}`.slice(0, 400) }];
}

// settings(): the environment the app starts with, the env file each name came from, the app's
// folder and its source files. launch(plan): a service of the repository started the way the app
// is. connections(): what the hook saw the app reach. hold(): the run's requests wait from here until
// the caller has the app on the copies made, since until then it still writes into the originals.
export function makeKeeping({ root, work, ledgerFile, onPath, say, settings, launch, connections, hold = () => {} }) {
  let pending = null;
  let now = null;
  let backing = null;
  let backedUp = false;
  let seen = 0;
  const told = new Set();
  const tell = (lines) => { for (const line of lines) say(lower(line)); };
  const held = (blocked) => tell(blocked.map((b) => `Run waits until this is fixed: ${lower(b.why)}`));

  async function keepAll(started) {
    const { values, from, appDir, sources } = settings();
    const disk = keepData({ values, from, appDir, root, work, sources, started });
    const stores = storesOf(disk.values);
    const keeper = storeKeeper({ ledgerFile, values: disk.values, dirs: [...new Set([appDir, root])] });
    const got = await keeper.keep(stores, { started, down: isDown });
    backing ??= makeBacking({ root, appDir, values: disk.values, onPath, ledgerFile, launch, adopt: started });
    now = { env: { ...disk.env, ...got.env }, risks: got.risks, notes: [...disk.said, ...got.copies], blocked: got.blocked, pass: got.pass, stores, keeper, values: disk.values, started };
    tell([...now.risks, ...now.notes]);
    held(now.blocked);
    return now;
  }
  // A read that failed is tried again on the next ask, never handed back as the same failure.
  const once = (started) => (pending ??= keepAll(started).catch((e) => { pending = null; throw e; }));

  // Brings up what is wanted, copies each store that now answers, and says both.
  async function bringUp(wants) {
    const k = await once(true);
    hold();
    const up = await backing.up(wants);
    const got = await k.keeper.keep(k.stores, { started: k.started, down: isDown });
    Object.assign(k.env, got.env);
    k.risks.unshift(...got.risks);
    // Said once: every look brings the same lines back, and status printed one hold four times.
    k.notes.push(...[...up.lines, ...got.copies].filter((l) => !k.notes.includes(l)));
    // A service a setting names that answers nothing holds Run until it does; one that answers now
    // lets go. ai-appointment-setter's only free run played with its knowledge base down.
    const checked = new Set(wants.map((w) => w.port));
    const stillDown = new Set(up.down.map((d) => d.port));
    for (let i = k.blocked.length - 1; i >= 0; i--) if (k.blocked[i].down && checked.has(k.blocked[i].port) && !stillDown.has(k.blocked[i].port)) k.blocked.splice(i, 1);
    for (const d of up.down) if (!k.blocked.some((b) => b.down && b.port === d.port)) k.blocked.push({ id: downId(d.port), names: d.names, why: d.why, down: true, port: d.port });
    k.blocked.push(...got.blocked.filter((b) => !k.blocked.some((x) => x.id === b.id)));
    k.pass.push(...got.pass);
    const said = [...got.risks, ...up.lines, ...got.copies];
    tell(said);
    held(got.blocked);
    return { changed: said.length > 0 || got.blocked.length > 0, came: up.ports.length > 0, copied: Object.keys(got.env).length > 0 };
  }
  // Ports on this machine the hook saw the app reach. A compose image serves only a store's port: a
  // model server behind a compose file is gigabytes nobody asked for.
  const reached = (appPort) => connections().filter((c) => onThisMachine(c.host) && c.port !== appPort).map((c) => ({ port: c.port, store: isStorePort(c.port) }));

  return {
    // The settings the app starts with: the copies it runs against.
    env: async (started) => (await once(started)).env,
    // The copies so far, for a service of the repository started beside the app.
    envNow: () => now?.env ?? {},
    // What trials write into for real first; the API keeps eight sentences of 400 characters.
    lines: async (started) => { const k = await once(started); return [...k.risks, ...k.notes].map((l) => l.slice(0, 400)).slice(0, 8); },
    // The stores off this machine no copy could be made of: each holds Run until the person says yes.
    blocked: async (started) => blockedRows((await once(started)).blocked),
    // The hosts a trial's writes may reach: the copies made off this machine, and the hosts and
    // stores the person said yes to (setup.consent). Before the copies are made, or after the app
    // was attached to instead, only the hosts.
    outbound: ({ hosts = [], stores = [] } = {}) => {
      if (!now) return [...new Set(hosts)];
      const yes = new Set(stores);
      const rest = now.blocked.length > BLOCKED_MAX ? overflow(now.blocked) : [];
      if (rest.length && yes.has(overflowId(rest))) for (const b of rest) yes.add(b.id);
      return [...new Set([...hosts, ...now.pass, ...now.stores.filter((s) => yes.has(storeId(s)) && !onThisMachine(s.host)).map((s) => String(s.host).toLowerCase())])];
    },
    // The app stopped before it answered: each store its settings name and each port it reached that
    // is down is brought up, once. True when the app is worth starting again.
    async backUp(appPort) {
      if (backedUp) return false;
      backedUp = true;
      const k = await once(true);
      const got = await bringUp([...localStores(k), ...reached(appPort)]);
      return got.came || got.copied;
    },
    // The app answers: each store and service its settings name on this machine that nothing
    // answers at is brought up, since an app that connects on first use starts without them.
    // `copied` says the app has copies it was not started on.
    async services(appPort) {
      const k = await once(true);
      return bringUp([...localStores(k), ...localAddresses(k.values)].filter((a) => a.port !== appPort));
    },
    // What the app reached since the last look. A live store no setting names is said, what is down
    // is brought up, and `copied` says the app has copies it was not started on.
    async watch(appPort) {
      const conns = connections();
      // A service that held Run and answers now lets go without a reconnect: the person started
      // Supabase, and the hold stood until they disconnected and connected again.
      const heldDown = now?.blocked.filter((b) => b.down) ?? [];
      const cameUp = [];
      for (const b of heldDown) if (await tcpOpen("127.0.0.1", b.port)) cameUp.push({ port: b.port, names: b.names });
      if (cameUp.length) { const got = await bringUp(cameUp); if (!pending || conns.length === seen) return { changed: true, copied: got.copied }; }
      if (!pending || conns.length === seen) return { changed: false, copied: false };
      seen = conns.length;
      const k = await pending;
      const live = [];
      for (const c of conns) if (!onThisMachine(c.host) || (await tcpOpen(c.host, c.port))) live.push(c);
      const fresh = unnamedLines(live, k.stores, told);
      k.risks.push(...fresh);
      tell(fresh);
      const bypassed = bypassedOf(live, k.stores, k.blocked);
      k.blocked.push(...bypassed);
      held(bypassed);
      const got = await bringUp(reached(appPort));
      return { changed: fresh.length > 0 || bypassed.length > 0 || got.changed, copied: got.copied };
    },
    // An app attached to instead of started keeps its own connections: its copies are of no use.
    async forget() {
      const k = await pending;
      pending = null;
      now = null;
      await k?.keeper.drop();
    },
    // Once the app has stopped: a copy is dropped when nothing holds it open, and a store is stopped
    // only after its copy is gone.
    async close() {
      await (await pending?.catch(() => null))?.keeper.drop().catch(() => {});
      await backing?.stop().catch(() => {});
    },
  };
}
