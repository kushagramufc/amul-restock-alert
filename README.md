# Amul restock alerts → Discord

Get a Discord ping the moment a sold-out Amul product comes back in stock **for your pincode** — and again when it sells out.

Currently watching (pincode **560102**):

- Amul Chocolate Whey Protein, 34 g — Pack of 30 sachets
- Amul Chocolate Whey Protein, 34 g — Pack of 60 sachets

## How it works

`shop.amul.com` is a single-page app behind Cloudflare, and **stock is per-pincode** (the same SKU can be sold out for one pincode and in stock for another). So each run:

1. **Playwright** (headless Chromium) opens the store and sets delivery pincode **560102**. This binds your region's "substore" to the session — without it the API hides all products.
2. The store's own product API is then read for each SKU. The reliable in-stock signal is the **`available`** flag (`1` = buyable, `0` = sold out). `inventory_quantity` is *not* used — a SKU can show units but still be unbuyable for your pincode.
3. State is saved in `state.json`. A Discord alert fires on a **status change in either direction** — 🟢 sold-out → in-stock ("Back in stock!") and 🔴 in-stock → sold-out ("Sold out again") — but only on the change itself, so you won't get repeat spam while the status holds.

It runs on a **GitHub Actions cron** — no server to manage, free for public repos.

## Setup (one time, ~10 minutes)

### 1. Create a Discord webhook
In your Discord server: **Server Settings → Integrations → Webhooks → New Webhook** → pick the channel → **Copy Webhook URL**. Keep it handy (it's a secret — anyone with it can post to your channel).

### 2. Put this folder on GitHub
A **public** repo is recommended (Actions minutes are free; the webhook lives in encrypted Secrets, never in code).

```bash
git init
git add .
git commit -m "Amul restock alerts"
git branch -M main
git remote add origin https://github.com/<you>/amul-restock-alerts.git
git push -u origin main
```

### 3. Add the webhook as a repo secret
**Repo → Settings → Secrets and variables → Actions → New repository secret**
- Name: `DISCORD_WEBHOOK_URL`
- Value: the webhook URL from step 1

### 4. Turn it on
Go to the **Actions** tab, enable workflows if prompted, open **“Amul restock check”**, and click **Run workflow**. Within a minute you should get a **“✅ Monitoring started”** message in Discord listing both SKUs' current status — that confirms everything is wired up. After that it runs automatically on the cron.

## Phone push (ntfy) — optional second channel

Get the same alerts pushed to your phone. Works alongside Discord (or on its own).

1. **Install the ntfy app** — [iOS](https://apps.apple.com/app/ntfy/id1625396347) or [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy), or just use [ntfy.sh](https://ntfy.sh) in a browser.
2. **Subscribe to your private topic.** In the app tap **+**, then enter your topic name — a long random string that acts like a private channel (e.g. `amul-restock-ab12cd34ef56`). Anyone who knows the topic can read your alerts, so keep it secret and **never commit it** to this public repo.
3. **Add it as a repo secret** so the cron can push to it: **Settings → Secrets and variables → Actions → New repository secret** → name `NTFY_TOPIC`, value = your topic.

Restocks and sold-outs now also ping your phone; tapping a notification opens the product page. To turn it off, just delete the `NTFY_TOPIC` secret.

## Customizing

Edit the constants at the top of [`check.mjs`](check.mjs), **or** set these as repo **Variables** (Settings → Secrets and variables → Actions → *Variables*) — no code change needed:

| Variable | Meaning | Default |
|---|---|---|
| `AMUL_PINCODE` | Delivery pincode | `560102` |
| `AMUL_ALIASES` | Comma-separated product aliases (the slug after `/product/` in the URL) | the two whey SKUs |

Cadence lives in [`.github/workflows/restock.yml`](.github/workflows/restock.yml) (`cron: '*/5 * * * *'`).

## Run it locally

```bash
npm install
npx playwright install chromium
# log-only (no alerts):
node check.mjs
# with alerts:
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." node check.mjs   # PowerShell: $env:DISCORD_WEBHOOK_URL="..."; node check.mjs
```

## Things to know

- **Cadence is best-effort.** GitHub's scheduled workflows have a 5-minute minimum and are frequently delayed 5–15 min (and occasionally skipped) under load. For Amul drops that sell out in minutes this can miss the fastest restocks. For tighter, guaranteed polling, run `check.mjs` on a small always-on host (a cheap VPS or a free worker) on a 1–2 min loop instead.
- **60-day inactivity.** GitHub auto-pauses scheduled workflows after 60 days with no repo commits. The state commits keep it alive whenever stock changes; if a SKU is unchanged for ~2 months, just hit **Run workflow** once (or push any commit) to re-enable.
- **Be a good citizen.** This polls only your specific SKUs with a real browser fingerprint and reuses one session per run — gentle on Amul's servers. Don't crank the cadence to seconds.
