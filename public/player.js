const id = location.pathname.split("/").pop();
const tekken = id === "tekken";
const game = tekken ? "Tekken 3" : "Road Rash";
const $ = (name) => document.getElementById(name);
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pattern = tekken
  ? "[A-HJ-NP-Z2-9]{5}"
  : "[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}";
const roomLength = tekken ? 5 : 6;
const valid = new RegExp("^" + pattern + "$");
const base = "/engines/" + id + "/";
const signal =
  (location.protocol === "https:" ? "wss://" : "ws://") +
  location.host +
  "/signal";
let invite = "";

document.title = game + " · Qonsole";
$("game").textContent = game;
$("edition").textContent = tekken
  ? "PlayStation / OpenKumite v0.5.1"
  : "Windows 95 / arkits PC rework";
$("intro").textContent = tekken
  ? "Open the game to play solo, or host a match and invite a second player."
  : "Import the supported Windows PC disc ISO or ROADRASH folder on each device. The port checks the files before starting.";
$("explain").textContent = tekken
  ? "Share a five-character code for an online fight."
  : "The race server creates your six-character code inside the game.";
$("source").href = tekken
  ? "https://github.com/openkumite/openkumite/tree/v0.5.1"
  : "https://github.com/arkits/road-rash/tree/0c1092a68d252ba2ae642f285ee68251eb708312";
$("code").placeholder = tekken ? "5 characters" : "6 characters";
$("code").maxLength = tekken ? roomLength : roomLength + 1;
$("code").pattern = pattern;
$("code").oninput = () => {
  $("code").value = $("code").value.replace(/[\s-]/g, "").toUpperCase();
};
const invited = new URLSearchParams(location.search).get("room")?.toUpperCase();
if (invited && valid.test(invited)) {
  $("code").value = invited;
  $("status").textContent = "Room invitation received. Select Join to enter.";
} else if (invited) {
  $("status").textContent = "This invite has an invalid room code.";
}
if (!window.isSecureContext) {
  $("status").textContent =
    "Open this player over HTTPS or localhost so the engine can store your imported game files.";
  for (const button of $("lobby").querySelectorAll("button"))
    button.disabled = true;
}

async function openGame(mode, code = "") {
  $("status").textContent = "Opening the game engine…";
  $("lobby").inert = true;
  try {
    const response = await fetch(base, { method: "HEAD" });
    if (!response.ok)
      throw Error(
        "The game engine is missing. The server owner can install it with npm run setup.",
      );
    let url = base;
    if (tekken) {
      // OpenKumite parses command-line tokens separated by literal ampersands.
      url += "?--signal&" + signal;
      if (mode !== "solo")
        url +=
          "&--online&" +
          code +
          (mode === "host" ? "&--host-room&--name&HOST" : "&--name&GUEST");
    } else if (code) {
      url += "?room=" + code;
    } else if (mode === "host") {
      url += "?qonsole=host";
    }
    document.body.classList.add("playing");
    $("lobby").hidden = true;
    $("stage").hidden = false;
    $("mode").textContent =
      mode === "solo"
        ? "Game player"
        : mode === "host"
          ? "Hosting"
          : "Joining room " + code;
    $("engine").onload = () => {
      $("status").textContent = "";
    };
    $("engine").src = url;
    if (code) {
      const link = new URL(location.pathname, location.origin);
      link.searchParams.set("room", code);
      invite = link.href;
      $("room").textContent = "Room " + code;
      $("invitation").hidden = false;
    }
    $("engine").focus();
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    $("lobby").inert = false;
  }
}
$("launch").onclick = () => openGame("solo");
$("host").onclick = () => {
  const code = tekken
    ? Array.from(
        crypto.getRandomValues(new Uint8Array(5)),
        (n) => alphabet[n % alphabet.length],
      ).join("")
    : "";
  void openGame("host", code);
};
$("join").onsubmit = (e) => {
  e.preventDefault();
  const code = $("code").value.trim().toUpperCase();
  if (valid.test(code)) void openGame("guest", code);
};
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(invite);
    $("status").textContent = "Invite link copied.";
  } catch {
    $("status").textContent = invite;
  }
};
$("leave").onclick = () => {
  $("engine").onload = null;
  $("engine").src = "about:blank";
  document.body.classList.remove("playing");
  $("stage").hidden = true;
  $("invitation").hidden = true;
  $("lobby").hidden = false;
  $("status").textContent = "";
  $("launch").focus();
};

if (document.fullscreenEnabled) {
  $("expand").hidden = false;
  $("expand").onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("stage").requestFullscreen();
      $("engine").focus();
    } catch (error) {
      $("status").textContent = error.message;
    }
  };
  document.addEventListener("fullscreenchange", () => {
    $("expand").textContent = document.fullscreenElement
      ? "Exit fullscreen"
      : "Fullscreen";
  });
}
