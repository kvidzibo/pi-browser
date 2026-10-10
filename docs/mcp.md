# Browser MCP service

The same isolated Chromium engine can run as **`pi-browser-mcp`**, a stdio service,
without loading Pi or its browser extension. Node **22.19+** and Chrome/Chromium
are required. Linux uses Xvfb when available, otherwise headless mode.

## Local gateway setup

Use the [MCP gateway's Pi adapter](https://github.com/kvidzibo/mcp-session-gateway),
which supports form elicitation and native UI v1. Pi's built-in MCP client can
browse anonymously but currently has no browser approval/app UI.

```bash
cd /absolute/path/to/pi-browser
npm ci --omit=dev --omit=peer --ignore-scripts
node mcp/cli.mjs  # stdio server; normally started by the gateway
```

There is no build step: Node loads the shipped TypeScript using native type stripping.
The published package also provides the `pi-browser-mcp` executable. Pi packages
are optional peers; the MCP runtime never imports them.

Merge this service into your gateway configuration, preserving other services:

```json
{
  "timeoutMs": 180000,
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/pi-browser/mcp/cli.mjs"]
    }
  }
}
```

Allow enough request time for human consent plus browser startup. The service's
approval timeout is 120 seconds; the gateway and harness deadlines may be shorter.
A cancelled/timed-out started request retires this gateway service: restart it
through **`/gateway` → Connection** before retrying, only with user direction.
Restarting the gateway affects all its services and revokes browser access.

The gateway passes only its minimal default environment and configured `env`.
Explicitly forward the variables you actually need:

- `PI_CODING_AGENT_DIR`: saved profiles and screenshot/run-state storage override.
- `PI_BROWSER_EXECUTABLE`: nonstandard Chromium/Chrome binary.
- `DISPLAY`, `XAUTHORITY`: manual login/host display (user action only).
- `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`: desktop keyring for encrypted cookies.
- `XDG_CONFIG_HOME`: a nondefault source Chromium profile location.

Use `"env": { "DISPLAY": "${DISPLAY}" }` etc. Missing interpolated variables fail
startup, so do not add unused/unset ones. Never configure cookie values or passwords.
Cookie import only reads the supported Linux Chromium Default profile, not arbitrary
Chrome/Firefox profiles. Preserve HOME if you want the existing saved profiles.

Load the gateway adapter once; do not also register this gateway in Pi's `mcp.json`.
For migration, remove the old pi-browser package from Pi's active `packages` load
list **after approving the configuration diff**, then `/reload`. Merely adding a
service does not change your current setup. Do not load both browser backends:
they have separate grants, tabs and session state, and could contend for profiles.

## Tools and private controls

Discover `browser__browser` with `gateway_tools`, then use `gateway_call` (or the
namespaced browser tool in another MCP client). The action arguments match the
native tool: navigation, snapshots/pagination, clicks, typing, tabs, screenshots,
close, cookie inventory and cookie requests. Attached images remain MCP image blocks.

Cookie requests use MCP **`elicitation/create`**: service → gateway → human dialog,
not an agent tool result. Only an explicit `accept` with boolean `approve: true`
authorizes the displayed scope. Missing UI, false/decline/cancel, timeout and disconnect
never grant access. Cookie inventory approval is separate, for one page only.
Matching/subset import requests reuse approval without narrowing grants or reimporting.
The same consent and origin-validation logic serves both transports.

Open **`/gateway` → Services → browser → Open app** for:

- Setup diagnostics and display mode selection.
- Creating/selecting saved profiles (authorizes all public websites), with confirmation.
- Manual login: open isolated Chromium, log in yourself, then **finish** or **cancel**
  in the app. Model actions are blocked while login is pending, even if you close
  the menu. Finishing closes the login window and restores the previous display mode.
  Unsaved login profiles require explicit exact origins before finishing.
- Choosing Chromium cookie sites privately or entering comma-separated exact origins,
  followed by a separate import confirmation. Large site/profile lists are paginated.
- Closing the browser without revoking grants, or switching to anonymous/revoking access.

These actions use **`native-ui/action`**, not model-callable tools. Stale revisions
and actions not present in the current screen are rejected. The app never returns
an editor draft or persists authorization in conversation state. Ordinary tool results
still reach the model; app screens do not. This is routing isolation, **not an OS sandbox**.
Clients implementing the private UI contract are trusted to obtain the displayed
confirmations. Never expose arbitrary native RPC as a model tool.

## Lifetime and security

Each service process owns one browser session; separate gateway launches do not
share active browser state. Saved profile directories survive, but selecting one
is always a fresh human action. Never use a saved profile in two processes at once.
Close/logout/reload semantics and [network protections](security.md) match the native
extension: localhost/private IPs/file URLs remain blocked and screenshot files remain
on disk. Shutdown/EOF/SIGINT/SIGTERM close Chromium/Xvfb and revoke imported access.
Process crashes or forced kills can leave stale temporary state; the next launch uses
the existing identity-checked stale-process cleanup.

Native UI conversation IDs are correlation labels, not credentials. A changed or
missing conversation ID after a bound session revokes its grants, closes tabs and
resets app drafts. Clients without conversation metadata get one session per connection.
Do not multiplex different users over one connection. Reloads/restarts never restore
profiles/grants from UI state, even when resuming the same conversation.

## Validation

```bash
npm ci --include=dev --ignore-scripts
npm run typecheck
npm run test:mcp
xvfb-run -a npm test
xvfb-run -a npm run test:integration
```

The MCP contract test uses in-memory transport and synthetic sessions: tool/schema
boundaries, private actions, stale revisions, consent reuse/denial, late acceptance
after cancellation, no-UI refusal, images, and session revocation. It reads no real
cookies and launches no browser. Existing integration tests validate Chromium,
synthetic cookie imports, LAN restrictions and cleanup under temporary app data.
