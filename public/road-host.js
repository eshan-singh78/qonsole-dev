// Imported data can take time to verify. Keep the native host button as a user
// gesture so the browser can unlock audio and request fullscreen on mobile.
if (new URLSearchParams(location.search).get("qonsole") === "host") {
  const ready = document.getElementById("ready");
  const presentHost = () => {
    if (ready.hidden) return;
    const button = document.getElementById("net-host");
    document.getElementById("setup-description").textContent =
      "Choose Host to create your race and get a room code.";
    button.scrollIntoView({ block: "center" });
    button.focus({ preventScroll: true });
    observer.disconnect();
  };
  const observer = new MutationObserver(presentHost);
  observer.observe(ready, { attributes: true, attributeFilter: ["hidden"] });
  presentHost();
}
