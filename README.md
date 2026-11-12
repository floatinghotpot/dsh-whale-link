# WhaleLink for DSH

**Other languages**: [简体中文](README.zh.md)

## What is WhaleLink

WhaleLink (鲸语通) is a **voice assistant**: talk to your agents instead of typing, and have the replies read aloud. Your agent goes where you go.

- **Speak to type.** Say a sentence and it becomes text in the input box; segments accumulate and can be edited before sending — no mode switching. Choose system recognition or offline on-device recognition, so your voice never leaves the device.
- **Read aloud.** Replies are read automatically; voice and speed are yours to set, so you can listen while doing something else.
- **One place for every host.** Every joined host lives in the same list — no addresses or ports to remember, one entry point however many hosts you have.
- **LAN-direct first.** On the same network it connects directly, for lower latency and less data; elsewhere it falls back to encrypted relay automatically — no config juggling.
- **Reachable from anywhere.** The host opens an outbound tunnel that traverses NAT and firewalls (outbound only), so your phone can reach your machine on any network.

## What this plugin is

`dsh-whale-link` is the **DSH desktop plugin** for WhaleLink — the "join" half: it connects the computer running DSH to WhaleLink (a **WhaleLink** section appears in DSH's Settings). Once joined, that computer shows up in your WhaleLink **host list** alongside your other hosts, and you open it from the app or a browser. Voice input and read-aloud come from the WhaleLink app, not from this plugin.

## Features

- **A panel, not a terminal.** Join, disconnect, revoke and status all live in **Settings → WhaleLink**.
- **Two ways to join.** Paste the one-time auth token from WhaleLink's web portal, or scan a QR code with the WhaleLink app.
- **Pause without losing the binding.** *Disconnect* stops the tunnel and keeps the token; *Revoke* clears the local binding and asks WhaleLink to revoke the host.
- **Optional access code.** A lock that belongs to you alone: anyone reaching this host — including the service operator — must enter it. On/off at any time.
- **Diagnostics & repair.** See which process holds the tunnel, which other copies of the plugin are installed on this machine, and clear a stale lock.
- **Directory picking works remotely.** The plugin pins DSH's directory picker to the **in-app browser**, because a remote browser can never reach a native OS dialog on the host's screen.

## Requirements

| | |
|---|---|
| DSH | **DSH Desktop**, or a command-line DSH (`dsh web`) with plugin support |
| Server | The hosted WhaleLink service (the panel pre-fills `https://rdsh.cn`), or a service you deploy yourself — see [remote-dsh](https://github.com/floatinghotpot/remote-dsh) |
| `pnpm` | Only needed if you install through DSH's **Plugins** screen |

## Install

Two ways; pick the one that matches how you run DSH.

### A. DSH Desktop

In **DSH Desktop**: **Plugins** → **Add plugin** → enter `dsh-whale-link`.

**⚠️ After installing, restart DSH.** Installing or upgrading can make the plugin page report an error such as "directory picker is already registered". Why:

1. DSH's directory picker is a single service (`directoryPicker`) with exactly two implementations: `native` (an OS dialog on the host) and `browse` (browsing inside the page).
2. The `native` dialog is drawn on the host's screen — a remote user on a phone or in a browser can neither see nor click it, so directory picking does not exist for remote sessions.
3. The `auto` chooser resolves to `native` on a desktop build (display present, loopback bind, not SSH), so the plugin must replace it with `browse` at boot — and that replacement can only come from a patch layer, not from a live apply.

**Quit and reopen DSH**: the plugin pins the picker back to `browse`, the error disappears, and remote sessions can pick directories again.

### B. Command line / cloud server / embedded Linux (prefer launching DSH with remote-dsh)

If DSH runs on a cloud server or an embedded Linux box such as a Raspberry Pi, **prefer launching and supervising DSH with [`remote-dsh`](https://github.com/floatinghotpot/remote-dsh)'s `rdsh`** instead of installing this plugin: `rdsh` starts DSH for you and can run as a system service — start on boot, restart on failure.

```bash
npm install -g remote-dsh
rdsh join https://rdsh.cn        # paste the one-time auth token from WhaleLink's web portal
rdsh serve                       # foreground: rdsh starts and supervises dsh web
rdsh service install             # systemd (Linux) / launchd (macOS): start on boot, restart on failure
```

- Start on boot **without a login**: `sudo loginctl enable-linger $USER` (user services otherwise run only while logged in).
- Status and logs: `rdsh service status`, `journalctl --user -u rdsh-join -f`.

If you do want the plugin in the command-line form (managing DSH yourself), install it into the profile and start DSH yourself:

```bash
dsh plugin --profile <name> add dsh-whale-link
dsh --profile <name>            # same as: dsh <name>
```

> One tunnel, one owner: while `rdsh` runs, the plugin panel shows "Managed by another instance on this machine" and stays read-only. Pick one; do not run both.

## Usage

### 1. Join this computer

**Recommended: scan with the WhaleLink app.**

1. In DSH open **Settings → WhaleLink** and click **Scan to connect**;
2. In the WhaleLink app, open the host list, go to **Remote Agents** → **Scan to add**, and scan the QR code;
3. When the panel shows **Connected**, the host is in your host list.

**Or join with a token** (handier when you only have the computer):

1. On WhaleLink's web portal choose **Add host** and copy the **server URL** and the **auth token** it shows (shown once);
2. Open **Settings → WhaleLink**. The server URL is pre-filled; change it only for your own deployment;
3. Paste the **auth token**, optionally set **this host's name**, and click **Connect**.

The token is stored on this machine after the first join, so you will not paste it again.

### 2. Reach it from anywhere

**The WhaleLink app is the recommended way**: sign in and tap this host in the host list — your phone is the entry point, and every host sits in the same list.

On a computer you can also **use a browser**: open WhaleLink's web portal, sign in, and tap this host in the host list. The app and the portal show the same host list.

### 3. Nothing to do day to day

Once joined, there is **nothing to operate**: every time DSH starts, the plugin joins and reconnects automatically; a dropped tunnel recovers by itself, and the panel status is always live.

Only reach for the panel to pause or unbind:

| Action | Effect |
|---|---|
| **Disconnect** | Pauses this connection and keeps config and auth; click **Connect** or start DSH again to resume. (The LAN listener keeps serving your network.) |
| **Revoke** | Unbinds completely: removes the local binding and token and asks WhaleLink to revoke this host (best effort; a failure is reported in the panel); the panel returns to *Not joined*. |

### Panel status

| Status | Meaning |
|---|---|
| Not joined | Never joined, or revoked |
| Connecting… / Reconnecting… | Establishing the tunnel, or auto-recovering after a drop |
| Connected | Reachable from outside right now |
| Disconnected (config kept) | Joined before, currently paused |
| Managed by another instance on this machine | The `rdsh` CLI or another DSH runs the tunnel; the panel is read-only |

## Where your data lives

Everything is kept under `~/.rdsh/` (override the host config path with `RDSH_CONFIG`):

| Path | Contents |
|---|---|
| `host.json` | Host config (`mode`, `hub`, `name`, access code, compatibility flag) |
| `join-<host>[-<port>].token` | Persisted host token (`0600`) |
| `e2ee-key.json` | Host end-to-end encryption key pair (`0600`) |
| `direct-secret` | Per-host secret for LAN-direct tickets (`0600`) |
| `join.lock` | Which process currently runs the tunnel (`0600`) |
| `device-id` | Stable per-device identifier (`0600`) |
| `rdsh-meta.json` | Reported device kind and component versions |

Deleting these is the same as "never joined", but prefer **Revoke** — it also asks WhaleLink to revoke the host.

## How it works

- **Server half** runs in DSH's **plugin host process** (a Cordis function plugin): in DSH Desktop that is the desktop app's main process, and in the command-line form it is the `dsh web` process — the plugin and DSH's server are the same process, and no extra process is started. It opens an **outbound** tunnel to WhaleLink through [`rdsh-gateway`](https://www.npmjs.com/package/rdsh-gateway) and forwards traffic to the local DSH web server (`127.0.0.1:<webServer.port>`). No inbound public port is opened.
- **LAN direct** listens on a separate local port (default `8442`) while joined. It is gated by a one-time ticket signed with a per-host secret; the optional access code is an additional layer.
- **Browser half** is a hand-written `window.__ModuleLoader__` module that registers the **Settings → WhaleLink** section and talks to the server half over the plugin's own `/remote-access` RPC route.
- **End-to-end encryption** is carried by the tunnel: the relay forwards ciphertext and cannot read sessions or files.

## Migrating from the old name `dsh-web-remote`

This plugin used to be called **`dsh-web-remote`**; it is now **`dsh-whale-link`**. They are one plugin with one implementation and **must not be installed into the same DSH profile**:

- both patches disable `directory-picker` and insert a `directory-picker-browse` row, which the loader rejects as `duplicate loader entry id` (duplicate `directoryPicker` service) — **DSH will not start**;
- both expose the same `/remote-access` RPC route and compete for the same machine-level `~/.rdsh/join.lock`.

**If you have the old package installed, remove it first, then install the new one:**

```bash
dsh plugin --profile <name> remove dsh-web-remote
dsh plugin --profile <name> add dsh-whale-link
```

You can also uninstall and install from DSH Desktop's plugin screens. **Restart DSH** afterwards.

**No re-joining needed.** The host config and auth token live in `~/.rdsh/`, independent of the package name; after switching packages the existing host joins automatically, and the panel status and access code are preserved.

## Security notes

- **Only your account gets in.** Joining does not open a door: a host is reachable only by the account that owns it.
- **Transport is encrypted end to end.** The relay sees connection metadata, not your conversations or files.
- **A local lock you control.** The optional access code is verified on this host, so even the service operator cannot get past it.
- **Revoke leaves nothing behind.** *Revoke* removes the local binding and token and asks WhaleLink to revoke the host.
- The plugin opens no inbound public port. The tunnel runs only while joined; the LAN listener keeps serving your local network while the host stays in join mode (ticket-gated, and code-gated when an access code is set).

## Related project

[**remote-dsh**](https://github.com/floatinghotpot/remote-dsh) (code name `rdsh`) is the open-source project behind this system, MIT licensed and public on GitHub:

- **Connection platform**: `rdsh-hub` (accounts, host registration and routing, with a built-in relay) + `rdsh-portal` (the web portal);
- **Host-side gateway**: the `rdsh` command line — the one that turns DSH into a resident service on servers and embedded devices (see Install B);
- **Protocols and public API**: the tunnel protocol and public API docs, for third-party clients;
- `rdsh-gateway`, which this plugin depends on, is published from there.

Start there if you want to deploy the service yourself, or avoid the hosted service.

## Development

Requires **Node.js ≥ 22** and **pnpm ≥ 9**.

```bash
pnpm install
pnpm build     # tsc, strict
pnpm test      # node --test
```

| Path | Contents |
|---|---|
| `src/index.ts` | Server half: tunnel lifecycle, direct listener, RPC dispatch |
| `src/rpc-route.ts` | The `/remote-access` prefix route and its envelope |
| `src/lock-diagnostics.ts` | Lock-holder classification and install scanning |
| `client.js` | Browser half: the Settings section |
| `cordis.patch.yml` | Bundle patch: mounts the plugin row and pins the directory picker |
| `locale/` | `meta.title` / `meta.description` / `meta.detail` for the DSH plugin pages |
| `docs/` | Plugin detail page body (English `DETAIL.md` / Chinese `DETAIL.zh.md`) |
| `icon.svg` | Plugin icon |

Runtime dependency: `rdsh-gateway` — the host-side tunnel implementation, published from [remote-dsh](https://github.com/floatinghotpot/remote-dsh). The exact version is pinned in [package.json](package.json); no range is used.

## License

Code is released under the **MIT License** — see [LICENSE](LICENSE). The **WhaleLink / 鲸语通** name and logo are brand assets and are **not** covered by the MIT grant — see [NOTICE](NOTICE).
