"""Assemble reproducible Store release assets and a checksum-pinned launcher catalog."""
import argparse
import gzip
import hashlib
import json
import re
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
TARGETS = ("darwin-arm64", "win32-x64", "linux-x64")
LINUX_SHA256 = "3aadc04aff612f2fd7ef8c8a3729d119a37aad586a45829317c58c2b3ae14230"


def digest(file):
    with file.open("rb") as src:
        return hashlib.file_digest(src, "sha256").hexdigest()


def tree(root, prefix, omit=()):
    for file in sorted(root.rglob("*")):
        relative = file.relative_to(root)
        if any(part.startswith(".") or part in omit for part in relative.parts):
            continue
        if file.is_symlink():
            raise ValueError(f"Unexpected symlink: {relative}")
        if file.is_file():
            yield file, f"{prefix}/{relative.as_posix()}"


def pack(out, name, entries):
    target = out / (name + ".tar.gz")
    temp = target.with_suffix(".part")
    count = 0
    with temp.open("wb") as dest, gzip.GzipFile(filename="", fileobj=dest, mode="wb", compresslevel=3, mtime=0) as gz, tarfile.open(fileobj=gz, mode="w|") as archive:
        for source, member in entries:
            if source.is_symlink() or not source.is_file():
                raise ValueError(f"Missing regular file: {source}")
            info = tarfile.TarInfo(member)
            info.size = source.stat().st_size
            info.mode = 0o755 if source.name in {"openkumite", "rr-game"} else 0o644
            with source.open("rb") as f:
                archive.addfile(info, f)
            count += 1
    if not count:
        raise ValueError(f"Empty bundle: {name}")
    temp.replace(target)
    print(target.name, target.stat().st_size, flush=True)
    return {"file": target.name, "size": target.stat().st_size, "sha256": digest(target)}


def disc_files(root):
    source = (RUNTIME / "road-source/src/reference_hashes.inc").read_text()
    rows = re.findall(r'\{"([^"}]+)",\s*"([0-9a-f]{64})"\}', source)
    if len(rows) != 341:
        raise ValueError("Unexpected Road Rash disc manifest")
    for name, sha in rows:
        file = root / name
        if digest(file) != sha:
            raise ValueError(f"Disc mismatch: {name}")
        yield file, "assets/" + name


def linux_engine(artifact, temp):
    if digest(artifact) != LINUX_SHA256:
        raise ValueError("Incorrect upstream Linux artifact")
    with zipfile.ZipFile(artifact) as outer:
        tarball = next(n for n in outer.namelist() if n.endswith(".tar.gz"))
        with outer.open(tarball) as data, tarfile.open(fileobj=data, mode="r|gz") as src:
            for item in src:
                if item.isfile():
                    src.extract(item, temp, filter="data")
    return next(temp.rglob("rr-game")).parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--linux-package", type=Path, required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--out", type=Path, default=RUNTIME / "store-release")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", args.release):
        parser.error("Invalid release tag")
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    games = {}
    with tempfile.TemporaryDirectory() as tmp:
        linux = linux_engine(args.linux_package, Path(tmp))
        for game in ("road", "tekken"):
            engines = {}
            for target in TARGETS:
                if game == "tekken":
                    source = RUNTIME / "native" / target / "tekken"
                    entries = list(tree(source, "engine", {"serve", "serve.exe"}))
                else:
                    win = RUNTIME / "native/win32-x64/road/Road Rash Native"
                    if target == "linux-x64":
                        entries = list(tree(linux, "engine", {"install-desktop-entry.sh", "road-rash-native.desktop.in", "portable.txt"}))
                    else:
                        entries = list(tree(win / "licenses", "engine/licenses"))
                        exe = win / "rr-game.exe" if target == "win32-x64" else RUNTIME / "native-road-static/rr-game"
                        entries.append((exe, "engine/" + exe.name))
                    entries.append((RUNTIME / "road-room.wasm", "engine/room-core.wasm"))
                engines[target] = pack(out, f"{game}-{target}", entries)
            if game == "road":
                entries = disc_files(RUNTIME / "road-disc/files/ROADRASH")
            else:
                source = RUNTIME / "tekken/openkumite-v0.5.1-web/assets"
                if not (source / "manifest.json").is_file():
                    raise ValueError("Bind the Tekken disc first.")
                entries = tree(source, "assets")
            games[game] = {"platforms": engines, "data": pack(out, game + "-data", entries)}
    catalog = {"release": args.release, "games": games}
    (out / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")


if __name__ == "__main__":
    main()
