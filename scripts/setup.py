"""Install the pinned community engines locally. Requires Python 3.12+, Node and CMake."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
REVISION = "0c1092a68d252ba2ae642f285ee68251eb708312"
KUMITE = "openkumite-v0.5.1-web"
ROAD = RUNTIME / "road-source"


def download(name, url, digest):
    dest = RUNTIME / name
    if dest.exists():
        with dest.open("rb") as current:
            if hashlib.file_digest(current, "sha256").hexdigest() == digest:
                return dest
    print(f"Downloading {name}", flush=True)
    with tempfile.NamedTemporaryFile(dir=RUNTIME, delete=False) as tmp:
        path = Path(tmp.name)
        try:
            with urllib.request.urlopen(url, timeout=180) as src:
                shutil.copyfileobj(src, tmp)
            tmp.close()
            with path.open("rb") as src:
                if hashlib.file_digest(src, "sha256").hexdigest() != digest:
                    raise ValueError(f"Checksum mismatch for {name}")
            path.replace(dest)
        finally:
            path.unlink(missing_ok=True)
    return dest


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def install_tekken():
    archive = download("tekken.zip", f"https://github.com/openkumite/openkumite/releases/download/v0.5.1/{KUMITE}.zip",
                       "a42496073001528d0e4ac709ddd77f49b3ceed798bedaacccfd3fe36bf4c31ee")
    with zipfile.ZipFile(archive) as src:
        src.extractall(RUNTIME / "tekken")
    game = RUNTIME / "tekken" / KUMITE
    (game / "pkg/config.json").write_text(json.dumps({"serverAssets": True}))
    page = game / "index.html"
    html = page.read_text().replace("<head>", '<head><script src="/rtc-config.js"></script>', 1)
    # All clients of a bound installation use the same disc, including returning browsers.
    check = "serverAssets && (await fetch('assets/manifest.json', { method: 'HEAD' }).then((r) => r.ok, () => false))"
    for old, new in [
        ("const kept = await stored();", f"const bound = {check};\n  const kept = !bound && await stored();"),
        ("let folder = !local &&", "let folder = !bound && !local &&"),
        (f"const noData = !local && !({check});", "const noData = !bound && !local;"),
    ]:
        if html.count(old) != 1:
            raise ValueError("Unexpected OpenKumite data loader")
        html = html.replace(old, new, 1)
    page.write_text(html)
    glue = game / "pkg/openkumite.js"
    factory = "new RTCPeerConnection(getObject(arg0))"
    if glue.read_text().count(factory) != 1:
        raise ValueError("Unexpected OpenKumite WebRTC bindings")
    glue.write_text(glue.read_text().replace(factory,
        "new RTCPeerConnection({...getObject(arg0), iceServers: globalThis.qonsoleIceServers ?? getObject(arg0).iceServers})"))
    # The local server serves the integration's plain JS, including behind compression proxies.
    for ext in [".gz", ".br"]:
        glue.with_suffix(".js" + ext).unlink(missing_ok=True)


def install_road_source():
    if (ROAD / ".git").exists():
        version = subprocess.check_output(["git", "-C", ROAD, "rev-parse", "HEAD"], text=True).strip()
        if version != REVISION:
            raise ValueError(f"Expected Road Rash {REVISION}, found {version}")
        return
    # The engine records Git's source identity during every build. A real
    # checkout also isolates provenance from the enclosing Qonsole repository.
    with tempfile.TemporaryDirectory(dir=RUNTIME) as tmp:
        run("git", "init", "--quiet", tmp)
        run("git", "-C", tmp, "fetch", "--depth=1", "https://github.com/arkits/road-rash.git", REVISION)
        run("git", "-C", tmp, "checkout", "--quiet", "--detach", REVISION)
        shutil.copytree(tmp, ROAD, dirs_exist_ok=True)


def build_server():
    build = RUNTIME / "netd"
    run("cmake", "-S", ROAD / "server", "-B", build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
        f"-DRR_NETD_REVISION={REVISION}")
    run("cmake", "--build", build, "--target", "rr-netd", "--parallel", "6")


def build_web():
    sdk = ROAD / ".tools" / "emsdk"
    if not (sdk / "emsdk").exists():
        sdk.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", "--depth", "1", "--branch", "6.0.10", "https://github.com/emscripten-core/emsdk", sdk)
    run(sdk / "emsdk", "install", "6.0.10")
    run(sdk / "emsdk", "activate", "6.0.10")
    build = RUNTIME / "road-build"
    run(sdk / "upstream/emscripten/emcmake", "cmake", "-S", ROAD, "-B", build, "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release", "-DRR_WEB_BROWSER=ON", "-DBUILD_TESTING=OFF")
    run("cmake", "--build", build, "--target", "rr-game", "--parallel", "6")
    dist = RUNTIME / "road"
    dist.mkdir(exist_ok=True)
    for name in ["style.css", "app.js", "favicon.ico", "og-image.png"]:
        shutil.copy2(ROAD / "web" / name, dist / name)
    page = (ROAD / "web/index.html").read_text().replace('<script src="telemetry.js" defer></script>',
        '<script src="/road-host.js" defer></script>')
    (dist / "index.html").write_text(page)
    for name in ["rr-game.js", "rr-game.wasm"]:
        shutil.copy2(build / name, dist / name)
    rows = re.findall(r'\{"([^"}]+)",\s*"([0-9a-f]{64})"\}', (ROAD / "src/reference_hashes.inc").read_text())
    if len(rows) != 341:
        raise ValueError("Unexpected Road Rash reference manifest")
    (dist / "references.json").write_text(json.dumps([dict(path=p, hash=h) for p, h in rows]))
    notices = [p for p in sorted((ROAD / "third_party").iterdir()) if p.is_file() and
               ("license" in p.name.lower() or "lgpl" in p.name.lower() or p.name == "FreeType-FTL.txt")]
    (dist / "LICENSES.txt").write_text("\n\n".join(p.name + "\n" + p.read_text() for p in notices))


if __name__ == "__main__":
    os.environ.setdefault("CMAKE_BUILD_PARALLEL_LEVEL", "4")
    RUNTIME.mkdir(exist_ok=True)
    steps = sys.argv[1:] or ["tekken", "road-source", "server", "web"]
    for step in steps:
        {"tekken": install_tekken, "road-source": install_road_source, "server": build_server, "web": build_web}[step]()
