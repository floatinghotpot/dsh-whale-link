# Changelog

All notable changes to this project are documented in this file. Versions
follow [Semantic Versioning](https://semver.org/).

## [0.16.0] — unreleased

First standalone release under the WhaleLink name.

### Added

- **Settings → WhaleLink** panel: join, disconnect, revoke, live status.
- Two ways to join: paste a one-time auth token, or scan a QR code with the WhaleLink app.
- LAN direct listener (default port `8442`, ticket-gated) with automatic relay fallback.
- Optional host access code, on/off at any time.
- Diagnostics & repair: lock holder, other plugin installs on this machine, force unlock.
- The plugin pins DSH's directory picker to the in-app browser, so directory picking works from a remote browser.

### Notes

- Functionally equivalent to `dsh-web-remote` `0.15.0`.
- Runs against `rdsh-gateway` `^0.18.0`.
- Must **not** be installed beside `dsh-web-remote` in the same DSH profile.
