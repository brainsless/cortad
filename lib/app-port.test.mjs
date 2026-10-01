import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { notAnApp, withoutStores } from "./app-port.mjs";

// AI Answers' npm run dev starts an in-memory MongoDB, the Express server and Vite; after a restart
// the run followed MongoDB's port.
test("a database answering an HTTP probe is not the app, and its address in the log is not the app's port", async () => {
  // What MongoDB actually answers a plain HTTP GET with, read off a socket the way fetch reads it.
  const mongo = createServer((s) => s.once("data", () => s.end("HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nIt looks like you are trying to access MongoDB over HTTP on the native driver port.\r\n"))).listen(0, "127.0.0.1");
  await new Promise((r) => mongo.once("listening", r));
  try {
    const head = await (await fetch(`http://127.0.0.1:${mongo.address().port}/`)).text();
    assert.equal(notAnApp(head), true);
  } finally { mongo.close(); }
  assert.equal(notAnApp("<!doctype html><title>AI Answers</title>"), false);
  assert.equal(notAnApp('{"status":"ok"}'), false);
  const log = "In-memory MongoDB started at: mongodb://127.0.0.1:52011/\nStarting server on port: 60809\n  Local: http://localhost:4101/\nredis://127.0.0.1:6391/0 connected";
  const said = [...withoutStores(log).matchAll(/(?:localhost|127\.0\.0\.1):(\d{2,5})\b|\bport\s*[:=]?\s*(\d{4,5})\b/gi)].map((m) => Number(m[1] || m[2]));
  assert.deepEqual(said, [60809, 4101]);
});
