## ⚠️ After installing, restart DSH

Right after installing or upgrading, the plugin page may report an error such as "directory picker is already registered". Why:

1. DSH's directory picker is a single service (`directoryPicker`) with exactly two implementations: `native` (an OS dialog on the host) and `browse` (browsing inside the page).
2. The `native` dialog is drawn on the host's screen — a remote user on a phone or in a browser can neither see nor click it, so directory picking does not exist for remote sessions.
3. The `auto` chooser resolves to `native` on a desktop build (display present, loopback bind, not SSH), so the plugin must replace it with `browse` at boot — and that replacement can only come from a patch layer, not from a live apply.

**Quit and reopen DSH: the plugin pins the picker back to `browse`, the error disappears, and remote sessions can pick directories again.**

## Compatibility

This release needs **DSH `0.2.2-rc.2` or newer**. It supports both authentication generations — the `0.2.2-rc.x` release line (launch-token session cookie) and DSH `0.2.3`+ (Connection authentication providers) — so no version pin is needed between them. On an older DSH install `dsh-whale-link@0.16.0` instead: `0.17.x` stays inactive there, and `0.16.x` exits DSH at startup on `0.2.2-rc.2` and later.

Which release runs on which DSH: `docs/COMPATIBILITY.md` (Chinese: `docs/COMPATIBILITY.zh.md`). This page renders a relative link as plain text; the file ships inside the installed package.

## Join

1. Open **Settings → WhaleLink**, click **Scan to connect**, and scan the QR code with the WhaleLink app (**Remote Agents → Scan to add**);
2. Or use a token: copy the **server URL** and **auth token** from **Add host** on WhaleLink's web portal, paste them into the panel, and click **Connect**.

## Note

If you have the old package `dsh-web-remote`, remove it before installing this one — they cannot share a DSH profile.
