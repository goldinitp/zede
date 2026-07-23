# Packaging & release (M4)

Zede packages with **electron-builder** (`electron-builder.yml`). Native modules
(`better-sqlite3`, `node-pty`) are unpacked from the asar (`asarUnpack: **/*.node`)
so they can be `dlopen`'d at runtime.

## Build commands

| Command | Result |
|---|---|
| `npm run build` | Compile main/preload/renderer → `out/` |
| `npm run selftest` | Build + run the headless self-test (`ZEDE_SELFTEST=1 electron .`) |
| `npm run dist:dir` | **Unsigned** unpacked `.app` in `dist/` — fast, runnable locally, no cert needed |
| `npm run dist` | Full installers (dmg + zip on macOS) |

> Native modules must match Electron's ABI before packaging: `npm run rebuild`
> (wraps `@electron/rebuild` for `better-sqlite3,node-pty`). Confirmed in M0.

## Windows

`electron-builder.yml` declares an NSIS target under `win:`. Because the native
addons (`better-sqlite3`, `node-pty`) can't be cross-compiled from macOS, the
Windows installer **must be built on Windows** — locally or via CI. The
`.github/workflows/build-windows.yml` workflow does this on a `windows-latest`
runner (`pnpm install` → `pnpm run rebuild` → `pnpm run dist`) and uploads the
`.exe` as an artifact; it runs on `workflow_dispatch` and on `v*` tags.

On Windows, `PtyManager.spawn` launches Windows PowerShell (`powershell.exe`,
overridable via `ZEDE_SHELL`) instead of the POSIX login shell. GUI apps inherit
the full user/system PATH on Windows, so no login-shell sourcing is needed; a
claude tab runs `powershell -NoLogo -NoExit -Command "claude …"` so the shell
stays interactive after claude exits, mirroring the POSIX `exec <shell> -il`.

## macOS signing + notarization

`hardenedRuntime: true` + `build/entitlements.mac.plist` are set so a credentialed
build signs and notarizes correctly. These steps **require an Apple Developer ID**
and cannot run without one. Provide via environment:

```
export CSC_LINK=/path/to/DeveloperIDApplication.p12   # or keychain identity
export CSC_KEY_PASSWORD=…
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
export APPLE_TEAM_ID=XXXXXXXXXX
npm i -D @electron/notarize     # the afterSign hook uses it
npm run dist
```

`build/notarize.cjs` (the `afterSign` hook) **no-ops when these vars are absent**,
so an uncredentialed `npm run dist:dir` still yields a runnable (unsigned) app —
you'll just get a Gatekeeper prompt on first launch.

## Entitlements rationale
- `allow-jit` / `allow-unsigned-executable-memory` — V8 JIT under hardened runtime.
- `disable-library-validation` — load the unpacked native `.node` addons.
- `allow-dyld-environment-variables` + `inherit` — `node-pty` spawns the login
  shell and `claude` with the inherited environment.

## Remaining release hardening (tracked)
- Auto-update (`electron-updater`) — feed URL + signing not yet wired.
- Idle `VACUUM` / `PRAGMA optimize` + FTS `optimize` on a timer (launch integrity
  check already runs via WAL + migrations).
- `sqlite-vec`: validate loadable-extension under the **signed** build before
  switching semantic search off brute-force cosine (deferred from M3 on purpose).
