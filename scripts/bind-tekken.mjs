import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtime = fileURLToPath(new URL("../.runtime/", import.meta.url));
const engine = path.join(runtime, "tekken/openkumite-v0.5.1-web");
const pkg = path.join(engine, "pkg");
const target = path.join(engine, "assets");
const sources = process.argv.slice(2);

function read(fd, at, buffer) {
  if (fs.readSync(fd, buffer, 0, buffer.length, at) !== buffer.length)
    throw Error("Unexpected end of file");
}

function write(fd, at, buffer) {
  if (fs.writeSync(fd, buffer, 0, buffer.length, at) !== buffer.length)
    throw Error("Incomplete write");
}

async function bind() {
  if (!sources.length) throw Error("Supply the Tekken 3 archive or the CUE and all its BIN tracks.");
  if (!fs.existsSync(pkg)) throw Error("Install the engine with python3 scripts/setup.py tekken first.");
  const converter = await import(pathToFileURL(path.join(pkg, "kumite_convert_web.js")));
  const staging = fs.mkdtempSync(path.join(runtime, "tekken-bind-"));
  const descriptors = [];
  function open(file, mode) {
    const fd = fs.openSync(file, mode);
    descriptors.push(fd);
    return fd;
  }
  try {
    const inputs = sources.map(file => open(file, "r"));
    // These stores implement OpenKumite's convert_worker.js interface on the host filesystem.
    const stores = Array.from({ length: 11 }, (_, i) => open(path.join(staging, String(i)), "w+"));
    Object.assign(globalThis, {
      okc_input_name: id => path.basename(sources[id]),
      okc_input_size: id => fs.fstatSync(inputs[id]).size,
      okc_input_read: (id, at, buf) => read(inputs[id], at, buf),
      okc_store_read: (id, at, buf) => read(stores[id], at, buf),
      okc_store_write: (id, at, buf) => write(stores[id], at, buf),
      okc_store_size: id => fs.fstatSync(stores[id]).size,
      okc_store_truncate: (id, len) => fs.ftruncateSync(stores[id], len),
      okc_store_flush: id => fs.fsyncSync(stores[id]),
      okc_log: console.log,
      okc_panic: console.error,
    });
    await converter.default({ module_or_path: fs.readFileSync(path.join(pkg, "kumite_convert_web_bg.wasm")) });
    const files = sources.map((file, id) => [path.basename(file), id]);
    const result = JSON.parse(converter.run(JSON.stringify({
      job: "convert", part: "t3", files, now: new Date().toISOString(),
    })));
    if (!result.t3 || !result.fingerprint) throw Error("The converter did not recognize a complete Tekken 3 disc.");
    const manifest = path.join(target, "manifest.json");
    if (fs.existsSync(manifest)) {
      if (JSON.parse(fs.readFileSync(manifest)).fingerprint !== result.fingerprint)
        throw Error("This installation already has different Tekken data.");
      console.log("This Tekken 3 disc is already bound.");
      return;
    }
    const assets = path.join(staging, "assets");
    fs.mkdirSync(assets);
    const index = JSON.parse(fs.readFileSync(path.join(staging, "1")));
    if (index.version !== 1 || !Object.hasOwn(index.files, "manifest.json"))
      throw Error("The converted pack has no usable index or manifest.");
    const packSize = fs.fstatSync(stores[0]).size;
    const buffer = Buffer.alloc(1024 * 1024);
    for (const [name, [offset, size]] of Object.entries(index.files)) {
      const file = path.resolve(assets, name);
      if (!file.startsWith(assets + path.sep) || !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > packSize)
        throw Error("Invalid converted pack entry: " + name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const output = fs.openSync(file, "wx");
      try {
        for (let pos = 0; pos < size; pos += buffer.length) {
          const chunk = buffer.subarray(0, Math.min(buffer.length, size - pos));
          read(stores[0], offset + pos, chunk);
          write(output, pos, chunk);
        }
      } finally {
        fs.closeSync(output);
      }
    }
    if (JSON.parse(fs.readFileSync(path.join(assets, "manifest.json"))).fingerprint !== result.fingerprint)
      throw Error("The unpacked manifest differs from the converted disc.");
    fs.renameSync(assets, target);
    console.log("Bound Tekken 3 to this installation. Fingerprint " + result.fingerprint);
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

bind().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
