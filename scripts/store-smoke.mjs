// Exercise the packaged client and the published release using a fresh portable profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
const root = await fs.mkdtemp(path.join(tmpdir(), "qonsole-shop-"));
const exe = {
  darwin: "Qonsole-darwin-arm64/Qonsole.app/Contents/MacOS/Qonsole",
  win32: "Qonsole-win32-x64/Qonsole.exe",
  linux: "Qonsole-linux-x64/Qonsole",
}[process.platform];
let app;
async function launch() {
  app = await electron.launch({
    executablePath: path.resolve("dist", exe),
    env: { ...process.env, QONSOLE_PROFILE: root },
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const page = await app.firstWindow();
  await page.locator("#nav-store").waitFor();
  return page;
}
try {
  let page = await launch();
  await page.locator("#browse-store").click();
  assert.deepEqual(await fs.readdir(path.join(root, "Library")), []);
  await page.locator("#collection").click();
  await page.waitForFunction(
    () => {
      const error = document.querySelector("#status").textContent;
      if (error) throw Error(error);
      return [...document.querySelectorAll(".game-actions .primary")].every(
        (b) => b.textContent === "View in library",
      );
    },
    null,
    { timeout: 12 * 60000 },
  );
  console.log("Both public Store bundles installed and verified.");
  await app.close();
  page = await launch();
  for (const id of ["tekken", "road"]) {
    await page.locator("#solo-" + id).click();
    await page.locator("#solo").waitFor({ state: "visible" });
    await page.locator("#stop-solo").click();
    await page.locator("#home").waitFor({ state: "visible" });
    console.log("Launched installed", id, "from Library after restart.");
  }
  await page
    .locator(".game-card")
    .filter({ has: page.locator("#solo-road") })
    .locator(".remove")
    .click();
  await page.locator('#confirm-remove button[value="remove"]').click();
  await page.locator("#solo-road").waitFor({ state: "hidden" });
  const inventory = await page.evaluate(() => window.qonsole.store());
  assert.ok(inventory.find((entry) => entry.id === "tekken").managed);
  assert.equal(inventory.find((entry) => entry.id === "road").installed, false);
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { force: true, recursive: true, maxRetries: 5 });
}
