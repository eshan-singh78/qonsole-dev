import http from "node:http";
import { networkInterfaces } from "node:os";
import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { validCode } from "./room.mjs";

const discoveryPort = 43627;
const ips = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a.family === "IPv4" && !a.internal);
const send = (socket, msg, port, host) =>
  socket.send(Buffer.from(msg), port, host, () => {});
export async function hostLan(code, onEvent, internet = false) {
  if (!validCode(code)) throw Error("Invalid room code.");
  const server = http.createServer((req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 100000,
    perMessageDeflate: false,
  });
  const sockets = new Map();
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/room/" + code || sockets.size >= 16 || req.headers.origin)
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = randomUUID();
      sockets.set(id, ws);
      onEvent({ type: "open", id });
      ws.on("error", () => ws.terminate());
      ws.on("message", (raw) => {
        try {
          onEvent({ type: "message", id, value: JSON.parse(raw) });
        } catch {
          ws.terminate();
        }
      });
      ws.on("close", () => {
        sockets.delete(id);
        onEvent({ type: "close", id });
      });
    });
  });
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(0, internet ? "127.0.0.1" : "0.0.0.0", ok);
  });
  const port = server.address().port;
  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("error", () => {}); // Explicit invites also work when discovery is blocked.
  udp.on("message", (buf, r) => {
    if (buf.toString() === "QONSOLE/1 FIND " + code)
      send(udp, "QONSOLE/1 FOUND " + code + " " + port, r.port, r.address);
  });
  if (!internet) udp.bind(discoveryPort);
  return {
    port,
    addresses: ips().map((a) => a.address),
    send(id, msg) {
      const ws = sockets.get(id);
      if (ws?.readyState === 1 && ws.bufferedAmount < 1024 * 1024)
        ws.send(JSON.stringify(msg));
    },
    drop(id) {
      sockets.get(id)?.terminate();
    },
    close() {
      try {
        udp.close();
      } catch {}
      for (const socket of sockets.values()) socket.terminate();
      wss.close();
      server.close();
    },
  };
}
export function findLan(code) {
  if (!validCode(code)) throw Error("Invalid room code.");
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => finish(null), 1300);
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (value) resolve(value);
      else
        reject(
          Error(
            "Room not found on this LAN. Paste the host’s direct invite or choose Internet.",
          ),
        );
    }
    socket.on("error", () => finish(null));
    socket.on("message", (bytes, r) => {
      const m = /^QONSOLE\/1 FOUND ([A-Z2-9]+) (\d+)$/.exec(bytes.toString());
      if (m && m[1] === code && +m[2] > 0 && +m[2] <= 65535)
        finish({ host: r.address, port: +m[2] });
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const host of [
        "127.0.0.1",
        "255.255.255.255",
        ...ips().map((a) =>
          a.address
            .split(".")
            .map((n, i) => +n | (255 ^ +a.netmask.split(".")[i]))
            .join("."),
        ),
      ])
        send(socket, "QONSOLE/1 FIND " + code, discoveryPort, host);
    });
  });
}
