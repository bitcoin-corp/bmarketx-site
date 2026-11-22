import { verifySession } from '@bwalletx/connect/server';
import { secret, sessionToken } from './bwalletx/_auth.js';
import { db } from './_db.js';
export { body } from './bwalletx/_auth.js';

/** The signed-in bWalletX identity key, or null. */
export async function who(req) {
  const s = secret();
  if (!s) return null;
  const p = await verifySession(sessionToken(req.headers.cookie), { secret: s });
  return p?.sub ?? null;
}
export const q = (v) => encodeURIComponent(String(v));
export async function rows(r) {
  if (!r.ok) {
    console.error('database', r.status, (await r.text()).slice(0, 500));   // details stay in the server log
    throw Object.assign(new Error('The market database had a problem. Try again in a minute.'), { status: 502 });
  }
  const t = await r.text();   // 201/204 with return=minimal come back empty
  return t ? JSON.parse(t) : [];
}
export const fail = (res, e) => {
  if (!e.status) console.error(e);
  return res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Try again.' });
};
/** State-changing calls must come from our own pages (on top of the SameSite cookie). */
export { originOk } from './bwalletx/_auth.js';

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

// Photo and logo links. Listing photos are fetched by our server (api/square.js), put in og:image (so X, WhatsApp
// and our own bChatX unfurler fetch them) and loaded by every visitor's browser, so a seller-supplied link must
// never point at our own services, private addresses, redirectors or trackers. Only these hosts (and paths):
//   i.ebayimg.com      eBay's photo CDN: every eBay import (CSV PicURL, store page, Sign in with eBay) uses it.
//   files.bdrivex.com  bDriveX storage, where sellers keep photos (bDriveX / bPhotosX).
//   ordfs.network      on-chain content (items minted in the seller's wallet): /content/<txid>_<vout> or /<txid>_<vout> only.
//   api.1sat.app       on-chain content: /content/… only.
// Keep the copy in app.js (okImg) the same.
const OUTPOINT_PATH = /^\/(content\/)?[0-9a-f]{64}_\d{1,6}$/i;
const IMAGE_HOSTS = {
  'i.ebayimg.com': () => true,
  'files.bdrivex.com': () => true,
  'ordfs.network': (p) => OUTPOINT_PATH.test(p),
  'api.1sat.app': (p) => /^\/content\/[^/]/.test(p),
};
/** The link as a clean https URL on an allowed photo host and path, or null. Use the returned value, not the input. */
export function safeImageUrl(url) {
  if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\/[^\s"'<>\\]+$/i.test(url)) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const pathOk = Object.hasOwn(IMAGE_HOSTS, u.hostname) && IMAGE_HOSTS[u.hostname](u.pathname);
  return pathOk ? u.href : null;
}
/** Fetch an allowlisted photo: no redirects, except at most one hop to the same host that is itself allowlisted
 *  (ordfs / 1sat sometimes do that). 5 s in all. Returns the final Response, or null. */
export async function fetchPhoto(src, { timeout = 5000 } = {}) {
  const signal = AbortSignal.timeout(timeout);
  let url = safeImageUrl(src);
  for (let hop = 0; url && hop < 2; hop++) {
    const r = await fetch(url, { redirect: 'manual', signal }).catch(() => null);
    if (!r) return null;
    if (r.status < 300 || r.status >= 400) return r;
    await r.body?.cancel().catch(() => {});
    let next = null;
    try { next = safeImageUrl(new URL(r.headers.get('location') || '', url).href); } catch {}
    if (!next || new URL(next).hostname !== new URL(url).hostname) return null;
    url = next;
  }
  return null;
}
/** Content types we read as photos: raster only (no SVG, which can carry scripts and external references). */
export const isImageType = (ct) => /^image\/(jpeg|png|webp|gif|avif)$/i.test(String(ct || '').split(';')[0].trim());
/** A fetch response body as a Buffer, or null once it passes `max` bytes (by content-length or while streaming). */
export async function readCapped(r, max) {
  if (+r.headers.get('content-length') > max) { await r.body?.cancel().catch(() => {}); return null; }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts, n);
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
}
/** The brand pictures shown in place of a photo or logo that isn't on the allowlist. */
export const BRAND_IMAGE = '/brand/mark.svg';
export const BRAND_OG = 'https://bmarketx.com/brand/og.png';
/** A stored photo list for the browser: allowed links only; the brand picture if none of them were allowed
 *  (unless { brand: false }). */
export function safeImages(list, { brand = true } = {}) {
  const all = Array.isArray(list) ? list : [];
  const ok = all.map(safeImageUrl).filter(Boolean);
  return ok.length || !all.length || !brand ? ok : [BRAND_IMAGE];
}
/** A stored store logo for the browser: the logo if allowed, the brand picture if not, null if none. */
export const safeLogo = (u) => (u ? safeImageUrl(u) || BRAND_IMAGE : null);
const photoError = (title, u) => Object.assign(new Error(
  `The photo link for "${String(title).slice(0, 40)}" can’t be used (${String(u).slice(0, 80)}). Photos must be eBay (i.ebayimg.com), bDriveX (files.bdrivex.com) or on-chain (ordfs.network/content/<txid>_<vout>, api.1sat.app/content/…) links.`,
), { status: 400 });

/** One listing as a bmx_listings row, checked and trimmed. Anything a browser sends goes through here.
 *  A photo link off the allowlist throws a 400 (strict: anything a seller typed or uploaded); with
 *  { strict: false } it is dropped instead (listings read from eBay itself). */
export function toRow(handle, i, { strict = true } = {}) {
  const price = Math.round(+i.priceCents);
  const title = String(i.title || '').replace(/\s+/g, ' ').trim();
  if (!title || !(price > 0) || price > 100_000_000) return null;
  const given = (Array.isArray(i.images) ? i.images : i.image ? [i.image] : []).filter((u) => u != null && String(u).trim() !== '');
  const images = [];
  for (const u of given) {
    const ok = safeImageUrl(typeof u === 'string' ? u.trim() : u);
    if (ok) images.push(ok);
    else if (strict) throw photoError(title, u);
  }
  images.splice(12);
  const was = Math.round(+i.wasCents) || null;
  return {
    store_handle: handle, title: title.slice(0, 80), price_cents: price, was_cents: was && was > price ? was : null,
    promo: clip(i.promo, 80), condition: clip(i.condition, 60), category: clip(i.category, 120), description: clip(i.description, 8000),
    images, quantity: Math.max(0, Math.min(99999, parseInt(i.quantity, 10) || 1)), ebay_id: clip(i.ebayId, 32), sku: clip(i.sku, 80),
    ship_cents: i.shipCents === '' || i.shipCents == null ? null : Math.max(0, Math.min(100000, Math.round(+i.shipCents) || 0)),
    source: ['ebay-page', 'bmarketx'].includes(i.source) ? i.source : 'ebay-csv', status: 'active',
  };
}

const ip = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
/** Rate limit: true (and a 429 sent) when `name` has run more than n times in `secs` for this wallet or IP.
 *  Fails open if the counter isn't reachable, so a database hiccup never locks people out. */
export async function limited(req, res, name, n, secs, id) {
  const d = db();
  if (!d) return false;
  try {
    const r = await d('rpc/bmx_hit', { method: 'POST', body: JSON.stringify({ p_key: `${name}:${id || ip(req)}`, p_limit: n, p_secs: secs }) });
    if (r.ok && (await r.json()) === false) { res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' }); return true; }
  } catch {}
  return false;
}
