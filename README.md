# pi-browser

Pi package. Agent-driven Chromium for pages that need JavaScript or a click path.

Driver is **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/Patchright)** (Playwright fork): no `Runtime.enable` leak, no `--enable-automation`, `navigator.webdriver` patched. Default display is **headed Xvfb** on Linux. Prefers installed Google Chrome over bundled Chromium.

This is anti-automation hardening, not a captcha solver and not a residential-IP cloak. Datacenter IPs and Turnstile still lose. Prefer [`pi-web-access`](https://github.com/kvidzibo/pi-web-access) `fetch_content` for static public HTML.

| tool / command | job |
|---|---|
| `browser` | navigate, a11y snapshot, click/type/select, tabs, screenshot, close |
| `/browser status` | mode, url, origin grants |
| `/browser mode xvfb\|headless\|host` | display mode (host = your `$DISPLAY`) |
| `/browser login` | isolated profile on your screen; you log in; then grant origins |
| `/browser logout` | drop grants; next launch is ephemeral |
| `/browser close` | kill Chromium + Xvfb |

> **Security:** Pi packages run with your full system permissions. After `/browser login`, the agent can act as that site-user on granted origins. Page text is untrusted (prompt injection). Localhost, private IPs, `file:`, and your real Chrome/Chromium profile are out of reach on purpose. Tool results redact cookie values of 6+ characters and sensitive URL query keys; this is not a complete secret scanner. Install only from a source you trust.

## Install

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

Default profile is **ephemeral**. No import from `~/.config/chromium` or Firefox.

`/browser login` opens an isolated profile at `~/.pi/agent/browser-profile` (mode 0700, including if the dir already exists) on your real display. You log in. Then you grant exact origins for **this session**. Reload, logout, and shutdown wipe grants. The profile dir can keep site cookies on disk; the agent still cannot navigate there without a fresh grant. Document navigations must match those origins. Other public hosts may still load as cookieless subresources (scripts, images, CDNs).

Do not type passwords into the `browser` tool. Tool results, errors, and `/browser status` redact URL userinfo, sensitive query keys, and cookie values of 6+ characters collected from the browser. That is not a complete secret scanner.

## Network gate

Every navigation and subresource is checked. Chromium traffic goes through a local pinning proxy on loopback (random Basic proxy credentials, not logged): DNS is resolved, private answers are rejected, and the TCP connect uses the validated address (no second lookup). Origin grants are enforced in the browser route layer, not by blocking CDN hosts at the proxy. Blocked:

- loopback, RFC1918, link-local, metadata, special-use
- URL credentials
- `file:`, `javascript:`, `chrome:`, `devtools:`
- service workers, downloads, file choosers, JS dialogs (dismissed)

This is not a full intercepting proxy. WebRTC is disabled; residual DNS-rebinding / WebSocket risk remains.

## Tests

```bash
npm test          # unit + factory load (needs `pi` on PATH)
npm run test:unit # no Pi required; this is what CI runs
```

No live browser in the default suite. Optional smoke:

```bash
BROWSER_LIVE=1 node --test --experimental-strip-types tests/live.test.ts
```

On a machine with Xvfb, headed smoke is:

```bash
BROWSER_LIVE=1 xvfb-run -a node --test --experimental-strip-types tests/live.test.ts
```

## Publish

- GitHub: `kvidzibo/pi-browser`
- npm: `@kvidzibo/pi-browser` (gallery crawls the `pi-package` keyword)

Push to `main` runs `.github/workflows/publish.yml`: unit tests, then `npm publish` if `package.json` `version` is not already on npm. Same version = skip (no error). The first successful `main` push after trusted publisher is bound publishes `0.1.0`. Bind the publisher **before** that push.

Bump `version` in the PR that should ship. Do not republish an existing version.

One-time npm trusted publisher (no `NPM_TOKEN` secret):

1. [Package access](https://www.npmjs.com/package/@kvidzibo/pi-browser/access) → **Trusted Publisher** (if the package is not on npm yet, add the publisher from your npm account packages page for this name)
2. GitHub Actions: user `kvidzibo`, repo `pi-browser`, workflow `publish.yml`
3. Allow `npm publish`
