import { readFile } from "node:fs/promises";
import { randomFillSync, randomInt } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";

const limit = 65536;

export async function startRoadServer(filename) {
  let core;
  const imports = {
    env: { emscripten_notify_memory_growth() {} },
    wasi_snapshot_preview1: {
      clock_time_get(clock, precision, pointer) {
        const value =
          clock === 0 ? BigInt(Date.now()) * 1000000n : process.hrtime.bigint();
        new DataView(core.memory.buffer).setBigUint64(pointer, value, true);
        return 0;
      },
      random_get(pointer, size) {
        randomFillSync(new Uint8Array(core.memory.buffer, pointer, size));
        return 0;
      },
    },
  };
  const { instance } = await WebAssembly.instantiate(
    await readFile(filename),
    imports,
  );
  core = instance.exports;
  core._initialize();
  core.room_init(randomInt(0x7fffffff));
  const pointer = core.malloc(limit);
  const clients = new Map();
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/net",
    maxPayload: limit,
    perMessageDeflate: false,
  });
  await once(server, "listening");
  function advance() {
    core.room_step(performance.now());
    for (const [id, socket] of clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      for (let count = 0; count < 128; count++) {
        const length = core.room_recv(id, pointer, limit);
        if (length < 0 || socket.bufferedAmount > 1024 * 1024) {
          socket.terminate();
          break;
        }
        if (!length) break;
        socket.send(
          Buffer.from(new Uint8Array(core.memory.buffer, pointer, length)),
        );
      }
    }
  }
  server.on("connection", (socket, request) => {
    socket.on("error", () => {});
    if (request.headers.origin || clients.size >= 16) return socket.terminate();
    const id = core.room_open();
    clients.set(id, socket);
    socket.on("close", () => {
      clients.delete(id);
      core.room_close(id);
    });
    socket.on("message", (bytes, binary) => {
      if (!binary || !bytes.length || bytes.length > limit)
        return socket.terminate();
      new Uint8Array(core.memory.buffer, pointer, bytes.length).set(bytes);
      core.room_send(id, pointer, bytes.length);
      advance();
    });
  });
  const timer = setInterval(advance, 8);
  timer.unref();
  return {
    port: server.address().port,
    close() {
      clearInterval(timer);
      for (const socket of clients.values()) socket.terminate();
      server.close();
    },
  };
}
