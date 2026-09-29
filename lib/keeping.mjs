// What one session keeps out of the run's way and brings up for it: the app's database files and
// servers, copied before it starts (lib/data.mjs, lib/stores.mjs), and the stores and services it
// reaches, started when nothing answers there (lib/backing.mjs). Every sentence goes to the terminal
// and, through lines(), to the run: what trials write into for real first.
import { localAddresses, makeBacking, tcpOpen } from "./backing.mjs";
import { keepData } from "./data.mjs";
import { isStorePort, onThisMachine, storeKeeper, storesOf, unnamedLines } from "./stores.mjs";

const lower = (line) => line.charAt(0).toLowerCase() + line.slice(1);
// A store with a network address nothing answers at is left for later: trials cannot write into it.
const isDown = async (s) => Boolean(s.host) && !s.host.startsWith("/") && Boolean(s.port) && !(await tcpOpen(s.host, s.port));

// settings(): the environment the app starts with, the env file each name came from, the app's
// folder and its source files. launch(plan): a service of the repository started the way the app
// is. connections(): what the hook saw the app reach.
export function makeKeeping({ root, work, ledgerFile, onPath, say, settings, launch, connections }) {
  let pending = null;
  let now = null;
  let backing = null;
  let backedUp = false;
  let seen = 0;
  const told = new Set();
  const tell = (lines) => { for (const line of lines) say(lower(line)); };

  async function keepAll(started) {
    const { values, from, appDir, sources } = settings();
    const disk = keepData({ values, from, appDir, root, work, sources, started });
    const stores = storesOf(disk.values);
    const keeper = storeKeeper({ ledgerFile });
    const got = await keeper.keep(stores, { started, down: isDown });
    backing ??= makeBacking({ root, appDir, values: disk.values, onPath, ledgerFile, launch });
    now = { env: { ...disk.env, ...got.env }, risks: got.risks, notes: [...disk.said, ...got.copies], stores, keeper, values: disk.values };
    tell([...now.risks, ...now.notes]);
    return now;
  }
  const once = (started) => (pending ??= keepAll(started));

  // Brings up what is wanted, copies each store that now answers, and says both.
  async function bringUp(wants) {
    const k = await once(true);
    const up = await backing.up(wants);
    const got = await k.keeper.keep(k.stores, { down: isDown });
    Object.assign(k.env, got.env);
    k.risks.unshift(...got.risks);
    k.notes.push(...up.lines, ...got.copies);
    const said = [...got.risks, ...up.lines, ...got.copies];
    tell(said);
    return { changed: said.length > 0, came: up.ports.length > 0, copied: Object.keys(got.env).length > 0 };
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
    // The app stopped before it answered: each store its settings name and each port it reached that
    // is down is brought up, once. True when the app is worth starting again.
    async backUp(appPort) {
      if (backedUp) return false;
      backedUp = true;
      const k = await once(true);
      const named = k.stores.filter((s) => onThisMachine(s.host) && s.port).map((s) => ({ port: s.port, names: s.names, store: true }));
      const got = await bringUp([...named, ...reached(appPort)]);
      return got.came || got.copied;
    },
    // The app answers: a service of the repository its settings call is brought up.
    services: async (appPort) => (await bringUp(localAddresses((await once(true)).values).filter((a) => a.port !== appPort))).changed,
    // What the app reached since the last look. A live store no setting names is said, what is down
    // is brought up, and `copied` says the app has copies it was not started on.
    async watch(appPort) {
      const conns = connections();
      if (!pending || conns.length === seen) return { changed: false, copied: false };
      seen = conns.length;
      const k = await pending;
      const live = [];
      for (const c of conns) if (!onThisMachine(c.host) || (await tcpOpen(c.host, c.port))) live.push(c);
      const fresh = unnamedLines(live, k.stores, told);
      k.risks.push(...fresh);
      tell(fresh);
      const got = await bringUp(reached(appPort));
      return { changed: fresh.length > 0 || got.changed, copied: got.copied };
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
