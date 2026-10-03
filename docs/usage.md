# Installation and browser usage

[Quickstart](../README.md) · [Usage](usage.md) · [Security](security.md) · [Development](development.md)

Run checkout-relative shell commands from the repository root. These guides track repository source; released packages may lag.

## Install

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
login profile, named profiles, screenshots and run-state files. Chromium import source paths remain
controlled by Chromium's own configuration variables; this override does not change
the source browser profile.

Run `/browser doctor` to check Node compatibility, executable availability, Xvfb,
mode and the selected agent directory. It does not launch a browser, contact sites,
read cookie inventory or access the keyring. `/pi-browser doctor` is an alias and also
reports the selected profile, native window sizing and network compatibility limits;
it cannot explain a site\'s CAPTCHA score. Network failures expose only fixed
categories and bounded counts (such as `dns`, `tls`, `origin_not_granted`,
`private_address`, `redirect`, `resource_limit` and `timeout`), not URLs, headers,
bodies or raw transport errors. Results and doctor show the current/last action's
categories; there is no persistent diagnostic log.

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

## Saved isolated profiles

Run `/pi-browser` (or `/browser profiles`) to create or select a named profile.
Creation explicitly asks permission to retain cookies, logins and site storage on disk.
Names use 1–40 ASCII letters, digits, hyphens or underscores, starting with a letter
or digit. **Selecting a saved profile authorizes the agent on all public websites
for this session**, including saved logins and normal cookie-bearing subresources.
There is no origin-entry or activation-confirmation prompt; the picker discloses the
all-public-site scope. Creating a profile confirms persistence and this scope, then
selects it. Cancelling the picker leaves the current browser unchanged.

Profiles live at `~/.pi/agent/browser-profiles/<name>/user-data`, or under
`PI_CODING_AGENT_DIR`. Storage directories are private (0700); symlink profiles
are rejected. Use a profile in only one Pi process at a time: Chromium enforces
its own profile singleton lock. Close all users before deleting a profile directory
manually; the picker does not delete saved data.

`/pi-browser close` retains selection and session approval. `/pi-browser logout`,
reload and shutdown clear both, but retain saved cookies/storage. No saved profile
is selected automatically in a new session. Choose **Use anonymous
browser** to revoke access and return to ephemeral browsing.

After selecting a profile, `/pi-browser login` opens that same profile on your
screen for manual login or verification, without asking for origins. Finishing login
resets tabs to about:blank before returning control to the agent.
It never opens your everyday profile. Chromium uses native window sizing, not a
forced 1920×1080 viewport. Localhost/private networks, unsupported schemes and
other non-origin safety restrictions remain blocked; persistence and
native sizing do not guarantee a higher CAPTCHA score.

## Cookies / login

Default profile is **ephemeral**. There is no automatic access to your everyday browser. Cookie import requires explicit approval, either through a model's `request_cookies` request or `/browser login --from-chromium`; Firefox is not supported.

`/browser login` opens the selected named profile, or the legacy isolated profile at `~/.pi/agent/browser-profile` (mode 0700) on your real display. You log in. Named profiles keep their all-public-site access. Legacy login still asks for exact origins for **this session**; document navigations must match those origins and other public hosts load as cookieless subresources (scripts, images, CDNs). Reload, logout, and shutdown wipe access/selection, not saved site cookies. Cookie imports below always retain exact-origin approval.

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

In the TUI, choose **No** or **Yes** with **↑/↓**, then press **Enter**.
**No is selected by default**; **Esc** cancels. There is no mandatory page-through
step before choosing Yes. **Page Up/Page Down** scroll the access details without
changing your choice. Long names and origin lists remain wrapped and fully
scrollable, not silently truncated. Resizing resets the choice to No; terminals
smaller than 40 columns or 13 rows must be enlarged before approval. RPC clients
keep their standard confirmation dialog with the full disclosure.

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

### Import failures

Known failures report a specific, fixed message after approval:

- **Profile directory not found:** open Chromium and sign in to its Default profile.
- **No cookie database:** sign in using Chromium's Default profile first.
- **No matching cookies:** no unexpired or session cookies matched the approved
  origins and optional name filter. Check the scope; Chrome's separate profile is
  not used. A test domain such as `example.com` may have nothing to import.
- **No imported cookies loaded:** Chromium opened the snapshot but loaded no cookies.
  Check the unlocked desktop keyring and profile compatibility; this does not
  establish that the keyring is the cause.

Other browser, SQLite and keyring failures remain generic to avoid exposing cookie
values, source paths or unrelated profile details. Cancellation and cleanup failures
still take precedence over the import reason. Use `/browser login` as an alternative.

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
