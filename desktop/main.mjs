import { app, BrowserWindow, ipcMain, dialog, clipboard } from "electron";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { hostLan, findLan } from "./lan.mjs";
import { validCode, playerName } from "./room.mjs";
import { Games, freePort } from "./games.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const win = process.platform === "win32";
const outer = app.isPackaged
  ? path.dirname(
      process.platform === "darwin"
        ? path.resolve(process.execPath, "../../..")
        : process.execPath,
    )
  : path.join(root, ".runtime");
const data = process.env.QONSOLE_PROFILE || path.join(outer, "Qonsole Data");
try {
  fs.mkdirSync(data, { recursive: true });
  app.setPath("userData", data);
} catch {
  /* A read-only volume uses the normal per-user desktop profile. */
}
const profile = app.getPath("userData");
const settingsFile = path.join(profile, "game-files.json");
let prefs = {};
try {
  prefs = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
} catch {}
const arch = process.platform + "-" + process.arch;
const bundled = app.isPackaged
  ? path.join(app.getAppPath(), "native")
  : path.join(root, ".runtime/native", arch);
const bin = (folder, name) => path.join(folder, name + (win ? ".exe" : ""));
const tekkenPath =
  process.platform === "darwin"
    ? path.join(bundled, "tekken/OpenKumite.app/Contents/MacOS/openkumite")
    : bin(path.join(bundled, "tekken"), "openkumite");
const networkBin = bin(path.join(bundled, "network"), "dumbpipe");
const existing = (...paths) => paths.find((p) => p && fs.existsSync(p)) || "";
function config() {
  const personal = path.join(outer, "Games");
  return {
    tekken: existing(tekkenPath),
    savePath: path.join(profile, "Saves"),
    tekkenAssets: existing(
      prefs.tekkenAssets,
      path.join(personal, "Tekken3/assets"),
      !app.isPackaged &&
        path.join(root, ".runtime/tekken/openkumite-v0.5.1-web/assets"),
    ),
    road: existing(
      prefs.road,
      bin(path.join(personal, "RoadRash"), "rr-game"),
      !app.isPackaged &&
        bin(path.join(root, ".runtime/native-road-static"), "rr-game"),
      !app.isPackaged &&
        bin(path.join(root, ".runtime/native-road"), "rr-game"),
    ),
    daemon: existing(
      prefs.daemon,
      path.join(personal, "RoadRash/room-core.wasm"),
      !app.isPackaged && path.join(root, ".runtime/road-room.wasm"),
      bin(path.join(personal, "RoadRash"), "rr-netd"),
      !app.isPackaged &&
        bin(path.join(root, ".runtime/native-road/server"), "rr-netd"),
    ),
    roadAssets: existing(
      prefs.roadAssets,
      path.join(personal, "RoadRash/ROADRASH"),
      !app.isPackaged && path.join(root, ".runtime/road-disc/files/ROADRASH"),
    ),
  };
}
let window,
  lan,
  guest,
  tunnel,
  generation = 0;
function emit(type, value) {
  if (window && !window.isDestroyed())
    window.webContents.send("q:event", { type, value });
}
const games = new Games((e) => emit("game", e));
function stopLinks() {
  generation++;
  guest?.terminate();
  guest = null;
  tunnel?.kill();
  tunnel = null;
  lan?.close();
  lan = null;
}
function pipe(args, whenOutput, epoch) {
  if (!fs.existsSync(networkBin))
    throw Error("Internet relay helper is missing from this installation.");
  const child = spawn(networkBin, args, {
    cwd: profile,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  tunnel = child;
  let output = "";
  const read = (b) => {
    if (generation === epoch) {
      output = (output + b.toString()).slice(-12000);
      whenOutput(output);
    }
  };
  child.stderr.on("data", read);
  child.stdout.on("data", read);
  child.on("error", (e) => {
    if (generation === epoch)
      emit("networkError", "Relay helper: " + e.message);
  });
  child.on("exit", () => {
    if (generation === epoch)
      emit(
        "networkError",
        "Relay helper stopped. Reopen the room to generate a new relay invite.",
      );
  });
}
async function connectWs(host, port, code, epoch, attempts) {
  for (let i = 0; i < attempts && generation === epoch; i++) {
    const ws = new WebSocket("ws://" + host + ":" + port + "/room/" + code, {
      handshakeTimeout: 8000,
      perMessageDeflate: false,
      maxPayload: 100000,
    });
    ws.on("error", () => {});
    try {
      await once(ws, "open");
    } catch (e) {
      ws.terminate();
      if (i + 1 === attempts) throw e;
      await delay(200);
      continue;
    }
    if (generation !== epoch) {
      ws.terminate();
      throw Error("Connection cancelled.");
    }
    guest = ws;
    ws.on("message", (b) => {
      try {
        emit("wire", { type: "message", id: "upstream", value: JSON.parse(b) });
      } catch {
        ws.terminate();
      }
    });
    ws.on("close", () => {
      if (generation === epoch) emit("wire", { type: "close", id: "upstream" });
    });
    return;
  }
  throw Error("Connection cancelled.");
}
function handle(name, fn) {
  ipcMain.handle("q:" + name, (e, ...args) => {
    if (
      e.sender !== window?.webContents ||
      e.senderFrame !== window.webContents.mainFrame
    )
      throw Error("Unknown window.");
    return fn(...args);
  });
}
handle("files", config);
handle("choose", async (key) => {
  if (!["tekkenAssets", "road", "daemon", "roadAssets"].includes(key))
    throw Error("Unknown file selection.");
  const folder = key.endsWith("Assets");
  const choice = await dialog.showOpenDialog(window, {
    properties: [folder ? "openDirectory" : "openFile"],
    title: folder ? "Choose game data folder" : "Choose native executable",
  });
  if (!choice.canceled) {
    let file = choice.filePaths[0];
    if (
      key === "tekkenAssets" &&
      !fs.existsSync(path.join(file, "manifest.json"))
    )
      throw Error("Select the converted folder containing manifest.json.");
    if (key === "roadAssets" && !fs.existsSync(path.join(file, "ROADRASH.EXE")))
      throw Error("Select the folder containing ROADRASH.EXE.");
    if (!folder && file.endsWith(".app")) {
      const executables = fs.readdirSync(path.join(file, "Contents/MacOS"));
      file = path.join(file, "Contents/MacOS", executables[0]);
    }
    prefs[key] = file;
    fs.writeFileSync(settingsFile, JSON.stringify(prefs));
  }
  return config();
});
handle("host", async (code, internet) => {
  stopLinks();
  const epoch = generation;
  const server = await hostLan(
    code,
    (e) => {
      if (generation === epoch) emit("wire", e);
    },
    internet === true,
  );
  if (generation !== epoch) {
    server.close();
    throw Error("Room closed.");
  }
  lan = server;
  if (internet) {
    let sent = false;
    pipe(
      ["listen-tcp", "--host", "127.0.0.1:" + lan.port],
      (s) => {
        const m = /(?:endpoint|node)[a-z2-7]{40,}(?=\s|$)/.exec(s);
        if (m && !sent) {
          sent = true;
          emit("relayInvite", "QR1." + code + "." + m[0]);
        }
      },
      epoch,
    );
  }
  return { port: lan.port, addresses: lan.addresses };
});
handle("join", async (invite) => {
  stopLinks();
  const epoch = generation;
  if (typeof invite !== "string" || invite.length > 5000)
    throw Error("Invalid invite.");
  const ticket =
    /^QR1\.([A-HJ-NP-Z2-9]{10})\.((?:endpoint|node)[a-z2-7]{40,4000})$/.exec(
      invite,
    );
  if (ticket) {
    const port = await freePort();
    pipe(
      ["connect-tcp", "--addr", "127.0.0.1:" + port, ticket[2]],
      () => {},
      epoch,
    );
    await connectWs("127.0.0.1", port, ticket[1], epoch, 50);
    return ticket[1];
  }
  let host, port, code;
  if (validCode(invite)) {
    code = invite;
    ({ host, port } = await findLan(code));
  } else {
    const direct =
      /^qonsole:\/\/([\w.-]+):(\d{1,5})\/([A-HJ-NP-Z2-9]{10})$/i.exec(invite);
    if (!direct || +direct[2] < 1 || +direct[2] > 65535)
      throw Error("Invalid direct invite.");
    [, host, port, code] = direct;
    code = code.toUpperCase();
  }
  await connectWs(host, port, code, epoch, 1);
  return code;
});
handle("leave", () => {
  stopLinks();
  games.stop();
});
handle("wire", (id, msg) => {
  if (JSON.stringify(msg).length > 100000) return;
  if (id === "upstream") {
    if (guest?.readyState === 1 && guest.bufferedAmount < 1024 * 1024)
      guest.send(JSON.stringify(msg));
  } else lan?.send(id, msg);
});
handle("drop", (id) => lan?.drop(id));
handle("copy", (value) => {
  if (typeof value === "string" && value.length < 6000)
    clipboard.writeText(value);
});
handle("play", async (match, owner, name) => {
  if (
    !match ||
    typeof match.id !== "string" ||
    !["road", "tekken"].includes(match.game)
  )
    throw Error("Unknown game.");
  const cfg = config();
  fs.mkdirSync(cfg.savePath, { recursive: true });
  await games.start(cfg, match, owner === true, playerName(name));
});
handle("members", (ids) => {
  if (Array.isArray(ids) && ids.length <= 16) games.members(ids);
});
handle("packet", (match, from, bytes) => games.input(match, from, bytes));
handle("stop", () => games.stop());
app.whenReady().then(() => {
  window = new BrowserWindow({
    title: "Qonsole",
    width: 1030,
    height: 760,
    minWidth: 640,
    minHeight: 570,
    backgroundColor: "#111615",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("render-process-gone", () => {
    stopLinks();
    games.stop();
  });
  window.loadFile(path.join(here, "index.html"));
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  stopLinks();
  games.stop();
});
