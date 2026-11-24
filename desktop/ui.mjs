import { Room, newCode, playerName, seats, validCode } from "./room.mjs";
const api = window.qonsole,
  $ = (id) => document.getElementById(id);
const titles = { tekken: "Tekken 3", road: "Road Rash" };
const name = () => playerName($("name").value);
$("name").value = localStorage.getItem("nickname") || "Player";
let model,
  self,
  state,
  mode,
  invite = "",
  cloud,
  upstream,
  playing,
  requested,
  epoch = 0,
  timeout,
  internetReady = false;
const clients = new Map();
const status = (s) => {
  $("status").textContent = s || "";
};
const problem = (e) =>
  status(
    String(e?.message || e).replace(
      /^Error invoking remote method '[^']*': (Error: )?/,
      "",
    ),
  );
const show = (id) => {
  for (const section of ["home", "lobby", "solo"])
    $(section).hidden = section !== id;
};
const pretty = (code) => code.slice(0, 5) + "-" + code.slice(5);
function el(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}
function action(label, run) {
  const b = el("button", label);
  b.onclick = () => Promise.resolve().then(run).catch(problem);
  return b;
}
function deliver(id, msg) {
  if (id === "host") return incoming(msg);
  clients.get(id)?.send(msg);
}
function command(msg) {
  if (model) model.receive("host", msg);
  else upstream?.send(msg);
}
function paint() {
  if (!state) return;
  show("lobby");
  $("scope").textContent = mode === "lan" ? "Local network" : "Internet room";
  $("code").textContent = pretty(state.code);
  $("copy-invite").hidden = !invite;
  $("copy-code").hidden = mode === "internet" && !internetReady;
  $("connection").textContent =
    mode === "lan"
      ? "Friends on the same network can join by code or direct invite."
      : model
        ? (internetReady
            ? "Friends can join by code."
            : "Connecting the short room code…") +
          (invite
            ? " For restrictive networks, share the connection invite."
            : "")
        : "Connected to the room host.";
  const members = state.members.map((p) => {
    const li = el("li", p.name + (p.id === self ? " (you)" : ""));
    const match = state.matches.find((m) => m.id === p.match);
    li.append(
      el(
        "small",
        match ? titles[match.game] : p.id === "host" ? "Room host" : "In room",
      ),
    );
    return li;
  });
  $("members").replaceChildren(...members);
  const mine = state.members.find((x) => x.id === self)?.match;
  const matches = state.matches.map((m) => {
    const players = state.members.filter((p) => p.match === m.id);
    const row = el("div", "");
    row.className = "row";
    const desc = el("div", titles[m.game]);
    desc.append(
      el(
        "small",
        players.map((x) => x.name).join(", ") +
          " · " +
          players.length +
          "/" +
          seats[m.game],
      ),
    );
    row.append(desc);
    if (mine === m.id)
      row.append(
        action("Leave match", () => {
          command({ type: "leaveMatch" });
        }),
      );
    else {
      const join = action("Join match", () =>
        requestGame("join", m.game, m.id),
      );
      join.disabled =
        Boolean(mine) ||
        players.length >= seats[m.game] ||
        (m.game === "road" && !m.raceCode);
      row.append(join);
    }
    return row;
  });
  $("matches").replaceChildren(
    ...(matches.length ? matches : [el("p", "No active matches.")]),
  );
  for (const game of Object.keys(titles))
    $("start-" + game).disabled = Boolean(mine || requested);
}
async function requestGame(type, game, id) {
  const files = await api.files();
  if (!files[game]) {
    await openFiles();
    throw Error("Choose the " + titles[game] + " executable first.");
  }
  if (game === "road" && type === "start" && !files.daemon) {
    await openFiles();
    throw Error("Choose the Road Rash room server to host a race.");
  }
  requested = { game, id, type };
  command({ type, game, match: id });
  paint();
}
let lastHostMessage = 0;
function incoming(msg) {
  lastHostMessage = Date.now();
  if (msg?.type === "ping") {
    upstream?.send({ type: "pong" });
    return;
  }
  if (msg?.type === "closed") {
    failJoin("The room host left.");
    return;
  }
  if (msg?.type === "packet") {
    if (playing?.id === msg.match)
      api.packet(msg.match, msg.from, msg.bytes).catch(problem);
    return;
  }
  if (msg?.type === "error") {
    requested = null;
    status(msg.message);
    paint();
    return;
  }
  if (
    msg?.type !== "state" ||
    !Array.isArray(msg.state?.members) ||
    !Array.isArray(msg.state?.matches) ||
    !validCode(msg.state.code)
  )
    return;
  clearTimeout(timeout);
  busy(false);
  self = msg.self;
  state = msg.state;
  const mine = state.members.find((x) => x.id === self)?.match;
  const match = state.matches.find((m) => m.id === mine);
  if (playing && playing.id !== mine) {
    playing = null;
    api.stop().catch(problem);
  }
  if (
    match &&
    requested &&
    match.game === requested.game &&
    (!requested.id || requested.id === match.id)
  ) {
    requested = null;
    playing = match;
    const role = match.host === self;
    api.play(match, role, name()).catch((e) => {
      if (playing?.id === match.id) {
        playing = null;
        command({ type: "leaveMatch" });
        problem(e);
      }
    });
    status(
      match.game === "road" && role
        ? "In Road Rash, choose Mano a Mano → Host. Your friends can then select Join match here."
        : "Game launched. Close it to return to this room.",
    );
  }
  if (match && playing)
    api
      .members(
        state.members
          .filter((x) => x.match === mine && x.id !== self)
          .map((x) => x.id),
      )
      .catch(problem);
  paint();
}
function accept(id, link) {
  if (!model || clients.size >= 16) {
    link.close();
    return;
  }
  const timer = setTimeout(() => {
    if (!model?.members.has(id)) link.close();
  }, 9000);
  link.lastSeen = Date.now();
  clients.set(id, link);
  link.receive = (msg) => {
    if (!model) return;
    link.lastSeen = Date.now();
    if (msg?.type === "bye") {
      link.lost();
      link.close();
      return;
    }
    if (msg?.type === "pong") return;
    if (!model.members.has(id)) {
      if (
        msg?.type !== "hello" ||
        msg.version !== 1 ||
        !model.add(id, msg.name)
      ) {
        link.close();
        return;
      }
      clearTimeout(timer);
      return;
    }
    model.receive(id, msg);
  };
  link.lost = () => {
    clearTimeout(timer);
    clients.delete(id);
    model?.remove(id);
  };
}
setInterval(() => {
  if (model) {
    for (const [id, link] of clients) {
      if (Date.now() - link.lastSeen > 18000) {
        link.lost?.();
        link.close();
      } else if (model.members.has(id)) link.send({ type: "ping" });
    }
  } else if (state && lastHostMessage && Date.now() - lastHostMessage > 24000)
    failJoin("Connection to the room host was lost.");
}, 4000);
function peerLink(conn) {
  return {
    send: (m) => {
      if (conn.open && conn.bufferSize < 128) conn.send(m);
    },
    close: () => conn.close(),
  };
}
function cloudPeer(code, isHost, token) {
  const peer = new Peer(isHost ? "qonsole-party-v1-" + code : undefined, {
    debug: 0,
  });
  cloud = peer;
  const hostId = "qonsole-party-v1-" + code;
  const introduction = "qonsole-invite-v1";
  let direct,
    fallbackStarted = false,
    fallbackInvite = "";
  async function tryFallback() {
    if (epoch !== token || state || fallbackStarted || !fallbackInvite) return;
    fallbackStarted = true;
    direct?.close();
    status("Connecting through the host’s encrypted invite…");
    upstream = {
      send: (message) => api.wire("upstream", message).catch(problem),
    };
    try {
      await api.join(fallbackInvite);
      if (epoch === token)
        upstream.send({ type: "hello", version: 1, name: name() });
    } catch (error) {
      if (epoch === token)
        failJoin("Could not reach the room. " + error.message);
    }
  }
  function introduce(connection, remaining = 14) {
    if (
      epoch !== token ||
      !model ||
      clients.size > 16 ||
      !connection.peerConnection
    )
      return;
    if (!invite) {
      if (remaining)
        setTimeout(() => introduce(connection, remaining - 1), 500);
      return;
    }
    // PeerJS delivers offer metadata over its signaling socket, even when
    // neither NAT permits the peers to open their WebRTC data channel.
    const reply = peer.connect(connection.peer, {
      label: introduction,
      serialization: "json",
      metadata: { invite },
    });
    if (!reply) return;
    reply.on("error", () => reply.close());
    setTimeout(() => reply.close(), 8000);
  }
  peer.on("error", (e) => {
    if (epoch !== token) return;
    if (isHost && e.type === "peer-unavailable") return;
    if (fallbackStarted) return;
    if (isHost) {
      internetReady = false;
      paint();
      status(
        "Short-code service unavailable. Share the connection invite instead.",
      );
    } else if (!state && fallbackInvite) tryFallback();
    else if (!state && e.type === "peer-unavailable")
      failJoin(
        "Short-code connection failed. Ask the host for their connection invite.",
      );
  });
  peer.on("disconnected", () => {
    if (epoch === token && isHost) {
      internetReady = false;
      paint();
      try {
        peer.reconnect();
      } catch {}
    }
  });
  peer.on("open", () => {
    if (epoch !== token) return;
    internetReady = true;
    if (isHost) {
      paint();
      return;
    }
    const c = peer.connect(hostId, {
      metadata: { invitationVersion: 1 },
      reliable: true,
      serialization: "json",
    });
    direct = c;
    upstream = peerLink(c);
    c.on("open", () => {
      if (!fallbackStarted && epoch === token)
        upstream?.send({ type: "hello", version: 1, name: name() });
    });
    c.on("data", (m) => {
      if (epoch === token && !fallbackStarted) incoming(m);
    });
    c.on("close", () => {
      if (epoch !== token || fallbackStarted) return;
      if (state) failJoin("The room connection closed.");
      else tryFallback();
    });
    c.on("error", () => {
      if (epoch === token && !fallbackStarted) {
        if (state) failJoin("The room connection closed.");
        else tryFallback();
      }
    });
  });
  peer.on("connection", (c) => {
    if (
      !isHost &&
      epoch === token &&
      c.peer === hostId &&
      c.label === introduction
    ) {
      const offered = c.metadata?.invite;
      if (
        typeof offered === "string" &&
        offered.length < 4100 &&
        offered.startsWith("QR1." + code + ".") &&
        /^QR1\.[A-HJ-NP-Z2-9]{10}\.(?:endpoint|node)[a-z2-7]{40,4000}$/.test(
          offered,
        )
      ) {
        fallbackInvite = offered;
        setTimeout(tryFallback, 4000);
      }
      c.close();
      return;
    }
    if (!isHost || epoch !== token || c.label === introduction) {
      c.close();
      return;
    }
    const id = crypto.randomUUID(),
      link = peerLink(c);
    accept(id, link);
    if (link.receive && c.metadata?.invitationVersion === 1) introduce(c);
    c.on("data", (m) => link.receive?.(m));
    c.on("close", () => link.lost?.());
    c.on("error", () => c.close());
  });
}
function busy(value) {
  $("host").disabled = value;
  $("join").querySelector("button").disabled = value;
}
async function reset() {
  epoch++;
  clearTimeout(timeout);
  model = null;
  state = null;
  self = null;
  playing = null;
  requested = null;
  invite = "";
  internetReady = false;
  cloud?.destroy();
  cloud = null;
  upstream = null;
  clients.clear();
  busy(false);
  await api.leave();
  show("home");
}
function failJoin(message) {
  reset().then(() => status(message));
}
function prepare() {
  status("");
  mode = $("transport").value;
  localStorage.setItem("nickname", name());
  busy(true);
  return ++epoch;
}
$("host").onclick = async () => {
  const token = prepare(),
    code = newCode();
  try {
    const local = await api.host(code, mode === "internet");
    if (epoch !== token) return;
    model = new Room(code, name(), deliver);
    if (mode === "lan")
      invite =
        "qonsole://" +
        (local.addresses[0] || "127.0.0.1") +
        ":" +
        local.port +
        "/" +
        code;
    model.update();
    if (mode === "internet") cloudPeer(code, true, token);
  } catch (e) {
    await reset();
    problem(e);
  }
};
$("join").onsubmit = async (e) => {
  e.preventDefault();
  const token = prepare(),
    raw = $("invite").value.trim(),
    code = raw.toUpperCase().replace(/[-\s]/g, "");
  status("Connecting to the room…");
  timeout = setTimeout(() => {
    if (!state && epoch === token)
      failJoin("Connection timed out. Try the host’s connection invite.");
  }, 30000);
  try {
    if (validCode(code) && mode === "internet") {
      cloudPeer(code, false, token);
      return;
    }
    if (raw.startsWith("QR1.")) mode = "internet";
    else mode = "lan";
    upstream = { send: (m) => api.wire("upstream", m).catch(problem) };
    await api.join(validCode(code) ? code : raw);
    if (epoch === token)
      upstream.send({ type: "hello", version: 1, name: name() });
  } catch (e) {
    if (epoch === token) {
      await reset();
      problem(e);
    }
  }
};
api.events(({ type, value: e }) => {
  if (type === "relayInvite") {
    invite = e;
    paint();
    return;
  }
  if (type === "networkError") {
    status(e);
    return;
  }
  if (type === "wire") {
    if (e.id === "upstream") {
      if (e.type === "close" && upstream)
        failJoin("The host closed the room or the connection was lost.");
      else if (e.type === "message") incoming(e.value);
      return;
    }
    if (e.type === "open")
      accept(e.id, {
        send: (m) => api.wire(e.id, m).catch(problem),
        close: () => api.drop(e.id),
      });
    else if (e.type === "close") clients.get(e.id)?.lost?.();
    else clients.get(e.id)?.receive?.(e.value);
  }
  if (type === "game") {
    if (e.type === "exit") {
      if (playing?.id !== e.match) return;
      playing = null;
      if (state) {
        command({ type: "leaveMatch" });
        status("Back in the room.");
      } else {
        show("home");
        status("");
      }
      if (e.error) status(e.error);
    } else command(e);
  }
});
$("leave").onclick = async () => {
  if (model) for (const link of clients.values()) link.send({ type: "closed" });
  else upstream?.send({ type: "bye" });
  await new Promise((resolve) => setTimeout(resolve, 180));
  await reset();
  status("");
};
$("copy-code").onclick = () =>
  api.copy(pretty(state.code)).then(() => status("Room code copied."));
$("copy-invite").onclick = () =>
  api
    .copy(invite)
    .then(() => status("Connection invite copied. Paste it in Join room."));
for (const game of Object.keys(titles)) {
  $("start-" + game).onclick = () => requestGame("start", game).catch(problem);
  $("solo-" + game).onclick = async () => {
    try {
      const cfg = await api.files();
      if (!cfg[game]) {
        await openFiles();
        throw Error("Select the " + titles[game] + " executable.");
      }
      playing = { id: crypto.randomUUID(), game, solo: true };
      await api.play(playing, true, name());
      if (playing) {
        $("solo-title").textContent = titles[game];
        show("solo");
        status("");
      }
    } catch (e) {
      playing = null;
      problem(e);
    }
  };
}
$("stop-solo").onclick = async () => {
  playing = null;
  await api.stop();
  show("home");
};
async function openFiles() {
  const cfg = await api.files();
  const rows = {
    tekkenAssets: "Tekken converted assets",
    road: "Road Rash executable",
    daemon: "Road Rash room server (.wasm or rr-netd)",
    roadAssets: "Road Rash game data",
  };
  $("paths").replaceChildren(
    ...Object.entries(rows).map(([key, title]) => {
      const row = el("div", "");
      row.className = "path";
      const info = el("div", title);
      info.append(
        el("small", cfg[key] || "Use an existing local installation"),
      );
      row.append(
        info,
        action("Choose", async () => {
          await api.choose(key);
          await openFiles();
        }),
      );
      return row;
    }),
  );
  if (!$("settings").open) $("settings").showModal();
}
$("files").onclick = () => openFiles().catch(problem);
$("done").onclick = () => $("settings").close();
