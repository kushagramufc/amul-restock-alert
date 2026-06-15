// Amul restock checker — Playwright binds the delivery pincode, then reads each
// SKU's `available` flag from the store's own product API. Alerts Discord and/or
// ntfy (phone push) on stock-status changes. Runs on a GitHub Actions cron.
//
// Config via env (all optional; set at least one notifier to get alerts):
//   DISCORD_WEBHOOK_URL  Discord webhook to post alerts to
//   NTFY_TOPIC           ntfy topic to push phone notifications to
//   NTFY_SERVER          ntfy server base URL (default https://ntfy.sh)
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
const NTFY_TOPIC = process.env.NTFY_TOPIC?.trim() || '';
const NTFY_SERVER = (process.env.NTFY_SERVER?.trim() || 'https://ntfy.sh').replace(/\/$/, '');
const STATE_FILE = new URL('./state.json', import.meta.url);
const PRODUCT_BASE = 'https://shop.amul.com/en/product/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function loadState() {
  try {
    let raw = await readFile(STATE_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // tolerate a UTF-8 BOM (e.g. hand-edited on Windows)
    return JSON.parse(raw);
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

// Push a phone notification via ntfy. `tags` render as emoji/icons; `click` opens on tap.
async function sendNtfy({ title, message, click, tags, priority }) {
  if (!NTFY_TOPIC) {
    log('(no NTFY_TOPIC set — would have pushed)', title, '—', message);
    return;
  }
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (title) headers['X-Title'] = title; // ASCII only — emoji goes in tags, not here
  if (click) headers['X-Click'] = click;
  if (tags) headers['X-Tags'] = tags;
  if (priority) headers['X-Priority'] = String(priority);
  try {
    const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, { method: 'POST', headers, body: message ?? '' });
    if (!res.ok) log('ntfy POST failed', res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    log('ntfy POST error', e.message);
  }
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

function soldOutEmbed(p) {
  const url = PRODUCT_BASE + p.alias;
  return {
    username: 'Amul Restock Bot',
    content: `🔴 **Sold out again** — ${p.name}`,
    embeds: [
      {
        title: p.name,
        url,
        color: 0xe74c3c,
        description: `No longer available for delivery to **${PINCODE}**. I'll ping you again when it's back in stock.`,
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
  const wentOOS = [];

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
    if (!firstRun && !inStock && wasInStock) wentOOS.push(p);
  }

  // Notify.
  if (firstRun) {
    const lines = ALIASES.map((a) => {
      const p = products[a];
      return `• ${p ? p.name : a}: ${p && p.available === 1 ? '🟢 in stock' : '🔴 sold out'}`;
    });
    await sendDiscord({
      username: 'Amul Restock Bot',
      content: `✅ **Monitoring started** for pincode **${PINCODE}**. You'll get a ping whenever any of these comes back in stock — or sells out again:\n${lines.join('\n')}`,
    });
    const ntfyLines = ALIASES.map((a) => {
      const p = products[a];
      return `${p ? p.name : a}: ${p && p.available === 1 ? 'in stock' : 'sold out'}`;
    });
    await sendNtfy({ title: 'Monitoring started', message: `Pincode ${PINCODE}\n${ntfyLines.join('\n')}`, tags: 'white_check_mark' });
    log('first run — baseline set, sent startup summary');
  } else {
    for (const p of restocked) {
      log('RESTOCK detected:', p.alias);
      await sendDiscord(restockEmbed(p));
      await sendNtfy({ title: 'Back in stock!', message: p.name, click: PRODUCT_BASE + p.alias, tags: 'green_circle', priority: 'high' });
    }
    for (const p of wentOOS) {
      log('SOLD OUT detected:', p.alias);
      await sendDiscord(soldOutEmbed(p));
      await sendNtfy({ title: 'Sold out again', message: p.name, click: PRODUCT_BASE + p.alias, tags: 'red_circle' });
    }
    if (restocked.length === 0 && wentOOS.length === 0) log('no stock transitions this run');
  }

  await writeFile(STATE_FILE, JSON.stringify(nextState, null, 2) + '\n');
}

main().catch((e) => {
  log('FATAL', e.stack || e.message);
  process.exit(1);
});
