"""Assemble a private portable Mac/Windows folder from local game installations."""
import argparse
import hashlib
from io import BytesIO
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
DIST = ROOT / "dist"
ARTIFACT = "https://nightly.link/arkits/road-rash/actions/runs/45077446619/windows-package-x64.zip"
DIGEST = "e6dd8e6f266a7289be1fbb05a013045118af54c3a3c6b8c05e6c177f31ba0db1"


def windows_engine(target, installed):
    if installed:
        if not (installed / "rr-game.exe").is_file():
            raise ValueError("The Windows engine folder must contain rr-game.exe.")
        shutil.copytree(installed, target, dirs_exist_ok=True)
        return
    archive = RUNTIME / "native/win32-x64/road-upstream.zip"
    archive.parent.mkdir(exist_ok=True, parents=True)
    if not archive.is_file():
        with urlopen(ARTIFACT, timeout=90) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != DIGEST:
            raise ValueError("Windows artifact differs from the upstream SHA-256.")
        archive.write_bytes(content)
    with archive.open("rb") as src:
        if hashlib.file_digest(src, "sha256").hexdigest() != DIGEST:
            raise ValueError("Windows artifact differs from the upstream SHA-256.")
    with ZipFile(archive) as outer:
        name = next(n for n in outer.namelist() if n.endswith("-windows-x64.zip"))
        with ZipFile(BytesIO(outer.read(name))) as inner:
            for name in inner.namelist():
                relative = Path(name).relative_to("Road Rash Native")
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unexpected artifact member")
                if relative.name in {"rr-game.exe", "portable.txt", "README.txt"} or relative.parts[:1] == ("licenses",):
                    dest = target / relative
                    dest.parent.mkdir(exist_ok=True, parents=True)
                    dest.write_bytes(inner.read(name))


def copy_disc(source, target):
    manifest = (RUNTIME / "road-source/src/reference_hashes.inc").read_text()
    rows = re.findall(r'\{"([^"}]+)",\s*"([0-9a-f]{64})"\}', manifest)
    if len(rows) != 341:
        raise ValueError("Unexpected Road Rash reference manifest")
    for name, digest in rows:
        src, dest = source / name, target / name
        with src.open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != digest:
                raise ValueError("Road Rash disc mismatch in " + name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    print(f"Verified and copied {len(rows)} Road Rash files.", flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--road-assets", type=Path, default=RUNTIME / "road-disc/files/ROADRASH")
    p.add_argument("--tekken-assets", type=Path, default=RUNTIME / "tekken/openkumite-v0.5.1-web/assets")
    p.add_argument("--windows-road", type=Path, help="Use an existing Windows native engine folder.")
    p.add_argument("--output", type=Path, default=DIST / "Qonsole-Personal")
    args = p.parse_args()
    out = args.output.resolve()
    archive = out.with_name(out.name + ".zip")
    if out.exists() or archive.exists():
        p.error("Choose a new --output folder to preserve your existing installation and saves.")
    if not (args.tekken_assets / "manifest.json").is_file():
        p.error("Bind the Tekken disc or select an existing --tekken-assets folder.")
    out.parent.mkdir(exist_ok=True, parents=True)
    with TemporaryDirectory(dir=out.parent) as temporary:
        stage = Path(temporary) / out.name
        # Only copy the clean packaged runtime. User profiles and saves are private.
        shutil.copytree(DIST / "Qonsole-win32-x64", stage, ignore=shutil.ignore_patterns("Qonsole Data", "Games"))
        subprocess.run(["ditto", str(DIST / "Qonsole-darwin-arm64/Qonsole.app"), str(stage / "Qonsole.app")], check=True)
        games = stage / "Games"
        shutil.copytree(args.tekken_assets, games / "Tekken3/assets")
        for target in ("darwin-arm64", "win32-x64"):
            shutil.copytree(RUNTIME / "native" / target / "tekken", games / "Tekken3" / target / "engine", ignore=shutil.ignore_patterns("serve", "serve.exe"))
        road = games / "RoadRash"
        copy_disc(args.road_assets, road / "ROADRASH")
        windows_engine(road, args.windows_road)
        shutil.copy2(RUNTIME / "native-road-static/rr-game", road / "rr-game")
        shutil.copy2(RUNTIME / "road-room.wasm", road / "room-core.wasm")
        (stage / "Play.txt").write_text(
            "Qonsole personal installation\n\nExtract the whole folder first. On macOS Apple silicon open Qonsole.app. "
            "On Windows x64 open Qonsole.exe. Keep Games beside the launcher. This folder includes your personal disc data.\n\n"
            "For multiplayer choose Internet or Local network, then Host room. Share the room code. "
            "If the Internet code cannot connect, share Copy connection invite. Keep the room host connected.\n"
            "For Tekken 3 start a match, have the guest join, then press Start in the game lobby. "
            "For Road Rash start a match, then choose Mano a Mano and host a race in the game. "
            "The guest can then click Join match in Qonsole.\n", encoding="utf-8")
        staged_zip = Path(temporary) / "personal.zip"
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(stage), str(staged_zip)], check=True)
        stage.rename(out)
        staged_zip.rename(archive)
    print(out, archive, sep="\n")


if __name__ == "__main__":
    main()
