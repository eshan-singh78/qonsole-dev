import test from "node:test";
import assert from "node:assert/strict";
import { Room, newCode, validCode } from "../desktop/room.mjs";
import { hostLan, findLan } from "../desktop/lan.mjs";
import { once } from "node:events";
import { WebSocket } from "ws";

test("party can split between games, enforces seats, and ends just the departed owner's match", () => {
  const deliveries = [];
  const room = new Room(newCode(), "Host", (id, m) => deliveries.push([id, m]));
  assert.ok(validCode(room.code));
  for (const id of ["a", "b", "c", "d", "e"]) assert.ok(room.add(id, id));
  room.receive("a", { type: "start", game: "tekken" });
  room.receive("c", { type: "start", game: "road" });
  const [fight, race] = [...room.matches.values()];
  room.receive("b", { type: "join", match: fight.id });
  room.receive("host", { type: "join", match: fight.id });
  assert.equal(room.members.get("host").match, null);
  room.receive("d", { type: "join", match: race.id });
  assert.equal(room.members.get("d").match, null);
  room.receive("c", { type: "raceCode", code: "234567" });
  for (const id of ["d", "e"])
    room.receive(id, { type: "join", match: race.id });
  deliveries.length = 0;
  room.receive("b", {
    type: "packet",
    to: "c",
    match: fight.id,
    bytes: "bQ==",
  });
  room.receive("b", {
    type: "packet",
    to: "a",
    match: fight.id,
    from: "c",
    bytes: "bQ==",
  });
  assert.deepEqual(deliveries, [
    ["a", { type: "packet", match: fight.id, from: "b", bytes: "bQ==" }],
  ]);
  room.remove("a");
  assert.equal(room.members.get("b").match, null);
  assert.equal(room.matches.size, 1);
  room.receive("b", { type: "join", match: race.id });
  assert.equal(room.members.get("b").match, race.id);
});

test("LAN codes discover the peer host and the private room socket carries packets", async (t) => {
  const code = newCode(),
    events = [];
  const server = await hostLan(code, (event) => events.push(event));
  t.after(() => server.close());
  const found = await findLan(code);
  assert.equal(found.port, server.port);
  const ws = new WebSocket(
    "ws://" + found.host + ":" + found.port + "/room/" + code,
  );
  t.after(() => ws.terminate());
  await once(ws, "open");
  const id = events[0].id;
  const next = once(ws, "message");
  server.send(id, { type: "ping" });
  assert.deepEqual(JSON.parse((await next)[0]), { type: "ping" });
});
