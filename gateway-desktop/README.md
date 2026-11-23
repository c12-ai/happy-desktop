# Karis Workbench (desktop)

A Mac app that opens Happy Gateway servers: one window per server, showing the
web interface that server already serves. People sign in on the gateway's own
page, with the same account and session rules as in a browser. It is a separate
app from `packages/happy-desktop-electron` and shares no code with it, only the
Electron and electron-builder versions this repository's lockfile pins.

- **Servers.** On first launch the Servers window offers `www.karis.ink`; any
  other `https://` name can be added (File → Servers…). An address is accepted
  only as a plain origin (no path, user name, IP address or plain http), and
  only once the server answers `/healthz` as a gateway over a certificate the
  Mac trusts. A name that forwards to another (`karis.ink` to `www.karis.ink`)
  is added as the name it forwards to.
- **Separation.** Each server has its own cookie store, named from a hash of
  its origin, and its own window. Its pages may load only that origin over TLS;
  every other address opens in the default browser, and requests to any other
  host are refused whatever the page asks for. Server pages have no preload and
  no bridge into the app.
- **Via SSH.** An SSH alias and gateway/local ports open a loopback forward with
  the system's `/usr/bin/ssh`, fixed options and existing config/agent/known_hosts.
  The required pasted SHA-256 certificate fingerprint must match before any
  HTTP request. Its session accepts only that pin and exact localhost origin;
  normal HTTPS sessions retain system trust. SSH sessions are named by alias,
  both ports and fingerprint, so certificate rotation starts a fresh session.
  Closing the last server window stops its tunnel; startup cleans up only exact
  recorded orphan SSH processes owned by this user. Use a dedicated SSH alias
  without additional forwards. The app never reads or writes SSH keys itself.
- **Nothing else.** No updater, no analytics, no local agent, no URL schemes.
  The spellchecker is the system's on macOS; elsewhere it is off, because
  Chromium would download dictionaries from Google. The app refuses to start
  with any command-line switch that would accept an untrusted certificate.

## Build

```sh
node gateway-desktop/build.mjs --platform mac --arch arm64,x64 --electron-dist <dir>
node gateway-desktop/build.mjs --platform linux --arch x64 --electron-dist <dir>   # for the checks
```

`<dir>` holds `electron-v<version>-<platform>-<arch>.zip`, already checked
against the `checksums.json` of the `electron` package the lockfile installs;
the build downloads nothing. The Mac app is signed ad hoc (with `codesign` on
a Mac, otherwise `rcodesign`, named by `RCODESIGN`) and zipped with its
symlinks kept. Output: `gateway-desktop/release/Karis-Workbench-<version>-<arch>-mac.zip`.

The build refuses a packaged app with an update feed, with any file it does
not need, with a string from a list of upstream servers, updaters, analytics
and global certificate exceptions, or with Electron fuses other than those it sets.
Exactly one certificate verification site is allowed for pinned SSH sessions;
the only subprocess programs are `/usr/bin/ssh` and `/bin/ps`.

The icon is a placeholder: `assets/icon-source.svg`, put on upstream's rounded
tile. Replace that file (any square artwork) and rebuild.

Checks: `pnpm --dir packages/happy-desktop-electron exec tsc -p ../../gateway-desktop/tsconfig.json`,
`oxfmt --check gateway-desktop` and `oxlint gateway-desktop`. The behaviour is
checked against a real gateway by `checks/mac-desktop.mjs` in Happy Gateway's
repository, with additional real-SSH lifecycle and certificate-rotation checks.
