import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { createPlayer, iceServers } from "../server.mjs";

const boundManifest = new URL("../.runtime/tekken/openkumite-v0.5.1-web/assets/manifest.json", import.meta.url);
test("a bound Tekken install serves the shared manifest and supports byte-range reads", {
  skip: !existsSync(boundManifest) && "Bind a Tekken 3 disc first",
}, async t => {
  const server = createPlayer({});
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}/engines/tekken/`;
  const url = base + "assets/manifest.json";
  const expected = readFileSync(boundManifest);
  assert.equal((await (await fetch(base + "pkg/config.json")).json()).serverAssets, true);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), expected.length);
  assert.equal((await (await fetch(url)).json()).fingerprint, JSON.parse(expected).fingerprint);
  for (const [range, start, end] of [["0-9", 0, 9], ["-4", expected.length - 4, expected.length - 1]]) {
    const part = await fetch(url, { headers: { Range: "bytes=" + range } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes ${start}-${end}/${expected.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), expected.subarray(start, end + 1));
  }
  const pastEnd = await fetch(url, { headers: { Range: "bytes=" + expected.length + "-" } });
  assert.equal(pastEnd.status, 416);
});

test("Matchbox introduces peers, routes signaling only inside the room and reports departure", async (t) => {
  const server = createPlayer({});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const connect = (code) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/signal/${code}`,
    );
    clients.push(ws);
    return ws;
  };
  const message = async (ws) =>
    JSON.parse(
      (await once(ws, "message", { signal: AbortSignal.timeout(3000) }))[0],
    );
  const host = connect("ABCDE");
  const { IdAssigned: hostId } = await message(host);
  const outsider = connect("FGHJK");
  const { IdAssigned: outsideId } = await message(outsider);
  const joinNotice = message(host);
  const guest = connect("ABCDE");
  const { IdAssigned: guestId } = await message(guest);
  assert.deepEqual(await joinNotice, { NewPeer: guestId });
  outsider.send(
    JSON.stringify({ Signal: { receiver: guestId, data: "outside" } }),
  );
  const offer = message(guest);
  host.send(
    JSON.stringify({
      Signal: { receiver: guestId, data: { Offer: "fixture" } },
    }),
  );
  assert.deepEqual(await offer, {
    Signal: { sender: hostId, data: { Offer: "fixture" } },
  });
  assert.notEqual(hostId, outsideId);
  const departure = message(host);
  guest.close();
  assert.deepEqual(await departure, { PeerLeft: guestId });
});

test("TURN configuration issues time-limited coturn credentials", () => {
  const [, turn] = iceServers({
    TURN_URLS: "turn:example.org:3478,turns:example.org:5349",
    TURN_SECRET: "fixture",
  });
  assert.equal(turn.urls.length, 2);
  const expiry = Number(turn.username.split(":")[0]);
  assert.ok(expiry > Date.now() / 1000 && expiry <= Date.now() / 1000 + 3601);
  assert.equal(
    turn.credential,
    createHmac("sha1", "fixture").update(turn.username).digest("base64"),
  );
  assert.deepEqual(iceServers({ STUN_URL: "" }), []);
});
