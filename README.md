# Wishing Stream owner page

The private page at **owner.thewishingstream.com** where the owner sees the four
gîtes' calendars, and later their guests and money. The design, and why it is
built this way, is `docs/owner-page.md` in the private `wishing-stream-bookings`
repository.

This repository is public on purpose, and holds nothing secret:

- The page is static HTML and JS, served by GitHub Pages.
- It holds the Supabase project URL and its **publishable** key, both designed
  to be public. The key reaches nothing on its own: every table is
  service-role only.
- All data comes from the `bookings` edge function's `/owner` routes, which
  verify the signed-in user, check they are the owner, and require the second
  sign-in step before reading anything.

Sign-in is an email link and then a Google Authenticator code. There are no
accounts to create; sign-ups are off in the project.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page, with its Content-Security-Policy |
| `app.js` | Sign-in steps, API calls, rendering |
| `calendar.js` | Pure date arithmetic: month grids, clipping, turnovers, feed health |
| `tests/calendar_test.js` | `deno run --no-config tests/calendar_test.js` |
| `CNAME` | The custom domain for GitHub Pages |
| `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Lets the page install as its own phone app (Android: Chrome › Install; iPhone: Safari › Add to Home Screen). The CSP allows `manifest-src 'self'` for it. |

The Supabase client is loaded from jsdelivr at a pinned version with a
subresource-integrity hash. Upgrading it means changing both the version and
the hash in `index.html`.
