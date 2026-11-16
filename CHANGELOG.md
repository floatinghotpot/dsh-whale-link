# Changelog

All notable changes to this project are documented in this file. Versions
follow [Semantic Versioning](https://semver.org/).

## [0.17.0] — 2026-11-16

### Breaking

- Requires **DSH `0.2.2-rc.2` or newer** (`engines.dsh`); DSH `0.2.2-rc.2`
  removed `Connection.requestRejection` and `Connection.authenticatedUrl`.
- Route admission now comes from DSH's WebServer policy (`auth: 'required'`)
  instead of the removed `Connection.requestRejection` call. Source/Origin
  checking itself is unchanged — both paths use DSH's own fence.

### Changed

- The tunnel and LAN-direct ports authenticate to the local DSH with a
  per-process owner credential registered as a standard Connection
  authentication provider, instead of exchanging DSH's launch token for a
  browser-session cookie.
- Runs against `rdsh-gateway` `0.18.1` (pinned exact in `package.json`), the
  gateway release whose tested DSH window extends to `0.2.2-rc.3`.

### Fixed

- DSH Desktop `0.2.2-rc.2`/`0.2.2-rc.3` no longer crashes at startup with
  `TypeError: connection.requestRejection is not a function`.
- A failing `/remote-access` request can no longer surface as an unhandled
  rejection that DSH reports as `fatal load failure` and exits on.
- Joining from `0.2.2-rc.2`+ no longer logs `llm provision skipped
  (settings/describe failed)`. Remote access keeps its authentication now that
  the launch-token exchange is gone.

### Docs

- `docs/COMPATIBILITY.md` (and its Chinese counterpart) lists which plugin
  release runs on which DSH, including the `0.16.x` line for older DSH.

## [0.16.0] — 2026-11-12

First standalone release under the WhaleLink name.

### Added

- **Settings → WhaleLink** panel: join, disconnect, revoke, live status.
- Two ways to join: paste a one-time auth token, or scan a QR code with the WhaleLink app.
- LAN direct listener (default port `8442`, ticket-gated) with automatic relay fallback.
- Optional host access code, on/off at any time.
- Diagnostics & repair: lock holder, other plugin installs on this machine, force unlock.
- The plugin pins DSH's directory picker to the in-app browser, so directory picking works from a remote browser.
- A restart notice at the top of the panel — plus one automatic diagnostics run — when the host's directory picker is still the native OS dialog (the state right after installing while DSH is running).

### Notes

- Functionally equivalent to `dsh-web-remote` `0.15.0`.
- Runs against `rdsh-gateway` `0.18.0` (pinned exact in `package.json`).
- Must **not** be installed beside `dsh-web-remote` in the same DSH profile.
