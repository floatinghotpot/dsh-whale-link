# WhaleLink for DSH

**Secure remote access to your DSH agent — from any browser or the WhaleLink app. No public IP, no port forwarding, end-to-end encrypted.**

`dsh-whale-link` is a plugin for **DeepSeek Harness (DSH)**. Once installed, DSH's **Settings** gain a **WhaleLink** panel that joins this computer to a hub you control (or the hosted WhaleLink service), so the DSH running on this machine can be reached from anywhere.

**Other languages**: [简体中文](README.zh.md)

---

## Status

Pre-release (`0.x`). Features and internals may still change before `1.0`; the plugin tracks the DSH plugin API and the `rdsh-gateway` runtime it depends on.

## Features

- **A panel, not a terminal.** Everything happens in **Settings → WhaleLink**: join, disconnect, revoke, status.
- **Two ways to join.** Paste a one-time auth token from the hub portal, or scan a QR code with the WhaleLink app.
- **LAN direct when possible.** On the same network the plugin listens on a dedicated local port (default `8442`) and serves clients directly — lower latency, higher throughput. Clients on another network fall back to the cloud relay automatically.
- **Pause without losing the binding.** *Disconnect* stops the tunnel but keeps the token; *Revoke* clears the local binding and revokes the host on the hub.
- **Optional access code.** An extra lock that belongs to you alone: anyone reaching this host — including the service provider — must enter it. On/off at any time.
- **Diagnostics & repair.** Lets you see which process holds the tunnel, which other copies of the plugin are installed on this machine, and clear a stale lock.
- **Directory picking works remotely.** The plugin pins DSH's directory picker to the **in-app browser**, because a remote browser can never reach a native OS dialog on the host's screen.

## Requirements

| | |
|---|---|
| DSH | The desktop app, or `dsh web` from a DSH build that supports plugin bundles, the `webServer` prefix route, and `connection.authenticatedUrl` (DSH 0.1.2+) |
| Hub | The hosted WhaleLink service (the panel pre-fills `https://rdsh.cn`), or a [self-hosted hub](https://github.com/floatinghotpot/remote-dsh) |
| `pnpm` | Only needed if you install through the DSH **Plugins** screen |

## Install

- **DSH app**: **Plugins** → install a third-party plugin → enter `dsh-whale-link`.
- **CLI**: `dsh plugin --profile <name> add dsh-whale-link` (the profile is initialized on first use).

After installing or upgrading, **restart DSH**. A directory picker mounted at boot cannot be replaced by a live patch, so the pinned picker only takes effect on the next start.

## Usage

### 1. Join this computer

1. On the hub, create a host (**Add host**) and copy the **Hub URL** and the **auth token** it shows (it is shown once).
2. Open **Settings → WhaleLink**. The server URL is already filled in — change it only if you run your own hub.
3. Paste the **auth token**, optionally set **this host's name**, then click **Connect**.

To join by phone instead: click **Scan to connect**, then scan the QR code with the WhaleLink app (host list → *Scan to add*).

The panel needs exactly one of these: a token, or a scanned binding. Once joined, the token is stored locally so reconnecting later does not require pasting it again.

### 2. Reach it from anywhere

- **Browser**: open the hub URL, sign in, then tap this host in the host list.
- **WhaleLink app**: sign in and tap this host in the host list.

### 3. Day to day

| Action | Effect |
|---|---|
| **Disconnect** | Stops the tunnel; config and auth are kept. Click **Connect** to resume. (LAN direct keeps serving this network while the host stays joined.) |
| **Revoke** | Stops the tunnel, deletes the local binding and token, and asks the hub to revoke this host. The panel returns to *Not joined*. |
| Connection drops | The tunnel reconnects automatically; no action needed. |

### Panel status

| Status | Meaning |
|---|---|
| Not joined | Never joined, or revoked |
| Connecting… / Reconnecting… | Establishing the tunnel, or auto-recovering after a drop |
| Connected | Reachable from outside right now |
| Disconnected (config kept) | Joined before, currently paused |
| Managed by another instance on this machine | The `rdsh` CLI or another DSH is running the tunnel; the panel is read-only |

## Where your data lives

Everything is kept under `~/.rdsh/` (override with `RDSH_CONFIG` for the host config path):

| Path | Contents |
|---|---|
| `host.json` | Host config (`mode`, `hub`, `name`, `accessCode`, compatibility flag) |
| `join-<host>[-<port>].token` | Persisted host token (`0600`) |
| `e2ee-key.json` | Host end-to-end encryption key pair (`0600`) |
| `direct-secret` | Per-host secret for LAN direct tickets (`0600`) |
| `join.lock` | Which process currently runs the tunnel (`0600`) |
| `device-id` | Stable per-device identifier (`0600`) |
| `rdsh-meta.json` | Reported device kind and component versions |

Removing all of them returns the machine to "never joined" — but prefer **Revoke**, which also revokes the host on the hub.

## How it works

- **Server half** runs inside the DSH web process (a Cordis function plugin). It opens an **outbound** tunnel to the hub through [`rdsh-gateway`](https://www.npmjs.com/package/rdsh-gateway) and forwards traffic to the local DSH (`127.0.0.1:<webServer.port>`). No inbound port is opened on the internet.
- **LAN direct** listens on a separate local port (default `8442`) while joined. It is gated by a one-time ticket signed with a per-host secret; the optional access code is an additional layer.
- **Browser half** is a hand-written `window.__ModuleLoader__` module that registers the **Settings → WhaleLink** section and talks to the server half over the plugin's own `/remote-access` RPC route.
- **End-to-end encryption** is carried by the tunnel: the relay forwards ciphertext and cannot read sessions or files.

## ⚠️ Do not install this next to `dsh-web-remote`

This package and [`dsh-web-remote`](https://www.npmjs.com/package/dsh-web-remote) are **the same plugin** under two names (see [NOTICE](NOTICE)). Installing both into one DSH profile breaks DSH:

- both patches insert a `directory-picker` override and a `directory-picker-browse` row, which the loader rejects as `duplicate loader entry id` (duplicate `directoryPicker` service) — **DSH will not start**;
- both expose the same `/remote-access` RPC route and compete for the same machine-level `~/.rdsh/join.lock`.

Pick **one** per profile. To try this package while the other stays installed in another profile, install into a profile of its own and boot that profile:

```bash
dsh plugin --profile whale-link add dsh-whale-link   # initialized on first use
dsh whale-link                                        # boot that profile
```

## Security notes

- **Only your account gets in.** Joining does not "open a door": a host is reachable by the account that owns it (and by anyone you explicitly share it with).
- **Transport is encrypted end to end.** The relay sees connection metadata, not your conversations or files.
- **A local lock you control.** The optional access code is verified on this host, so even the operator of the hub cannot get past it.
- **Nothing persists when you revoke.** *Revoke* removes the local binding and token, and revokes the host on the hub side.
- The plugin never opens an inbound public port. The tunnel runs only while joined. The LAN listener keeps serving your local network while the host stays in join mode (it is ticket-gated, and additionally code-gated when an access code is set).

## Development

Requires **Node.js ≥ 22** and **pnpm ≥ 9**.

```bash
pnpm install
pnpm build     # tsc (strict)
pnpm test      # node --test
```

| Path | Contents |
|---|---|
| `src/index.ts` | Server half: tunnel lifecycle, direct listener, RPC dispatch |
| `src/rpc-route.ts` | The `/remote-access` prefix route and its envelope |
| `src/lock-diagnostics.ts` | Lock-holder classification and install scanning |
| `client.js` | Browser half: the Settings section |
| `cordis.patch.yml` | Bundle patch: mounts the plugin row and pins the directory picker |
| `locale/` | `meta.title` / `meta.description` for the DSH plugin pages |
| `icon.svg` | Plugin icon |

Runtime dependency: `rdsh-gateway` (`^0.18.0`) — the host-side tunnel implementation, published from [remote-dsh](https://github.com/floatinghotpot/remote-dsh).

## License

Code is released under the **MIT License** — see [LICENSE](LICENSE). The **WhaleLink / 鲸语通** name and logo are brand assets and are **not** covered by the MIT grant — see [NOTICE](NOTICE).
