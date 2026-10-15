// What the site's Worker does for /api on cortad.com, for a backend on this machine: the request goes
// on with /api taken off the front of its path and the origin secret the backend checks (read from
// ORIGIN_SECRET). Usage: ORIGIN_SECRET=... node front.mjs <listen port> <backend port>
import { createServer, request } from "node:http";

const [listen, backend] = process.argv.slice(2).map(Number);
createServer((req, res) => {
  const path = req.url.startsWith("/api/") ? req.url.slice(4) : req.url;
  const out = request({ host: "127.0.0.1", port: backend, method: req.method, path, headers: { ...req.headers, host: `127.0.0.1:${backend}`, "x-brainsless-origin": process.env.ORIGIN_SECRET ?? "" } }, (back) => {
    res.writeHead(back.statusCode ?? 502, back.headers);
    back.pipe(res);
  });
  out.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(out);
}).listen(listen, "127.0.0.1");
