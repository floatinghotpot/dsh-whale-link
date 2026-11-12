## ⚠️ After installing, restart DSH

Right after installing or upgrading, the plugin page may report an error such as "directory picker is already registered". Why:

1. DSH's directory picker is a single service (`directoryPicker`) with exactly two implementations: `native` (an OS dialog on the host) and `browse` (browsing inside the page).
2. The `native` dialog is drawn on the host's screen — a remote user on a phone or in a browser can neither see nor click it, so directory picking does not exist for remote sessions.
3. The `auto` chooser resolves to `native` on a desktop build (display present, loopback bind, not SSH), so the plugin must replace it with `browse` at boot — and that replacement can only come from a patch layer, not from a live apply.

**Quit and reopen DSH: the plugin pins the picker back to `browse`, the error disappears, and remote sessions can pick directories again.**

## Join

1. Open **Settings → WhaleLink**, click **Scan to connect**, and scan the QR code with the WhaleLink app (**Remote Agents → Scan to add**);
2. Or use a token: copy the **server URL** and **auth token** from **Add host** on WhaleLink's web portal, paste them into the panel, and click **Connect**.

## Note

If you have the old package `dsh-web-remote`, remove it before installing this one — they cannot share a DSH profile.
