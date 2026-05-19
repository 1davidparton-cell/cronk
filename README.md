# Cronk

> Live: **https://cronk.vercel.app** · Source: **https://github.com/1davidparton-cell/cronk**

A mobile-first PWA with 2 to 4 tiles. Each tile fires a configurable webhook
that runs `claude -p "ping"` against a specific account, priming your usage
window early in the morning.

You can fire each tile two ways:

1. **Manually**, by tapping a tile on the PWA from your phone.
2. **Automatically**, on a daily schedule built into the companion server.

## Files

```
index.html              the PWA (single page, vanilla JS)
manifest.webmanifest    PWA manifest
sw.js                   service worker (shell caching only)
icon.svg                vector icon
icon-180.png            180x180 raster icon (iOS)
icon-192.png            192x192 raster icon
icon-512.png            512x512 raster icon
server.js               Node companion server (multi-account + scheduler)
```

## Architecture

```
   phone                 internet                  your Mac
  --------               --------                 ----------
  Cronk   ── POST ──▶  tunnel  ── localhost ──▶ server.js
   (PWA)               (Tailscale,             ──▶ spawn claude -p "ping"
                       cloudflared,            ──▶ HOME=~/.cronk/acctN
                       or ngrok)                      ▲
                                                      │
                                          scheduler runs every 15s,
                                          fires at HH:MM you configure
```

Each tile in the PWA has its own URL, so you can point them at different
account slugs (`/fire/acct1`, `/fire/acct2`) on the same server.

There are two ways to fire each account:

- **Manual**, by tapping a tile in the PWA. Hits `POST /fire/:slug`.
- **Automatic**, built into `server.js`. Fires at HH:MM times you list per
  account in `ACCOUNTS`. Runs even if your phone is asleep or off.

## 1. Host the PWA

Any static host. Vercel, Netlify, GitHub Pages, Cloudflare Pages, or just
drop the files into your existing Anchor deploy under a subpath.

Must be served over HTTPS for service worker + install prompt.

## 2. Set up per-account credentials on your Mac

Claude Code reads credentials from `$HOME/.claude/`. Use a different HOME
per account:

```bash
mkdir -p ~/.cronk/acct1 ~/.cronk/acct2

HOME=~/.cronk/acct1 claude
# /login with account 1, then exit

HOME=~/.cronk/acct2 claude
# /login with account 2, then exit
```

Each directory now holds its own `.claude/.credentials.json`.

## 3. Run the companion server

```bash
node server.js
# Cronk server listening on :8787
```

Optional auth (recommended if exposed beyond Tailscale):

```bash
export CRONK_SECRET=$(openssl rand -hex 32)
node server.js
```

Test locally:

```bash
curl -X POST http://localhost:8787/fire/acct1
```

## 4. Expose it to your phone

Pick one.

**Tailscale (simplest, most secure):**
Install Tailscale on your Mac and phone, join the same tailnet, then use
`http://<mac-tailnet-name>:8787/fire/acct1` as the tile URL. No public
internet exposure.

**Cloudflare Tunnel (works on cell data, no public IP):**
```bash
cloudflared tunnel --url http://localhost:8787
# prints a https://*.trycloudflare.com URL
```
Use that hostname in tile URLs. Definitely set `CRONK_SECRET` here.

**ngrok:**
```bash
ngrok http 8787
```
Same deal. Use the ngrok https URL and set `CRONK_SECRET`.

## 5. Configure tiles in the PWA

Open the PWA on your phone, tap the gear on each tile:

- **Name:** anything (e.g. "Work Claude")
- **Endpoint URL:** `https://your-tunnel/fire/acct1`
- **Method:** POST
- **Headers (optional):** `{"Authorization":"Bearer <CRONK_SECRET>"}`
- **Body (optional):** leave empty

Save. Tap the tile. Status dot goes amber while firing, green on success.

## 6. Set up the auto-fire timer

Two ways to schedule fires:

**A. From the PWA (recommended).** Open the gear on a tile. Set:
- **Anchor time:** first fire of the day in your Mac's local time (e.g. `05:00`).
- **Every:** interval in minutes between fires. `301` = 5h 1m, which keeps
  a continuous rolling Anthropic window during your waking hours.
- **Days:** every day / weekdays / weekends.

The PWA shows a live preview of the derived schedule (`05:00 · 10:01 · 15:02 · 20:03`).
Save sends it to your Mac via `PUT /api/account/<slug>`, which persists to
`cronk.config.json` — no server restart needed.

**B. By editing `cronk.config.json` directly.** Two scheduling modes:

```jsonc
{
  "acct1": {
    "label": "Account 1",
    "home": "~/.cronk/acct1",
    "prompt": "ping",
    "anchorTime": "05:00",       // interval mode: anchor + interval generates
    "intervalMinutes": 301,      //   the daily grid (05:00, 10:01, 15:02, 20:03)
    "schedule": [],              //   leave empty when using interval mode
    "days": null                 //   null = every day, [1,2,3,4,5] = weekdays
  },
  "acct2": {
    "label": "Account 2",
    "home": "~/.cronk/acct2",
    "prompt": "ping",
    "schedule": ["05:00", "11:00"],  // legacy HH:MM mode (ignored if anchorTime set)
    "days": [1, 2, 3, 4, 5]
  }
}
```

Verify what loaded:

```bash
curl http://localhost:8787/api/status | jq '.accounts[] | {label, anchorTime, intervalMinutes, effective_schedule, next_auto_fire}'
```

### Keep the server running across reboots (macOS launchd)

A ready-to-go agent lives at `~/Library/LaunchAgents/com.cronk.server.plist`:

```bash
launchctl load -w ~/Library/LaunchAgents/com.cronk.server.plist   # enable + start
launchctl list | grep cronk                                       # confirm running
tail -f cronk.out.log                                             # follow logs
launchctl unload ~/Library/LaunchAgents/com.cronk.server.plist    # stop
```

`KeepAlive` is on, so the server respawns if it crashes and starts on login.

## 7. Install to home screen

iOS: Safari → Share → Add to Home Screen.
Android: Chrome → menu → Install App.

The icon and standalone window come from the manifest.

## Notes

- The 5-hour window hint in the footer is based on the most-recent
  successful fire across all tiles. It does not query Anthropic.
- Tile state persists in `localStorage`. Clearing site data resets it.
- Add up to 4 tiles via the `+ ADD TILE` button.
- To add a third account, add a new slug to `ACCOUNTS` in `server.js`,
  then re-auth that HOME directory.
- Manual and automatic firing are independent. You can use one, the other,
  or both. The scheduler does not prevent manual fires.
