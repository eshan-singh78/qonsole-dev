import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { packager } from "@electron/packager";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
await fs.mkdir(output, { recursive: true });
const version = JSON.parse(await fs.readFile(path.join(root, "package.json")))
  .devDependencies.electron;
for (const target of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["darwin-arm64", "win32-x64", "linux-x64"]) {
  if (!["darwin-arm64", "win32-x64", "linux-x64"].includes(target))
    throw Error("Unknown target " + target);
  const [platform, arch] = target.split("-");
  const stage = await fs.mkdtemp(path.join(root, ".runtime/package-"));
  const copy = (from, to, options = {}) =>
    fs.cp(path.join(root, from), path.join(stage, to), {
      recursive: true,
      ...options,
    });
  try {
    await copy("desktop", "desktop");
    await copy("node_modules/ws", "node_modules/ws");
    await copy(
      "node_modules/peerjs/dist/peerjs.min.js",
      "node_modules/peerjs/dist/peerjs.min.js",
    );
    const copied = new Set();
    async function notices(pkg) {
      if (copied.has(pkg)) return;
      copied.add(pkg);
      const dir = "node_modules/" + pkg;
      for (const f of await fs.readdir(path.join(root, dir)))
        if (/^(licen[cs]e|notice|copying)/i.test(f))
          await copy(dir + "/" + f, "notices/" + pkg + "/" + f);
      const meta = JSON.parse(
        await fs.readFile(path.join(root, dir, "package.json")),
      );
      for (const dep of Object.keys(meta.dependencies || {}))
        await notices(dep);
    }
    await notices("peerjs");
    await notices("ws");
    await copy(".runtime/native/" + target + "/tekken", "native/tekken", {
      filter: (p) => !/^serve(\.exe)?$/.test(path.basename(p)),
    });
    await copy(".runtime/native/" + target + "/network", "native/network");
    await copy("desktop/notices", "notices/iroh-dumbpipe");
    await fs.writeFile(
      path.join(stage, "package.json"),
      JSON.stringify({
        name: "qonsole",
        productName: "Qonsole",
        version: "0.2.0",
        type: "module",
        main: "desktop/main.mjs",
      }),
    );
    const [dir] = await packager({
      dir: stage,
      name: "Qonsole",
      platform,
      arch,
      out: output,
      overwrite: true,
      appBundleId: "dev.qonsole.player",
      electronVersion: version,
      prune: false,
      asar: false,
      win32metadata: { CompanyName: "Qonsole", ProductName: "Qonsole" },
    });
    const dest = path.join(output, "Qonsole-" + target + ".zip");
    if (platform === "darwin") {
      const bundle = path.join(dir, "Qonsole.app");
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], {
        stdio: "inherit",
      });
      execFileSync("ditto", ["-c", "-k", "--keepParent", bundle, dest]);
    } else if (platform === "linux") {
      const archive = path.join(output, "Qonsole-linux-x64.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", output, path.basename(dir)]);
      console.log(archive);
      continue;
    } else {
      execFileSync(process.platform === "win32" ? "python" : "python3", [
        "-c",
        "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], sys.argv[3])",
        dest.slice(0, -4),
        path.dirname(dir),
        path.basename(dir),
      ]);
    }
    console.log(dest);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
