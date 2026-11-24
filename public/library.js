const about = document.querySelector("#about");
document.querySelector(".navlink").addEventListener("click", () => {
  about.open = true;
});
if (location.hash === "#about") about.open = true;
