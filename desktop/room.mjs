// The room owner's launcher assigns seats and routes only between members of the same match.
export const seats = Object.freeze({ tekken: 2, road: 8 });
export const validCode = (value) =>
  typeof value === "string" && /^[A-HJ-NP-Z2-9]{10}$/.test(value);
export function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (n) => alphabet[n % 32],
  ).join("");
}
export function playerName(value) {
  return (
    (typeof value === "string" ? value : "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 24) || "Player"
  );
}

export class Room {
  constructor(code, ownerName, deliver) {
    this.code = code;
    this.deliver = deliver;
    this.members = new Map([
      ["host", { id: "host", name: playerName(ownerName), match: null }],
    ]);
    this.matches = new Map();
  }
  add(id, name) {
    if (this.members.has(id) || this.members.size >= 16) return false;
    this.members.set(id, { id, name: playerName(name), match: null });
    this.update();
    return true;
  }
  update() {
    const state = {
      code: this.code,
      members: [...this.members.values()],
      matches: [...this.matches.values()],
    };
    for (const id of this.members.keys())
      this.deliver(id, { type: "state", self: id, state });
  }
  detach(id) {
    const member = this.members.get(id);
    const match = this.matches.get(member?.match);
    if (!match) return;
    member.match = null;
    if (match.host === id) {
      this.matches.delete(match.id);
      for (const seat of this.members.values())
        if (seat.match === match.id) seat.match = null;
    }
  }
  remove(id) {
    this.detach(id);
    this.members.delete(id);
    this.update();
  }
  receive(id, msg) {
    const member = this.members.get(id);
    if (!member || !msg || typeof msg !== "object") return;
    const fail = (message) => this.deliver(id, { type: "error", message });
    const current = this.matches.get(member.match);
    switch (msg.type) {
      case "start": {
        if (current || !Object.hasOwn(seats, msg.game))
          return fail("Leave the current match first.");
        const match = {
          id: crypto.randomUUID(),
          game: msg.game,
          host: id,
          raceCode: "",
        };
        this.matches.set(match.id, match);
        member.match = match.id;
        break;
      }
      case "join": {
        const match = this.matches.get(msg.match);
        if (current || !match) return fail("This match is unavailable.");
        if (match.game === "road" && !match.raceCode)
          return fail("The host is setting up the race.");
        const occupied = [...this.members.values()].filter(
          (m) => m.match === match.id,
        ).length;
        if (occupied >= seats[match.game]) return fail("This match is full.");
        member.match = match.id;
        break;
      }
      case "leaveMatch":
        this.detach(id);
        break;
      case "raceCode":
        if (
          current?.host !== id ||
          current.game !== "road" ||
          !/^[A-Z2-9]{6}$/.test(msg.code)
        )
          return;
        current.raceCode = msg.code;
        break;
      case "packet": {
        const to = this.members.get(msg.to);
        if (
          !current ||
          current.id !== msg.match ||
          !to ||
          to.match !== current.id ||
          id === to.id ||
          (current.host !== id && current.host !== to.id)
        )
          return;
        if (typeof msg.bytes !== "string" || msg.bytes.length > 90000) return;
        this.deliver(to.id, {
          type: "packet",
          from: id,
          match: current.id,
          bytes: msg.bytes,
        });
        return;
      }
      default:
        return;
    }
    this.update();
  }
}
