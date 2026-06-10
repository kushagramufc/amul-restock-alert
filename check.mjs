// Amul restock checker — Playwright binds the delivery pincode, then reads each
// SKU's `available` flag from the store's own product API. Alerts Discord on a
// sold-out -> in-stock transition. Designed to run on a GitHub Actions cron.
//
// Config via env (all optional except the webhook for alerts):
//   DISCORD_WEBHOOK_URL  Discord webhook to post alerts to (no alerts if unset)
//   AMUL_PINCODE         delivery pincode (default 560102)
//   AMUL_ALIASES         comma-separated product aliases (defaults below)

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const PINCODE = process.env.AMUL_PINCODE?.trim() || '560102';
const ALIASES = (process.env.AMUL_ALIASES?.trim()
  ? process.env.AMUL_ALIASES.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'amul-chocolate-whey-protein-34-g-or-pack-of-30-sachets',
      'amul-chocolate-whey-protein-34-g-or-pack-of-60-sachets',
    ]);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL?.trim() || '';
const STATE_FILE = new URL('./state.json', import.meta.url);
const PRODUCT_BASE = 'https://shop.amul.com/en/product/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return null; // null => first run
  }
}

async function sendDiscord(payload) {
  if (!WEBHOOK) {
    log('(no DISCORD_WEBHOOK_URL set — would have sent)', JSON.stringify(payload).slice(0, 200));
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) log('Discord POST failed', res.status, (await res.text()).slice(0, 200));
}

function restockEmbed(p) {
  const url = PRODUCT_BASE + p.alias;
  return {
    username: 'Amul Restock Bot',
    content: `🟢 **Back in stock!** ${p.name}`,
    embeds: [
      {
        title: p.name,
        url,
        color: 0x2ecc71,
        description: `Now available for delivery to **${PINCODE}**. Grab it before it sells out again.`,
        fields: [
          { name: 'Buy', value: `[Open product page](${url})`, inline: true },
          { name: 'Inventory', value: String(p.inventory_quantity ?? '—'), inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** Launch a browser, bind the pincode, and return { products, close }. */
async function fetchAvailability() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-IN' });
  const page = await ctx.newPage();

  const products = {}; // alias -> product record from the API
  page.on('response', async (res) => {
    if (!res.url().includes('ms.products')) return;
    try {
      const j = await res.json();
      if (j?.data?.length) for (const p of j.data) if (p.alias) products[p.alias] = p;
    } catch {}
  });

  // Bind the delivery pincode (sets the substore for this session).
  await bindPincode(page);

  // Visit each product page so the SPA fetches its (substore-scoped) availability.
  for (const alias of ALIASES) {
    try {
      await page.goto(PRODUCT_BASE + alias, { waitUntil: 'networkidle', timeout: 60000 });
      // Wait until the API response for this alias has landed.
      for (let i = 0; i < 20 && !products[alias]; i++) await page.waitForTimeout(500);
      if (!products[alias]) log('WARN: no API data captured for', alias);
    } catch (e) {
      log('WARN: navigation failed for', alias, e.message);
    }
  }

  await browser.close();
  return products;
}

async function bindPincode(page) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(PRODUCT_BASE + ALIASES[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('#search', { timeout: 20000 });
      await page.fill('#search', PINCODE);
      await page.waitForSelector('a.searchitem-name', { timeout: 15000 });
      await page.click('a.searchitem-name');
      await page.waitForSelector('#search', { state: 'hidden', timeout: 15000 });
      await page.waitForTimeout(1500);
      log(`pincode ${PINCODE} bound (attempt ${attempt})`);
      return;
    } catch (e) {
      lastErr = e;
      log(`pincode bind attempt ${attempt} failed:`, e.message);
      await page.waitForTimeout(1500);
    }
  }
  throw new Error('could not bind pincode: ' + lastErr?.message);
}

async function main() {
  const prevState = await loadState();
  const prev = prevState || {};
  const firstRun = Object.keys(prev).length === 0; // empty/missing state => baseline run

  const products = await fetchAvailability();
  const read = ALIASES.map((a) => products[a]).filter(Boolean);
  if (read.length === 0) {
    log('ERROR: read 0 products — the page flow likely changed. Failing so the run is visible.');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const nextState = {};
  const restocked = [];

  for (const alias of ALIASES) {
    const p = products[alias];
    if (!p) {
      // Keep prior state for a SKU we couldn't read this run.
      if (prev[alias]) nextState[alias] = prev[alias];
      continue;
    }
    const inStock = p.available === 1;
    const wasInStock = prev[alias]?.available === 1;
    const changed = prev[alias]?.available !== (inStock ? 1 : 0);

    nextState[alias] = {
      name: p.name,
      available: inStock ? 1 : 0,
      lastChangedAt: changed ? now : prev[alias]?.lastChangedAt || now,
    };

    log(`${alias} -> available=${p.available} inventory=${p.inventory_quantity} inStock=${inStock}`);

    if (!firstRun && inStock && !wasInStock) restocked.push(p);
  }

  // Notify.
  if (firstRun) {
    const lines = ALIASES.map((a) => {
      const p = products[a];
      return `• ${p ? p.name : a}: ${p && p.available === 1 ? '🟢 in stock' : '🔴 sold out'}`;
    });
    await sendDiscord({
      username: 'Amul Restock Bot',
      content: `✅ **Monitoring started** for pincode **${PINCODE}**. You'll get a ping when any of these comes back in stock:\n${lines.join('\n')}`,
    });
    log('first run — baseline set, sent startup summary');
  } else {
    for (const p of restocked) {
      log('RESTOCK detected:', p.alias);
      await sendDiscord(restockEmbed(p));
    }
    if (restocked.length === 0) log('no restock transitions this run');
  }

  await writeFile(STATE_FILE, JSON.stringify(nextState, null, 2) + '\n');
}

main().catch((e) => {
  log('FATAL', e.stack || e.message);
  process.exit(1);
});
