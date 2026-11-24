import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createPlayer } from "../server.mjs";

import { startRoadServer } from "../desktop/road-server.mjs";

const wasmPath = fileURLToPath(new URL("../.runtime/road-room.wasm", import.meta.url));
const daemonPath = fileURLToPath(
  new URL("../.runtime/netd/rr-netd", import.meta.url),
);

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Protocol v1 uses a type byte followed by little-endian fields.
async function rider(url, alias, t) {
  const socket = new WebSocket(url);
  const inbox = [];
  socket.on("message", (bytes) => inbox.push(bytes));
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  async function read(type) {
    for (let i = 0; i < 150; i++) {
      const at = inbox.findIndex((frame) => frame[0] === type);
      if (at !== -1) return inbox.splice(at, 1)[0];
      await delay(40);
    }
    throw Error(`Rider ${alias} timed out waiting for message ${type}`);
  }
  await once(socket, "open");
  const hello = Buffer.concat([
    Buffer.from([1, 1, 0]),
    Buffer.alloc(40),
    Buffer.from([3, alias.length]),
    Buffer.from(alias),
    Buffer.from([0]),
  ]);
  socket.send(hello);
  await read(2); // Welcome
  return { read, send: (bytes) => socket.send(Buffer.from(bytes)) };
}

test(
  "Road Rash serves a shared race and returns both riders' first inputs",
  {
    skip: !existsSync(daemonPath) && "Build rr-netd with npm run setup first",
    timeout: 20000,
  },
  async (t) => {
    const wsPort = await availablePort();
    let healthPort = await availablePort();
    while (wsPort === healthPort) healthPort = await availablePort();
    const env = {
      RR_NETD_PORT: String(wsPort),
      RR_NETD_HTTP_PORT: String(healthPort),
      RR_NETD_BIND: "127.0.0.1",
    };
    const daemon = spawn(daemonPath, [], {
      env: { ...process.env, ...env },
      cwd: await mkdtemp(join(tmpdir(), "qonsole-race-")),
      stdio: "ignore",
    });
    const server = createPlayer(env);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      daemon.kill();
      server.closeAllConnections();
      server.close();
    });
    const origin = "127.0.0.1:" + server.address().port;
    const health = () => fetch("http://" + origin + "/net/health");
    for (let i = 0; i < 50; i++) {
      if ((await health()).ok) break;
      await delay(50);
    }
    const endpoint = "ws://" + origin + "/net";
    await verifyRace(endpoint, t);
  },
);


async function verifyRace(endpoint, t) {
  const host = await rider(endpoint, "ALPHA", t);
  const guest = await rider(endpoint, "BRAVO", t);
  host.send([4, 0, 2, 1, 1]); // Create a public race
  const state = await host.read(9);
  const code = state.subarray(2, 8);
  guest.send([5, 6, ...code, 0]);
  const guestState = await guest.read(9);
  assert.deepEqual(guestState.subarray(2, 8), code);
  assert.equal(guestState[14], 1); // Second seat
  host.send([10, 1]);
  guest.send([10, 2]); // Pick riders
  host.send([11, 4]);
  guest.send([11, 4]); // Vote for the same track
  const [startA, startB] = await Promise.all([host.read(14), guest.read(14)]);
  assert.deepEqual(startA.subarray(1, 10), startB.subarray(1, 10)); // Race ID, seed, course
  host.send([18, 0, 0, 0, 0, 1, 8, 0]);
  guest.send([18, 0, 0, 0, 0, 1, 4, 0]);
  const [a, b] = await Promise.all([host.read(19), guest.read(19)]);
  assert.deepEqual(a.subarray(7, 14), b.subarray(7, 14));
  assert.deepEqual([...a.subarray(7, 14)], [2, 3, 0, 8, 0, 4, 0]); // Seats, present mask, late mask, inputs
}

test("portable race core seats both riders and agrees on the input frame", {
  skip: !existsSync(wasmPath) && "Build the personal room core first",
  timeout: 15000,
}, async t => {
  const core = await startRoadServer(wasmPath);
  t.after(() => core.close());
  await verifyRace("ws://127.0.0.1:" + core.port + "/net", t);
});
