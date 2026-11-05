// Checks the photo-link allowlist that stops server-side request forgery through listing photos and store logos
// (31 Oct 2026: "ssrf <url>" listings pointing at our own services and da.gd redirectors).
// Run from the repo root: node scripts/ssrf-check.mjs   (no network: fetch is mocked)
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
const { safeImageUrl, isImageType, readCapped, safeImages, safeLogo, toRow, BRAND_IMAGE, BRAND_OG } = await import('../api/_util.js');

let pass = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); }
};

console.log('safeImageUrl: accepted');
for (const u of [
  'https://i.ebayimg.com/images/g/abcAAOSw123/s-l1600.jpg',
  'https://i.ebayimg.com/00/s/MTYwMFgxMjAw/z/abc/$_57.JPG?set_id=8800005007',
]) await t(u, () => assert.equal(safeImageUrl(u), new URL(u).href));
const TX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
for (const u of [
  'https://files.bdrivex.com/u/abc/photo.jpg',
  `https://ordfs.network/content/${TX}_0`,
  `https://ordfs.network/${TX}_12`,
  `https://api.1sat.app/content/${TX}_0`,
  'https://api.1sat.app/content/abc123',
]) await t(u, () => assert.equal(safeImageUrl(u), new URL(u).href));
await t('upper-case scheme and host are normalised', () =>
  assert.equal(safeImageUrl('HTTPS://I.EBAYIMG.COM/images/g/x/s-l500.jpg'), 'https://i.ebayimg.com/images/g/x/s-l500.jpg'));

console.log('safeImageUrl: rejected');
for (const u of [
  'http://i.ebayimg.com/images/g/x/s-l500.jpg',                // http
  'https://da.gd/abc123',                                      // the redirector used in the probe
  'https://da.gd/',
  'https://pay.bwallet.space/',                                // our own services
  'https://messagebox.bwalletx.com/',
  'https://dbis9kvkrujbj7cj4eu0szwaxjotj6s6x.oast.online/',    // out-of-band callback host from the probe
  'https://httpbin.org/redirect-to?url=http://169.254.169.254/',
  'https://127.0.0.1/x.jpg',                                   // IP literals
  'https://10.0.0.1/x.jpg',
  'https://[::1]/x.jpg',
  'https://[::ffff:169.254.169.254]/',
  'https://2130706433/x.jpg',                                  // 127.0.0.1 as a number
  'https://0x7f000001/x.jpg',
  'https://localhost/x.jpg',                                   // localhost
  'https://localhost:3000/x.jpg',
  'https://169.254.169.254/latest/meta-data/',                 // cloud metadata
  'https://user:pass@i.ebayimg.com/x.jpg',                     // userinfo
  'https://user@i.ebayimg.com/x.jpg',
  'https://i.ebayimg.com@evil.example/x.jpg',
  'https://i.ebayimg.com:pw@evil.example/x.jpg',
  'https://i.ebayimg.com\\@evil.example/x.jpg',                // backslash tricks
  'https://evil.example\\@i.ebayimg.com/x.jpg',
  'https://evil.example#@i.ebayimg.com/x.jpg',                 // fragment / lookalike hosts
  'https://i.ebayimg.com.evil.example/x.jpg',
  'https://xi.ebayimg.com/x.jpg',
  'https://i.ebayimg.com./x.jpg',
  'https://i.ebayimg.com:8443/x.jpg',                          // non-default port
  'https:/i.ebayimg.com/x.jpg',
  '//i.ebayimg.com/x.jpg',
  'https://i.ebayimg.com/x.jpg" onerror="alert(1)',
  ' https://i.ebayimg.com/x.jpg',
  'https://i.ebayimg.com/' + 'a'.repeat(2100),
  'http://files.bdrivex.com/x.jpg',                            // new hosts: http, userinfo, port, wrong paths
  'https://user:pw@files.bdrivex.com/x.jpg',
  'https://files.bdrivex.com:8443/x.jpg',
  'https://bdrivex.com/x.jpg',
  'https://evil.files.bdrivex.com/x.jpg',
  `https://user@ordfs.network/content/${TX}_0`,
  `https://ordfs.network:444/content/${TX}_0`,
  'https://ordfs.network/',
  'https://ordfs.network/api/txos/x',
  `https://ordfs.network/content/${TX}`,
  `https://ordfs.network/content/${TX}_0/extra`,
  `https://ordfs.network/content/../redirect?u=x`,
  'https://ordfs.network/content/notanoutpoint_0',
  `http://ordfs.network/content/${TX}_0`,
  'https://api.1sat.app/other',
  'https://api.1sat.app/v5/txos/x',
  'https://api.1sat.app/content/',
  'https://api.1sat.app/content/../v5/x',
  'https://api.1sat.app/content%2f..%2fv5',
  'https://user@api.1sat.app/content/x',
  'https://1sat.app/content/x',
  'data:image/png;base64,AAAA',
  'javascript:alert(1)',
  'file:///etc/passwd',
  '',
]) await t(JSON.stringify(u.length > 70 ? u.slice(0, 70) + '…' : u), () => assert.equal(safeImageUrl(u), null));
for (const v of [null, undefined, 42, {}, ['https://i.ebayimg.com/x.jpg']]) await t(`non-string ${JSON.stringify(v)}`, () => assert.equal(safeImageUrl(v), null));

console.log('isImageType');
for (const ct of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'IMAGE/JPEG; charset=binary']) await t(`accepts ${ct}`, () => assert.ok(isImageType(ct)));
for (const ct of ['text/html', 'text/html; charset=utf-8', 'application/json', 'application/octet-stream', 'image/svg+xml', 'text/plain', '', null, undefined])
  await t(`rejects ${JSON.stringify(ct)}`, () => assert.equal(isImageType(ct), false));

console.log('readCapped');
const streamOf = (n, chunk = 64 * 1024) => new ReadableStream({
  pull(c) { if (n <= 0) return c.close(); const k = Math.min(chunk, n); n -= k; c.enqueue(new Uint8Array(k)); },
});
await t('reads a body under the cap', async () => assert.equal((await readCapped(new Response(streamOf(1000)), 8 << 20)).length, 1000));
await t('stops a streamed body past the cap (no content-length)', async () => assert.equal(await readCapped(new Response(streamOf(9 << 20)), 8 << 20), null));
await t('refuses a content-length past the cap', async () =>
  assert.equal(await readCapped(new Response(streamOf(10), { headers: { 'content-length': String(9 << 20) } }), 8 << 20), null));

console.log('toRow (save and import)');
const base = { title: 'Card', priceCents: 500 };
await t('keeps eBay photos', () => assert.deepEqual(toRow('s', { ...base, images: ['https://i.ebayimg.com/images/g/x/s-l500.jpg'] }).images, ['https://i.ebayimg.com/images/g/x/s-l500.jpg']));
await t('strict: refuses a da.gd photo with a clear 400', () => assert.throws(() => toRow('s', { ...base, images: ['https://da.gd/abc'] }), (e) => e.status === 400 && /i\.ebayimg\.com/.test(e.message)));
await t('strict: refuses an http photo', () => assert.throws(() => toRow('s', { ...base, images: ['http://i.ebayimg.com/x.jpg'] }), (e) => e.status === 400));
await t('strict: refuses one bad link among good ones', () => assert.throws(() => toRow('s', { ...base, images: ['https://i.ebayimg.com/a.jpg', 'https://pay.bwallet.space/'] }), (e) => e.status === 400));
await t('strict: refuses the single image field too', () => assert.throws(() => toRow('s', { ...base, image: 'https://169.254.169.254/' }), (e) => e.status === 400));
await t('non-strict (eBay imports): drops bad links, keeps good', () =>
  assert.deepEqual(toRow('s', { ...base, images: ['https://da.gd/x', 'https://i.ebayimg.com/a.jpg'] }, { strict: false }).images, ['https://i.ebayimg.com/a.jpg']));
await t('blank photo lines are ignored', () => assert.deepEqual(toRow('s', { ...base, images: ['', '  '] }).images, []));

console.log('safeImages / safeLogo (what browsers get)');
await t('all bad -> brand picture', () => assert.deepEqual(safeImages(['https://da.gd/x', 'https://messagebox.bwalletx.com/']), [BRAND_IMAGE]));
await t('all bad, brand off (My bMarketX / Mint) -> empty', () => assert.deepEqual(safeImages(['https://da.gd/x'], { brand: false }), []));
await t('mixed -> only the good one', () => assert.deepEqual(safeImages(['https://da.gd/x', 'https://i.ebayimg.com/a.jpg']), ['https://i.ebayimg.com/a.jpg']));
await t('none -> none', () => assert.deepEqual(safeImages(null), []));
await t('bad logo -> brand picture', () => assert.equal(safeLogo('https://pay.bwallet.space/'), BRAND_IMAGE));
await t('no logo -> null', () => assert.equal(safeLogo(null), null));

// Handlers, with the database and the network mocked: anything not to the database is recorded as an outbound fetch.
const outbound = [];
let listing = null;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://db.test/')) return new Response(JSON.stringify(listing ? [listing] : []), { status: 200 });
  outbound.push({ url, init });
  return mockPhoto(url, init);
};
let mockPhoto = () => new Response('nope', { status: 500 });
const run = async (handler, query) => {
  const res = { code: 0, headers: {}, body: null, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end() { return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
  await handler({ query, headers: {}, method: 'GET' }, res);
  return res;
};
const page = (await import('../api/page.js')).default;
const square = (await import('../api/square.js')).default;
const item = (await import('../api/item.js')).default;

console.log('api/page.js og:image');
const og = (html) => (html.match(/property="og:image" content="([^"]*)"/) || [])[1];
await t('a da.gd photo becomes the brand card', async () => {
  listing = { id: 1, title: 'ssrf https://da.gd/x', price_cents: 100, condition: 'New', images: ['https://da.gd/x'], store_handle: 'bvxprobea-store' };
  assert.equal(og((await run(page, { kind: 'itm', id: '1' })).body), BRAND_OG);
});
await t('an eBay photo stays (as the 1200px size)', async () => {
  listing = { id: 2, title: 'Card', price_cents: 100, images: ['https://i.ebayimg.com/images/g/x/s-l500.jpg'], store_handle: 's' };
  assert.equal(og((await run(page, { kind: 'itm', id: '2' })).body), 'https://i.ebayimg.com/images/g/x/s-l1200.jpg');
});
await t('a bad store logo becomes the brand card', async () => {
  listing = { handle: 'bvxprobea-store', display_name: 'x', logo: 'https://messagebox.bwalletx.com/' };
  assert.equal(og((await run(page, { kind: 'str', handle: 'bvxprobea-store' })).body), BRAND_OG);
});

console.log('api/item.js');
await t('a probe listing comes back with the brand picture, not the probe URL', async () => {
  listing = { id: 1, title: 'ssrf', images: ['https://pay.bwallet.space/'], store_handle: 'bvxprobea-store', logo: 'https://da.gd/y' };
  const r = await run(item, { id: '1' });
  assert.deepEqual(r.body.item.images, [BRAND_IMAGE]);
  assert.equal(r.body.store.logo, BRAND_IMAGE);
});

console.log('api/square.js (server-side fetch)');
outbound.length = 0;
for (const u of ['https://da.gd/abc', 'https://pay.bwallet.space/', 'https://messagebox.bwalletx.com/', 'http://i.ebayimg.com/x.jpg', 'https://169.254.169.254/', 'https://localhost/x.jpg'])
  await t(`404 and no fetch for ${u}`, async () => {
    listing = { images: [u] };
    assert.equal((await run(square, { id: '1' })).code, 404);
    assert.equal(outbound.length, 0, `fetched ${outbound.map((o) => o.url)}`);
  });
await t('eBay photo is fetched with manual redirects and a timeout', async () => {
  listing = { images: ['https://i.ebayimg.com/images/g/x/s-l500.jpg'] };
  mockPhoto = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
  outbound.length = 0;
  const r = await run(square, { id: '1' });
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://i.ebayimg.com/images/g/x/s-l1600.jpg');
  assert.equal(outbound[0].init.redirect, 'manual');
  assert.ok(outbound[0].init.signal instanceof AbortSignal);
  assert.equal(r.code, 404, 'text/html must be refused');
});
await t('a network error is a 404', async () => {
  mockPhoto = () => { throw new TypeError('fetch failed'); };
  assert.equal((await run(square, { id: '1' })).code, 404);
});
const sharpMod = (await import('sharp')).default;
const JPG = await sharpMod({ create: { width: 400, height: 300, channels: 3, background: '#c33' } }).jpeg().toBuffer();
const jpgRes = () => new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
const redirect = (to) => new Response(null, { status: 302, headers: { location: to } });
await t('a redirect to another host is a 404 (not followed)', async () => {
  mockPhoto = () => redirect('https://169.254.169.254/latest/meta-data/');
  outbound.length = 0;
  assert.equal((await run(square, { id: '1' })).code, 404);
  assert.equal(outbound.length, 1);
});
await t('a redirect to an allowlisted other host is still a 404', async () => {
  mockPhoto = () => redirect('https://files.bdrivex.com/x.jpg');
  outbound.length = 0;
  assert.equal((await run(square, { id: '1' })).code, 404);
  assert.equal(outbound.length, 1);
});
await t('ordfs: one same-host hop is followed', async () => {
  listing = { images: [`https://ordfs.network/${TX}_0`] };
  mockPhoto = (url) => (url.includes('/content/') ? jpgRes() : redirect(`/content/${TX}_0`));
  outbound.length = 0;
  assert.equal((await run(square, { id: '1' })).code, 200);
  assert.deepEqual(outbound.map((o) => o.url), [`https://ordfs.network/${TX}_0`, `https://ordfs.network/content/${TX}_0`]);
});
await t('ordfs: a same-host hop to a path off the allowlist is a 404', async () => {
  mockPhoto = () => redirect('/api/anything');
  assert.equal((await run(square, { id: '1' })).code, 404);
});
await t('ordfs: a second hop is a 404', async () => {
  mockPhoto = (url) => redirect(url.includes('/content/') ? `/${TX}_0` : `/content/${TX}_0`);
  outbound.length = 0;
  assert.equal((await run(square, { id: '1' })).code, 404);
  assert.equal(outbound.length, 2);
});
await t('1sat: a same-host hop out of /content/ is a 404', async () => {
  listing = { images: [`https://api.1sat.app/content/${TX}_0`] };
  mockPhoto = () => redirect('https://api.1sat.app/v5/admin');
  assert.equal((await run(square, { id: '1' })).code, 404);
});
await t('ordfs content that is SVG is a 404', async () => {
  listing = { images: [`https://ordfs.network/content/${TX}_0`] };
  mockPhoto = () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  assert.equal((await run(square, { id: '1' })).code, 404);
});
listing = { images: ['https://i.ebayimg.com/images/g/x/s-l500.jpg'] };
await t('SVG is refused', async () => {
  mockPhoto = () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  assert.equal((await run(square, { id: '1' })).code, 404);
});
await t('over 8 MB (streamed, no content-length) is a 404', async () => {
  mockPhoto = () => new Response(streamOf(9 << 20), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  assert.equal((await run(square, { id: '1' })).code, 404);
});
await t('over 8 MB by content-length is a 404', async () => {
  mockPhoto = () => new Response(streamOf(10), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(20 << 20) } });
  assert.equal((await run(square, { id: '1' })).code, 404);
});
await t('a real JPEG from eBay makes the square', async () => {
  mockPhoto = () => new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(JPG.length) } });
  const r = await run(square, { id: '1' });
  assert.equal(r.code, 200);
  assert.equal(r.headers['content-type'], 'image/jpeg');
});

console.log('on-chain listing (ordfs.network/content/<txid>_<vout>) end to end');
const ONCHAIN = `https://ordfs.network/content/${TX}_0`;
await t('item page JSON keeps it', async () => {
  listing = { id: 9, title: 'Minted card', price_cents: 100, images: [ONCHAIN], store_handle: 's', logo: null };
  assert.deepEqual((await run(item, { id: '9' })).body.item.images, [ONCHAIN]);
});
await t('og:image is it', async () => assert.equal(og((await run(page, { kind: 'itm', id: '9' })).body), ONCHAIN));
await t('saving it is accepted', () => assert.deepEqual(toRow('s', { ...base, images: [ONCHAIN] }).images, [ONCHAIN]));
await t('square renders it', async () => {
  listing = { images: [ONCHAIN] };
  mockPhoto = () => jpgRes();
  outbound.length = 0;
  assert.equal((await run(square, { id: '9' })).code, 200);
  assert.equal(outbound[0].url, ONCHAIN);
});
// the browser copy of the allowlist (app.js okImg), which the grid, item page and logos use
const appSrc = (await import('node:fs')).readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const okImg = new Function(appSrc.slice(appSrc.indexOf('const IMG_HOSTS'), appSrc.indexOf('const safeImg')) + 'return okImg;')();
await t('grid / item page (app.js okImg) shows it', () => assert.ok(okImg(ONCHAIN)));
await t('app.js okImg agrees with safeImageUrl on every case above', () => {
  const cases = [ONCHAIN, `https://ordfs.network/${TX}_1`, 'https://files.bdrivex.com/a.jpg', 'https://api.1sat.app/content/x', 'https://i.ebayimg.com/a.jpg',
    'https://api.1sat.app/other', `https://user@ordfs.network/content/${TX}_0`, 'https://ordfs.network/x', 'https://da.gd/x', 'http://i.ebayimg.com/a.jpg',
    'https://pay.bwallet.space/', 'https://169.254.169.254/', 'https://i.ebayimg.com@evil.example/', 'https://i.ebayimg.com:8443/a.jpg'];
  for (const c of cases) assert.equal(okImg(c), !!safeImageUrl(c), c);
});

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
