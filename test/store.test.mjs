import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "../desktop/store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "qonsole-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archives = new Map();
  async function archive(name, directory, files) {
    const folder = path.join(root, directory);
    await fs.mkdir(folder);
    for (const file of files)
      await fs.writeFile(path.join(folder, file), "fixture");
    const output = path.join(root, name);
    execFileSync("tar", ["-czf", output, "-C", root, directory]);
    const bytes = await fs.readFile(output);
    archives.set(name, bytes);
    return {
      file: name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const engine = await archive("engine.tgz", "engine", [
    "rr-game",
    "room-core.wasm",
  ]);
  const data = await archive("data.tgz", "assets", ["ROADRASH.EXE"]);
  const game = { platforms: { "linux-x64": engine }, data };
  const settings = {
    manifest: { release: "test", games: { road: game, tekken: game } },
    fetcher: async (url) =>
      new Response(archives.get(new URL(url).pathname.split("/").pop())),
  };
  return {
    make: (extra = {}) =>
      new Store(root, "linux-x64", { ...settings, ...extra }),
    root,
    archives,
  };
}

test("Store downloads only on install, persists offline, and removes only its game files", async (t) => {
  const { make, root } = await fixture(t);
  const store = make();
  assert.equal(store.list()[1].installed, false);
  await store.install("road");
  const saved = path.join(root, "Saves");
  await fs.mkdir(saved);
  await fs.writeFile(path.join(saved, "career"), "round 3");
  const offline = make({
    fetcher: () => {
      throw Error("offline");
    },
  });
  await offline.install("road");
  assert.equal(offline.list()[1].managed, true);
  const local = {
    ...offline.paths("road"),
    road: path.join(root, "engine/rr-game"),
    roadAssets: path.join(root, "assets"),
  };
  await offline.remove("road");
  assert.equal(offline.list(local)[1].installed, true);
  assert.equal(offline.list(local)[1].managed, false);
  assert.equal(
    await fs.readFile(path.join(saved, "career"), "utf8"),
    "round 3",
  );
});

test("A bad checksum keeps the library clean and the game can be retried", async (t) => {
  const { make, archives } = await fixture(t);
  const original = archives.get("data.tgz");
  const store = make();
  archives.set("data.tgz", Buffer.alloc(original.length));
  await assert.rejects(store.install("road"), /verification failed/);
  assert.deepEqual(await fs.readdir(store.root), []);
  archives.set("data.tgz", original);
  await store.install("road");
  assert.ok(store.paths("road").daemon);
  await assert.rejects(store.install("../elsewhere"), /Unknown Store game/);
});

test("An interrupted download can be canceled without exposing a partial install", async (t) => {
  const { make } = await fixture(t);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const store = make({
    fetcher: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const pending = store.install("road");
  await ready;
  await assert.rejects(store.install("road"), /already/);
  store.cancel("road");
  await assert.rejects(pending, /canceled/);
  assert.deepEqual(await fs.readdir(store.root), []);
});
