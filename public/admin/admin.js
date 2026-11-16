(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CAT_LABEL = { makanan: 'Makanan', minuman: 'Minuman', snack: 'Snack' };
  const STATUS_LABEL = {
    pending_payment: 'Menunggu bayar', paid: 'Sudah dibayar', preparing: 'Disiapkan',
    ready: 'Siap diantar', completed: 'Selesai', cancelled: 'Dibatalkan', expired: 'Kedaluwarsa'
  };
  const NEXT = {
    paid: { to: 'preparing', label: 'Mulai siapkan' },
    preparing: { to: 'ready', label: 'Tandai siap' },
    ready: { to: 'completed', label: 'Selesaikan' }
  };
  const CAN_CANCEL = ['pending_payment', 'paid', 'preparing', 'ready'];
  const FILTERS = [
    { id: 'active', label: 'Perlu diproses', test: o => ['paid', 'preparing', 'ready'].includes(o.status) },
    { id: 'pending', label: 'Menunggu bayar', test: o => o.status === 'pending_payment' },
    { id: 'done', label: 'Selesai', test: o => o.status === 'completed' },
    { id: 'closed', label: 'Batal / kedaluwarsa', test: o => ['cancelled', 'expired'].includes(o.status) },
    { id: 'all', label: 'Semua', test: () => true }
  ];

  let token = sessionStorage.getItem('ws_admin') || '';
  let orders = [], menu = [], settings = null;
  let filter = 'active';
  let knownPaid = null; // Set id pesanan yang sudah pernah terlihat
  let fresh = new Set();
  let pollTimer;
  let map, marker, circle;

  async function API(path, opts = {}) {
    const res = await fetch('/api/admin' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error(data.error || 'Sesi berakhir. Masuk lagi.'); }
    if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
    return data;
  }

  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 3800);
  }

  // ---------- Auth ----------
  function showLogin() { $('#login-view').hidden = false; $('#app-view').hidden = true; clearTimeout(pollTimer); }
  function logout() { token = ''; sessionStorage.removeItem('ws_admin'); showLogin(); }

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#login-err'); err.hidden = true;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#l-user').value, password: $('#l-pass').value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Gagal masuk.');
      token = data.token; sessionStorage.setItem('ws_admin', token);
      $('#l-pass').value = '';
      start();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  $('#logout').addEventListener('click', logout);

  // ---------- Tab ----------
  function setTab(name) {
    $$('.side-nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === name ? 'page' : 'false'));
    $$('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + name; });
    if (name === 'settings') initMap();
  }
  $$('.side-nav button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- Pesanan ----------
  const timeFmt = iso => new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  function beep() {
    if (!$('#sound').checked) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [660, 880].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
        o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.18);
      });
    } catch { /* browser memblokir audio sebelum ada interaksi */ }
  }

  function renderStats() {
    const today = new Date().toDateString();
    const paidStatuses = ['paid', 'preparing', 'ready', 'completed'];
    const todays = orders.filter(o => new Date(o.createdAt).toDateString() === today && paidStatuses.includes(o.status));
    const revenue = todays.reduce((a, o) => a + o.total, 0);
    const active = orders.filter(o => ['paid', 'preparing', 'ready'].includes(o.status)).length;
    $('#stats').innerHTML = `
      <div class="stat"><b>${active}</b><span>Perlu diproses</span></div>
      <div class="stat"><b>${todays.length}</b><span>Pesanan dibayar hari ini</span></div>
      <div class="stat"><b>${rp(revenue)}</b><span>Pendapatan hari ini</span></div>`;
    const badge = $('#orders-badge');
    badge.textContent = active; badge.hidden = active === 0;
  }

  function renderFilters() {
    $('#filters').innerHTML = FILTERS.map(f => {
      const n = orders.filter(f.test).length;
      return `<button class="chip" role="tab" aria-selected="${f.id === filter}" data-f="${f.id}">${f.label} (${n})</button>`;
    }).join('');
  }

  function renderOrders() {
    renderStats(); renderFilters();
    const f = FILTERS.find(x => x.id === filter);
    const list = orders.filter(f.test);
    const root = $('#orders-list');
    if (!list.length) {
      root.innerHTML = '<div class="empty"><strong>Belum ada pesanan di sini</strong>Pesanan baru akan muncul otomatis.</div>';
      return;
    }
    root.innerHTML = list.map(o => {
      const next = NEXT[o.status];
      return `<article class="order${fresh.has(o.id) ? ' fresh' : ''}">
        <div class="order-top">
          <div>
            <div class="order-code">${esc(o.id.slice(-6))}</div>
            <div class="order-meta">${esc(o.customer.name)}${o.customer.table ? ` · Meja ${esc(o.customer.table)}` : ''}${o.phone ? ` · ${esc(o.phone)}` : ''}</div>
            <div class="order-meta">${esc(timeFmt(o.createdAt))}${o.distance != null ? ` · ${esc(o.distance)} m dari restoran` : ''} · ${o.payment.method === 'qris' ? 'QRIS' : 'Midtrans'}</div>
          </div>
          <span class="pill ${esc(o.status)}">${esc(STATUS_LABEL[o.status] || o.status)}</span>
        </div>
        <ul>${o.items.map(i => `<li><span>${i.qty}× ${esc(i.name)}${i.note ? `<small>Catatan: ${esc(i.note)}</small>` : ''}</span><span>${rp(i.price * i.qty)}</span></li>`).join('')}</ul>
        <div class="order-total"><span>Total</span><span>${rp(o.total)}</span></div>
        <div class="order-actions">
          ${next ? `<button class="btn primary small" data-adv="${esc(o.id)}" data-to="${next.to}">${next.label}</button>` : ''}
          ${CAN_CANCEL.includes(o.status) ? `<button class="btn danger small" data-cancel="${esc(o.id)}">Batalkan</button>` : ''}
        </div>
      </article>`;
    }).join('');
  }

  async function loadOrders(initial) {
    try {
      orders = await API('/orders');
      const paidNow = new Set(orders.filter(o => o.status !== 'pending_payment' && o.status !== 'expired' && o.status !== 'cancelled').map(o => o.id));
      if (knownPaid === null) knownPaid = paidNow;
      else {
        const added = [...paidNow].filter(id => !knownPaid.has(id));
        if (added.length) {
          added.forEach(id => fresh.add(id));
          beep();
          toast(added.length === 1 ? 'Ada pesanan baru yang sudah dibayar.' : `${added.length} pesanan baru sudah dibayar.`);
          setTimeout(() => { fresh.clear(); renderOrders(); }, 2600);
        }
        knownPaid = paidNow;
      }
      renderOrders();
    } catch (e) { if (initial) toast(e.message, true); }
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadOrders, 7000);
  }

  $('#filters').addEventListener('click', e => {
    const b = e.target.closest('[data-f]');
    if (b) { filter = b.dataset.f; renderOrders(); }
  });
  $('#orders-list').addEventListener('click', async e => {
    const adv = e.target.closest('[data-adv]');
    const can = e.target.closest('[data-cancel]');
    if (!adv && !can) return;
    const id = (adv || can).dataset[adv ? 'adv' : 'cancel'];
    const to = adv ? adv.dataset.to : 'cancelled';
    if (can && !confirm('Batalkan pesanan ini? Jika sudah dibayar, lakukan refund lewat dashboard Midtrans.')) return;
    try {
      await API('/orders/' + encodeURIComponent(id), { method: 'PATCH', body: { status: to } });
      const o = orders.find(x => x.id === id); if (o) o.status = to;
      renderOrders();
      toast(to === 'cancelled' ? 'Pesanan dibatalkan.' : 'Status pesanan diperbarui.');
    } catch (ex) { toast(ex.message, true); }
  });

  // ---------- Menu ----------
  function renderMenu() {
    const rows = [...menu].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    $('#menu-rows').innerHTML = rows.length ? rows.map(m => `
      <tr>
        <td class="em" aria-hidden="true">${esc(m.emoji || '🍽️')}</td>
        <td><strong>${esc(m.name)}</strong><span class="sub">${esc(m.desc || '')}</span></td>
        <td>${esc(CAT_LABEL[m.category] || m.category)}</td>
        <td class="r">${rp(m.price)}</td>
        <td><label class="switch"><input type="checkbox" data-avail="${esc(m.id)}" ${m.available ? 'checked' : ''} aria-label="Tersedia: ${esc(m.name)}"><i></i></label></td>
        <td><div class="acts"><button class="btn small" data-edit="${esc(m.id)}">Ubah</button><button class="btn small danger" data-del="${esc(m.id)}">Hapus</button></div></td>
      </tr>`).join('') : '<tr><td colspan="6"><div class="empty"><strong>Menu masih kosong</strong>Tekan "Tambah menu" untuk mulai.</div></td></tr>';
  }
  async function loadMenu() { menu = await API('/menu'); renderMenu(); }

  const dlg = $('#menu-dialog');
  let editingId = null;
  function openMenuDialog(m) {
    editingId = m ? m.id : null;
    $('#menu-dialog-title').textContent = m ? 'Ubah menu' : 'Tambah menu';
    $('#m-name').value = m ? m.name : '';
    $('#m-desc').value = m ? m.desc || '' : '';
    $('#m-cat').value = m ? m.category : 'makanan';
    $('#m-price').value = m ? m.price : '';
    $('#m-emoji').value = m ? m.emoji || '' : '';
    $('#m-img').value = m ? m.imageUrl || '' : '';
    $('#m-avail').checked = m ? !!m.available : true;
    $('#menu-err').hidden = true;
    dlg.showModal();
    $('#m-name').focus();
  }
  $('#add-menu').addEventListener('click', () => openMenuDialog(null));
  $('#menu-cancel').addEventListener('click', () => dlg.close());
  $('#menu-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      name: $('#m-name').value, desc: $('#m-desc').value, category: $('#m-cat').value,
      price: Number($('#m-price').value), emoji: $('#m-emoji').value, imageUrl: $('#m-img').value,
      available: $('#m-avail').checked
    };
    try {
      if (editingId) await API('/menu/' + encodeURIComponent(editingId), { method: 'PUT', body });
      else await API('/menu', { method: 'POST', body });
      dlg.close(); await loadMenu(); toast('Menu disimpan.');
    } catch (ex) { const er = $('#menu-err'); er.textContent = ex.message; er.hidden = false; }
  });
  $('#menu-rows').addEventListener('click', async e => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) openMenuDialog(menu.find(m => m.id === ed.dataset.edit));
    if (del) {
      const m = menu.find(x => x.id === del.dataset.del);
      if (!m || !confirm(`Hapus "${m.name}" dari menu? Pesanan lama tidak terpengaruh.`)) return;
      try { await API('/menu/' + encodeURIComponent(m.id), { method: 'DELETE' }); await loadMenu(); toast('Menu dihapus.'); }
      catch (ex) { toast(ex.message, true); }
    }
  });
  $('#menu-rows').addEventListener('change', async e => {
    const t = e.target.closest('[data-avail]');
    if (!t) return;
    try { await API('/menu/' + encodeURIComponent(t.dataset.avail), { method: 'PUT', body: { available: t.checked } }); toast(t.checked ? 'Menu tersedia.' : 'Menu ditandai habis.'); }
    catch (ex) { t.checked = !t.checked; toast(ex.message, true); }
  });

  // ---------- Pengaturan ----------
  function fillSettings() {
    const s = settings;
    $('#s-lat').value = s.lat; $('#s-lng').value = s.lng;
    $('#s-radius').value = s.radius; $('#s-acc').value = s.maxAccuracy;
    $('#s-geo').checked = s.geofenceEnabled; $('#s-open').checked = s.open;
    $('#s-name-in').value = s.name; $('#s-tagline').value = s.tagline || '';
    $('#s-address').value = s.address || ''; $('#s-hours').value = s.hours || '';
    $('#s-tax').value = s.taxPercent;
    $('#s-name').textContent = s.name;
    document.title = `Admin — ${s.name}`;
    const modes = {
      mock: 'Mode demo: kunci Midtrans belum diisi, pembayaran hanya simulasi. Isi MIDTRANS_SERVER_KEY dan MIDTRANS_CLIENT_KEY di file .env untuk mulai menerima pembayaran.',
      sandbox: 'Midtrans Sandbox aktif: transaksi uji coba, tidak ada uang sungguhan.',
      production: 'Midtrans Production aktif: transaksi memakai uang sungguhan.'
    };
    const pm = $('#pay-mode');
    pm.textContent = modes[s.paymentMode] || '';
    pm.className = 'notice ' + (s.paymentMode === 'production' ? 'ok' : 'info');
  }

  function initMap() {
    if (!window.L || !settings) return;
    const lat = Number($('#s-lat').value) || settings.lat, lng = Number($('#s-lng').value) || settings.lng;
    if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
    map = L.map('map').setView([lat, lng], 17);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    marker = L.marker([lat, lng], { draggable: true }).addTo(map);
    circle = L.circle([lat, lng], { radius: Number($('#s-radius').value) || settings.radius, color: '#2c365a', fillColor: '#c4bcb0', fillOpacity: 0.18, weight: 2 }).addTo(map);
    const setPoint = ll => { marker.setLatLng(ll); circle.setLatLng(ll); $('#s-lat').value = ll.lat.toFixed(6); $('#s-lng').value = ll.lng.toFixed(6); };
    marker.on('dragend', () => setPoint(marker.getLatLng()));
    map.on('click', e => setPoint(e.latlng));
    map.fitBounds(circle.getBounds(), { padding: [30, 30] });
    setTimeout(() => map.invalidateSize(), 80);
  }
  function syncFromInputs() {
    if (!map) return;
    const lat = Number($('#s-lat').value), lng = Number($('#s-lng').value), r = Number($('#s-radius').value);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) { marker.setLatLng([lat, lng]); circle.setLatLng([lat, lng]); }
    if (Number.isFinite(r) && r > 0) { circle.setRadius(r); map.fitBounds(circle.getBounds(), { padding: [30, 30] }); }
  }
  ['#s-lat', '#s-lng', '#s-radius'].forEach(s => $(s).addEventListener('change', syncFromInputs));

  $('#use-me').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Browser tidak mendukung lokasi.', true);
    navigator.geolocation.getCurrentPosition(p => {
      $('#s-lat').value = p.coords.latitude.toFixed(6); $('#s-lng').value = p.coords.longitude.toFixed(6);
      syncFromInputs();
      if (map) map.setView([p.coords.latitude, p.coords.longitude], 18);
      toast('Titik pusat dipindahkan ke lokasimu. Tekan Simpan untuk menerapkan.');
    }, () => toast('Tidak bisa membaca lokasi. Izinkan akses lokasi atau klik peta.', true), { enableHighAccuracy: true, timeout: 15000 });
  });

  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#settings-msg');
    try {
      settings = await API('/settings', {
        method: 'PUT',
        body: {
          lat: Number($('#s-lat').value), lng: Number($('#s-lng').value),
          radius: Number($('#s-radius').value), maxAccuracy: Number($('#s-acc').value),
          geofenceEnabled: $('#s-geo').checked, open: $('#s-open').checked,
          name: $('#s-name-in').value, tagline: $('#s-tagline').value,
          address: $('#s-address').value, hours: $('#s-hours').value,
          taxPercent: Number($('#s-tax').value)
        }
      });
      fillSettings(); syncFromInputs();
      msg.className = 'notice ok'; msg.textContent = 'Pengaturan disimpan.'; msg.hidden = false;
      setTimeout(() => { msg.hidden = true; }, 3000);
    } catch (ex) { msg.className = 'notice bad'; msg.textContent = ex.message; msg.hidden = false; }
  });

  // ---------- Mulai ----------
  async function start() {
    $('#login-view').hidden = true; $('#app-view').hidden = false;
    try {
      settings = await API('/settings');
      fillSettings();
      await Promise.all([loadMenu(), loadOrders(true)]);
    } catch (e) { /* 401 sudah ditangani logout() */ }
  }

  if (token) start(); else showLogin();
})();
