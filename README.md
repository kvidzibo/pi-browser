# pi-browser

Let a [Pi coding agent](https://github.com/earendil-works/pi) inspect and interact
with JavaScript-heavy pages through Patchright/Chromium, without driving your
everyday browser profile. Prefer [pi-web-access](https://github.com/kvidzibo/pi-web-access)
for static public HTML. This is not a CAPTCHA solver or a complete sandbox.

## Install

Requires **Node >=22.19.0** and Google Chrome or Chromium; development and CI test
with Pi **0.85.1**. Linux uses headed **Xvfb** when installed, otherwise headless mode.

```bash
pi install npm:@kvidzibo/pi-browser
```

For a local checkout, Pi does not install dependencies automatically:

```bash
cd /absolute/path/to/pi-browser
npm install --omit=dev --omit=peer
pi install /absolute/path/to/pi-browser
```

Load through `packages` only, not also `extensions`, then `/reload` or restart Pi.
`PI_BROWSER_EXECUTABLE` overrides browser discovery. Run `/browser doctor` to check
local prerequisites without launching a browser, contacting sites, or reading cookies.
This README tracks repository source; npm releases and Git tags may lag.

## Quick example

Start a fresh Pi session, or run `/browser logout` yourself for an anonymous profile.
Then ask Pi:

```text
Use browser to open https://example.com in an anonymous session.
Take a snapshot and report the page title and first heading.
Do not log in, submit forms or follow links. Close the browser when done.
```

This is a usage example, not a recorded session. It needs public network access.
The `browser` tool handles navigation, snapshots, clicks, typing, tabs, and screenshots.
Use element references from the **latest snapshot**. For continuation, use the returned
`snapshotId` and `offset`; navigating or switching tabs invalidates old references.

| Command | Purpose |
|---|---|
| `/browser status` | Show display mode, URL, and origin grants |
| `/browser doctor` | Check local setup and bounded failure categories |
| `/browser mode xvfb\|headless\|host` | Select display mode; host uses your real display |
| `/browser login` | Log in yourself in an isolated profile, then grant exact origins |
| `/browser login --from-chromium` | Select Linux Chromium cookie sites and approve a private copy |
| `/browser logout` | Revoke access; next launch is anonymous |
| `/browser close` | Close Chromium/Xvfb without revoking this session's grants |

## Signed-in work and safety

- **Full system permissions, not a sandbox.** Install only trusted code. Page text
  is untrusted; approved access lets the agent act as you on granted sites.
- Profiles start anonymous. The model can request `browser` action `request_cookies`
  for exact origins and optional cookie names; only you can approve. Linux Chromium's
  Default profile is supported, not Firefox. Your everyday profile is never driven.
- Matching/subset cookie requests reuse the approved scope without prompting or
  reimporting. Subsets do **not** narrow access. Broader requests require approval,
  replace the old grants/profile, and close its tabs; denial leaves access unchanged.
- `/browser logout`, `/reload`, session changes, and shutdown revoke grants.
  `/browser close` does not. Use logout before narrowing access, or the manual import
  command to refresh cookies. Imports are snapshots; some logins will not transfer.
- Never put passwords in the tool. The model cannot approve itself, open manual
  login, or switch to your real display. Do not retry denied access without direction.
  Cookie approval requires interactive TUI/RPC dialogs; print/JSON mode fails closed.
- Localhost, private addresses, and `file:` URLs are blocked. With grants active,
  document destinations must match exact origins; other public hosts may supply
  cookieless subresources. These controls are not a guarantee against every network risk.
- **Screenshots are unredacted** and their files survive close/logout. Tool text
  redacts cookie values of 6+ characters and sensitive URL query keys, but is not a
  complete secret scanner. Delete retained screenshots when no longer needed.
  Cancellation cannot undo actions already dispatched to a site.

## Validation

From the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm run typecheck
xvfb-run -a npm test
xvfb-run -a npm run test:integration
```

The default suite uses fixtures and offline Pi checks, not a live browser.
Integration tests launch isolated Chromium with synthetic cookies and loopback
fixtures, never your real profile or public sites. Public-network smoke is opt-in.

## Detailed guides

In the [source repository](https://github.com/kvidzibo/pi-browser):
[installation, snapshots, login and troubleshooting](docs/usage.md),
[security and network internals](docs/security.md), and
[development, integration prerequisites and architecture](docs/development.md).
The npm package includes this quickstart; the detailed guides live in the checkout.

[MIT](LICENSE).
