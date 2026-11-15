(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CATS = [
    { id: 'makanan', label: 'Makanan' },
    { id: 'minuman', label: 'Minuman' },
    { id: 'snack', label: 'Snack' }
  ];

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* abaikan */ } }
  };

  let config = null;
  let menu = [];
  let cart = store.get('ws_cart', {}); // { id: { qty, note } }
  let loc = null; // hasil cek lokasi terakhir
  let busy = false;

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

  // ---------- Config ----------
  function renderConfig() {
    document.title = `${config.name} — Pesan dari meja`;
    $('#brand-name').textContent = config.name;
    $('#foot-name').textContent = `${config.name} © ${new Date().getFullYear()}`;
    if (config.tagline) $('#tagline').textContent = config.tagline;
    $('#info-address').textContent = config.address || '—';
    $('#info-hours').textContent = config.hours || '—';
    $('#info-radius').textContent = config.geofence
      ? `Pemesanan hanya untuk pengunjung dalam radius ${config.radius} m dari restoran.`
      : 'Pemesanan terbuka untuk semua pengunjung.';
    $('#radar-limit-lbl').textContent = `radius ${config.radius} m`;
    $('#map-link').href = `https://www.openstreetmap.org/?mlat=${config.lat}&mlon=${config.lng}#map=18/${config.lat}/${config.lng}`;
    $('#closed').hidden = config.open;
    if (!config.geofence) {
      $('#radar-msg').innerHTML = 'Tanpa batas lokasi<small>Restoran ini menerima pesanan dari mana saja.</small>';
    }
  }

  // ---------- Radar ----------
  function bearing(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
    return Math.atan2(y, x);
  }

  function renderRadar() {
    const box = $('#radar-status');
    if (busy) { box.dataset.state = 'busy'; $('#radar-msg').innerHTML = 'Mencari lokasimu…<small>Izinkan akses lokasi jika diminta browser.</small>'; return; }
    if (!loc) return;
    const you = $('#you');
    if (loc.distance != null && loc.lat != null) {
      const R = 150;
      const rr = Math.min((loc.distance / config.radius) * R, 185);
      const b = bearing(config.lat, config.lng, loc.lat, loc.lng);
      const x = 200 + rr * Math.sin(b), y = 200 - rr * Math.cos(b);
      for (const id of ['#you-dot', '#you-halo']) { $(id).setAttribute('cx', x.toFixed(1)); $(id).setAttribute('cy', y.toFixed(1)); }
      $('#you-dot').setAttribute('fill', loc.ok ? '#b7cfa0' : '#f0c3cd');
      $('#you-halo').setAttribute('fill', loc.ok ? 'rgba(183,207,160,.35)' : 'rgba(240,195,205,.35)');
      you.hidden = false;
    }
    box.dataset.state = loc.ok ? 'ok' : 'bad';
    const msg = $('#radar-msg');
    if (loc.ok) {
      msg.innerHTML = `${loc.distance != null ? `Kamu ${esc(fmtDist(loc.distance))} dari restoran` : 'Lokasi diterima'}<small>Kamu berada di dalam jangkauan. Silakan pesan.</small>`;
    } else {
      msg.innerHTML = `${esc(loc.message || 'Di luar jangkauan')}<small>Datang ke restoran lalu cek lokasi lagi.</small>`;
    }
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
  function renderTabs() {
    $('#tabs').innerHTML = CATS
      .filter(c => menu.some(m => m.category === c.id))
      .map((c, i) => `<a class="tab" href="#cat-${c.id}" data-cat="${c.id}" ${i === 0 ? 'aria-current="true"' : ''}>${c.label}</a>`)
      .join('');
  }

  function itemControl(m) {
    if (!m.available) return '<span class="soldout-tag">Habis</span>';
    const q = (cart[m.id] && cart[m.id].qty) || 0;
    if (!q) return `<button class="add-btn" type="button" data-add="${esc(m.id)}" aria-label="Tambah ${esc(m.name)}">+</button>`;
    return `<div class="stepper"><button type="button" data-dec="${esc(m.id)}" aria-label="Kurangi ${esc(m.name)}">−</button><span aria-live="polite">${q}</span><button type="button" data-add="${esc(m.id)}" aria-label="Tambah ${esc(m.name)}">+</button></div>`;
  }

  function renderMenu() {
    const root = $('#menu-root');
    if (!menu.length) { root.innerHTML = '<p class="muted" style="padding:48px 0">Menu belum tersedia.</p>'; return; }
    root.innerHTML = CATS.map(c => {
      const items = menu.filter(m => m.category === c.id);
      if (!items.length) return '';
      return `<section class="menu-group" id="cat-${c.id}">
        <h3><span class="flower" aria-hidden="true"></span>${c.label}</h3>
        <div class="menu-grid">${items.map(m => {
          const disk = m.imageUrl && /^https?:\/\//i.test(m.imageUrl)
            ? `<img src="${esc(m.imageUrl)}" alt="" loading="lazy">` : esc(m.emoji || '🍽️');
          return `<div class="mi${m.available ? '' : ' soldout'}" data-cat="${c.id}" data-id="${esc(m.id)}">
            <div class="disk" aria-hidden="true">${disk}</div>
            <div>
              <div class="mi-head"><span class="mi-name">${esc(m.name)}</span><span class="mi-dots" aria-hidden="true"></span><span class="mi-price">${rp(m.price)}</span></div>
              <p class="mi-desc">${esc(m.desc || '')}</p>
            </div>
            <div class="mi-side" data-ctl>${itemControl(m)}</div>
          </div>`;
        }).join('')}</div>
      </section>`;
    }).join('');
  }

  function refreshControl(id) {
    const row = document.querySelector(`.mi[data-id="${CSS.escape(id)}"] [data-ctl]`);
    const m = menuById(id);
    if (row && m) row.innerHTML = itemControl(m);
  }

  function setQty(id, qty) {
    const m = menuById(id);
    if (!m || !m.available) return;
    qty = Math.max(0, Math.min(20, qty));
    if (qty === 0) delete cart[id];
    else cart[id] = { qty, note: (cart[id] && cart[id].note) || '' };
    saveCart();
    refreshControl(id);
    renderCart();
  }

  // ---------- Keranjang ----------
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
    $('#cart-count').textContent = t.count;
    const items = $('#cart-items');
    const hasItems = lines.length > 0;
    $('#cart-form').hidden = !hasItems;
    $('#cart-foot').hidden = !hasItems;

    if (!hasItems) {
      items.innerHTML = '<div class="empty"><strong>Keranjang masih kosong</strong>Pilih menu lalu tekan tombol + untuk menambahkannya.</div>';
      return;
    }
    // Jangan render ulang input catatan saat user mengetik.
    items.innerHTML = lines.map(l => `
      <div class="ci" data-id="${esc(l.m.id)}">
        <div class="ci-top"><span>${esc(l.m.name)}</span><span>${rp(l.m.price * l.qty)}</span></div>
        <div class="ci-row">
          <div class="stepper"><button type="button" data-dec="${esc(l.m.id)}" aria-label="Kurangi ${esc(l.m.name)}">−</button><span>${l.qty}</span><button type="button" data-add="${esc(l.m.id)}" aria-label="Tambah ${esc(l.m.name)}">+</button></div>
          <input type="text" maxlength="100" placeholder="Catatan, mis. tanpa pedas" value="${esc(l.note || '')}" data-note="${esc(l.m.id)}" aria-label="Catatan untuk ${esc(l.m.name)}">
        </div>
      </div>`).join('');

    $('#totals').innerHTML = `
      <div><span>Subtotal</span><span>${rp(t.subtotal)}</span></div>
      ${config.taxPercent > 0 ? `<div><span>Pajak ${esc(config.taxPercent)}%</span><span>${rp(t.tax)}</span></div>` : ''}
      <div class="grand"><span>Total</span><span>${rp(t.total)}</span></div>`;
    $('#pay-btn').textContent = `Bayar ${rp(t.total)}`;
  }

  function openCart() {
    $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
    $('#drawer').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('#close-cart').focus(), 50);
  }
  function closeCart() {
    $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on');
    $('#drawer').setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    $('#open-cart').focus();
  }

  function setGeoNotice(text, kind) {
    const n = $('#geo-notice');
    n.className = 'notice ' + kind;
    n.textContent = text;
  }

  async function checkout(e) {
    e.preventDefault();
    if (busy) return;
    const lines = cartLines();
    if (!lines.length) return toast('Keranjang masih kosong.', 'bad');
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
      const method = document.querySelector('input[name="method"]:checked').value;
      const order = await api('/api/orders', {
        method: 'POST',
        body: {
          items: lines.map(l => ({ id: l.m.id, qty: l.qty, note: l.note || '' })),
          customer: { name, phone: $('#f-phone').value.trim(), table: $('#f-table').value.trim() },
          location, method
        }
      });
      cart = {}; saveCart();
      store.set('ws_name', { name, phone: $('#f-phone').value.trim(), table: $('#f-table').value.trim() });
      location_href('/bayar.html?o=' + encodeURIComponent(order.id));
    } catch (err) {
      setGeoNotice(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  }
  const location_href = url => { window.location.href = url; };

  // ---------- Events ----------
  document.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    const dec = e.target.closest('[data-dec]');
    if (add) { const id = add.dataset.add; setQty(id, ((cart[id] && cart[id].qty) || 0) + 1); }
    else if (dec) { const id = dec.dataset.dec; setQty(id, ((cart[id] && cart[id].qty) || 0) - 1); }
  });
  document.addEventListener('input', e => {
    const n = e.target.closest('[data-note]');
    if (n && cart[n.dataset.note]) { cart[n.dataset.note].note = n.value.slice(0, 100); saveCart(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#drawer').classList.contains('on')) closeCart(); });

  $('#open-cart').addEventListener('click', openCart);
  $('#close-cart').addEventListener('click', closeCart);
  $('#scrim').addEventListener('click', closeCart);
  $('#checkout').addEventListener('submit', checkout);
  $('#radar-check').addEventListener('click', checkFromButton);
  $('#hero-check').addEventListener('click', () => { $('#radar-check').scrollIntoView({ behavior: 'smooth', block: 'center' }); checkFromButton(); });

  // Tab kategori mengikuti posisi scroll
  function watchTabs() {
    const secs = [...document.querySelectorAll('.menu-group')];
    if (!('IntersectionObserver' in window) || !secs.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const cat = en.target.id.replace('cat-', '');
        document.querySelectorAll('.tab').forEach(t => {
          if (t.dataset.cat === cat) t.setAttribute('aria-current', 'true');
          else t.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    secs.forEach(s => io.observe(s));
  }

  // ---------- Mulai ----------
  (async function init() {
    try {
      [config, menu] = await Promise.all([api('/api/config'), api('/api/menu')]);
    } catch (e) {
      $('#menu-root').innerHTML = '<p class="notice bad" style="margin:48px 0">Menu gagal dimuat. Muat ulang halaman.</p>';
      return;
    }
    // Bersihkan keranjang dari menu yang sudah dihapus / habis
    for (const id of Object.keys(cart)) { const m = menuById(id); if (!m || !m.available) delete cart[id]; }
    saveCart();
    const prev = store.get('ws_name', null);
    if (prev) { $('#f-name').value = prev.name || ''; $('#f-phone').value = prev.phone || ''; $('#f-table').value = prev.table || ''; }
    renderConfig(); renderTabs(); renderMenu(); renderCart(); watchTabs();
  })();
})();
