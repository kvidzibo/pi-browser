# Validated lessons

- Fulfill Chromium routes with decoded response bytes and remove Content-Encoding/Content-Length: forwarding raw gzip produced a download, while the decoded synthetic fixture rendered correctly under Xvfb.
- A rejected Chromium navigation can still commit chrome-error asynchronously. In isolated tests, perform remaining successful navigations before the deliberately blocked redirect, or use a fresh page rather than racing an immediate retry.
- Recheck grant/cancellation policy in the I/O caller after awaiting a pin helper: even the helper's final return yields a microtask gap. A queued revocation reproduced late HTTP/CONNECT attempts until the caller rechecked before opening the socket.
- Assert page-script execution through shared DOM markers in Patchright fixtures. Default evaluate did not see the script's window global, but a documentElement data attribute was visible and made the cache test reliable.
