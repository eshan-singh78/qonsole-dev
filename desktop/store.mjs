import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const disk = fs.promises;
const unpack = promisify(execFile);
const catalog = JSON.parse(
  fs.readFileSync(new URL("./store-catalog.json", import.meta.url)),
);
const release =
  "https://github.com/eshan-singh78/qonsole-builds/releases/download/" +
  catalog.release +
  "/";
const ids = ["tekken", "road"];

export function gamePaths(game, target, dir) {
  const win = target === "win32-x64";
  if (game === "tekken") {
    const exe =
      target === "darwin-arm64"
        ? "OpenKumite.app/Contents/MacOS/openkumite"
        : win
          ? "openkumite.exe"
          : "openkumite";
    return {
      tekken: path.join(dir, "engine", exe),
      tekkenAssets: path.join(dir, "assets"),
    };
  }
  return {
    road: path.join(dir, "engine", win ? "rr-game.exe" : "rr-game"),
    daemon: path.join(dir, "engine/room-core.wasm"),
    roadAssets: path.join(dir, "assets"),
  };
}

function playable(game, paths) {
  const required =
    game === "tekken"
      ? [
          paths.tekken,
          paths.tekkenAssets && path.join(paths.tekkenAssets, "manifest.json"),
        ]
      : [
          paths.road,
          paths.roadAssets && path.join(paths.roadAssets, "ROADRASH.EXE"),
        ];
  return required.every(
    (file) => file && fs.statSync(file, { throwIfNoEntry: false })?.isFile(),
  );
}

export class Store {
  constructor(
    profile,
    target,
    { fetcher = fetch, onChange = () => {}, manifest = catalog } = {},
  ) {
    this.root = path.join(profile, "Library");
    this.target = target;
    this.fetcher = fetcher;
    this.onChange = onChange;
    this.manifest = manifest;
    this.active = new Map();
    fs.mkdirSync(this.root, { recursive: true });
  }

  // Called once after obtaining exclusive ownership of this profile.
  async cleanStaging() {
    for (const name of await disk.readdir(this.root))
      if (/^\.partial-[\da-f-]{36}$/.test(name))
        await disk.rm(path.join(this.root, name), {
          recursive: true,
          force: true,
        });
  }

  dir(id) {
    if (!ids.includes(id)) throw Error("Unknown Store game.");
    return path.join(this.root, id + "-" + this.target);
  }

  paths(id) {
    const dir = this.dir(id);
    const files = gamePaths(id, this.target, dir);
    if (!fs.existsSync(path.join(dir, ".complete")) || !playable(id, files))
      return {};
    if (id === "road" && !fs.existsSync(files.daemon)) return {};
    return files;
  }

  list(local = {}) {
    return ids.map((id) => {
      const build = this.manifest.games[id];
      const engine = build.platforms[this.target];
      const managed = Boolean(this.paths(id)[id]);
      return {
        id,
        managed,
        installed: managed || playable(id, local),
        supported: Boolean(engine),
        total: engine ? engine.size + build.data.size : 0,
        progress: this.active.get(id)?.progress || null,
      };
    });
  }

  async download(asset, archive, controller, advance) {
    const hash = createHash("sha256");
    let count = 0,
      timer;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(Error("Download timed out. Try again.")),
        90000,
      );
      timer.unref();
    };
    watch();
    try {
      const response = await this.fetcher(release + asset.file, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw Error(
          "Download returned HTTP " + response.status + ". Try again.",
        );
      const meter = new Transform({
        transform(chunk, _encoding, next) {
          count += chunk.length;
          if (count > asset.size)
            return next(Error("Download exceeded its published size."));
          watch();
          hash.update(chunk);
          advance(chunk.length);
          next(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        fs.createWriteStream(archive, { flags: "wx" }),
        { signal: controller.signal },
      );
      if (count !== asset.size || hash.digest("hex") !== asset.sha256)
        throw Error("Download verification failed. Try installing again.");
    } finally {
      clearTimeout(timer);
    }
  }

  async install(id) {
    const dest = this.dir(id);
    if (this.active.has(id))
      throw Error("This game already has an installation in progress.");
    if (this.paths(id)[id]) return;
    const build = this.manifest.games[id],
      engine = build.platforms[this.target];
    if (!engine) throw Error("This platform has no compatible release.");
    const controller = new AbortController();
    const progress = {
      phase: "Downloading",
      bytes: 0,
      total: engine.size + build.data.size,
    };
    this.active.set(id, { controller, progress });
    const staging = path.join(this.root, ".partial-" + randomUUID());
    const files = path.join(staging, "files"),
      archive = path.join(staging, "download.tar.gz");
    let last = 0;
    try {
      this.onChange();
      await disk.mkdir(files, { recursive: true });
      for (const asset of [engine, build.data]) {
        progress.phase = "Downloading";
        this.onChange();
        await this.download(asset, archive, controller, (bytes) => {
          progress.bytes += bytes;
          if (Date.now() - last >= 200) {
            this.onChange();
            last = Date.now();
          }
        });
        progress.phase = "Installing";
        this.onChange();
        // Only unpack bytes matching the bundled catalog. The publisher writes regular files.
        const tar =
          process.platform === "win32"
            ? path.join(process.env.SystemRoot, "System32/tar.exe")
            : "/usr/bin/tar";
        await unpack(tar, ["-xzf", archive, "-C", files], {
          signal: controller.signal,
          windowsHide: true,
        });
        await disk.unlink(archive);
      }
      const paths = gamePaths(id, this.target, files);
      if (
        !playable(id, paths) ||
        (id === "road" && !fs.existsSync(paths.daemon))
      )
        throw Error("The downloaded build is incomplete.");
      await disk.writeFile(
        path.join(files, ".complete"),
        this.manifest.release,
      );
      controller.signal.throwIfAborted();
      // A valid installation returned above. Replace any previously damaged bundle only now.
      if (fs.existsSync(dest))
        await disk.rename(dest, path.join(staging, "damaged"));
      await disk.rename(files, dest);
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      try {
        await disk.rm(staging, { recursive: true, force: true, maxRetries: 3 });
      } finally {
        this.active.delete(id);
        this.onChange();
      }
    }
  }

  cancel(id) {
    this.dir(id);
    this.active.get(id)?.controller.abort(Error("Download canceled."));
  }

  async remove(id) {
    const dir = this.dir(id);
    if (this.active.has(id))
      throw Error("Finish or cancel the download first.");
    if (!this.paths(id)[id]) return;
    const old = path.join(this.root, ".partial-" + randomUUID());
    await disk.rename(dir, old);
    this.onChange();
    await disk.rm(old, { recursive: true, force: true, maxRetries: 3 });
  }
}
