# Development and validation

[Quickstart](../README.md) · [Usage](usage.md) · [Security](security.md) · [Development](development.md)

Run checkout-relative shell commands from the repository root. These guides track repository source; released packages may lag.

## Development and tests

```bash
npm ci --include=dev --ignore-scripts
npm run typecheck
xvfb-run -a npm test # unit, package contents, native TUI/factory load
xvfb-run -a npm run test:integration
```

The factory suite uses the pinned development Pi (a global `pi` is only a fallback).
`npm run test:unit` runs without launching Chromium. CI runs typechecking, the full
factory/TUI suite, packaging checks and local Chromium integration on **Node 22 and
24**. Publishing depends on that same validation workflow. The public-network smoke
remains opt-in; CI uses synthetic cookies, fixtures and a private test keyring.

No live browser in the default suite. Cookie-site and name-filter tests use synthetic SQLite/WAL files;
permission tests cover approval reuse, scope expansion, denial, cancellation, exact
origins, non-interactive refusal and revocation/cleanup. The factory suite verifies
tool wiring and the full native cookie-approval path using a synthetic session: long disclosures, pagination,
default denial, cancellation, remapped keys, resizing and narrow-terminal bounds.
It also exercises cookie-site multi-selection, search, keyboard/mouse input and manual origins.

Run the isolated local Chromium cookie/decoding/TLS/proxy contract tests (synthetic cookies, temporary OpenSSL test certificate, loopback fixtures, no public requests):

```bash
xvfb-run -a npm run test:integration
```

The cookie-import fixture creates a synthetic encrypted Chromium profile and checks
persistent/session cookies, source integrity, origin/name filtering, same-scope reuse
without reimporting or invalidating snapshots, approved scope replacement, denial
preserving the active session, output redaction and logout cleanup. When `gnome-keyring-daemon`, `dbus-daemon` and `gdbus` are installed,
this also creates a private test D-Bus/keyring and verifies libsecret-encrypted `v11`
cookies, not just basic-storage `v10` cookies. It does not read your real browser
cookies or desktop keyring. CI sets `BROWSER_REQUIRE_KEYRING=1` so missing keyring
fixture dependencies fail rather than silently skip. The lifecycle suite also checks
cancelled input, cross-tab stale references, navigation invalidation, snapshot
pagination, image attachments and the agent-directory override.

### Architecture

- `session.ts`: command/action orchestration and approved cookie-profile transactions.
- `runtime.ts`: browser launch, partial-launch cleanup and private run-state files.
- `tabs.ts`: tab/document identity and snapshot-reference lifetime, with typed page fixtures.
- `network-policy.ts`: routed request policy; `pin-proxy.ts` and `cookieless.ts`: transports.
- `snapshot.ts`: immutable, bounded snapshot pagination; `diagnostics.ts`: fixed failure categories.
- `cancellation.ts`: cancellation checks and a queue that retains locks during cleanup.

Optional public-network smoke:

```bash
BROWSER_LIVE=1 xvfb-run -a node --test --experimental-strip-types tests/live.test.ts
```

Run `/reload` in Pi after extension changes to replace the loaded runtime.
