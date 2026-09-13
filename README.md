# pi-browser

Let a [Pi coding agent](https://github.com/earendil-works/pi) inspect and interact with JavaScript-heavy pages without borrowing your everyday browser profile. Wraps Patchright/Chromium with page snapshots, browser actions and explicit permissions for signed-in work.

Driver is **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/Patchright)** (Playwright fork): no `Runtime.enable` leak, no `--enable-automation`, `navigator.webdriver` patched. Default display is **headed Xvfb** on Linux. Prefers installed Google Chrome over bundled Chromium.

This is anti-automation hardening, not a captcha solver and not a residential-IP cloak. Datacenter IPs and Turnstile still lose. Prefer [`pi-web-access`](https://github.com/kvidzibo/pi-web-access) `fetch_content` for static public HTML.

| tool / command | job |
|---|---|
| `browser` | navigate, a11y snapshot, click/type/select, tabs, screenshot, close |
| `/browser status` | mode, url, origin grants |
| `/browser mode xvfb\|headless\|host` | display mode (host = your `$DISPLAY`) |
| `/browser login` | isolated profile on your screen; you log in; then grant origins |
| `/browser login --from-chromium` | multi-select cookie sites from Linux Chromium's Default profile, then approve import |
| `/browser logout` | drop grants; next launch is ephemeral |
| `/browser close` | kill Chromium + Xvfb |

> **Security:** Pi packages run with your full system permissions. After `/browser login`, the agent can act as that site-user on granted origins. Page text is untrusted (prompt injection). Localhost, private IPs and `file:` are blocked. Your real Chrome/Chromium profile is never driven; the optional human-confirmed Chromium import uses a separate cookie snapshot. Tool results redact cookie values of 6+ characters and sensitive URL query keys; this is not a complete secret scanner. Install only from a source you trust.

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

**Permission check:** `/browser status` shows the mode, URL and origin grants. For signed-in work, run `/browser login` yourself, log in and grant only the exact origins needed. The model cannot initiate login or switch to your real display.

**Design trade-off:** ephemeral anonymous profiles and per-session login grants keep agent browsing separate from your everyday profile. Signed-in tasks need a manual setup step, and ungranted document destinations are blocked rather than silently inheriting access. These controls are not a complete sandbox. See [grant handling](grants.ts), [grant tests](tests/grants.test.ts) and the [network limitations](#network-gate).

## Install

This README tracks repository source. npm packages and Git tags may be behind it; check the version you install before relying on newer features.

Need Google Chrome or Chromium. Optional on Linux: `xvfb` (headed virtual display — default when present).

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
npm install --omit=peer
pi install /absolute/path/to/pi-browser
```

Do **not** also list this path in `settings.json` `extensions` — package load is enough.

Then `/reload` (or restart Pi).

Browser discovery, in order:

1. `PI_BROWSER_EXECUTABLE`
2. `google-chrome` / `chrome` / Edge on `PATH` (real Chrome preferred)
3. `chromium` on `PATH`
4. Patchright-cached Chromium (`npx patchright install chromium`)

Default mode: **xvfb** on Linux if `Xvfb` exists, else **headless**. `host` is slash-command only. The model cannot switch to host or login.

## Cookies / login

Default profile is **ephemeral**. There is no automatic access to your everyday browser. Cookie import is an explicit `/browser login --from-chromium` option; Firefox is not supported.

`/browser login` opens an isolated profile at `~/.pi/agent/browser-profile` (mode 0700) on your real display. You log in. Then you grant exact origins for **this session**. Reload, logout, and shutdown wipe grants. The profile dir can keep site cookies on disk; the agent still cannot navigate there without a fresh grant. Document navigations must match those origins. Other public hosts may still load as cookieless subresources (scripts, images, CDNs).

Do not type passwords into the `browser` tool. Cancelled or failed login—including browser launch failure—closes the attempted login and clears its grants/persistent-profile selection. Snapshot revisions are not reused after close/reopen, and tool failures reject with redacted messages so Pi marks them as errors.

### Reuse your default Chromium cookies (Linux)

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

- Requires **Node 22.16+** and `chromium` or `chromium-browser` on PATH. Uses Chromium,
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

The model-facing tool has no cookie-extraction action. Running the command permits a
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

## Tests

```bash
xvfb-run -a npm test # unit + native TUI/factory load (needs `pi` and Xvfb on PATH)
npm run test:unit    # no Pi required; this is what CI runs
```

No live browser in the default suite. Cookie-site tests use synthetic SQLite/WAL files;
the factory suite exercises real Pi TUI components, multi-selection, search, keyboard/mouse
input, manual origins and narrow-terminal rendering.

Run the isolated local Chromium cookie/decoding/TLS/proxy contract tests (synthetic cookies, temporary OpenSSL test certificate, loopback fixtures, no public requests):

```bash
BROWSER_LOCAL_INTEGRATION=1 xvfb-run -a node --test --experimental-strip-types tests/cookieless.test.ts tests/chromium-import-live.test.ts
```

The cookie-import fixture creates a synthetic encrypted Chromium profile and checks
persistent/session cookies, source integrity, origin filtering, output redaction and
logout cleanup. When `gnome-keyring-daemon`, `dbus-daemon` and `gdbus` are installed,
this also creates a private test D-Bus/keyring and verifies libsecret-encrypted `v11`
cookies, not just basic-storage `v10` cookies. It does not read your real browser
cookies or desktop keyring.

Optional public-network smoke:

```bash
BROWSER_LIVE=1 node --test --experimental-strip-types tests/live.test.ts
```

On a machine with Xvfb, headed smoke is:

```bash
BROWSER_LIVE=1 xvfb-run -a node --test --experimental-strip-types tests/live.test.ts
```
