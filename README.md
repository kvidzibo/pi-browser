# pi-browser

Let a [Pi coding agent](https://github.com/earendil-works/pi) inspect and interact with JavaScript-heavy pages without borrowing your everyday browser profile. Wraps Patchright/Chromium with page snapshots, browser actions and explicit permissions for signed-in work.

Driver is **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/Patchright)** (Playwright fork): no `Runtime.enable` leak, no `--enable-automation`, `navigator.webdriver` patched. Default display is **headed Xvfb** on Linux. Prefers installed Google Chrome over bundled Chromium.

This is anti-automation hardening, not a captcha solver and not a residential-IP cloak. Datacenter IPs and Turnstile still lose. Prefer [`pi-web-access`](https://github.com/kvidzibo/pi-web-access) `fetch_content` for static public HTML.

| tool / command | job |
|---|---|
| `browser` | navigate, a11y snapshot, click/type/select, tabs, screenshot, close |
| `browser` action `request_cookies` | approve cookie access once per session scope; reuse it for matching requests |
| `/browser status` | mode, url, origin grants |
| `/browser doctor` | local Node/browser/Xvfb checks and bounded network failure categories |
| `/browser mode xvfb\|headless\|host` | display mode (host = your `$DISPLAY`) |
| `/browser login` | isolated profile on your screen; you log in; then grant origins |
| `/browser login --from-chromium` | multi-select cookie sites from Linux Chromium's Default profile, then approve import |
| `/browser logout` | drop grants; next launch is ephemeral |
| `/browser close` | kill Chromium + Xvfb |

> **Security:** Pi packages run with your full system permissions. After `/browser login` or an approved cookie request, the agent can act as that site-user on granted origins. Page text is untrusted (prompt injection). Localhost, private IPs and `file:` are blocked. Your real Chrome/Chromium profile is never driven; the optional human-confirmed Chromium import uses a separate cookie snapshot. Text tool results redact cookie values of 6+ characters and sensitive URL query keys; this is not a complete secret scanner. Install only from a source you trust.

## Quick example

After [installing](#install), start a fresh Pi session or run `/browser logout` yourself to select an ephemeral profile. Then ask Pi:

```text
Use browser to open https://example.com in an anonymous session.
Take a snapshot and report the page title and first heading.
Do not log in, submit forms or follow links. Close the browser when done.
```

The basic sequence uses three separate `browser` tool calls:

```json
{ "action": "navigate", "url": "https://example.com" }
```

```json
{ "action": "snapshot" }
```

```json
{ "action": "close" }
```

This is a usage example, not a recorded browser session. It needs a browser executable and public network access, but no login. For clicks or typing, use references from the latest snapshot rather than inventing element IDs.

**Permission check:** `/browser status` shows the mode, URL and origin grants. For signed-in work, the model can request Chromium cookies with `browser` action `request_cookies`; you approve or deny in Pi. No manual `/browser login --from-chromium` command is needed. Alternatively, use `/browser login` yourself. The model cannot approve its own request, open your everyday profile, or switch to your real display.

**Design trade-off:** ephemeral anonymous profiles and per-session login grants keep agent browsing separate from your everyday profile. Signed-in tasks need your explicit approval, and ungranted document destinations are blocked rather than silently inheriting access. These controls are not a complete sandbox. See [grant handling](grants.ts), [grant tests](tests/grants.test.ts) and the [network limitations](#network-gate).

## Snapshots and screenshots

Snapshots default to **200 lines**, with a byte limit. Use the `snapshotId` and
next `offset` printed in a result to read more of that **same cached snapshot**:

```json
{ "action": "snapshot", "snapshotId": 7, "offset": 201, "limit": 200 }
```

Use the actual numbers returned by your session. `limit` accepts 1–1000 lines;
byte limits may return fewer. Exceptionally long lines are wrapped, not discarded.
Omit `snapshotId` to capture a new snapshot. A fresh snapshot can use `depth`
(1–30) to limit tree depth. The cache holds one snapshot, up to 4 MiB.
Tab switches, closure and main-frame navigation invalidate references and cached
continuations. Taking another snapshot also invalidates older references.

Screenshots save a private PNG and return its path. To attach the image directly:

```json
{ "action": "screenshot", "image": true }
```

Attachments are limited to 8 MiB; larger images remain available at the saved path.
Screenshots contain **unredacted, untrusted visible page data**. Screenshot files
are retained after close/logout; delete them yourself when no longer needed.
Cancelled actions reject before further input is dispatched; already-dispatched
site actions cannot be undone. Queued cancellations do not start browser work.

## Install

This README tracks repository source. npm packages and Git tags may be behind it; check the version you install before relying on newer features.

Requires **Node >=22.19.0** and Google Chrome or Chromium. Development and CI test
against Pi **0.85.1**. Optional on Linux: `xvfb` (headed virtual display — default when present).

```bash
pi install npm:@kvidzibo/pi-browser
```

Git:

```bash
pi install git:github.com/kvidzibo/pi-browser@v0.1.0
```

Local checkout — Pi adds the path only; it does **not** run `npm install` for local sources:

```bash
cd /absolute/path/to/pi-browser
npm install --omit=dev --omit=peer
pi install /absolute/path/to/pi-browser
```

Do **not** also list this path in `settings.json` `extensions` — package load is enough.

Then `/reload` (or restart Pi).

Browser discovery, in order:

1. `PI_BROWSER_EXECUTABLE`
2. `google-chrome` / `chrome` / Edge on `PATH` (real Chrome preferred)
3. `chromium` on `PATH`
4. Patchright-cached Chromium (`npx patchright install chromium`)

Default mode: **xvfb** on Linux if `Xvfb` exists, else **headless**. `host` is slash-command only. The model cannot switch to host or open manual login; it can request cookie access through a user approval dialog.

### Storage and troubleshooting

`PI_CODING_AGENT_DIR` overrides the default `~/.pi/agent` directory for the isolated
login profile, screenshots and run-state files. Chromium import source paths remain
controlled by Chromium's own configuration variables; this override does not change
the source browser profile.

Run `/browser doctor` to check Node compatibility, executable availability, Xvfb,
mode and the selected agent directory. It does not launch a browser, contact sites,
read cookie inventory or access the keyring. Network failures expose only fixed
categories and bounded counts (such as `dns`, `tls`, `origin_not_granted`,
`private_address`, `redirect`, `resource_limit` and `timeout`), not URLs, headers,
bodies or raw transport errors. Results and doctor show the current/last action's
categories; there is no persistent diagnostic log.

## Cookies / login

Default profile is **ephemeral**. There is no automatic access to your everyday browser. Cookie import requires explicit approval, either through a model's `request_cookies` request or `/browser login --from-chromium`; Firefox is not supported.

`/browser login` opens an isolated profile at `~/.pi/agent/browser-profile` (mode 0700) on your real display. You log in. Then you grant exact origins for **this session**. Reload, logout, and shutdown wipe grants. The profile dir can keep site cookies on disk; the agent still cannot navigate there without a fresh grant. Document navigations must match those origins. Other public hosts may still load as cookieless subresources (scripts, images, CDNs).

Do not type passwords into the `browser` tool. Cancelled or failed login—including browser launch failure—closes the attempted login and clears its grants/persistent-profile selection. Snapshot revisions are not reused after close/reopen, and tool failures reject with redacted messages so Pi marks them as errors.

### Let the model request cookie access (Linux)

The model can call:

```json
{
  "action": "request_cookies",
  "origins": ["https://mail.google.com", "https://accounts.google.com"]
}
```

Pi shows an **Allow browser cookie access for this session?** dialog listing the
source, exact origins, cookie-name scope, session lifetime and replacement warning.
Approving imports matching cookies and grants those origins; the model can then
navigate. Requests within the current approved scope reuse that profile without
another prompt, source-profile read or tab reset. It does not open a manual login
window or switch display mode.

In the TUI, **Deny is selected by default**. Read the request with **↑/↓** or
**Page Up/Page Down**; Allow becomes available only after every page has been
shown. Then **Tab** selects Allow and **Enter** confirms. **Esc** denies.
Long names and origin lists are wrapped and scrollable, not silently truncated.
Resize terminals smaller than 40 columns or 13 rows to enable approval. RPC clients
receive the full disclosure through their standard confirmation dialog.

- Optional `cookieNames`, for example `["sessionid"]`, restricts the import to those
  exact, case-sensitive names. Omit it to request **all cookies matching the origins**;
  this broader scope is stated in the dialog. Empty lists and wildcards are rejected.
  Up to 8 origins and 32 names per request. Each array item must be one valid origin;
  comma-separated host strings are rejected before approval.
- Cookies must already match a destination under their own host/domain rules. They
  are never reassigned to another domain. Name filters apply to the imported snapshot
  (all matching paths), not new cookies a site sets later. Authenticated network access
  remains restricted to the exact approved origins, including scheme and port;
  other public hosts can still supply cookieless subresources.
- There is **no cookie inventory or profile read before approval**. The tool returns
  only the outcome, requested scope and loaded count, never cookie values or other
  sites from your profile. It cannot accept source paths, cookie values or an approval flag.
- Approval is remembered for the current imported profile in this session, including
  imports approved through `/browser login --from-chromium`. Matching requests and
  subsets of its origins/names return `status: "granted", reused: true` without
  prompting or importing again. Order, duplicates and equivalent origin spellings do
  not matter; cookie names remain case-sensitive. Subset requests leave the existing
  grants, cookie snapshot and tabs unchanged—they do not narrow or refresh access.
- New origins (including different schemes/ports), additional cookie names, or changing
  a named filter to all cookies require fresh confirmation. Approval **replaces** the
  current profile and grants and closes its tabs; permissions do not accumulate across
  replacements. Include all origins needed for the next task. Denying or cancelling
  leaves current access untouched. Failed or aborted imports clear the attempted grants
  and clean up the copy; they do not restore the replaced session.
- Works in Pi TUI and RPC clients supporting approval dialogs. Print/JSON mode and
  missing UI fail closed. Use `/browser logout` to revoke; `/reload`, session changes
  (`/new`, `/resume`, `/fork`, `/clone`) and shutdown also clear approval/grants and
  delete the temporary copy. `/browser close` alone retains them. To refresh cookies,
  run `/browser login --from-chromium` again. To narrow access, use `/browser logout`
  before requesting a reduced scope.

The same Linux/Default-profile, keyring and transfer limitations below apply. The
model must not retry a denied request without your direction. Cookie access permits
signed-in browser actions, not just reading public pages; approve only trusted tasks.

### Reuse your default Chromium cookies manually (Linux)

```text
/reload
/browser login --from-chromium
```

In Pi's terminal UI, this opens a **searchable multi-select list** of sites with
unexpired or session cookies. Nothing is selected automatically:

- Type to filter; **↑/↓** move; **Space** checks/unchecks a site. Mouse clicks work too.
- Choices are retained while filtering. **Enter** continues to the final import confirmation;
  **Esc** cancels without changing the current browser session.
- **Ctrl+N** adds exact origins manually. Cookie domains cannot enumerate every usable
  subdomain, HTTP origin or custom port; use this for missing entries.
- For Gmail, check **Gmail** and **Google sign-in** when offered. Otherwise add
  `https://mail.google.com, https://accounts.google.com` manually.

The list suggests HTTPS origins; cookie presence does **not** prove you are signed in.
Only checked origins are DNS-validated and offered for import approval. Nothing grants
all Google sites automatically. RPC clients, or a failed site inventory, retain the
manual comma-separated origin prompt.

- Requires **Node >=22.19.0** and `chromium` or `chromium-browser` on PATH. Uses Chromium,
  not the ordinary Chrome/Edge auto-selection or `PI_BROWSER_EXECUTABLE` override.
- Reads the standard Linux **Default** profile at `~/.config/chromium/Default`
  (`CHROME_CONFIG_HOME` / `XDG_CONFIG_HOME` respected). Supports both `Cookies` and
  `Network/Cookies`. Other profiles and Snap-specific paths are not auto-discovered.
- Takes a read-only SQLite snapshot, including committed WAL data while Chromium is
  running. Removes unrelated and expired cookies before launching a separate profile.
  The source cookie data is not changed; history, passwords, extensions and tabs are
  not imported. Only cookie encryption metadata is copied from `Local State`.
- Chromium decrypts its own cookies with your desktop keyring. The keyring may need
  unlocking. Import never prints cookie values, and the existing browser-result
  redaction remains active. All normal network/origin gates remain in place.
- The private copy lives in a mode-0700 `pi-browser-chromium-*` directory under the
  system temporary directory. `/browser close` retains it for this session;
  `/browser logout`, `/reload` and normal shutdown delete it. Cleanup failures report
  the directory and retain a retry handle for `/browser logout` in the current runtime.
  After an exit/reload or abrupt crash, a leftover protected copy may need manual removal
  (once Chromium is closed) or system temp cleanup.
- This is a disk snapshot, not live synchronization. Cookies not yet flushed by
  Chromium, device-bound sessions, and logins requiring local storage may not transfer;
  sites may still require sign-in. Re-run the command to refresh the snapshot, or use
  the ordinary `/browser login` flow.

The model-facing tool can request permission but has no raw cookie-extraction action.
Running the manual command permits a
read-only inventory of cookie host/expiry metadata for the user-only picker. It does
not query cookie values, access the keyring, inspect history, resolve unselected hosts,
or send the site list to the model. Copying cookies and granting access still require
the final confirmation. `/browser status` shows `source=chromium-copy` when the imported
profile is selected.

## Network gate

Every navigation and subresource is checked. Ordinary Chromium traffic goes through a local pinning proxy: DNS is resolved, private answers are rejected, and the TCP connect uses the validated address (no second lookup).

Ungranted public subresources are instead fetched by a stateless, DNS-pinned Node HTTP transport and fulfilled back to Chromium. Chromium ignores Cookie overrides in `route.continue`, so that API is not used to strip cookies. The stateless path has no cookie jar/auth cache: Cookie and Authorization headers are removed and Set-Cookie is not propagated. GET/HEAD requests omit cache/range validators and 304 responses are rejected; write preconditions are retained. Context routing disables Chromium's HTTP cache, including previously stored profile responses. Redirected ungranted resources fail closed: forwarding Location would bypass route interception and resend browser cookies; hiding the redirect would bypass browser URL/CSP/mixed-content checks and change relative-URL resolution. Non-redirecting public subresources still load cookieless. TLS verification remains enabled; a 30-second deadline includes DNS/body decoding, with 32 MiB limits on both wire and decoded bodies and gzip/deflate/Brotli support. Close cancels pending stateless fetches.

With profile grants active, the proxy itself restricts every HTTP request and CONNECT tunnel to granted origins, including ports. This also blocks ungranted redirects and WebSockets that bypass route interception. Grant changes drop existing tunnels; requests awaiting DNS recheck grants before connecting. Persistent-profile Chromium uses HTTP/1.1 to prevent cross-origin HTTP/2 tunnel coalescing; QUIC and non-proxied WebRTC UDP are disabled. Ordinary anonymous sessions retain HTTP/2. The proxy parses each HTTP request instead of trusting the first request on a reused connection. Blocked:

- loopback, RFC1918, link-local, metadata, special-use
- URL credentials
- `file:`, `javascript:`, `chrome:`, `devtools:`
- service workers, downloads, file choosers, JS dialogs (dismissed)

This is not a full intercepting proxy. WebRTC is disabled; residual DNS-rebinding / WebSocket risk remains.

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
