"""Fetch and verify the two native OpenKumite builds used by the desktop bundles."""
import hashlib
from pathlib import Path
import sys
import tarfile
import zipfile
from urllib.request import urlopen
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = "https://github.com/openkumite/openkumite/releases/download/v0.5.1/"
BUILDS = {
    "darwin-arm64": ("openkumite-v0.5.1-macos-universal.tar.gz", "2b516cb4325c5e0a31edb304286377bc3eda5697273171643f3626b9b5c0c063"),
    "win32-x64": ("openkumite-v0.5.1-windows-amd64.zip", "ba51105051774a8934d4ac799db6ea15ed2d0892db854154b2e7a1321440e812"),
}
def install(base, dest, build):
    name, digest = build
    if dest.is_dir():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent) as temp:
        archive = Path(temp) / name
        with urlopen(base + name, timeout=120) as src, archive.open("wb") as out:
            shutil.copyfileobj(src, out)
        with archive.open("rb") as src:
            if hashlib.file_digest(src, "sha256").hexdigest() != digest:
                raise ValueError("Checksum mismatch for " + name)
        unpacked = Path(temp) / "unpacked"
        if zipfile.is_zipfile(archive):
            with zipfile.ZipFile(archive) as src:
                src.extractall(unpacked)
        else:
            with tarfile.open(archive) as src:
                src.extractall(unpacked, filter="data")
        roots = list(unpacked.iterdir())
        root = roots[0] if len(roots) == 1 and roots[0].is_dir() else unpacked
        root.rename(dest)
        print("Installed", dest, flush=True)

PIPES = {
    "darwin-arm64": ("dumbpipe-v0.40.2-darwin-aarch64.tar.gz", "b62f4f9d8982792309aeaa05fc891cc64a983c2b9674cfdd794737dc9e6649b3"),
    "win32-x64": ("dumbpipe-v0.40.2-windows-x86_64.zip", "3874c0c1ebe9308f891bc57eb1a4e822697fc82ecd7de494ad74bc327c3ce87a"),
}
for target in sys.argv[1:] or BUILDS:
    dest = ROOT / ".runtime/native" / target
    install(RELEASE, dest / "tekken", BUILDS[target])
    install("https://github.com/n0-computer/dumbpipe/releases/download/v0.40.2/", dest / "network", PIPES[target])
