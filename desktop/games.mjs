import dgram from "node:dgram";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { setTimeout as pause } from "node:timers/promises";

import { startRoadServer } from "./road-server.mjs";

const loopback = "127.0.0.1";
export async function freePort() {
  const s = net.createServer();
  s.listen(0, loopback);
  await once(s, "listening");
  const port = s.address().port;
  await new Promise((done) => s.close(done));
  return port;
}
async function udpSocket() {
  const s = dgram.createSocket("udp4");
  s.bind(0, loopback);
  await once(s, "listening");
  return s;
}
export class Games {
  constructor(event) {
    this.event = event;
    this.endpoints = new Map();
    this.children = new Set();
  }
  async child(exe, args, opts, match) {
    const logPath = path.join(opts.cwd, path.basename(exe) + ".log");
    const log = fs.openSync(logPath, "w");
    let child;
    try {
      child = spawn(exe, args, {
        ...opts,
        windowsHide: false,
        stdio: ["ignore", log, log],
      });
    } finally {
      fs.closeSync(log);
    }
    this.children.add(child);
    child.once("exit", (code) => {
      this.children.delete(child);
      if (this.match === match) {
        this.stop();
        this.event({
          type: "exit",
          match: match.id,
          error: code
            ? "Game exited with code " + code + ". See " + logPath
            : "",
        });
      }
    });
    try {
      await once(child, "spawn");
    } catch (err) {
      this.children.delete(child);
      throw err;
    }
    if (this.match !== match) {
      child.kill();
      throw Error("Match closed.");
    }
  }
  async start(config, match, owner, name) {
    if (this.match) throw Error("Close the running game first.");
    this.match = match;
    this.owner = owner;
    this.allowed = new Set();
    const opts = {
      cwd: config.savePath,
      env: { ...process.env, OPENKUMITE_SAVE_DIR: config.savePath },
    };
    const args = [];
    try {
      if (match.game === "tekken") {
        if (!config.tekken) throw Error("OpenKumite executable is missing.");
        if (config.tekkenAssets) args.push("--assets", config.tekkenAssets);
        if (!match.solo) {
          const socket = await udpSocket();
          if (this.match !== match) {
            socket.close();
            throw Error("Match closed.");
          }
          this.port = socket.address().port;
          if (owner) {
            await new Promise((done) => socket.close(done));
            args.push("--host", String(this.port));
          } else {
            this.local = socket;
            socket.on("message", (buf, r) => {
              if (r.address !== loopback) return;
              this.clientPort = r.port;
              this.packet(match.host, buf);
            });
            socket.on("error", () => {});
            args.push("--join", loopback + ":" + this.port);
          }
          args.push("--name", name);
        }
        await this.child(config.tekken, args, opts, match);
      } else {
        if (!config.road)
          throw Error(
            "Choose your native Road Rash executable in Game files first.",
          );
        if (config.roadAssets) args.push("--assets", config.roadAssets);
        if (!match.solo) {
          if (owner) {
            if (!config.daemon)
              throw Error(
                "Choose the Road Rash room server in Game files first.",
              );
            if (config.daemon.endsWith(".wasm")) {
              const server = await startRoadServer(config.daemon);
              if (this.match !== match) {
                server.close();
                throw Error("Match closed.");
              }
              this.portableServer = server;
              this.port = server.port;
            } else {
              this.port = await freePort();
              const health = await freePort();
              await this.child(
                config.daemon,
                [],
                {
                  ...opts,
                  env: {
                    ...opts.env,
                    RR_NETD_BIND: loopback,
                    RR_NETD_PORT: String(this.port),
                    RR_NETD_HTTP_PORT: String(health),
                    RR_NETD_RTC: "0",
                  },
                },
                match,
              );
              let ready = false;
              for (let i = 0; i < 60 && this.match === match; i++) {
                try {
                  ready = (
                    await fetch("http://127.0.0.1:" + health + "/net/health", {
                      signal: AbortSignal.timeout(300),
                    })
                  ).ok;
                } catch {}
                if (ready) break;
                await pause(80);
              }
              if (!ready) throw Error("The local race server could not start.");
            }
          }
          const proxy = new WebSocketServer({
            host: loopback,
            port: 0,
            maxPayload: 65536,
            perMessageDeflate: false,
          });
          this.proxy = proxy;
          await once(proxy, "listening");
          if (this.match !== match) {
            proxy.close();
            throw Error("Match closed.");
          }
          proxy.on("connection", (native, req) => {
            if (
              req.url !== "/net" ||
              req.headers.origin ||
              this.native?.readyState === 1
            )
              return native.terminate();
            this.native = native;
            native.on("error", () => {});
            if (owner) {
              const backend = this.roadEndpoint("self");
              native.on("message", (bytes) => this.sendRoad(backend, bytes));
              native.on("close", () => this.remove("self"));
            } else {
              native.on("message", (bytes) => this.packet(match.host, bytes));
              native.on("close", () =>
                this.packet(match.host, Buffer.alloc(0)),
              );
            }
          });
          args.push(
            "--net-server",
            "ws://127.0.0.1:" + proxy.address().port + "/net",
          );
          if (!owner && match.raceCode) args.push("--room", match.raceCode);
        }
        await this.child(config.road, args, opts, match);
      }
    } catch (err) {
      if (this.match === match) this.stop();
      throw err;
    }
  }
  packet(to, bytes) {
    if (this.match)
      this.event({
        type: "packet",
        to,
        match: this.match.id,
        bytes: bytes.toString("base64"),
      });
  }
  members(ids) {
    this.allowed = new Set(ids);
    for (const id of this.endpoints.keys())
      if (id !== "self" && !this.allowed.has(id)) this.remove(id);
  }
  roadEndpoint(id) {
    const ws = new WebSocket("ws://127.0.0.1:" + this.port + "/net", {
      perMessageDeflate: false,
      maxPayload: 65536,
    });
    const endpoint = { ws, queue: [] };
    this.endpoints.set(id, endpoint);
    ws.on("open", () => {
      for (const buf of endpoint.queue) ws.send(buf);
      endpoint.queue.length = 0;
    });
    ws.on("error", () => {});
    ws.on("message", (bytes) => {
      if (id !== "self") return this.packet(id, bytes);
      if (bytes[0] === 9 && bytes[1] === 6) {
        const code = bytes.subarray(2, 8).toString();
        if (code !== this.raceCode) {
          this.raceCode = code;
          this.event({ type: "raceCode", code });
        }
      }
      if (this.native?.readyState === 1) this.native.send(bytes);
    });
    ws.on("close", () => {
      if (this.endpoints.get(id) !== endpoint) return;
      this.endpoints.delete(id);
      if (id === "self") this.native?.terminate();
      else this.packet(id, Buffer.alloc(0));
    });
    return endpoint;
  }
  sendRoad(ep, bytes) {
    if (ep.ws.readyState === 1) ep.ws.send(bytes);
    else if (ep.ws.readyState === 0 && ep.queue.length < 32)
      ep.queue.push(bytes);
  }
  async input(matchId, from, data) {
    const match = this.match;
    if (
      !match ||
      match.id !== matchId ||
      !this.allowed?.has(from) ||
      typeof data !== "string" ||
      data.length > 90000
    )
      return;
    const buf = Buffer.from(data, "base64");
    if (match.game === "road") {
      if (!buf.length) {
        if (this.owner) this.remove(from);
        else this.native?.terminate();
        return;
      }
      if (this.owner)
        this.sendRoad(this.endpoints.get(from) || this.roadEndpoint(from), buf);
      else if (this.native?.readyState === 1) this.native.send(buf);
      return;
    }
    if (!buf.length || buf.length > 65507) return;
    if (this.owner) {
      let ep = this.endpoints.get(from);
      if (!ep) {
        ep = { pending: udpSocket() };
        this.endpoints.set(from, ep);
        const s = await ep.pending;
        if (this.match !== match || this.endpoints.get(from) !== ep) {
          s.close();
          return;
        }
        ep.socket = s;
        s.on("message", (bytes, r) => {
          if (r.address === loopback && r.port === this.port)
            this.packet(from, bytes);
        });
        s.on("error", () => {});
      }
      const socket = await ep.pending;
      if (this.match === match && this.endpoints.get(from) === ep)
        socket.send(buf, this.port, loopback, () => {});
    } else if (this.clientPort && this.local)
      this.local.send(buf, this.clientPort, loopback, () => {});
  }
  remove(id) {
    const ep = this.endpoints.get(id);
    this.endpoints.delete(id);
    ep?.socket?.close();
    ep?.ws?.terminate();
  }
  stop() {
    this.match = null;
    for (const c of this.children) c.kill();
    this.children.clear();
    for (const id of [...this.endpoints.keys()]) this.remove(id);
    this.native?.terminate();
    this.proxy?.close();
    this.local?.close();
    this.portableServer?.close();
    this.portableServer = null;
    this.native = null;
    this.proxy = null;
    this.local = null;
    this.clientPort = null;
    this.raceCode = "";
  }
}
