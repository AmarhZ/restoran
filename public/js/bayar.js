(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const id = new URLSearchParams(location.search).get('o');
  const root = $('#root');

  let config, order, pollTimer, tickTimer;

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
  const qrisUrl = () => `/api/qris?v=${encodeURIComponent(config.payment.version)}`;

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
    const claimed = !!o.payment.claimedAt;
    const merchant = config.payment.merchant;
    return `<div class="panel hot">
      <h1>${claimed ? 'Menunggu konfirmasi kasir' : 'Bayar dengan QRIS'}</h1>
      ${claimed
        ? '<p class="muted" style="margin:0">Kasir sedang memeriksa pembayaranmu. Halaman ini berubah sendiri setelah pembayaran dikonfirmasi.</p>'
        : '<p class="muted" style="margin:0">Selesaikan dalam <span class="countdown" id="cd">--:--</span>, lalu tekan tombol <strong>Saya sudah bayar</strong>.</p>'}
      <div class="big-total">${rp(o.total)}</div>
      <p class="muted" style="margin:4px 0 0">Masukkan nominal tepat seperti di atas.</p>

      <div class="qr-box" id="qr"><img src="${qrisUrl()}" alt="Kode QRIS${merchant ? ' ' + esc(merchant) : ''}"></div>
      ${merchant ? `<p class="muted" style="text-align:center;margin:0 0 4px">Penerima: <strong>${esc(merchant)}</strong></p>` : ''}

      <ol class="how">
        <li>Buka e-wallet atau m-banking, pilih <strong>Scan QR</strong>.</li>
        <li>Arahkan ke kode di atas, lalu ketik nominal <strong>${rp(o.total)}</strong>.</li>
        <li>Setelah berhasil, tekan <strong>Saya sudah bayar</strong>.</li>
      </ol>

      ${claimed ? '' : '<button class="btn block" id="claim-btn" type="button">Saya sudah bayar</button>'}
      <div class="pay-tools">
        <button class="btn alt" id="copy-amt" type="button">Salin nominal</button>
        <a class="btn alt" href="${qrisUrl()}" download="qris-${esc(config.name.replace(/\s+/g, '-').toLowerCase())}">Simpan gambar QRIS</a>
      </div>
      <p class="muted" style="margin:14px 0 0;font-size:.88rem">Membayar dari ponsel yang sama? Simpan gambar QRIS, lalu pilih dari galeri di menu Scan QR e-wallet-mu.</p>
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
      <p class="muted">${expired ? 'Pembayaran tidak diterima sebelum batas waktu.' : 'Pesanan ini dibatalkan dan tidak akan diproses.'} Jika kamu sudah membayar, tunjukkan bukti bayar dan kode <strong>${esc(shortCode(o))}</strong> ke kasir. Jika belum, buat pesanan baru dari menu.</p>
      <a class="btn block" style="margin-top:16px" href="/#menu">Kembali ke menu</a>
    </div>`;
  }

  function render() {
    const status = order.status;
    const pending = status === 'pending_payment';
    const key = pending ? (order.payment.claimedAt ? 'claimed' : 'pending') : status;
    const main = pending ? pendingPanel(order)
      : ['paid', 'preparing', 'ready', 'completed'].includes(status) ? paidPanel(order) : endedPanel(order);
    // Panel yang sama tidak digambar ulang (gambar QRIS tidak berkedip)
    if (root.dataset.key !== key) {
      root.dataset.key = key;
      root.innerHTML = `<div class="pay-grid"><div id="main">${main}</div><div>${summary(order)}</div></div>`;
      if (pending) bindPending();
    } else if (!pending) {
      $('#main').innerHTML = main;
    }
  }

  function bindPending() {
    const img = $('#qr img');
    if (img) img.addEventListener('error', () => { $('#qr').textContent = 'Gambar QRIS tidak dapat dimuat. Minta bantuan kasir.'; });

    $('#copy-amt').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(String(order.total)); toast(`Nominal ${order.total} disalin.`); }
      catch { toast(`Ketik nominal ${rp(order.total)} secara manual.`); }
    });

    const claim = $('#claim-btn');
    if (claim) claim.addEventListener('click', async () => {
      claim.disabled = true;
      try { order = await api(`/api/orders/${encodeURIComponent(id)}/claim`, { method: 'POST' }); render(); toast('Terima kasih. Kasir akan memeriksa pembayaranmu.'); }
      catch (e) { toast(e.message, true); claim.disabled = false; }
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
      const changed = o.status !== order.status || !!o.payment.claimedAt !== !!order.payment.claimedAt;
      order = o;
      if (changed || order.status !== 'pending_payment') render();
      if (changed && order.status === 'paid') toast('Pembayaran dikonfirmasi. Terima kasih!');
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
