# DSH compatibility

Which DSH release each `dsh-whale-link` release needs, and which releases it was actually booted with.

| Plugin | DSH requirement | Tested with DSH | Notes |
|---|---|---|---|
| `0.17.x` | `>=0.2.2-rc.2` (`engines.dsh`) | `0.2.2-rc.3` | Uses the Connection authentication-provider API that `0.2.2-rc.2` introduced. |
| `0.16.x` | none declared | `0.1.2-rc.1`, `0.1.5-rc.2`, `0.1.7-rc.1`, `0.2.2-rc.1` | No `engines.dsh`, so nothing refuses it. It exits DSH at startup on `0.2.2-rc.2` and later; use `0.17.x` there. |

## How the requirement is enforced

`package.json` → `engines.dsh` is the machine-readable floor. DSH's **Plugin manager** (the Plugins screen) compares it with the running DSH version and refuses an incompatible install or activation. The profile boot itself does not check it.

The `dsh plugin` command forwards its arguments to pnpm and performs **no** compatibility check. On an older DSH it will happily install `0.17.x`, which then stays inactive; on a newer DSH it will happily install `0.16.x`, which crashes at startup. Pin the version yourself when you install from the command line.

"Tested with DSH" is not enforced. It records the versions this repository actually started DSH with; a version missing from that column is untested, not known to be incompatible.

## Installing a release for an older DSH

```bash
dsh plugin --profile <name> add dsh-whale-link@0.16.0
```

In **Plugins**, pick the same version from the version list instead. Restart DSH after installing or changing the version.

## Maintaining this file

- Raise `engines.dsh` only when the new release really stops working on the older DSH — a DSH API it needs was removed or renamed. "Not tested there" is not a reason.
- Add or update this release's row in the same change that touches `engines.dsh`. `test/compatibility-doc.test.ts` fails when the current `<major>.<minor>.x` row is missing or does not state the exact `engines.dsh` range.
- List a DSH version under "Tested with DSH" only after booting DSH with this plugin on it. Never list inferred compatibility.
- DSH `0.2.2-rc.2` counts as the floor because the API arrived there, even though the row's tested column starts at `0.2.2-rc.3`.

## The previous package

`dsh-web-remote` (this plugin's earlier package name, up to `0.15.0`) is no longer maintained; its compatibility history is not carried here. Remove it before installing `dsh-whale-link` in the same profile — both pin DSH's directory picker, and the duplicate row stops DSH from booting.
