# Qonsole

Qonsole is a portable, player-hosted desktop launcher for Tekken 3 and Road Rash for Windows 95. Qonsole owns the room code, guest list and match selection. OpenKumite runs the Tekken fight and the Road Rash rework runs the race. Each computer reads its own game files. Players can stay in the same room between matches. The repository also includes a browser player.

## Play the personal desktop build

Open `dist/Qonsole-Personal/Qonsole.app` on an Apple silicon Mac, or extract `dist/Qonsole-Personal.zip` and run `Qonsole.exe` on Windows x64. Keep the extracted folder together. Both executables use the same adjacent `Games` directory. This personal build includes the converted US PlayStation Tekken 3 disc and all 341 checksum-verified files from the supplied Windows Road Rash disc.

1. Each player opens their local copy and enters a name. The host chooses **Internet** or **Local network** and clicks **Host room**.
2. The host clicks **Copy code**. Friends select the same network mode, paste the code and click **Join room**. When a short code fails, use **Copy connection invite** and paste the entire invite in the same field.
3. For **Tekken 3**, select **Start Tekken 3**. The other player clicks **Join match**. Once both names are in Tekken's lobby, the match host presses Start (Enter on the default keyboard layout) and both select fighters.
4. For **Road Rash**, select **Start Road Rash**, then choose **Mano a Mano** and host a race inside the game. The guest's **Join match** button becomes available when the game creates the race. Confirm the in-game join, pick riders and vote for a course.
5. Close the game or select **Leave match** to return to the party. The room owner keeps Qonsole open. Leaving as room owner closes the entire room. Leaving as match host ends that match.

A room accepts 16 people. Each Tekken match seats two and each Road Rash race seats up to eight. Other room members can host a second match at the same time. A writable installation keeps Qonsole settings and Tekken saves in `Qonsole Data`. The packaged Road Rash engine keeps its portable files in `Games/RoadRash/data`.

### Networking and cost

| Mode | How friends connect | What the host needs |
| --- | --- | --- |
| Local network | UDP discovers the code, then players connect to the host's local WebSocket. The direct invite works on reachable local addresses even if discovery is blocked. | The same reachable LAN and local firewall permission. Works offline. |
| Internet code | PeerJS Cloud introduces the players. Qonsole tries a WebRTC data channel first. The host also returns its iroh invite through signaling so the guest can switch automatically if the data channel stalls. | An internet connection. No service account or project ID. [PeerJS FAQ](https://peerjs.com/client/faq) |
| Internet connection invite | The long invite identifies an iroh endpoint. It can connect directly or forward encrypted traffic through an iroh public relay. | An internet connection. The public relays are free, rate-limited and have no uptime guarantee. [iroh public relay hosting](https://www.iroh.computer/services/hosting) |

The room owner's launcher routes messages between players who share a match. The match host runs the game session. Tekken's rollback engine exchanges inputs over a local UDP adapter. The Road Rash host runs the upstream room and input-ordering code locally, using a WebAssembly build of the C++ server core. Game files stay on each computer. The desktop build has no billing account, cloud deployment or service subscriptions. The host's ordinary internet connection carries the traffic. A service outage or firewall can prevent internet joins.

### Remote cross-play verification

| Game | Machines | What passed on November 25, 2026 (India time) |
| --- | --- | --- |
| Road Rash | Mumbai EC2 Linux and Windows Server, GitHub-hosted Apple silicon macOS | Three automated native riders ran 600 simulation ticks. All three reported the same state hash, `11409676181235700393`, and received official results from the race server. |
| Tekken 3 | Mumbai EC2 Linux, GitHub-hosted Windows desktop and Apple silicon macOS | Linux–macOS, Linux–Windows and macOS–Windows each started a two-player match and synchronized with the same seed on both machines. The test ends at synchronization. Completing a full fight and measuring controller latency are outside its coverage. |

The headless Windows Server completed the Road Rash test. Its Tekken session timed out, so both Windows Tekken pairs ran again on a hosted Windows desktop. The native test uses the same room, networking and game adapters as the launcher. [macOS test run](https://github.com/eshan-singh78/qonsole-dev/actions/runs/45480947827) · [Windows desktop test run](https://github.com/eshan-singh78/qonsole-dev/actions/runs/45484205680)

In a separate test of the packaged apps, Linux hosted a room and Windows and macOS joined with the ten-character code. Both guests saw all three player names and returned to the home screen when the host left. All three repeated the sequence with the full connection invite. [Packaged room test on all three platforms](https://github.com/eshan-singh78/qonsole-dev/actions/runs/45485100905)

### Packages and original game files

The smaller `dist/Qonsole-darwin-arm64.zip`, `dist/Qonsole-win32-x64.zip` and `dist/Qonsole-linux-x64.tar.gz` contain the launcher, networking helper and MIT-licensed OpenKumite engine. Other owners can select their converted Tekken assets in **Game files**, or use the native engine's disc importer on first launch. For Road Rash, supply an installation of the pinned native rework, select its executable and original game-data directory in **Game files**, and select a built `room-core.wasm` or compatible `rr-netd` to host. The personal folder resolves all these paths automatically.

Keep the personal ZIP private. The smaller packages omit original game content and the Road Rash engine. The pinned Road Rash project documents that its owner has yet to select a project license. Both reworks are independent, in-development projects. [OpenKumite release](https://github.com/openkumite/openkumite/releases/tag/v0.5.1) · [Road Rash upstream build and licensing notes](https://github.com/arkits/road-rash/blob/0c1092a68d252ba2ae642f285ee68251eb708312/docs/plans/33b-windows.md)

On Linux x64, extract the tarball and run `./Qonsole` from its folder. OpenKumite needs Vulkan or OpenGL and a working desktop display. For a minimal Ubuntu 24.04 test image, add `libx11-6`, `libx11-xcb1`, `libxcursor1`, `libxi6`, `libxkbcommon-x11-0`, `libasound2t64` and `mesa-vulkan-drivers`. A headless test can use `xvfb-run`.

### Build the desktop player

The packaging workflow runs on macOS with Node 22+, npm, Python 3.12+, Xcode command line tools and `ditto`. It produces a locally signed Apple silicon app and portable builds for Windows x64 and Linux x64.

```sh
npm ci
python3 scripts/native-engines.py
npm run desktop
npm run build:desktop
```

To reproduce a personal package, use the browser setup below to prepare the pinned Road Rash source and Emscripten toolchain, then bind the Tekken disc. Build the standalone native Mac game and portable room core and select your extracted Windows disc directory.

```sh
npm run setup
npm run bind:tekken -- "my-game/Tekken 3 (USA).7z"
cmake -S .runtime/road-source -B .runtime/native-road-static -G Ninja -DCMAKE_BUILD_TYPE=Release -DRR_STATIC_SDL=ON -DBUILD_TESTING=OFF
cmake --build .runtime/native-road-static --target rr-game
python3 scripts/road-room-core.py
python3 scripts/personal-desktop.py --road-assets "/path/to/ROADRASH"
```

The assembly script checks the Windows rework against the pinned upstream GitHub Actions artifact SHA-256. If upstream expires the artifact, pass `--windows-road "/path/to/Road Rash Native"` with your local build of that revision. Use `--output` to choose a fresh folder for a subsequent build. Original discs and generated personal packages are excluded from Git.

## Browser player

| Game | Downloaded engine | Multiplayer |
| --- | --- | --- |
| Tekken 3 | OpenKumite v0.5.1 | The built-in Matchbox-compatible signaling service introduces players in the same room. OpenKumite exchanges inputs over WebRTC and runs rollback locally. [Engine and MIT notice](https://github.com/openkumite/openkumite/tree/v0.5.1) · [Matchbox protocol](https://github.com/johanhelsing/matchbox/tree/main/matchbox_protocol) |
| Road Rash | arkits/road-rash at commit `0c1092a` | The original rework’s `rr-netd` assigns seats, starts races and sends the ordered rider inputs to each client. This setup uses its WebSocket transport on the same origin as the player. [Source](https://github.com/arkits/road-rash/tree/0c1092a68d252ba2ae642f285ee68251eb708312) · [Browser port](https://github.com/arkits/road-rash/blob/0c1092a68d252ba2ae642f285ee68251eb708312/docs/WEB.md) |

### Start the browser player

On this prepared checkout, run `npm start`, then open **http://127.0.0.1:8787**. The server starts the Road Rash room daemon as a child process.

For a new checkout on macOS or Linux, install Node 22+, Python 3.12+, Git, CMake, Ninja, a C++20 toolchain and OpenSSL development libraries. The initial setup requires internet access, several GB of disk space, and time to compile the Road Rash browser engine.

```sh
npm ci
npm run setup
npm start
```

Setup verifies OpenKumite’s release archive against its SHA-256 hash, checks out Road Rash at the pinned Git commit, installs a project-local Emscripten SDK, and builds the Road Rash client and daemon from the same revision. All generated files live under `.runtime/`. To retry a single step use `python3 scripts/setup.py tekken`, `road-source`, `server`, or `web`. The web step needs the source step first, as does the server step.

### Browser import and play

- **Tekken 3.** On this installation, select **Open game** to play, or **Host a match** to create an invite. The other player opens the invite and selects **Join**. Both browsers load the host’s converted PlayStation game data automatically. The host starts the fight in the game room.
- **Binding a disc on a fresh installation.** After setup, run `npm run bind:tekken -- "my-game/Tekken 3 (USA).7z"`, or pass the CUE and all corresponding BIN files together. The command converts the disc under `.runtime/`. Anyone with access to that player can fetch its converted assets. Git ignores the source archive under `my-game/` and the converted files. If the host has no bound disc, the engine offers its individual game-data importer.
- **Road Rash.** Select the supported Windows PC disc ISO or extracted `ROADRASH` folder. The upstream importer verifies 341 reference files and accepts the Windows rerelease documented by the project. Use **Host a match**, then **Host a room** inside the game. The other rider selects **Join** with that six-character code, confirms the in-game invitation, picks a rider and votes for a course.
- Browser imports and saves stay in that browser for this site. The bound Tekken disc stays on the host. [OpenKumite import guide](https://github.com/openkumite/openkumite/tree/v0.5.1#browser-build) · [Road Rash source requirements](https://github.com/arkits/road-rash/tree/0c1092a68d252ba2ae642f285ee68251eb708312#requirements)

### Browser internet play

Both players open the **same HTTPS origin**. Localhost works for a single-machine test. A phone’s localhost points to the phone. To play on separate devices, run the player behind an HTTPS reverse proxy on your own host, forwarding HTTP and WebSocket upgrades (including `/signal/` and `/net`) to port 8787 while preserving the Host header. Alternatively the player can serve TLS directly using a certificate trusted by both devices for that hostname.

```sh
HOST=0.0.0.0 PORT=8787 TLS_CERT=/path/to/fullchain.pem TLS_KEY=/path/to/key.pem npm start
```

The binary race socket and its health port bind to loopback. The browser reaches both through Qonsole. Override `RR_NETD_PORT` and `RR_NETD_HTTP_PORT` together if the default ports 18080 and 18081 are occupied.

For Tekken, STUN helps find a direct peer route. The default is Cloudflare’s public STUN endpoint. Set `STUN_URL` to your own service or the empty string for LAN-only ICE candidates. Some carrier networks and firewalls need TURN. Qonsole accepts a coturn server configured with `use-auth-secret`, a realm and a shared secret. Set the matching `TURN_SECRET` on the Qonsole host and `TURN_URLS` to the relay endpoints, such as `turn:relay.example.org:3478?transport=udp,turns:relay.example.org:5349?transport=tcp`. The browser receives temporary credentials valid for one hour. Keep the player behind access control when sharing your relay with a private group. Road Rash uses the race server through the HTTPS proxy and needs no TURN. The SDKs and protocols have no per-player fee. Server time and internet traffic depend on your host. [WebRTC connectivity](https://webrtc.org/getting-started/peer-connections) · [coturn](https://github.com/coturn/coturn)

### Browser verification

`npm test` exercises room discovery, signaling isolation, peer departure and TURN credentials. With the race daemon built, it also starts an isolated race server, seats two protocol clients, votes for a course and verifies that both clients receive the same two rider inputs. When a Tekken disc is bound, the tests also verify that Qonsole serves its manifest and supports byte-range requests for streaming game data.
