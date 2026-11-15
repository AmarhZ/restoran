(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const id = new URLSearchParams(location.search).get('o');
  const root = $('#root');

  let config, order, snapLoaded = false, snapAutoOpened = false, pollTimer, tickTimer, qrDrawn = false;

  async function api(path, opts = {}) {
    const res = await fetch(path, { method: opts.method || 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan. Coba lagi.');
    return data;
  }

  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 4000);
  }

  const shortCode = o => o.id.slice(-6);

  function summary(o) {
    return `<div class="panel">
      <h2>Rincian pesanan</h2>
      <p class="muted" style="margin:0 0 12px">Kode <strong>${esc(shortCode(o))}</strong> · atas nama ${esc(o.customer.name)}${o.customer.table ? ` · meja ${esc(o.customer.table)}` : ''}</p>
      ${o.items.map(i => `<div class="sum-line"><span>${i.qty}× ${esc(i.name)}${i.note ? `<br><small class="muted">${esc(i.note)}</small>` : ''}</span><span>${rp(i.price * i.qty)}</span></div>`).join('')}
      <div class="sum-line"><span>Subtotal</span><span>${rp(o.subtotal)}</span></div>
      ${o.tax > 0 ? `<div class="sum-line"><span>Pajak ${esc(o.taxPercent)}%</span><span>${rp(o.tax)}</span></div>` : ''}
      <div class="sum-line total"><span>Total</span><span>${rp(o.total)}</span></div>
    </div>`;
  }

  function track(status) {
    const steps = [['paid', 'Dibayar'], ['preparing', 'Disiapkan'], ['ready', 'Siap diantar'], ['completed', 'Selesai']];
    const idx = steps.findIndex(s => s[0] === status);
    return `<div class="track" aria-label="Status pesanan">${steps.map((s, i) =>
      `<div class="${i < idx || status === 'completed' ? 'done' : i === idx ? 'now' : ''}">${s[1]}</div>`).join('')}</div>`;
  }

  function pendingPanel(o) {
    const mock = config.midtrans.mode === 'mock';
    const isQris = o.payment.method === 'qris';
    return `<div class="panel hot">
      ${mock ? '<span class="demo-tag">Mode demo — belum terhubung ke Midtrans</span>' : ''}
      <h1>Selesaikan pembayaran</h1>
      <p class="muted" style="margin:0">Bayar dalam <span class="countdown" id="cd">--:--</span>. Pesanan diteruskan ke dapur setelah pembayaran berhasil.</p>
      <div class="big-total" style="margin-top:16px">${rp(o.total)}</div>
      ${isQris ? `
        <div class="qr-box" id="qr" aria-label="Kode QRIS"></div>
        <p class="muted" style="text-align:center;margin:0">Buka e-wallet atau m-banking, pilih <strong>Scan QR</strong>, lalu arahkan ke kode di atas.</p>`
        : `<p class="muted" style="margin:18px 0 12px">Pilih transfer bank, e-wallet, kartu, atau metode lain di jendela pembayaran Midtrans.</p>
           <button class="btn block" id="snap-btn" type="button">Pilih metode pembayaran</button>`}
      ${mock ? `<hr class="hr">
        <p class="muted" style="margin:0 0 10px">Di mode demo, tidak ada uang sungguhan. Tekan tombol di bawah untuk menyimulasikan pembayaran berhasil.</p>
        <button class="btn alt block" id="sim-btn" type="button">Simulasikan pembayaran berhasil</button>` : ''}
      <p class="muted" style="margin:18px 0 0;font-size:.9rem">Halaman ini diperbarui otomatis. Jangan tutup sebelum pembayaran selesai.</p>
    </div>`;
  }

  function paidPanel(o) {
    const labels = {
      paid: ['Pembayaran diterima', 'Pesananmu sudah masuk ke dapur. Kami segera menyiapkannya.'],
      preparing: ['Pesananmu sedang disiapkan', 'Dapur sedang memasak. Tunggu di tempat dudukmu.'],
      ready: ['Pesananmu siap diantar', 'Pelayan segera membawa pesanan ke mejamu.'],
      completed: ['Pesanan selesai', 'Terima kasih sudah makan di sini. Sampai jumpa lagi.']
    }[o.status];
    return `<div class="panel hot">
      <h1 class="state-title">${labels[0]}</h1>
      <p class="muted" style="margin:0">${labels[1]}</p>
      ${track(o.status)}
      <p style="margin:18px 0 0">Tunjukkan kode <strong style="font-size:1.4rem;letter-spacing:.06em">${esc(shortCode(o))}</strong> jika pelayan menanyakan pesananmu.</p>
      ${o.status === 'completed' ? '<a class="btn block" style="margin-top:20px" href="/#menu">Pesan lagi</a>' : ''}
    </div>`;
  }

  function endedPanel(o) {
    const expired = o.status === 'expired';
    return `<div class="panel hot">
      <h1 class="state-title">${expired ? 'Waktu pembayaran habis' : 'Pesanan dibatalkan'}</h1>
      <p class="muted">${expired ? 'Pembayaran tidak diterima sebelum batas waktu.' : 'Pesanan ini dibatalkan dan tidak akan diproses.'} Kamu belum dikenai biaya. Buat pesanan baru dari menu.</p>
      <a class="btn block" style="margin-top:16px" href="/#menu">Kembali ke menu</a>
    </div>`;
  }

  function render() {
    const status = order.status;
    const main = status === 'pending_payment' ? pendingPanel(order)
      : ['paid', 'preparing', 'ready', 'completed'].includes(status) ? paidPanel(order) : endedPanel(order);
    // Hindari menggambar ulang panel yang sama (QR/Snap tidak berkedip)
    const key = status === 'pending_payment' ? 'pending' : status;
    if (root.dataset.key !== key) {
      root.dataset.key = key;
      qrDrawn = false;
      root.innerHTML = `<div class="pay-grid"><div id="main">${main}</div><div>${summary(order)}</div></div>`;
      if (status === 'pending_payment') bindPending();
    } else if (status !== 'pending_payment') {
      $('#main').innerHTML = main;
    }
  }

  function drawQr() {
    if (qrDrawn) return;
    const box = $('#qr');
    if (!box) return;
    box.innerHTML = '';
    if (order.payment.qrString && window.QRCode) {
      new window.QRCode(box, { text: order.payment.qrString, width: 236, height: 236, correctLevel: window.QRCode.CorrectLevel.M });
      qrDrawn = true;
    } else if (order.payment.qrUrl) {
      const img = document.createElement('img');
      img.alt = 'Kode QRIS';
      img.src = order.payment.qrUrl;
      box.appendChild(img);
      qrDrawn = true;
    } else {
      box.textContent = 'QR belum tersedia';
    }
  }

  function loadSnap() {
    return new Promise((resolve, reject) => {
      if (snapLoaded && window.snap) return resolve();
      const s = document.createElement('script');
      s.src = config.midtrans.snapUrl;
      s.setAttribute('data-client-key', config.midtrans.clientKey);
      s.onload = () => { snapLoaded = true; resolve(); };
      s.onerror = () => reject(new Error('Gagal memuat Midtrans. Periksa koneksi internetmu.'));
      document.head.appendChild(s);
    });
  }

  async function openSnap() {
    try {
      await loadSnap();
      window.snap.pay(order.payment.snapToken, {
        onSuccess: () => poll(),
        onPending: () => toast('Menunggu pembayaran kamu selesai.'),
        onError: () => toast('Pembayaran gagal. Coba lagi atau pilih metode lain.', true),
        onClose: () => { /* tombol tetap tersedia */ }
      });
    } catch (e) { toast(e.message, true); }
  }

  function bindPending() {
    const mock = config.midtrans.mode === 'mock';
    if (order.payment.method === 'qris') drawQr();
    else if (!mock) {
      $('#snap-btn').addEventListener('click', openSnap);
      if (!snapAutoOpened) { snapAutoOpened = true; openSnap(); }
    } else {
      $('#snap-btn').addEventListener('click', () => toast('Mode demo: gunakan tombol simulasi di bawah.'));
    }
    const sim = $('#sim-btn');
    if (sim) sim.addEventListener('click', async () => {
      sim.disabled = true;
      try { order = await api(`/api/orders/${encodeURIComponent(id)}/simulate-pay`, { method: 'POST' }); render(); }
      catch (e) { toast(e.message, true); sim.disabled = false; }
    });
    tick();
  }

  function tick() {
    clearInterval(tickTimer);
    const run = () => {
      const el = $('#cd');
      if (!el) return clearInterval(tickTimer);
      const left = Math.max(0, new Date(order.payment.expiresAt).getTime() - Date.now());
      const m = String(Math.floor(left / 60000)).padStart(2, '0');
      const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
      el.textContent = `${m}:${s}`;
    };
    run();
    tickTimer = setInterval(run, 1000);
  }

  async function poll() {
    try {
      const o = await api(`/api/orders/${encodeURIComponent(id)}`);
      const changed = o.status !== order.status;
      order = o;
      if (changed || order.status !== 'pending_payment') render();
      if (changed && order.status === 'paid') toast('Pembayaran diterima. Terima kasih!');
    } catch { /* coba lagi pada putaran berikutnya */ }
    const done = ['completed', 'cancelled', 'expired'].includes(order.status);
    clearTimeout(pollTimer);
    if (!done) pollTimer = setTimeout(poll, order.status === 'pending_payment' ? 3000 : 8000);
  }

  (async function init() {
    if (!id) { root.innerHTML = '<div class="panel"><h1>Pesanan tidak ditemukan</h1><p class="muted">Tautan ini tidak memuat kode pesanan.</p><a class="btn" href="/">Ke beranda</a></div>'; return; }
    try {
      [config, order] = await Promise.all([api('/api/config'), api(`/api/orders/${encodeURIComponent(id)}`)]);
    } catch (e) {
      root.innerHTML = `<div class="panel"><h1>Pesanan tidak ditemukan</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="/">Ke beranda</a></div>`;
      return;
    }
    $('#brand-name').textContent = config.name;
    document.title = `Pembayaran — ${config.name}`;
    render();
    poll();
  })();
})();
