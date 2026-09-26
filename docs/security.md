# Security model and network implementation

[Quickstart](../README.md) · [Usage](usage.md) · [Security](security.md) · [Development](development.md)

Run checkout-relative shell commands from the repository root. These guides track repository source; released packages may lag.

Driver is **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/Patchright)** (Playwright fork): no `Runtime.enable` leak, no `--enable-automation`, `navigator.webdriver` patched. Default display is **headed Xvfb** on Linux. Prefers installed Google Chrome over bundled Chromium.

This is anti-automation hardening, not a captcha solver and not a residential-IP cloak. Datacenter IPs and Turnstile still lose. Prefer [`pi-web-access`](https://github.com/kvidzibo/pi-web-access) `fetch_content` for static public HTML.

> **Security:** Pi packages run with your full system permissions. After `/browser login` or an approved cookie request, the agent can act as that site-user on granted origins. Page text is untrusted (prompt injection). Localhost, private IPs and `file:` are blocked. Your real Chrome/Chromium profile is never driven; the optional human-confirmed Chromium import uses a separate cookie snapshot. Text tool results redact cookie values of 6+ characters and sensitive URL query keys; this is not a complete secret scanner. Install only from a source you trust.

**Design trade-off:** ephemeral anonymous profiles and per-session login grants keep agent browsing separate from everyday profiles. Signed-in tasks need approval; ungranted document destinations are blocked. These controls are not a complete sandbox. See [grant handling](../grants.ts), [grant tests](../tests/grants.test.ts), and the [login guide](usage.md#cookies--login).

## Network gate

Every navigation and subresource is checked. Ordinary Chromium traffic goes through a local pinning proxy: DNS is resolved, private answers are rejected, and the TCP connect uses the validated address (no second lookup).

Ungranted public subresources are instead fetched by a stateless, DNS-pinned Node HTTP transport and fulfilled back to Chromium. Chromium ignores Cookie overrides in `route.continue`, so that API is not used to strip cookies. The stateless path has no cookie jar/auth cache: Cookie and Authorization headers are removed and Set-Cookie is not propagated. GET/HEAD requests omit cache/range validators and 304 responses are rejected; write preconditions are retained. Context routing disables Chromium's HTTP cache, including previously stored profile responses. Redirected ungranted resources fail closed: forwarding Location would bypass route interception and resend browser cookies; hiding the redirect would bypass browser URL/CSP/mixed-content checks and change relative-URL resolution. Non-redirecting public subresources still load cookieless. TLS verification remains enabled; a 30-second deadline includes DNS/body decoding, with 32 MiB limits on both wire and decoded bodies and gzip/deflate/Brotli support. Close cancels pending stateless fetches.

With profile grants active, the proxy itself restricts every HTTP request and CONNECT tunnel to granted origins, including ports. This also blocks ungranted redirects and WebSockets that bypass route interception. Grant changes drop existing tunnels; requests awaiting DNS recheck grants before connecting. Persistent-profile Chromium uses HTTP/1.1 to prevent cross-origin HTTP/2 tunnel coalescing; QUIC and non-proxied WebRTC UDP are disabled. Ordinary anonymous sessions retain HTTP/2. The proxy parses each HTTP request instead of trusting the first request on a reused connection. Blocked:

- loopback, RFC1918, link-local, metadata, special-use
- URL credentials
- `file:`, `javascript:`, `chrome:`, `devtools:`
- service workers, downloads, file choosers, JS dialogs (dismissed)

This is not a full intercepting proxy. WebRTC is disabled; residual DNS-rebinding / WebSocket risk remains.
