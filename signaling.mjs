import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

// OpenKumite uses the Matchbox full-mesh protocol. The new peer answers offers
// from existing members. No game traffic passes through this socket.
export function matchbox() {
  const ws = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const rooms = new Map();
  function send(socket, event) {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(event));
  }
  function accept(socket, code) {
    const room = rooms.get(code) ?? new Map();
    if (room.size >= 4 || ws.clients.size > 1024)
      return socket.close(1013, "Room or server full");
    const id = randomUUID();
    rooms.set(code, room);
    send(socket, { IdAssigned: id });
    for (const peer of room.values()) send(peer, { NewPeer: id });
    room.set(id, socket);
    socket.on("message", (bytes, binary) => {
      if (binary) return socket.close(1003, "Expected text");
      let message;
      try {
        message = JSON.parse(bytes);
      } catch {
        return socket.close(1007, "Invalid JSON");
      }
      if (message === "KeepAlive") return;
      const signal = message?.Signal;
      if (
        !signal ||
        typeof signal.receiver !== "string" ||
        signal.data === undefined
      ) {
        return socket.close(1007, "Invalid signaling message");
      }
      const peer = room.get(signal.receiver);
      if (peer && peer !== socket)
        send(peer, { Signal: { sender: id, data: signal.data } });
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      room.delete(id);
      for (const peer of room.values()) send(peer, { PeerLeft: id });
      if (!room.size) rooms.delete(code);
    });
  }
  const heartbeat = setInterval(() => {
    for (const peer of ws.clients) {
      if (peer.waitingForPong) peer.terminate();
      else {
        peer.waitingForPong = true;
        peer.once("pong", () => {
          peer.waitingForPong = false;
        });
        peer.ping();
      }
    }
  }, 30000);
  heartbeat.unref();
  return {
    upgrade(req, socket, head, code) {
      ws.handleUpgrade(req, socket, head, (client) => accept(client, code));
    },
    close() {
      clearInterval(heartbeat);
      for (const peer of ws.clients) peer.terminate();
      ws.close();
    },
  };
}
