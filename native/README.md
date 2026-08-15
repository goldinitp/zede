# Zede (native)

The Rust rewrite of Zede — a Claude-first terminal. GPU-rendered (Metal via
wgpu), single binary, no Node/Electron at runtime.

## Build from source

Requires only the Rust toolchain (plus Xcode Command Line Tools on macOS,
which you almost certainly have):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # once
cd native
cargo run --release
```

The first build compiles ~500 crates and takes a few minutes; incremental
builds are seconds. The binary lands at `target/release/zede` and is fully
self-contained (SQLite is compiled in; there are no native-module or signing
steps). Locally built binaries run without notarization.

## Checks

```bash
cargo test            # unit tests
cargo run -- --selftest   # headless end-to-end checks (PTY, grid, db, keys)
```

## Where things live

- App state: `~/Library/Application Support/ZedeNative/zede.db` (macOS).
  The `Zede` directory belongs to the Electron app; the native app refuses to
  touch its database (import lands in P6). `ZEDE_DATA_DIR` overrides the
  location (handy for testing).
- Plan and porting notes: [PLAN.md](./PLAN.md)
