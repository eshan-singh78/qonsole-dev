import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { matchbox } from "./signaling.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, ".runtime");
const mounts = [
  ["/engines/tekken/", path.join(runtime, "tekken/openkumite-v0.5.1-web")],
  ["/engines/road/", path.join(runtime, "road")],
  ["/", path.join(root, "public")],
];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".avi": "video/x-msvideo",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};
function plain(res, status, message) {
  res
    .writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
    .end(message);
}

export function iceServers(env) {
  const servers = [];
  if (env.STUN_URL !== "")
    servers.push({ urls: env.STUN_URL || "stun:stun.cloudflare.com:3478" });
  if (env.TURN_URLS && env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:${randomUUID()}`;
    servers.push({
      urls: env.TURN_URLS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      username,
      credential: createHmac("sha1", env.TURN_SECRET)
        .update(username)
        .digest("base64"),
    });
  }
  return servers;
}

export function createPlayer(env = process.env) {
  const signaling = matchbox();
  const roadWs = Number(env.RR_NETD_PORT || 18080);
  const roadHealth = Number(env.RR_NETD_HTTP_PORT || 18081);
  async function handle(req, res) {
    try {
      if (!["GET", "HEAD"].includes(req.method))
        return plain(res, 405, "Use GET or HEAD.");
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      if (
        pathname.includes("\\") ||
        pathname.includes("\0") ||
        pathname.split("/").includes("..")
      )
        return plain(res, 400, "Invalid path");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "same-origin");
      if (pathname === "/net/health") {
        const response = await fetch(
          `http://127.0.0.1:${roadHealth}/net/health`,
          { signal: AbortSignal.timeout(2000) },
        );
        res
          .writeHead(response.status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(await response.text());
        return;
      }
      if (pathname === "/rtc-config.js") {
        res.writeHead(200, {
          "Content-Type": "text/javascript",
          "Cache-Control": "no-store",
        });
        res.end(
          `globalThis.qonsoleIceServers = ${JSON.stringify(iceServers(env))};`,
        );
        return;
      }
      const [prefix, dir] = mounts.find(([prefix]) =>
        pathname.startsWith(prefix),
      );
      let relative = pathname.slice(prefix.length);
      if (/^\/play\/(tekken|road)$/.test(pathname)) relative = "player.html";
      if (!relative || relative.endsWith("/")) relative += "index.html";
      const target = path.resolve(dir, relative);
      if (!target.startsWith(dir + path.sep))
        return plain(res, 404, "File not found");
      const info = await stat(target);
      if (!info.isFile()) return plain(res, 404, "File not found");
      let range;
      if (pathname.startsWith("/engines/tekken/assets/")) {
        res.setHeader("Accept-Ranges", "bytes");
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
        if (req.method === "GET" && match && (match[1] || match[2])) {
          const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
          const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
          if (start > end) {
            res.writeHead(416, { "Content-Range": "bytes */" + info.size }).end();
            return;
          }
          range = { start, end };
          res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
        }
      }
      res.writeHead(range ? 206 : 200, {
        "Content-Type": mime[path.extname(target)] || "application/octet-stream",
        "Content-Length": range ? range.end - range.start + 1 : info.size,
      });
      if (req.method === "HEAD") return res.end();
      const stream = createReadStream(target, range);
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      if (error instanceof URIError) return plain(res, 400, "Invalid path");
      if (error.code === "ENOENT" || error.code === "ENOTDIR")
        return plain(res, 404, "File not found");
      if (req.url === "/net/health")
        return plain(res, 503, "Road Rash server unavailable");
      plain(res, 500, "Request failed");
    }
  }
  if (Boolean(env.TLS_CERT) !== Boolean(env.TLS_KEY))
    throw Error("Supply both TLS_CERT and TLS_KEY.");
  const server = env.TLS_CERT
    ? https.createServer(
        { cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) },
        handle,
      )
    : http.createServer(handle);
  server.on("close", () => signaling.close());
  server.on("upgrade", (req, socket, head) => {
    try {
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      )
        return socket.destroy();
      const pathname = new URL(req.url, "http://localhost").pathname;
      const match = /^\/signal\/([A-Z2-9]{1,16})$/.exec(pathname);
      if (match) return signaling.upgrade(req, socket, head, match[1]);
      if (
        pathname !== "/net" ||
        req.headers.upgrade?.toLowerCase() !== "websocket"
      )
        return socket.destroy();
      // rr-netd owns the binary game protocol and room lifecycle.
      const upstream = net.connect(roadWs, "127.0.0.1");
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("connect", () => {
        const headers = req.rawHeaders.reduce(
          (lines, item, i, all) =>
            i % 2 ? lines : lines + item + ": " + all[i + 1] + "\r\n",
          "",
        );
        upstream.write("GET /net HTTP/1.1\r\n" + headers + "\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    } catch {
      socket.destroy();
    }
  });
  return server;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const binary = path.join(runtime, "netd/rr-netd");
  const gameFiles = [
    binary,
    path.join(mounts[0][1], "pkg/openkumite_bg.wasm"),
    path.join(mounts[1][1], "rr-game.wasm"),
  ];
  if (!gameFiles.every(existsSync))
    throw Error("Game engines are missing. Run npm run setup first.");
  const server = createPlayer();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  const daemon = spawn(binary, [], {
    cwd: runtime,
    stdio: "inherit",
    env: {
      ...process.env,
      RR_NETD_BIND: "127.0.0.1",
      RR_NETD_PORT: process.env.RR_NETD_PORT || "18080",
      RR_NETD_HTTP_PORT: process.env.RR_NETD_HTTP_PORT || "18081",
    },
  });
  process.on("exit", () => daemon.kill());
  daemon.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  daemon.on("exit", (code) => {
    console.error("Road Rash server stopped.");
    process.exit(code || 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => process.exit(0));
  server.listen(port, host, () =>
    console.log(
      `Qonsole: ${process.env.TLS_CERT ? "https" : "http"}://${host}:${server.address().port}`,
    ),
  );
}
