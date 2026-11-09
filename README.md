# ZedStream

A movie streaming platform where viewers pay per title with **mobile money** (MTN, Airtel, Zamtel) through **Lipila**.

## Features

- Netflix-style home page: featured banner carousel, trending, new releases, free and premium rows, genre rows, and an "All Movies" grid with filters
- Search, sort (latest, most watched, top rated, A–Z), ratings, view counts
- Series and episodes with "next episode" at the end
- **Pay-per-view with mobile money**: enter your number → approve the PIN prompt on your phone → the movie unlocks automatically
- Rentals (1, 2, 3, 7 or 30 days) or lifetime access, set per title
- **Premieres with pre-orders**: set a premiere date and time; the title shows a live countdown, fans pay in advance, and it unlocks for everyone at the premiere. Rentals start counting from the premiere. Admins can preview early
- **Season passes**: one payment unlocks every episode of a series, including episodes added later. Set the price per series in Admin → Movies
- **Anti-piracy watermark**: paid videos show the viewer's phone number and account ID, moving around the picture, so a screen recording can be traced to the account. Fullscreen keeps the watermark on top; picture-in-picture is turned off for paid titles
- Protected streaming: video files and video URLs are never exposed to the browser and stream only to users who have paid
- Continue watching (resume where you left off), My List, purchase and payment history
- Admin panel: revenue dashboard, movie uploads with progress bar, payment log with "re-check with Lipila", users, granting free access
- Works on phones (bottom tab bar, installable as a web app)

## Run it

Needs Node.js 22.13 or newer (it uses Node's built-in SQLite).

```bash
npm install
npm start
```

Open http://localhost:3000. Sign in as admin with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.

Data lives in `data/app.db`, uploaded images in `uploads/images`, and uploaded videos in `storage/videos` (never served publicly).

## Payments: mock → sandbox → live

Set `LIPILA_MODE` in `.env`:

| Mode | What happens | Key |
|---|---|---|
| `mock` | No network calls. Payments succeed after ~6 seconds. `0977000002` fails, `0977000003` stays pending. | none |
| `sandbox` | Real calls to Lipila's test API (`api.lipila.dev`). No real money. | `lsk_…` from dashboard.lipila.dev |
| `live` | Real money (`blz.lipila.io`). | `lpk_…` from dashboard.lipila.io |

How it works:

1. `POST /api/payments` creates a pending payment and calls Lipila `POST /collections/mobile-money` with `referenceId`, `amount`, `accountNumber` (2609…), `currency: ZMW`, `narration`, and a `callbackUrl` header.
2. The customer approves the prompt on their phone.
3. The movie unlocks when **either** Lipila calls `PUBLIC_URL/api/webhooks/lipila`, **or** the app's status check (`GET /collections/check-status?referenceId=…`) returns `Successful`. The browser checks every 3 seconds and the server re-checks pending payments every 30 seconds.
4. The webhook body is never trusted on its own: the server always confirms the status with Lipila before unlocking. If you set `LIPILA_WEBHOOK_SECRET`, signatures are verified too.

For webhooks to reach you during sandbox testing, `PUBLIC_URL` must be reachable from the internet (deploy it, or use a tunnel such as ngrok or Cloudflare Tunnel). Polling still works without it.

Lipila's endpoint paths above come from their public docs and community SDKs. Check them against your dashboard's API reference when you get your keys. They live in `src/lipila.js`.

## Going to production

- Set a long random `JWT_SECRET`, `NODE_ENV=production`, and an `https://` `PUBLIC_URL`
- Change the admin password
- Host behind HTTPS (Railway, Render, a VPS with Caddy or Nginx). Keep the `data/`, `uploads/` and `storage/` folders on a persistent disk
- For large catalogues, move videos to object storage (Cloudflare R2, Backblaze B2, S3) and put the URL in "video URL". The server streams it through so the real address stays hidden
- Encode videos as MP4 (H.264 + AAC) so they play on every phone

## Demo content

The titles, descriptions and numbers in the demo catalogue are made up. Delete them in Admin → Movies once you upload real films.

The demo clips come from [test-videos.co.uk](https://test-videos.co.uk): *Big Buck Bunny* and *Sintel* (© Blender Foundation, CC BY 3.0, blender.org) and a public jellyfish test clip.
