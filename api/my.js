// GET /api/my -> { stores: [{ ...store, listings: [...] }] } for the signed-in wallet
import { db } from './_db.js';
import { fail, q, rows, safeImages, safeLogo, who } from './_util.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = await who(req);
  if (!me) return res.status(401).json({ error: 'Connect bWalletX first.' });
  const d = db();
  if (!d) return res.status(503).json({ error: 'The market database is not switched on yet.' });
  try {
    const stores = await rows(await d(`bmx_stores?owner_key=eq.${q(me)}&select=handle,display_name,tagline,logo,contact,ship_cents,ebay_name&order=created_at`));
    for (const s of stores) {
      s.logo = safeLogo(s.logo);
      // no brand stand-in here: Mint inscribes images[0], and it must never mint our logo as someone's photo
      s.listings = (await rows(await d(`bmx_listings?store_handle=eq.${q(s.handle)}&status=eq.active&select=id,title,price_cents,quantity,sku,images,token_id,minted_at&order=id&limit=5000`)))
        .map((l) => ({ ...l, images: safeImages(l.images, { brand: false }) }));
    }
    return res.status(200).json({ identityKey: me, stores, promote: process.env.BADS_PROMOTE === 'on' });
  } catch (e) { return fail(res, e); }
}
