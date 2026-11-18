(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CATS = [
    { id: 'all', label: 'Semua', icon: '🍽️' },
    { id: 'makanan', label: 'Makanan', icon: '🍛' },
    { id: 'minuman', label: 'Minuman', icon: '🧋' },
    { id: 'snack', label: 'Snack', icon: '🍟' }
  ];
  const mq = window.matchMedia('(max-width: 1099px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Animasi kecil saat angka berubah (hanya transform, murah untuk GPU)
  function bump(el) {
    if (!el || reduceMotion) return;
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  }

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* abaikan */ } }
  };

  let config = null;
  let menu = [];
  let cart = store.get('ws_cart', {}); // { id: { qty, note } }
  let fav = store.get('ws_fav', []);
  let loc = null; // hasil cek lokasi terakhir
  let busy = false;
  let lastAdded = null; // id menu yang baru masuk keranjang (untuk animasi)
  const view = { cat: 'all', tab: 'all', q: '', sort: 'default' };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Terjadi kesalahan. Coba lagi.'); e.data = data; throw e; }
    return data;
  }

  let toastTimer;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast on' + (kind === 'bad' ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 4200);
  }

  const fmtDist = d => (d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1).replace('.', ',')} km`);
  const menuById = id => menu.find(m => m.id === id);
  const saveCart = () => store.set('ws_cart', cart);
  const saveFav = () => store.set('ws_fav', fav);

  // Menjaga fokus keyboard saat elemen dirender ulang
  function keepFocus(fn) {
    const a = document.activeElement;
    let sel = null;
    if (a && a.dataset) {
      for (const k of ['add', 'dec', 'fav']) {
        if (k in a.dataset) {
          const box = a.closest('.dish, .inv-item');
          if (box) sel = { box: box.classList.contains('dish') ? '.dish' : '.inv-item', id: a.dataset[k], k };
        }
      }
    }
    fn();
    if (sel) {
      const box = document.querySelector(`${sel.box}[data-id="${CSS.escape(sel.id)}"]`);
      const el = box && (box.querySelector(`[data-${sel.k}]`) || box.querySelector('[data-add]'));
      if (el) el.focus();
    }
  }

  // ---------- Config ----------
  function renderConfig() {
    document.title = `${config.name} — Pesan dari meja`;
    $('#brand-name').textContent = config.name;
    $('#foot-name').textContent = `${config.name} © ${new Date().getFullYear()}`;
    if (config.tagline) $('#banner-tagline').textContent = config.tagline;
    $('#banner-open').textContent = config.open ? 'Buka' : 'Tutup';
    $('#banner-open').dataset.open = config.open ? '1' : '0';
    $('#banner-hours').textContent = config.hours || '—';
    $('#info-address').textContent = config.address || '—';
    $('#info-hours').textContent = config.hours || '—';
    $('#info-radius').textContent = config.geofence
      ? `Pemesanan hanya untuk pengunjung dalam radius ${config.radius} m dari restoran.`
      : 'Pemesanan terbuka untuk semua pengunjung.';
    $('#radar-limit-lbl').textContent = config.geofence ? `Radius ${config.radius} m` : 'Tanpa batas';
    $('#map-link').href = `https://www.openstreetmap.org/?mlat=${config.lat}&mlon=${config.lng}#map=18/${config.lat}/${config.lng}`;
    $('#closed').hidden = config.open;
    if (!config.payment.ready) {
      const n = $('#geo-notice');
      n.className = 'notice bad';
      n.textContent = 'Pembayaran QRIS belum diatur oleh restoran, jadi pesanan belum bisa dibuat.';
    }
    if (!config.geofence) {
      $('#radar-msg').innerHTML = 'Tanpa batas lokasi<small>Restoran ini menerima pesanan dari mana saja.</small>';
      $('#radar-check').hidden = true;
    }
    const last = store.get('ws_last', null);
    if (last) { const a = $('#nav-order'); a.href = '/bayar.html?o=' + encodeURIComponent(last); a.hidden = false; }
  }

  // ---------- Lokasi pengunjung ----------
  function renderRadar() {
    const box = $('#radar-status');
    if (busy) { box.dataset.state = 'busy'; $('#radar-msg').innerHTML = 'Mencari lokasimu…<small>Izinkan akses lokasi jika diminta browser.</small>'; return; }
    if (!loc) return;
    if (loc.distance != null) {
      const you = $('#you');
      you.style.left = Math.min(100, (loc.distance / config.radius) * 100).toFixed(1) + '%';
      you.dataset.ok = loc.ok ? '1' : '0';
      you.hidden = false;
    }
    box.dataset.state = loc.ok ? 'ok' : 'bad';
    $('#radar-msg').innerHTML = loc.ok
      ? `${loc.distance != null ? `Kamu ${esc(fmtDist(loc.distance))} dari restoran` : 'Lokasi diterima'}<small>Kamu berada di dalam jangkauan. Silakan pesan.</small>`
      : `${esc(loc.message || 'Di luar jangkauan')}<small>Datang ke restoran lalu cek lokasi lagi.</small>`;
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Browser ini tidak mendukung lokasi.'));
      if (!window.isSecureContext) return reject(new Error('Lokasi hanya bisa dipakai lewat HTTPS. Hubungi pemilik restoran.'));
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        e => reject(new Error(
          e.code === 1 ? 'Izin lokasi ditolak. Aktifkan lokasi untuk situs ini di pengaturan browser, lalu coba lagi.'
            : e.code === 3 ? 'Lokasi terlalu lama didapat. Coba lagi di tempat terbuka.'
              : 'Lokasi tidak tersedia. Aktifkan GPS lalu coba lagi.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  async function verifyLocation() {
    busy = true; renderRadar();
    try {
      const pos = await getPosition();
      const r = await api('/api/location/check', { method: 'POST', body: pos });
      loc = { ...pos, ...r };
      return loc;
    } catch (e) {
      loc = { ok: false, message: e.message, distance: null };
      throw e;
    } finally {
      busy = false; renderRadar();
    }
  }

  async function checkFromButton() {
    if (!config.geofence) return toast('Restoran ini tidak membatasi lokasi pemesanan.');
    try { await verifyLocation(); } catch (e) { toast(e.message, 'bad'); }
  }

  // ---------- Menu ----------
  function renderCats() {
    $('#cats').innerHTML = CATS
      .filter(c => c.id === 'all' || menu.some(m => m.category === c.id))
      .map((c, i) => {
        const n = c.id === 'all' ? menu.length : menu.filter(m => m.category === c.id).length;
        return `<button type="button" class="cat" style="--i:${i}" data-cat="${c.id}" aria-pressed="${view.cat === c.id}">
          <span class="ico" aria-hidden="true">${c.icon}</span>${c.label}<small>${n}</small></button>`;
      }).join('');
  }

  function visibleMenu() {
    const q = view.q.trim().toLowerCase();
    let list = menu.filter(m =>
      (view.cat === 'all' || m.category === view.cat) &&
      (view.tab === 'all' || fav.includes(m.id)) &&
      (!q || m.name.toLowerCase().includes(q) || (m.desc || '').toLowerCase().includes(q)));
    if (view.sort === 'price-asc') list = [...list].sort((a, b) => a.price - b.price);
    else if (view.sort === 'price-desc') list = [...list].sort((a, b) => b.price - a.price);
    else if (view.sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'id'));
    return list;
  }

  // Ilustrasi garis untuk empty state: mangkuk beruap di atas alas
  const ART = '<svg class="art" viewBox="0 0 104 80" aria-hidden="true"><ellipse class="fill" cx="52" cy="70" rx="40" ry="5"/><path d="M20 44h64a32 28 0 0 1-64 0z"/><path d="M36 74h32"/><path class="soft" d="M40 34c-4-5 4-8 0-13M52 34c-4-5 4-8 0-13M64 34c-4-5 4-8 0-13"/></svg>';

  const heart = on => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7C19.5 15.9 12 20.5 12 20.5z"/></svg>`;
  const pic = m => (m.imageUrl && /^https?:\/\//i.test(m.imageUrl)) ? `<img src="${esc(m.imageUrl)}" alt="" loading="lazy" decoding="async">` : `<span class="emo">${esc(m.emoji || '🍽️')}</span>`;

  function dishControl(m, q) {
    if (!m.available) return '<span class="soldout-tag">Habis</span>';
    if (!q) return `<button class="btn-main" type="button" data-add="${esc(m.id)}" aria-label="Tambah ${esc(m.name)}">Tambah</button>`;
    return `<div class="stepper"><button type="button" data-dec="${esc(m.id)}" aria-label="Kurangi ${esc(m.name)}">−</button><span aria-live="polite">${q}</span><button type="button" data-add="${esc(m.id)}" aria-label="Tambah ${esc(m.name)}">+</button></div>`;
  }

  // Menu pertama pada tampilan default dibuat lebih lebar agar susunan tidak seragam
  function isFeat(m) {
    if (view.cat !== 'all' || view.tab !== 'all' || view.q.trim() || view.sort !== 'default') return false;
    const list = visibleMenu();
    return list.length >= 4 && list[0].id === m.id && m.available;
  }

  function dishHTML(m, o = {}) {
    const q = (cart[m.id] && cart[m.id].qty) || 0;
    const isFav = fav.includes(m.id);
    return `<article class="dish${q ? ' selected' : ''}${m.available ? '' : ' soldout'}${o.enter ? ' in' : ''}${o.pop ? ' pop' : ''}${isFeat(m) ? ' feat' : ''}"${o.enter ? ` style="--i:${Math.min(o.i || 0, 8)}"` : ''} data-id="${esc(m.id)}">
      <div class="dish-img" data-cat="${esc(m.category)}">${pic(m)}<span class="tick" aria-hidden="true">${q ? '✓' : ''}</span></div>
      <h3 class="dish-name">${esc(m.name)}</h3>
      <p class="dish-desc">${esc(m.desc || '')}</p>
      <div class="dish-price">${rp(m.price)}</div>
      <div class="dish-act">
        <button class="btn-soft" type="button" data-fav="${esc(m.id)}" aria-pressed="${isFav}" aria-label="${isFav ? 'Hapus' : 'Tambahkan'} ${esc(m.name)} ${isFav ? 'dari' : 'ke'} favorit">${heart(isFav)}<span class="t">Favorit</span></button>
        ${dishControl(m, q)}
      </div>
    </article>`;
  }

  function renderMenu(anim = true) {
    const root = $('#menu-root');
    root.removeAttribute('aria-busy');
    const list = visibleMenu();
    if (!list.length) {
      const msg = view.q ? [`Menu tidak ditemukan`, `Tidak ada hasil untuk “${esc(view.q)}”. Coba kata lain.`, 'clear', 'Hapus pencarian']
        : view.tab === 'fav' ? ['Belum ada favorit', 'Tekan tombol hati pada menu yang kamu suka, nanti muncul di sini.', 'all', 'Lihat semua menu']
          : ['Menu belum tersedia', 'Pemilik restoran belum menambahkan menu di kategori ini.', 'all', 'Lihat semua menu'];
      root.innerHTML = `<div class="cards-empty">${ART}<strong>${msg[0]}</strong><span>${msg[1]}</span><button class="btn alt" style="margin-top:14px" type="button" data-reset="${msg[2]}">${msg[3]}</button></div>`;
    } else {
      root.innerHTML = list.map((m, i) => dishHTML(m, { enter: anim && !reduceMotion, i })).join('');
    }
    $('#fav-count').textContent = fav.length ? `(${fav.length})` : '';
  }

  function refreshDish(id, o) {
    const card = document.querySelector(`.dish[data-id="${CSS.escape(id)}"]`);
    const m = menuById(id);
    if (card && m) card.outerHTML = dishHTML(m, o);
  }

  function setQty(id, qty) {
    const m = menuById(id);
    if (!m || !m.available) return;
    qty = Math.max(0, Math.min(20, qty));
    const prev = (cart[id] && cart[id].qty) || 0;
    if (qty === 0) delete cart[id];
    else cart[id] = { qty, note: (cart[id] && cart[id].note) || '' };
    saveCart();
    const first = prev === 0 && qty > 0;
    if (first) lastAdded = id;
    keepFocus(() => { refreshDish(id, { pop: first }); renderCart(); });
    if (qty > prev) { bump($('#cart-count')); bump($('#mb-total')); }
  }

  function toggleFav(id) {
    fav = fav.includes(id) ? fav.filter(x => x !== id) : [...fav, id];
    saveFav();
    keepFocus(() => { if (view.tab === 'fav') renderMenu(); else { refreshDish(id); $('#fav-count').textContent = fav.length ? `(${fav.length})` : ''; } });
  }

  // ---------- Panel pesanan ----------
  function cartLines() {
    return Object.entries(cart).map(([id, v]) => ({ m: menuById(id), ...v })).filter(l => l.m && l.m.available && l.qty > 0);
  }

  function totals() {
    const lines = cartLines();
    const subtotal = lines.reduce((a, l) => a + l.m.price * l.qty, 0);
    const tax = Math.round((subtotal * config.taxPercent) / 100);
    return { subtotal, tax, total: subtotal + tax, count: lines.reduce((a, l) => a + l.qty, 0) };
  }

  function renderCart() {
    const lines = cartLines();
    const t = totals();
    const has = lines.length > 0;
    $('#cart-count').textContent = t.count;
    $('#cart-form').hidden = !has;
    $('#cart-foot').hidden = !has;
    $('#pay-btn').disabled = !config.payment.ready;
    $('#mobile-bar').hidden = !has;
    $('#mb-count').textContent = t.count;
    $('#mb-total').textContent = rp(t.total);

    const items = $('#cart-items');
    const added = lastAdded; lastAdded = null;
    if (!has) {
      const cats = CATS.filter(c => c.id !== 'all' && menu.some(m => m.category === c.id && m.available));
      items.innerHTML = `<div class="inv-empty">${ART}<strong>Meja ini belum memesan</strong>
        <p>Pilih menu, lalu pesananmu muncul di sini lengkap dengan total bayar.</p>
        <div class="inv-cta">${cats.map(c => `<button type="button" data-goto="${c.id}"><span class="emo-lbl"><span aria-hidden="true">${c.icon}</span>Lihat ${c.label.toLowerCase()}</span><span class="go">${menu.filter(m => m.category === c.id && m.available).length} menu</span></button>`).join('')}</div></div>`;
      return;
    }
    items.innerHTML = lines.map(l => `
      <div class="inv-item${l.m.id === added ? ' new' : ''}" data-id="${esc(l.m.id)}">
        <div class="thumb" data-cat="${esc(l.m.category)}" aria-hidden="true">${pic(l.m)}</div>
        <div class="inv-info"><b>${esc(l.m.name)}</b><span>${rp(l.m.price * l.qty)}</span></div>
        <div class="stepper"><button type="button" data-dec="${esc(l.m.id)}" aria-label="Kurangi ${esc(l.m.name)}">−</button><span>${l.qty}</span><button type="button" data-add="${esc(l.m.id)}" aria-label="Tambah ${esc(l.m.name)}">+</button></div>
        <input class="note" type="text" maxlength="100" placeholder="Catatan, mis. tanpa pedas" value="${esc(l.note || '')}" data-note="${esc(l.m.id)}" aria-label="Catatan untuk ${esc(l.m.name)}">
      </div>`).join('');

    $('#sum-sub').textContent = rp(t.subtotal);
    $('#sum-tax-row').hidden = !(config.taxPercent > 0);
    $('#sum-tax-lbl').textContent = `Pajak ${config.taxPercent}%`;
    $('#sum-tax').textContent = rp(t.tax);
    $('#sum-total').textContent = rp(t.total);
    $('#pay-btn').textContent = `Pesan sekarang · ${rp(t.total)}`;
  }

  // Di layar kecil panel pesanan berupa laci geser
  function openCart() {
    const inv = $('#invoice');
    inv.classList.add('on'); $('#scrim').classList.add('on');
    inv.setAttribute('role', 'dialog'); inv.setAttribute('aria-modal', 'true'); inv.setAttribute('aria-labelledby', 'inv-title');
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('#close-cart').focus(), 50);
  }
  function closeCart(restoreFocus = true) {
    const inv = $('#invoice');
    const wasOpen = inv.classList.contains('on');
    inv.classList.remove('on'); $('#scrim').classList.remove('on');
    inv.removeAttribute('role'); inv.removeAttribute('aria-modal'); inv.removeAttribute('aria-labelledby');
    document.body.style.overflow = '';
    if (wasOpen && restoreFocus) ($('#open-cart').offsetParent ? $('#open-cart') : $('#mobile-bar')).focus();
  }
  function syncInvoiceHidden() { $('#invoice').setAttribute('aria-hidden', mq.matches && !$('#invoice').classList.contains('on') ? 'true' : 'false'); }

  function setGeoNotice(text, kind) {
    const n = $('#geo-notice');
    n.className = 'notice ' + kind;
    n.textContent = text;
    n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function checkout(e) {
    e.preventDefault();
    if (busy) return;
    if (!config.payment.ready) return toast('Pembayaran QRIS belum diatur oleh restoran.', 'bad');
    const lines = cartLines();
    if (!lines.length) return toast('Pesanan masih kosong.', 'bad');
    if (!config.open) return toast('Restoran sedang tutup.', 'bad');
    const name = $('#f-name').value.trim();
    if (!name) { $('#f-name').focus(); return setGeoNotice('Isi nama pemesan dulu.', 'bad'); }

    const btn = $('#pay-btn');
    btn.disabled = true;
    try {
      let location = null;
      if (config.geofence) {
        setGeoNotice('Mengecek lokasimu…', 'info');
        const l = await verifyLocation();
        if (!l.ok) { setGeoNotice(l.message || 'Kamu di luar jangkauan restoran.', 'bad'); return; }
        location = { lat: l.lat, lng: l.lng, accuracy: l.accuracy };
        setGeoNotice(`Lokasi sesuai (${fmtDist(l.distance)} dari restoran). Membuat pesanan…`, 'ok');
      }
      const order = await api('/api/orders', {
        method: 'POST',
        body: {
          items: lines.map(l => ({ id: l.m.id, qty: l.qty, note: l.note || '' })),
          customer: { name, phone: $('#f-phone').value.trim(), table: $('#f-table').value.trim() },
          location
        }
      });
      cart = {}; saveCart();
      store.set('ws_name', { name, phone: $('#f-phone').value.trim(), table: $('#f-table').value.trim() });
      store.set('ws_last', order.id);
      window.location.href = '/bayar.html?o=' + encodeURIComponent(order.id);
    } catch (err) {
      setGeoNotice(err.message, 'bad');
    } finally {
      btn.disabled = !config.payment.ready;
    }
  }

  // ---------- Events ----------
  document.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    const dec = e.target.closest('[data-dec]');
    const fv = e.target.closest('[data-fav]');
    if (add) { const id = add.dataset.add; setQty(id, ((cart[id] && cart[id].qty) || 0) + 1); }
    else if (dec) { const id = dec.dataset.dec; setQty(id, ((cart[id] && cart[id].qty) || 0) - 1); }
    else if (fv) toggleFav(fv.dataset.fav);

    const go = e.target.closest('[data-goto]');
    if (go) {
      view.cat = go.dataset.goto; view.tab = 'all';
      $$('.tabs2 [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === 'all')));
      $$('.cat').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cat === view.cat)));
      renderMenu();
      if (mq.matches) closeCart(false);
      $('#menu').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
    const rs = e.target.closest('[data-reset]');
    if (rs) {
      if (rs.dataset.reset === 'clear') { view.q = ''; $('#q').value = ''; }
      else { view.tab = 'all'; view.cat = 'all'; }
      $$('.tabs2 [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === 'all')));
      $$('.cat').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cat === view.cat)));
      renderMenu();
    }

    const cat = e.target.closest('.cat');
    if (cat) { view.cat = cat.dataset.cat; $$('.cat').forEach(b => b.setAttribute('aria-pressed', String(b === cat))); renderMenu(); }
    const tab = e.target.closest('.tabs2 [data-tab]');
    if (tab) {
      view.tab = tab.dataset.tab;
      $$('.tabs2 [data-tab]').forEach(b => b.setAttribute('aria-selected', b === tab ? 'true' : 'false'));
      renderMenu();
    }
  });
  document.addEventListener('input', e => {
    const n = e.target.closest('[data-note]');
    if (n && cart[n.dataset.note]) { cart[n.dataset.note].note = n.value.slice(0, 100); saveCart(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#invoice').classList.contains('on')) closeCart(); });

  let qTimer;
  $('#q').addEventListener('input', e => { view.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(() => renderMenu(false), 120); });
  $('#sort').addEventListener('change', e => { view.sort = e.target.value; renderMenu(); });
  $('#open-cart').addEventListener('click', openCart);
  $('#mobile-bar').addEventListener('click', openCart);
  $('#close-cart').addEventListener('click', () => closeCart());
  $('#scrim').addEventListener('click', () => closeCart());
  $('#checkout').addEventListener('submit', checkout);
  $('#radar-check').addEventListener('click', checkFromButton);
  mq.addEventListener('change', () => { closeCart(false); syncInvoiceHidden(); });

  // Penanda navigasi mengikuti bagian yang sedang dilihat
  function watchSections() {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        $$('.side-nav a[href^="#"]').forEach(a => {
          if (a.getAttribute('href') === '#' + en.target.id) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    ['menu', 'cara', 'info'].forEach(id => { const s = document.getElementById(id); if (s) io.observe(s); });
  }

  // Bagian di bawah layar muncul halus saat digulir (sekali saja, tanpa listener scroll)
  function watchReveal() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('on'); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -8% 0px' });
    $$('#cara, #info').forEach(el => { el.classList.add('rv'); io.observe(el); });
  }

  // ---------- Mulai ----------
  (async function init() {
    try {
      [config, menu] = await Promise.all([api('/api/config'), api('/api/menu')]);
    } catch (e) {
      $('#menu-root').innerHTML = `<div class="cards-empty">${ART}<strong>Menu gagal dimuat</strong><span>Periksa koneksi internetmu, lalu muat ulang halaman.</span><button class="btn alt" style="margin-top:14px" type="button" onclick="location.reload()">Muat ulang</button></div>`;
      return;
    }
    for (const id of Object.keys(cart)) { const m = menuById(id); if (!m || !m.available) delete cart[id]; }
    fav = fav.filter(id => menuById(id));
    saveCart(); saveFav();
    const prev = store.get('ws_name', null);
    if (prev) { $('#f-name').value = prev.name || ''; $('#f-phone').value = prev.phone || ''; $('#f-table').value = prev.table || ''; }
    renderConfig(); renderCats(); renderMenu(); renderCart(); watchSections(); watchReveal(); syncInvoiceHidden();
  })();
})();
