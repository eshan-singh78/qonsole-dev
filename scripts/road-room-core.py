"""Build the native rework's portable room server for a personal installation."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
source = root / '.runtime/road-source'
compiler = source / '.tools/emsdk/upstream/emscripten/em++'
target = Path(sys.argv[1]) if len(sys.argv) > 1 else root / '.runtime/road-room.wasm'
subprocess.run([str(compiler), '-std=c++20', '-O2', '-fwasm-exceptions',
    str(root / 'desktop/native/race-server.cpp'),
    *[str(source / name) for name in ('server/room.cpp', 'server/sealer.cpp', 'src/net/protocol.cpp', 'src/net/loopback_channel.cpp')],
    '-I'+str(source/'server'), '-I'+str(source/'src'), '--no-entry', '-sSTANDALONE_WASM',
    '-sALLOW_MEMORY_GROWTH=1', '-sEXPORTED_FUNCTIONS=_malloc,_room_init,_room_open,_room_close,_room_send,_room_recv,_room_step',
    '-o', str(target)], check=True)
