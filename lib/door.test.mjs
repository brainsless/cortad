// The door's promises, on a real folder: what it refuses, what it puts back, and what it will not
// overwrite. Run: node --test lib/
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, linkSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDoor } from "./door.mjs";

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "door-root-"));
  const store = mkdtempSync(join(tmpdir(), "door-store-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.txt"), "one\ntwo\n");
  return { root, door: openDoor(root, { store }) };
};
const B = (s) => Buffer.from(s);

test("an edit is put back exactly, mode included, and a new file is removed", () => {
  const { root, door } = fresh();
  chmodSync(join(root, "src/a.txt"), 0o755);
  assert.equal(door.write("src/a.txt", B("one\nTWO\nthree\n"), { checkpoint: "c1" }).success, true);
  assert.equal(door.write("src/new.txt", B("hello\n"), { checkpoint: "c1", exclusive: true }).success, true);
  assert.equal(statSync(join(root, "src/a.txt")).mode & 0o777, 0o755);
  const seen = door.changes();
  assert.deepEqual(seen.files.map((f) => [f.path, f.status, f.added, f.removed, f.conflict]), [["src/a.txt", "modified", 2, 1, false], ["src/new.txt", "added", 1, 0, false]]);
  const out = door.restore("c1");
  assert.deepEqual(out.restored.sort(), ["src/a.txt", "src/new.txt"]);
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "one\ntwo\n");
  assert.equal(statSync(join(root, "src/a.txt")).mode & 0o777, 0o755);
  assert.equal(existsSync(join(root, "src/new.txt")), false);
  assert.equal(door.pending(), 0);
});

test("restoring an earlier checkpoint undoes it and everything after it", () => {
  const { root, door } = fresh();
  door.write("src/a.txt", B("v1\n"), { checkpoint: "c1" });
  door.write("src/a.txt", B("v2\n"), { checkpoint: "c2" });
  door.write("src/b.txt", B("b\n"), { checkpoint: "c2" });
  door.restore("c2");
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "v1\n");
  assert.equal(existsSync(join(root, "src/b.txt")), false);
  door.write("src/a.txt", B("v3\n"), { checkpoint: "c3" });
  door.restore("c1");
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "one\ntwo\n");
});

test("a file they edited afterwards is never overwritten, and stays pending", () => {
  const { root, door } = fresh();
  door.write("src/a.txt", B("sandy\n"), { checkpoint: "c1" });
  writeFileSync(join(root, "src/a.txt"), "sandy\nand my own line\n");
  assert.equal(door.changes().files[0].conflict, true);
  const out = door.restore("c1");
  assert.deepEqual(out.restored, []);
  assert.equal(out.skipped[0].path, "src/a.txt");
  assert.equal(readFileSync(join(root, "src/a.txt"), "utf8"), "sandy\nand my own line\n");
  assert.equal(door.pending(), 1);
});

test("keep lets the way back go", () => {
  const { door } = fresh();
  door.write("src/a.txt", B("kept\n"), { checkpoint: "c1" });
  assert.equal(door.keep().kept, 1);
  assert.equal(door.pending(), 0);
  assert.equal(door.restore("c1").missing, true);
});

test("what is never written", () => {
  const { root, door } = fresh();
  const outside = mkdtempSync(join(tmpdir(), "door-out-"));
  writeFileSync(join(outside, "real.txt"), "theirs\n");
  symlinkSync(outside, join(root, "way-out"));
  symlinkSync(join(root, "src/a.txt"), join(root, "alias.txt"));
  linkSync(join(root, "src/a.txt"), join(root, "hard.txt"));
  mkdirSync(join(root, ".git")); mkdirSync(join(root, "node_modules"));
  for (const path of ["../escape.txt", "/etc/hosts", ".env", ".env.local", "deploy.pem", ".git/config", "node_modules/x.js", "way-out/real.txt", "alias.txt", "hard.txt", "src"]) {
    const res = door.write(path, B("x"), { checkpoint: "c1" });
    assert.equal(res.success, false, `${path} must be refused, got ${JSON.stringify(res)}`);
  }
  assert.equal(readFileSync(join(outside, "real.txt"), "utf8"), "theirs\n");
  assert.equal(door.pending(), 0);
});

test("pending changes survive a new session", () => {
  const root = mkdtempSync(join(tmpdir(), "door-root-"));
  const store = mkdtempSync(join(tmpdir(), "door-store-"));
  writeFileSync(join(root, "a.txt"), "before\n");
  openDoor(root, { store }).write("a.txt", B("after\n"), { checkpoint: "c1" });
  const again = openDoor(root, { store });
  assert.equal(again.pending(), 1);
  again.restore("c1");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "before\n");
});

test("a pending file shows its before and after as one diff", () => {
  const { door } = fresh();
  door.write("src/a.txt", B("one\nTWO\n"), { checkpoint: "c1" });
  door.write("src/a.txt", B("one\nTWO\nthree\n"), { checkpoint: "c2" });
  const out = door.diff("src/a.txt").diff;
  assert.match(out, /^--- a\/src\/a\.txt/m);
  assert.match(out, /^-two$/m);
  assert.match(out, /^\+TWO$/m);
  assert.match(out, /^\+three$/m);
  assert.equal(door.diff("src/none.txt").missing, true);
});

test("another account on the same folder does not see these edits", () => {
  const root = mkdtempSync(join(tmpdir(), "door-root-"));
  const store = mkdtempSync(join(tmpdir(), "door-store-"));
  writeFileSync(join(root, "a.txt"), "before\n");
  openDoor(root, { store, owner: "account-a" }).write("a.txt", B("after\n"), { checkpoint: "c1" });
  assert.equal(openDoor(root, { store, owner: "account-b" }).pending(), 0);
  assert.equal(openDoor(root, { store, owner: "account-a" }).pending(), 1);
});
