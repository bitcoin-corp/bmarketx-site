/* Buy It Now: the buyer's bWalletX pays the seller's wallet directly. The server quotes the BSV amount and the
   seller's one-off address; the wallet shows it, the buyer approves, and the server checks the payment arrived. */
(() => {
  const { esc, api, usd, alertBar } = BMX;
  const FIELDS = [['name', 'Full name'], ['line1', 'Address line 1'], ['line2', 'Address line 2 (optional)'], ['city', 'Town or city'],
    ['region', 'County, state or region'], ['postcode', 'Postcode / ZIP'], ['country', 'Country']];
  const saved = () => { try { return JSON.parse(localStorage.getItem('bmx-shipto') || '{}'); } catch { return {}; } };
  const keep = (a) => { try { localStorage.setItem('bmx-shipto', JSON.stringify(a)); } catch {} };
  const hex = (a) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => (h.match(/../g) || []).map((x) => parseInt(x, 16));

  async function wallet() {
    if (window.bmxWallet) return window.bmxWallet;
    const { wallet } = await window.bWalletXConnect.connectBwalletX({ reusePairing: true });
    return (window.bmxWallet = wallet);
  }

  // A payment bWalletX didn't answer may still have gone out (connect 0.9.0: NO_ANSWER_MAYBE_SENT, maybeSent). Until
  // we know, never offer to pay again: a pending marker per order (localStorage) holds the order, and the next press
  // checks this site's order status and bWalletX's own record (listActions by the order's label) first.
  const isMaybeSent = (er) => !!er && (er.code === 'NO_ANSWER_MAYBE_SENT' || er.maybeSent === true);
  const PENDING = 'bmx-pay-pending';
  const pendingAll = () => { try { return JSON.parse(localStorage.getItem(PENDING) || '{}') || {}; } catch { return {}; } };
  const pending = {
    get: (k) => pendingAll()[k] || null,
    set: (k, v) => { try { const m = pendingAll(); if (v) m[k] = { ...v, at: Date.now() }; else delete m[k]; localStorage.setItem(PENDING, JSON.stringify(m)); } catch {} },
    forListing: (id) => Object.entries(pendingAll()).find(([, v]) => v && v.listing === id && Date.now() - v.at < 7 * 864e5) || null,
  };
  /** bWalletX's record of a payment with this label: { txid, status } if one exists (anything not failed counts), else
   *  null. Throws when the wallet can't be asked. */
  async function sentWithLabel(w, label) {
    const r = await w.listActions({ labels: [label], labelQueryMode: 'any', limit: 10 });
    const a = (r && r.actions || []).find((x) => x && x.status !== 'failed');
    return a ? { txid: a.txid, status: a.status } : null;
  }

  async function signedIn() {
    const j = await fetch('/api/bwalletx/session', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}));
    return j.identityKey || null;
  }

  function modal(html) {
    const m = document.createElement('div'); m.className = 'bwx-modal';
    m.innerHTML = `<div class="ckout">${html}</div>`;
    m.onclick = (e) => { if (e.target === m) m.remove(); };
    document.body.appendChild(m);
    return m;
  }

  window.BMXcheckout = async (item, store) => {
    if (!(await signedIn())) {
      const m = modal(BMX.signInBox('Sign in with bWalletX to buy. You pay the seller straight from your wallet.'));
      document.addEventListener('bmarketx-wallet', () => { m.remove(); window.BMXcheckout(item, store); }, { once: true });
      return;
    }
    // A payment for this item that may already have gone out: back to that order's check, not a new quote.
    const p = pending.forListing(item.id);
    if (p && p[1].o) { review(modal('<div></div>'), p[1].o, p[1].store); return; }
    const a = saved();
    const ship = item.ship_cents ?? store.ship_cents ?? 0;
    const max = Math.min(item.quantity, 100);
    const m = modal(`<form>
      <h3>Buy It Now</h3>
      <div class="ck-item">${item.images[0] ? BMX.picture(item.images[0], 140, 'alt=""') : ''}<div><b>${esc(item.title)}</b><span class="muted">from ${esc(store.display_name)}</span></div></div>
      <label class="ck-qty">Quantity <input name="qty" type="number" min="1" max="${max}" value="1" ${max < 2 ? 'readonly' : ''}> <span class="muted">${item.quantity} available</span></label>
      <fieldset><legend>Post to</legend>${FIELDS.map(([k, t]) => `<input name="${k}" placeholder="${t}" value="${esc(a[k] || '')}" ${k === 'line2' || k === 'region' ? '' : 'required'} autocomplete="${{ name: 'name', line1: 'address-line1', line2: 'address-line2', city: 'address-level2', region: 'address-level1', postcode: 'postal-code', country: 'country-name' }[k]}">`).join('')}</fieldset>
      <div class="ck-sum"><span>Item</span><b data-it></b><span>Postage</span><b>${ship ? usd(ship) : 'Free'}</b><span>Total</span><b data-tot></b></div>
      <p class="muted" style="font-size:12px;margin:8px 0">Paid in BSV straight to the seller’s wallet. bMarketX takes no fee. Your address is shown only to this seller.</p>
      <div class="ck-row"><button class="btn ghost" type="button" data-x>Cancel</button><button class="btn">Review payment</button></div>
      <p class="err" data-e></p></form>`);
    const f = m.querySelector('form'), e = f.querySelector('[data-e]');
    const sum = () => { const n = Math.max(1, Math.min(max, +f.qty.value || 1)); f.querySelector('[data-it]').textContent = usd(item.price_cents * n); f.querySelector('[data-tot]').textContent = usd(item.price_cents * n + ship); };
    f.qty.oninput = sum; sum();
    f.querySelector('[data-x]').onclick = () => m.remove();
    f.onsubmit = async (ev) => {
      ev.preventDefault(); e.textContent = '';
      const shipTo = Object.fromEntries(FIELDS.map(([k]) => [k, f[k].value.trim()]));
      keep(shipTo);
      const btn = f.querySelector('button:not([data-x])'); btn.disabled = true; btn.textContent = 'Getting the price…';
      try {
        const { order: o } = await api('/api/order', { method: 'POST', body: JSON.stringify({ action: 'quote', listingId: item.id, qty: +f.qty.value || 1, shipTo }) });
        BMX.track('checkout_started', { cents: o.total_cents });
        review(m, { ...o, listing_id: item.id }, store);
      } catch (er) { e.textContent = er.message; btn.disabled = false; btn.textContent = 'Review payment'; }
    };
  };

  function review(m, o, store) {
    const box = m.querySelector('.ckout');
    box.innerHTML = `<h3>Pay ${esc(store.display_name)}</h3>
      <div class="ck-big">${(o.sats / 1e8).toFixed(8)} BSV</div>
      <p class="muted" style="text-align:center;margin-top:0">${usd(o.total_cents)} at $${(+o.usd_per_bsv).toFixed(2)} per BSV · ${o.sats.toLocaleString()} sats</p>
      <p>Your bWalletX will ask you to approve this payment to the seller. Check the amount there before you press Allow.</p>
      <div class="ck-row"><button class="btn ghost" type="button" data-x>Cancel</button><button class="btn" type="button" data-pay>Pay with bWalletX</button></div>
      <p class="err" data-e></p>`;
    const e = box.querySelector('[data-e]'), btn = box.querySelector('[data-pay]');
    const label = `bmx-order-${o.id}`;
    const MAYBE = 'Check bWalletX: this may already be paid. Don’t pay again until it’s checked.';
    const hold = (msg) => { e.textContent = msg; btn.disabled = false; btn.textContent = 'Check bWalletX'; };
    const done = (txid) => {
      pending.set(label, null);
      BMX.track('purchase', { cents: o.total_cents });
      box.innerHTML = `<h3>Paid. Thank you!</h3><p>${esc(store.display_name)} has your order and your address. Your receipt is in <a class="u" href="/my#purchases">Purchase history</a>.</p>
        ${txid ? `<p class="muted" style="font-size:12px">Payment <a class="u" target="_blank" rel="noopener" href="https://whatsonchain.com/tx/${esc(txid)}">${esc(txid.slice(0, 16))}…</a></p>` : ''}
        <div class="ck-row"><a class="btn" href="/my#purchases">See my order</a></div>`;
    };
    // While a payment may be out, Cancel only closes this box: the order stays, so it can still be matched.
    box.querySelector('[data-x]').onclick = () => {
      if (!pending.get(label)) api('/api/order', { method: 'POST', body: JSON.stringify({ action: 'cancel', id: o.id }) }).catch(() => {});
      m.remove();
    };
    if (pending.get(label)) hold(MAYBE);
    let sent = null;   // once the wallet has paid, never ask it to pay again: only re-check
    btn.onclick = async () => {
      btn.disabled = true; e.textContent = '';
      // A payment that may be out: check before anything else, and only then allow paying.
      if (!sent && pending.get(label)) {
        btn.textContent = 'Checking…';
        try {
          const j = await api('/api/order');
          const mine = (j.bought || []).find((x) => x.id === o.id && x.status !== 'quoted');
          if (mine) return done(mine.txid);
          const found = await sentWithLabel(await wallet(), label);
          if (found) {
            return hold(`bWalletX shows a payment for this order (${found.txid ? found.txid.slice(0, 16) + '…' : found.status}). Don’t pay again. Send the seller that payment id, or contact us with this page open.`);
          }
          pending.set(label, null);
          e.textContent = 'bWalletX has no payment for this order. You can pay now.';
          btn.disabled = false; btn.textContent = 'Pay with bWalletX';
        } catch {
          hold('Couldn’t reach bWalletX to check. Open bWalletX, then press Check bWalletX again. Don’t pay again until then.');
        }
        return;
      }
      try {
        if (!sent) {
          btn.textContent = 'Waiting for your wallet…';
          const w = await wallet();
          let r;
          try {
            r = await w.createAction({
              description: `bMarketX order ${o.id}`.slice(0, 50),
              outputs: [{ lockingScript: o.locking_script, satoshis: o.sats, outputDescription: `Payment to ${store.display_name}`.slice(0, 50) }],
              labels: ['bmarketx', label], options: { randomizeOutputs: false },
            });
          } catch (er) {
            if (isMaybeSent(er)) {
              // Only what the check needs (no postal address).
              const keep = { id: o.id, sats: o.sats, total_cents: o.total_cents, usd_per_bsv: o.usd_per_bsv, locking_script: o.locking_script, listing_id: o.listing_id ?? null };
              pending.set(label, { o: keep, store: { display_name: store.display_name }, listing: keep.listing_id });
              return hold(MAYBE);
            }
            throw er;
          }
          if (!r?.tx) throw new Error('Your wallet didn’t send the payment.');
          sent = { txid: r.txid, beef: hex(r.tx) };
        }
        btn.textContent = 'Checking the payment…';
        await api('/api/order', { method: 'POST', body: JSON.stringify({ action: 'pay', id: o.id, ...sent }) });
        done(sent.txid);
      } catch (er) {
        e.textContent = sent ? `${er.message} Don’t pay again: press the button to check once more.` : er.message;
        btn.disabled = false; btn.textContent = sent ? 'Check again' : 'Pay with bWalletX';
      }
    };
  }
  window.BMXpay = { hex, fromHex, wallet, isMaybeSent, pending, sentWithLabel };
})();
