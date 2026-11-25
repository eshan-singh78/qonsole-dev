const metadata = {
  tekken: {
    title: "Tekken 3",
    category: "PlayStation · Fighting",
    detail: "1–2 players",
    engine: "OpenKumite",
  },
  road: {
    title: "Road Rash",
    category: "Windows 95 · Racing",
    detail: "1–8 players",
    engine: "Road Rash Native",
  },
};
const size = (bytes) =>
  bytes >= 1e9
    ? (bytes / 1e9).toFixed(2) + " GB"
    : Math.ceil(bytes / 1e6) + " MB";

export function createShelf({ api, play, browse, report, message, inSession }) {
  const $ = (id) => document.getElementById(id);
  let rows = [],
    view = "library",
    collectionBusy = false,
    removing;
  const cards = new Map();
  const run = (task) => Promise.resolve().then(task).catch(report);
  for (const [id, game] of Object.entries(metadata)) {
    const card = document.createElement("article");
    card.className = "game-card";
    card.hidden = true;
    card.innerHTML = `<img class="cover" alt=""><div class="game-info"><div class="game-meta"></div><h2></h2><p class="game-details"></p><p class="game-state"></p><progress max="100" hidden></progress><div class="game-actions"><button class="primary"></button><button class="quiet remove" hidden>Remove</button></div></div>`;
    card.querySelector("img").src = "art/" + id + ".webp";
    card.querySelector(".game-meta").textContent = game.category;
    card.querySelector("h2").textContent = game.title;
    card.querySelector(".game-details").textContent =
      game.engine + " · " + game.detail;
    card
      .querySelector("progress")
      .setAttribute("aria-label", "Installing " + game.title);
    const button = card.querySelector(".primary");
    button.onclick = () =>
      run(async () => {
        message("");
        const row = rows.find((row) => row.id === id);
        if (row.progress) await api.cancelInstall(id);
        else if (!row.installed) await api.install(id);
        else if (view === "store") browse("library");
        else await play(id);
      });
    card.querySelector(".remove").onclick = () => {
      removing = id;
      $("remove-title").textContent = "Remove " + game.title + "?";
      $("confirm-remove").returnValue = "";
      $("confirm-remove").showModal();
    };
    cards.set(id, card);
    $("catalog-games").append(card);
  }
  $("confirm-remove").addEventListener("close", () => {
    if ($("confirm-remove").returnValue === "remove")
      run(() => api.removeInstall(removing));
  });
  $("browse-store").onclick = () => browse("store");
  $("collection").onclick = () =>
    run(async () => {
      const pending = rows.filter(
        (row) => row.supported && !row.installed && !row.progress,
      );
      message("");
      collectionBusy = true;
      render();
      try {
        const results = await Promise.allSettled(
          pending.map((row) => api.install(row.id)),
        );
        const failures = results.filter(
          (result) => result.status === "rejected",
        );
        if (failures.length) throw failures[0].reason;
      } finally {
        collectionBusy = false;
        render();
      }
    });
  function render() {
    const store = view === "store";
    const count = rows.filter((row) => row.installed).length;
    $("shelf-title").textContent = store ? "Store" : "Library";
    $("shelf-description").textContent = store
      ? "Games available for your Qonsole."
      : count
        ? count +
          (count === 1 ? " game on this device" : " games on this device")
        : "";
    $("empty-library").hidden = store || count > 0 || !rows.length;
    $("collection").hidden =
      !store ||
      rows.filter((row) => row.supported && !row.installed).length !== 2;
    $("collection").disabled =
      collectionBusy || rows.some((row) => row.progress);
    for (const row of rows) {
      const card = cards.get(row.id);
      card.hidden = !store && !row.installed;
      const progress = card.querySelector("progress");
      progress.hidden = !row.progress;
      const info = card.querySelector(".game-state");
      const button = card.querySelector(".primary");
      if (row.progress) {
        const { bytes, total, phase } = row.progress;
        progress.value = Math.round((bytes / total) * 100);
        info.textContent = phase + " · " + size(bytes) + " / " + size(total);
        button.textContent = "Cancel";
      } else {
        info.textContent = row.installed
          ? row.managed
            ? "Installed"
            : "Local installation"
          : row.supported
            ? size(row.total) + " download"
            : "Unavailable on this platform";
        button.textContent = row.installed
          ? store
            ? "View in library"
            : "Play solo"
          : "Install";
      }
      button.disabled =
        !row.progress &&
        ((!row.installed && !row.supported) ||
          (row.installed && !store && inSession()));
      button.id = (store ? "store-" : "solo-") + row.id;
      card.querySelector(".remove").hidden =
        store || !row.managed || inSession();
    }
  }
  return {
    data(items) {
      rows = items;
      render();
    },
    show(tab) {
      view = tab;
      render();
    },
  };
}
