// Drive the release UI on independent machines. The private exchange only
// passes invitations and test acknowledgements, as a friend would in chat.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright-core";

const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
const run = GITHUB_RUN_ID + "-" + GITHUB_RUN_ATTEMPT;
const platform = process.platform;
const peers = ["win32", "darwin"];
const mailbox = JSON.parse(process.env.QONSOLE_ROOM_TEST_MAILBOX);
delete process.env.QONSOLE_ROOM_TEST_MAILBOX;
const appPath = {
  linux: "Qonsole-linux-x64/Qonsole",
  darwin: "Qonsole-darwin-arm64/Qonsole.app/Contents/MacOS/Qonsole",
  win32: "Qonsole-win32-x64/Qonsole.exe",
}[platform];
const profile = await mkdtemp(path.join(tmpdir(), "qonsole-room-"));
let app;
async function send(key, value) {
  const res = await fetch(mailbox[key].put, {
    method: "PUT",
    body: JSON.stringify({ run, ...value }),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(res.ok, "Failed to publish test acknowledgement");
}
async function poll(key, phase, seconds = 900) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(mailbox[key].get, {
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const object = await res.json();
      if (object.run === run && object.phase === phase) return object;
    } else if (![403, 404].includes(res.status))
      throw Error("Exchange returned HTTP " + res.status);
    await delay(1500);
  }
  throw Error("Timed out waiting for " + key + " " + phase);
}
try {
  app = await electron.launch({
    executablePath: path.resolve("dist", appPath),
    args: platform === "linux" ? ["--no-sandbox"] : [],
    env: { ...process.env, QONSOLE_PROFILE: profile },
    timeout: 45000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => typeof document.querySelector("#host")?.onclick === "function",
  );
  await page.locator("#name").fill(platform);
  await page.locator("#transport").selectOption("internet");
  // Hosted operating systems can start several minutes apart.
  if (platform === "linux") {
    await Promise.all(peers.map((p) => poll(p, "ready")));
  } else {
    await send(platform, { phase: "ready" });
  }
  for (const phase of ["code", "invite"]) {
    assert.equal(await page.locator("#name").inputValue(), platform);
    if (platform === "linux") {
      await page.locator("#host").click();
      assert.equal(
        await page
          .locator("#members li")
          .first()
          .evaluate((li) => li.firstChild.textContent),
        "linux (you)",
      );
      await page
        .locator(phase === "code" ? "#copy-code" : "#copy-invite")
        .click({ timeout: 60000 });
      await page.waitForFunction(() =>
        document.querySelector("#status").textContent.includes("copied"),
      );
      const invite = await app.evaluate(({ clipboard }) =>
        clipboard.readText(),
      );
      assert.match(
        invite,
        phase === "code" ? /^[A-Z2-9]{5}-[A-Z2-9]{5}$/ : /^QR1\./,
      );
      await send("host", { phase, invite });
      await Promise.all(peers.map((p) => poll(p, phase)));
      await page.waitForFunction(
        () => document.querySelectorAll("#members li").length === 3,
      );
      console.log(
        "Linux, Windows and macOS share the packaged room using",
        phase,
      );
      await page.locator("#leave").click();
      await Promise.all(peers.map((p) => poll(p, phase + "-closed")));
    } else {
      const { invite } = await poll("host", phase);
      await page.locator("#invite").fill(invite);
      await page.locator("#join button").click();
      await page
        .locator("#lobby")
        .waitFor({ state: "visible", timeout: 45000 })
        .catch(async () => {
          throw Error(
            "Join via " +
              phase +
              " failed: " +
              (await page.locator("#status").innerText()),
          );
        });
      console.log(platform, "joined the host using", phase);
      await page.waitForFunction(
        () => document.querySelectorAll("#members li").length === 3,
        null,
        { timeout: 90000 },
      );
      const names = await page
        .locator("#members li")
        .evaluateAll((items) =>
          items
            .map((item) => item.firstChild.textContent.replace(/ \(you\)$/, ""))
            .sort(),
        );
      assert.deepEqual(names, ["darwin", "linux", "win32"]);
      await send(platform, { phase });
      await page.locator("#home").waitFor({ state: "visible", timeout: 60000 });
      await send(platform, { phase: phase + "-closed" });
      console.log(
        platform,
        "joined via",
        phase,
        "and returned when the host left",
      );
    }
  }
} finally {
  await app?.close();
  await rm(profile, { force: true, recursive: true, maxRetries: 3 });
}
