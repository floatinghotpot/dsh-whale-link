# Contributing

Thanks for taking the time to contribute.

## Before you start

- **Bugs and feature requests**: open an issue. Say which hub you used (the hosted WhaleLink service, or a self-hosted [remote-dsh](https://github.com/floatinghotpot/remote-dsh) hub) and which DSH build, because this plugin only works against a hub.
- **Never install this package next to `dsh-web-remote` in the same profile.** Both patches pin the directory picker, and the loader rejects the duplicate row — DSH will not boot. `dsh-web-remote` is this plugin's previous package name, so when you switch, remove the old package first and install the new one:

  ```bash
  dsh plugin --profile <name> remove dsh-web-remote
  dsh plugin --profile <name> add dsh-whale-link
  ```

  Restart DSH afterwards. The host config and token live in `~/.rdsh/`, independent of the package name, so the existing host joins again on its own.

## Development setup

Requires Node.js ≥ 22 and pnpm ≥ 9. The test suite runs `.ts` files directly through Node's type stripping, so `pnpm test` needs Node ≥ 22.18 (or `--experimental-strip-types`).

```bash
pnpm install
pnpm build     # tsc, strict
pnpm test      # node --test
```

The browser half (`client.js`) is a hand-written `window.__ModuleLoader__` module — there is no bundler, so edit it directly and keep it valid as-is.

## Pull requests

- **Surgical changes**: touch only what the fix needs; no drive-by reformatting.
- **Zero defects**: `pnpm build` must pass with zero TypeScript errors. `client.js` must stay free of syntax errors.
- **Tests**: add or adjust tests under `test/`; `pnpm test` must be green.
- **Commit messages**: English, Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …), one concern per commit.

## Relationship to upstream

The implementation is maintained in the [remote-dsh](https://github.com/floatinghotpot/remote-dsh) project and mirrored here under a second package name, so the two editions stay identical. A fix that changes behavior should be proposed upstream first; a maintainer then brings it into this edition.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
