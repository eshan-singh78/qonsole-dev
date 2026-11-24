// Remote integration test. Each machine runs its native game and the launcher's
// room, local game adapters, and encrypted Internet invite transport.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { Games, freePort } from "../desktop/games.mjs";
import { Room, newCode } from "../desktop/room.mjs";
import { hostLan } from "../desktop/lan.mjs";

const config = JSON.parse(await fs.readFile("config.json", "utf8"));
const role = config.role;
const exe = (name) =>
  path.resolve("bin", name + (process.platform === "win32" ? ".exe" : ""));
const resources = {
  tekken: exe("openkumite"),
  tekkenAssets: path.resolve("Tekken3/assets"),
  road: exe("net-bots"),
  roadAssets: path.resolve("RoadRash/ROADRASH"),
  daemon: path.resolve("bin/room-core.wasm"),
};
async function read(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw Error("Coordination read failed with HTTP " + res.status);
  return res.json();
}
async function write(url, data) {
  const res = await fetch(url, {
    method: "PUT",
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw Error("Coordination write failed with HTTP " + res.status);
}
async function until(check, description, seconds = 100, wait = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await delay(wait);
  }
  throw Error("Timed out waiting for " + description);
}
const privateDetails = /https?:\/\/\S+|(?:node|endpoint)[a-z2-7]{40,}/g;
function safe(message) {
  return String(message).replace(privateDetails, "[private]").slice(-1600);
}
let state, self, room, listener, connection, tunnel, round, active;
const children = new Set();
function pipe(args) {
  const child = spawn(exe("dumbpipe"), args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      output = (output + b).slice(-10000);
    });
  return { child, output: () => output };
}
function send(msg) {
  if (room) room.receive("host", msg);
  else if (connection?.readyState === 1) connection.send(JSON.stringify(msg));
}
class AutomatedGames extends Games {
  async child(file, args, opts, match) {
    if (match.game === "road" && file === resources.road) {
      const host = this.owner;
      const url = args[args.indexOf("--net-server") + 1];
      args = [
        "--url",
        url,
        "--disc",
        resources.roadAssets,
        "--clients",
        "1",
        "--seats",
        String(round.players.length),
        "--first",
        String(round.players.indexOf(role)),
        host ? "--host-alias" : "--join-alias",
        "QONSOLE",
        "--native-platform",
        "--no-udp",
        "--ticks",
        "600",
        "--timeout",
        "150",
      ];
    } else if (match.game === "tekken") {
      const keys = [];
      for (let frame = 120; frame < 2200; frame += 70) {
        if (this.owner && frame < 1100) keys.push(frame + ":start");
        keys.push(frame + 20 + ":b1");
      }
      if (process.platform === "win32") {
        opts.env.VK_DRIVER_FILES = path.resolve("bin/vk_swiftshader_icd.json");
        opts.env.VK_ICD_FILENAMES = opts.env.VK_DRIVER_FILES;
      }
      args.push(
        "--windowed",
        "--resolution",
        "640x480",
        "--render-scale",
        "0.5",
        "--mute",
        "--hash-log",
        "30",
        "--keys",
        keys.join(","),
        "--quit-after",
        "4000",
      );
    }
    return super.child(file, args, opts, match);
  }
}
const games = new AutomatedGames((e) => {
  if (e.type === "packet" || e.type === "raceCode") send(e);
});
function receive(msg) {
  if (msg.type === "packet") {
    games.input(msg.match, msg.from, msg.bytes).catch(() => {});
    return;
  }
  if (msg.type !== "state") return;
  self = msg.self;
  state = msg.state;
  if (active)
    games.members(
      state.members
        .filter((m) => m.match === active.id && m.id !== self)
        .map((m) => m.id),
    );
}
async function connect() {
  if (role === "linux") {
    const code = newCode();
    room = new Room(code, role, (id, msg) =>
      id === "host" ? receive(msg) : listener.send(id, msg),
    );
    listener = await hostLan(
      code,
      (ev) => {
        if (ev.type === "close") room.remove(ev.id);
        else if (ev.type === "message") {
          if (ev.value?.type === "hello") {
            if (!room.add(ev.id, ev.value.name)) listener.drop(ev.id);
          } else room.receive(ev.id, ev.value);
        }
      },
      true,
    );
    room.update();
    tunnel = pipe(["listen-tcp", "--host", "127.0.0.1:" + listener.port]);
    const ticket = await until(
      () => /(?:endpoint|node)[a-z2-7]{40,}(?=\s|$)/.exec(tunnel.output())?.[0],
      "encrypted invite",
      90,
    );
    await write(config.ticketPut, { code, ticket });
  } else {
    const invite = await until(
      () => read(config.ticketGet),
      "host invite",
      360,
      1500,
    );
    const port = await freePort();
    tunnel = pipe([
      "connect-tcp",
      "--addr",
      "127.0.0.1:" + port,
      invite.ticket,
    ]);
    await until(
      async () => {
        const ws = new WebSocket(
          "ws://127.0.0.1:" + port + "/room/" + invite.code,
          { handshakeTimeout: 7000 },
        );
        ws.on("error", () => {});
        try {
          await once(ws, "open");
        } catch {
          ws.terminate();
          return false;
        }
        connection = ws;
        ws.on("message", (b) => receive(JSON.parse(b)));
        return true;
      },
      "Internet connection",
      120,
      500,
    );
    connection.send(JSON.stringify({ type: "hello", name: role, version: 1 }));
  }
  await until(() => state?.members.some((m) => m.name === role), "room roster");
}
async function play(plan) {
  const n = plan.n;
  round = plan;
  if (active) send({ type: "leaveMatch" });
  active = null;
  games.stop();
  if (!plan.players.includes(role)) return { n, stage: "observing" };
  await until(
    () => plan.players.every((p) => state?.members.some((m) => m.name === p)),
    "cross-platform roster",
    160,
  );
  const dir = path.resolve("round-" + n);
  await fs.mkdir(dir, { recursive: true });
  const host = role === plan.players[0];
  if (host) {
    await until(
      () => !state.members.find((m) => m.id === self)?.match,
      "previous session to close",
    );
    send({ type: "start", game: plan.game });
  } else {
    const target = await until(
      () =>
        state.matches.find(
          (m) =>
            m.game === plan.game &&
            state.members.some(
              (p) => p.id === m.host && p.name === plan.players[0],
            ) &&
            (plan.game !== "road" || m.raceCode),
        ),
      "host match",
    );
    send({ type: "join", match: target.id });
  }
  const mine = await until(
    () =>
      state.matches.find(
        (m) => m.id === state.members.find((p) => p.id === self)?.match,
      ),
    "match seat",
  );
  active = mine;
  const launched = games.start(
    { ...resources, savePath: dir },
    mine,
    host,
    role,
  );
  games.members(
    state.members
      .filter((m) => m.match === mine.id && m.id !== self)
      .map((m) => m.id),
  );
  await launched;
  const log = path.join(
    dir,
    path.basename(plan.game === "tekken" ? resources.tekken : resources.road) +
      ".log",
  );
  const summary = await until(
    async () => {
      const body = await fs.readFile(log, "utf8").catch(() => "");
      if (plan.game === "road") {
        const found = /confirmed 600 hash (\d+)/.exec(body);
        if (found && body.includes("official cutoff results"))
          return { hash: found[1], ticks: 600 };
      } else {
        const found = /online: match (\d+) \(2 players\), seed (\d+)/.exec(
          body,
        );
        if (
          found &&
          /netplay: Synchronized/.test(body) &&
          !/desync at frame/.test(body)
        )
          return { match: found[1], seed: found[2] };
      }
      if (!games.match) throw Error("Native game exited. " + safe(body));
      return false;
    },
    "native " + plan.game + " result",
    170,
    350,
  ).catch(async (err) => {
    const logTail = await fs.readFile(log, "utf8").catch(() => "");
    throw Error(safe(err.message + " " + logTail));
  });
  return {
    n,
    stage: "passed",
    game: plan.game,
    players: plan.players,
    ...summary,
  };
}
try {
  await write(config.ready, {
    stage: "connecting",
    platform: process.platform,
    arch: process.arch,
  });
  await connect();
  await write(config.ready, {
    stage: "joined",
    platform: process.platform,
    arch: process.arch,
  });
  let last = 0;
  while (true) {
    const plan = await read(config.plan);
    if (plan?.game === "stop") break;
    if (plan && plan.n > last) {
      last = plan.n;
      let result;
      try {
        result = await play(plan);
      } catch (err) {
        result = { n: last, stage: "failed", message: safe(err.message) };
      }
      await write(config.report, result);
      console.log(role, JSON.stringify(result));
      if (active) {
        await until(
          async () => {
            const values = await Promise.all(
              plan.players.map((p) => read(config.peers[p])),
            );
            return (
              values.every((v) => v?.n === last) ||
              (await read(config.plan))?.n !== last
            );
          },
          "other player results",
          180,
          1300,
        ).catch(() => {});
        send({ type: "leaveMatch" });
        active = null;
        games.stop();
      }
    }
    await delay(1200);
  }
} catch (err) {
  await write(config.ready, {
    stage: "failed",
    message: safe(err.message),
  }).catch(() => {});
  process.exitCode = 1;
} finally {
  games.stop();
  connection?.terminate();
  listener?.close();
  for (const child of children) child.kill();
}
