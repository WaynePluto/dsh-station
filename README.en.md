# DSH Station (dsh-station)

[简体中文](README.md) | **English**

Bundled dsh: `0.1.7-rc.2` (next channel, developer preview)

A complete workstation for the official DeepSeek Harness (dsh). The desktop app bundles dsh and works out of the box; remote access is built in but optional, off by default — enable it when you want it.

- Bundles dsh: no separate install, and upgrading dsh-station upgrades dsh
- No forks or patches to dsh; all extras ship as plugins. dsh's own 40 official UI plugins work unchanged, plus 20 bundled components (model, conversation, and development enhancements)
- Desktop-only is the complete product: the first launch needs no account and touches no remote setup
- Remote is opt-in: exposed machines listen on no public port and dial out instead, so no router port forwarding; every non-loopback browser visit requires login (password + TOTP)

Every machine running dsh-station is identical: its own dsh, a console, and a dialer. Once remote is on, the only difference is which machine you treat as the entry machine — the one your browser actually opens.

## Requirements

| | Requirement |
|---|---|
| OS | Windows / Linux / macOS |
| Node.js | **22.19+ for the lite editions and the server zip** (LTS from [nodejs.org](https://nodejs.org); check with `node -v`); **the desktop full edition bundles its own Node — no install needed** |
| Network | Exposed machines must reach the entry machine; the entry machine must be reachable if it is on the public internet |
| dsh | **Not needed** — bundled in the package |

## Install

Download the media for your platform from [Releases](../../releases) (dsh is included). There are four release targets: the Windows / macOS / Linux desktop apps and the Linux server zip. Every medium comes in lite / full variants, and each desktop target further ships in setup (installer) and portable zip forms:

| Feature | lite | full |
|---|---|---|
| dsh core features | ✅ | ✅ |
| Office document preview | ❌ | ✅ |
| Node runtime | ❌ | ✅ (bundled v24.21.0) |

| Release target | setup (installer) | portable zip |
|---|---|---|
| Windows desktop | `…-desktop-<variant>-setup.exe` | `…-desktop-<variant>.zip` |
| macOS desktop | `…-desktop-<variant>.dmg` (drag to Applications) | `…-desktop-<variant>.zip` (contains .app) |
| Linux desktop | `…-desktop-<variant>.deb` | `…-desktop-<variant>.zip` |

The fourth target is the Linux server zip (`…-linux-x64-server-<variant>.zip`): for headless servers, unpack and run `./start.sh`; it always requires system Node ≥ 22.19.0 and carries no Node binary.

- The lite edition does not bundle Node.js — install 22.19+ yourself before starting it; the full edition bundles a pinned Node and works out of the box
- Installers and executables are unsigned; SmartScreen / Gatekeeper may warn about an unknown publisher
- The macOS app is not notarized; allow it under System Settings → Privacy & Security on first launch

> Packages are per-platform because dsh's dependencies ship prebuilt platform binaries; dsh-station's own code has zero native modules.

### Bundled functional plugins

On the first start of the `dsh-station-web` profile, dsh-station uses dsh's official plugin manager to install and enable 10 bundled third-party Bundles containing 20 components: four grouped packages (remote experience, model enhancements, conversation enhancements, development tools) plus six standalone packages (directory picker, proxy, concise mode, global instructions, files, fixed YOLO).

- A grouped package can be disabled or uninstalled as a whole, and its component rows can normally be disabled independently. The model catalog and model capabilities components share the `llm-pi-ai` startup barrier and must not be disabled separately for now
- The browser directory picker is standalone because it must statically override dsh's native picker
- Upgrading dsh-station also upgrades every bundled package that is still installed, including disabled ones, while preserving disabled states
- Uninstalling is remembered: neither the launcher nor the tray restores the package. To reinstall the version shipped with the current release, use dsh's "Add plugin" action with the absolute path `<unpacked-directory>/plugins/<package-directory>`, then enable that Bundle
- If an older profile still has third-party packages no longer shipped, remove them manually through dsh's official plugin manager; the launcher does not clean up those entries or change other profiles
- Under Settings → Proxy, choose Follow environment (default), Use plugin proxy URL, or Force direct. The policy covers native fetch and official web fetching, not necessarily subprocesses or independent network libraries
- To pan a zoomed image preview, hold Space and drag with the left mouse button over the image scroll area; real-browser verification is still pending
- The connection webServer injection is a mandatory shell-level overlay. It underpins browser RPC and is not a user-disableable plugin

Or build the exact same package from source:

```bash
git clone <this-repo-url> dsh-station
cd dsh-station
pnpm install
pnpm release
```

Release commands are split per release target × variant: `pnpm release:win:lite` / `pnpm release:win:full` (mac/linux likewise; `release:linux:<variant>` also packs the matching server zip). To pack only the server zip — including from a non-Linux machine — use `release:linux-server:<variant>`; it runs on any platform. `pnpm release` packs everything the current machine can produce: host desktop both variants plus the Linux server zip. The unified entry is `scripts/release.mjs`: it builds once and chains the two packers; `--skip-build` reuses dist.

The full edition downloads its bundled Node (~30 MB per platform) on the first pack and caches it under `.dev/desktop-toolchain` afterwards; in China, set `DSH_STATION_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node` to use a mirror. Stick to the `:lite` commands to skip the download entirely.

The desktop shell is a Wails 2 (Go) app and depends on the system WebView/CGO toolchain, so it can only be built on its own platform; the release workflow's native runners cover the rest. Packing requires pnpm ≥ 10: use whatever you have installed locally, CI pins 10.17.0 for reproducibility.

## First start

**Desktop**: install (or unpack) and launch — the app window is the dsh workbench. The shell is a Wails 2 (Go + system WebView) single-window app that spawns and supervises the local background processes. Local use needs no account; quit from the tray menu. When you want the remote capability, the first visit to the "Remote admin" page walks you through creating the admin, password, and TOTP (see [Remote capability (optional)](#remote-capability-optional)).

**Linux server zip**: unpack on the machine you want as the entry machine and run `./start.sh`. There is no admin account yet on the first start; the terminal prints an address like `http://127.0.0.1:30809` — open it in a browser to finish setup (three steps under [Enable remote entry](#enable-remote-entry)). Headless servers can use the [CLI init flow](deploy/README.md) instead.

> **Local-only? You're done here.** Everything dsh offers plus the 20 bundled components is in the local workbench — no account, no remote configuration. Come back to the next section when you want the remote capability.

## Remote capability (optional)

Once enabled, a phone, tablet, or another computer's browser can keep directing this machine. With several machines, pick one as the entry machine and expose the rest through it — whichever machine the browser opens is the machine being directed.

### How it connects

> Each machine runs its own dsh; file access and command execution happen locally on that machine. Opening pc2's page directs pc2's dsh working on pc2's code; pc1 only forwards. Choosing a machine = choosing where your code runs.

```
                    ┌──────────────────────────────────────┐
   phone /          │  pc1 (entry machine, e.g. a VPS      │
   tablet    ───>   │  or an always-on home computer)      │
   browser          │                                      │
                    │   console  ←── login, routing, list  │
                    │      ↑  ↑                            │
                    │      │  └──> pc1's own dsh           │
                    └──────┼───────────────────────────────┘
                           │
              reverse tunnel (dialed out by the exposed machine,
                           no public IP needed)
                           │
              ┌────────────┴────────────┐
              │                         │
      ┌───────┴────────┐       ┌────────┴───────┐
      │  pc2            │       │  pc3           │
      │  dialer ──> dsh │       │  dialer ──> dsh│
      └────────────────┘       └────────────────┘
      office desktop                 home laptop
```

- The relation is one-way: pc1 can open pc2, but pc2 cannot open pc1; any machine can act as the entry
- Exposed machines need no public IP and no port forwarding
- Without a public domain, each attached machine gets a fixed port on the entry machine (e.g. `http://10.1.2.87:30810` is pc2). Once the entry machine sets `relay.domain` behind a wildcard-domain TLS proxy, subdomains like `https://pc2.your-domain` take over — new machines need no new DNS or proxy config (recommended for the public internet; see the [deployment guide](deploy/README.md))
- dsh only ever listens on `127.0.0.1`; every outward-facing door is guarded by the console

### Enable remote entry

Open the admin console for the first time (the desktop app's "Remote admin" page, or the setup address the server zip printed) and complete three steps on that machine:

1. Pick the account name (defaults to `admin`; letters, digits, `. _ -`) and set the admin password: at least 6 characters, using at least 3 of upper case, lower case, digits, symbols
2. Scan the QR code with an authenticator app (Microsoft / Google Authenticator, 1Password, …)
3. Enter the 6-digit code to confirm

Access from your phone or any other computer then uses that account name with the password and TOTP code. If you forget the name, the console's "Account" page shows it.

> 🔒 The setup wizard is loopback-only (`127.0.0.1`). Anyone else on the LAN only sees "finish setup on that machine" and cannot hijack the admin account. On a headless server the wizard is out of reach — see "Emergency" below.

Restart once and every access address is printed: the server zip prints to the terminal, the desktop app shows them on its "Remote admin" page.

```
  ✓ Node v22.19.0
  ✓ dsh ready            127.0.0.1:3080
  ✓ pc1 console running  0.0.0.0:30809
  ○ no remote entry      pc1 reachable from localhost and LAN only

  ┌────────────────────────────────────────────────────┐
  │  local console  http://127.0.0.1:30809   no login  │
  │  LAN access     http://10.1.2.87:30809   login     │
  └────────────────────────────────────────────────────┘
```

On the machine itself, `http://127.0.0.1:30809` is login-free; loopback only, and the address stays even after a public domain is configured. dsh's own address is never advertised — always go through the console, which handles the token exchange dsh has required since 0.1.2. `Ctrl+C` in the terminal shuts all three processes down together.

### Attaching a second machine

1. Start dsh-station on pc2 too. It will say "no remote entry" — expected; leave it running
2. On pc1, open `http://127.0.0.1:30809/_admin`, enter pc2's machine name under "expose another machine via pc1", and issue a token. The page shows a copy-paste command. With a public domain configured the command uses `wss://dsh.example.com` — even when issued from the loopback page on pc1 itself, the loopback address is never sent to pc2:
   ```
   dsh-station-connector --relay ws://192.168.1.10:30809 --slug pc2 --enroll-token xxxxx --hub-authority 192.168.1.10
   ```
3. On pc2, open the console's "Remote entry" page (`http://127.0.0.1:30809/_admin/hub`) and paste the whole command into the only input box

pc2 connects immediately, no restart, and gets a fixed port on pc1; from pc1's address plus that port you are now driving dsh on pc2.

> The token is single-use and valid for 5 minutes. Once pc2 registers its device public key, the token is deleted and never shown again — issue a new one if it expires.
>
> pc2's dsh restarts automatically once to trust pc1's address (the "Remote entry" page shows the progress). Day-to-day access in public-domain mode is then `https://pc2.your-domain`; the entry machine itself keeps `http://127.0.0.1:30809` or `https://pc1.your-domain`.
>
> Canceling the remote entry needs no new token: the "Remote entry" page remembers the last hub, and "Reconnect" attaches it again; the entry machine's "Machines" page marks it "disconnected · wakeable", and "Request online" brings it back within about a minute. Only after the entry machine has run "stop and remove" on it do you need to issue and paste a new token.

### Day-to-day

Everything happens in the browser. The console at `/_admin` has three tabs; each page is headed "you are managing pc1", since consoles on different machines look identical:

| Tab | Path | What it manages |
|---|---|---|
| Machines | `/_admin` | machines exposed via this one; enrollment tokens |
| Remote entry | `/_admin/hub` | which machine this one is attached to; set / cancel / one-click reconnect |
| Account | `/_admin/account` | change password, reset authenticator |

| To do this | Go here |
|---|---|
| See which machines you can open | "Machines" |
| Expose one more machine | "Machines" → "expose another machine via …" |
| Call back a stopped machine | "Machines" → "Request online" on a disconnected machine; it reconnects within about a minute |
| Stop a machine and detach it | "Machines" → "stop … and remove" — dsh-station on that machine exits entirely; offline machines can only be "removed", which cannot stop anything still running on them |
| Set / cancel this machine's remote entry | "Remote entry" |
| Reattach to a previously canceled entry | "Remote entry" → "Reconnect" — no new token; only needed again after the other side ran "stop and remove" |
| Change password / new phone for authenticator | "Account" |
| See what happened recently | There is no such page in the UI — see "Security" below |

#### Emergency: if the web UI is unreachable

Only for two situations: first deployment on a headless server, or both password and authenticator lost.

```bash
node dist/relay.js init          # create the admin (first server deployment)
node dist/relay.js passwd        # reset the admin password
node dist/relay.js totp reset    # reset the authenticator, re-scan
```

> Run these inside the unpacked package directory; in the source repo the equivalents are `pnpm relay:init` / `pnpm relay:passwd` / `pnpm relay:totp-reset`.
>
> These commands do not ask for the old password. Anyone who can run commands on the machine can already read the database file directly; what you must guard is login to the machine itself. On a VPS the setup wizard is loopback-only and unreachable from your local browser — create the admin with `init`, or borrow the wizard over the SSH port forwarding below.

For a first deployment you can also skip `init` and open an SSH tunnel from your own computer:

```bash
ssh -L 30809:127.0.0.1:30809 user@server
```

While the tunnel is up, open `http://127.0.0.1:30809` in your local browser. The request lands on the server's loopback interface, so the wizard admits it and you can scan the QR code as usual. Open exactly that `127.0.0.1:30809` address — the Host header must stay loopback to remain login-free. The wizard is one-time: disconnect the tunnel once setup is done and use the server's public address day to day.

## Security

Enabling the remote capability hands this dev machine to a browser. Read this once before you do; the fixed YOLO bullet applies to local use as well:

- Never expose it to the public internet without HTTPS. Plain HTTP on the LAN is an accepted trade-off (a loud warning is printed at startup); on the public internet, put HTTPS in front (Caddy or similar with automatic certificates)
- dsh itself has no authentication and only listens on `127.0.0.1`; the console is the only door. A compromised console account equals a compromised machine: whoever can start a session can run commands
- Five failed logins lock the account for 15 minutes
- The default is fixed YOLO mode: `dsh-station-web` hides the permission selector; `bash` / `pwsh` / `write` / `edit` run with the dsh process user's permissions and legitimate approval requests are allowed automatically. Disable the `yolo-mode` plugin and restart dsh to restore dsh's native permission protection. `ask_user_question` still asks you questions
- Linux systemd deployments run as your own unprivileged user and default to that user's home directory; admin tasks go through explicit sudo commands in the interactive terminal, keeping the system sudo cache but never opening a persistent root shell. Runtime data lives in `~/.dsh-station`, official dsh data in `~/.dsh` — see the [deployment guide](deploy/README.md)
- Security records are not in the web UI. Login attempts, machine attach/remove, password/authenticator changes are written to both the relay log (JSON lines with `"audit":true`) and the `audit_log` table in `relay.db`, never auto-expiring; inspect them on the machine running the relay
- Threat model and accepted trade-offs: [docs/04-security.md](docs/04-security.md) (Chinese)

## Troubleshooting

| Symptom | Cause |
|---|---|
| Node version too low | Install 22.19+ |
| Works locally, not from the LAN | Firewall. Windows: `New-NetFirewallRule -DisplayName "dsh-station" -Direction Inbound -LocalPort 30809 -Protocol TCP -Action Allow` |
| Correct password rejected | Check the startup log for a "pre-scrypt password hash" warning; if present, reset the password once on the local admin page |
| 403 on an attached machine's page | That machine's dsh doesn't trust the entry machine's address yet. After pasting the command its dsh restarts automatically and trusts the new address; if its "Remote entry" page reports the automatic restart failed, restart dsh-station on that machine as the page instructs |

## Local development and debugging (for developers)

`pnpm run dev` is a development stack, not an installation method. It builds the functional plugins, generates installable media under `.dev/plugins/`, and prepares a dependency-fingerprinted dsh runtime beside the repository. That runtime has no same-name workspace plugin anchor, so dsh actually loads the third-party Bundles installed into the profile. The stack then runs the same first-install, upgrade, disable, and uninstall-memory lifecycle as a release and prints the `.dev/plugins/` reinstall path.

The relay database, device key, membership, and JWT secret reuse the release default `~/.dsh-station`; dsh settings, profiles, and sessions use the standard `~/.dsh`. Do not run the dev stack and an installed release at the same time: they contend for ports and share device identity. `pnpm start` only runs existing build artifacts — it does not do the plugin build, media generation, or runtime preparation of `pnpm run dev`.

```powershell
pnpm run dev   # build plugins, generate .dev/plugins, prepare the isolated dsh runtime, and start the source stack
pnpm start     # run existing dist artifacts after the development media/runtime have been prepared
```

A plugin uninstalled during development is not restored automatically; reinstall it from `<repository>/.dev/plugins/<package-directory>`. On Windows, if the repository and profile are on different drives, the bundled pnpm proxy maps that source to a profile-local media mirror so the installed link stays valid; the install path to enter is still the `.dev/plugins` one. Development conventions and the usual checks live in [AGENTS.md](AGENTS.md) (Chinese).

## Docs (for developers, in Chinese)

| Doc | Contents |
|---|---|
| [AGENTS.md](AGENTS.md) | conventions and hard rules for AI assistants |
| [docs/README.md](docs/README.md) | documentation navigation and maintenance rules |
| [docs/plugins.md](docs/plugins.md) | plugin features, entry points, and package READMEs |
| [docs/01-decisions.md](docs/01-decisions.md) | current decisions, terminology, and product boundaries |
| [docs/02-dsh-facts.md](docs/02-dsh-facts.md) | verified dsh source facts (each with file paths) |
| [docs/03-architecture.md](docs/03-architecture.md) | components, tunnel protocol, request flow |
| [docs/04-security.md](docs/04-security.md) | auth design, threat model, accepted risks |
| [docs/05-roadmap.md](docs/05-roadmap.md) | milestones and acceptance criteria |
| [docs/06-packaging.md](docs/06-packaging.md) | release media, launcher, dependencies |

## Status

The desktop workstation, the tunnel, authentication, release media (four desktop targets + the Linux server zip), and the 20 functional plugin components are implemented. The Windows desktop app has passed real-machine checks of its core flow; macOS/Linux desktop acceptance is still pending. Remaining plugin distribution and device checks are tracked in [docs/05-roadmap.md](docs/05-roadmap.md) (Chinese).

| Item | Value |
|---|---|
| dsh version | `0.1.7-rc.2` (next channel, developer preview, **breaking changes expected**) |
| dsh Node requirement | `^22.19.0 \|\| >=24.0.0` |
| Runtime policy | the Linux server zip and desktop lite editions use the system Node; desktop full editions bundle a pinned Node (verified against official SHA-256) |
| Native modules | zero in our own code (scrypt from Node core); dsh ships prebuilt per-platform binaries, hence per-platform packages |

## License

[MIT](LICENSE) © dsh-station contributors
