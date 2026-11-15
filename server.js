'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Muat .env (tanpa dependensi) ----
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* .env opsional */ }

const express = require('express');
const db = require('./lib/db');

const PORT = Number(process.env.PORT) || 3000;
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY || '';
const IS_PROD = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const MOCK = !SERVER_KEY; // tanpa kunci = mode demo
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const SNAP_BASE = IS_PROD ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com';
const API_BASE = IS_PROD ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
const PAY_WINDOW_MIN = 30;

const CATEGORIES = ['makanan', 'minuman', 'snack'];
const ORDER_STATUSES = ['pending_payment', 'paid', 'preparing', 'ready', 'completed', 'cancelled', 'expired'];

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'geolocation=(self)');
  next();
});

// ---------- Utilitas ----------
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || h.reset < now) { hits.set(req.ip, { n: 1, reset: now + windowMs }); return next(); }
    if (++h.n > max) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi sebentar lagi.' });
    next();
  };
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = d => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Geofence: validasi di SERVER (klien tidak dipercaya).
function checkLocation(loc) {
  const s = db.settings;
  if (!s.geofenceEnabled) return { ok: true, distance: null, radius: s.radius, reason: 'disabled' };
  if (!loc || !isNum(loc.lat) || !isNum(loc.lng) || Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) {
    return { ok: false, distance: null, radius: s.radius, reason: 'invalid', message: 'Lokasi tidak valid. Aktifkan GPS lalu coba lagi.' };
  }
  const accuracy = isNum(loc.accuracy) ? loc.accuracy : Infinity;
  const distance = Math.round(distanceM(loc.lat, loc.lng, s.lat, s.lng));
  if (accuracy > s.maxAccuracy) {
    return { ok: false, distance, radius: s.radius, reason: 'accuracy', message: `Sinyal GPS kurang akurat (±${Math.round(accuracy)} m). Pindah ke tempat terbuka atau aktifkan lokasi presisi tinggi.` };
  }
  if (distance > s.radius) {
    return { ok: false, distance, radius: s.radius, reason: 'outside', message: `Kamu berada ${distance} m dari restoran. Pemesanan hanya untuk radius ${s.radius} m.` };
  }
  return { ok: true, distance, radius: s.radius, reason: 'inside' };
}

function newOrderId() {
  return 'WS-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function publicOrder(o) {
  return {
    id: o.id,
    createdAt: o.createdAt,
    status: o.status,
    items: o.items,
    subtotal: o.subtotal,
    taxPercent: o.taxPercent,
    tax: o.tax,
    total: o.total,
    customer: { name: o.customer.name, table: o.customer.table },
    payment: {
      method: o.payment.method,
      provider: o.payment.provider,
      snapToken: o.payment.snapToken || null,
      qrString: o.payment.qrString || null,
      qrUrl: o.payment.qrUrl || null,
      expiresAt: o.payment.expiresAt,
      paidAt: o.payment.paidAt || null
    }
  };
}

// ---------- Midtrans ----------
const authHeader = () => 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64');

async function midtransRequest(url, body, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  const sc = data.status_code ? String(data.status_code) : '';
  if (!res.ok || (sc && !['200', '201', '407'].includes(sc))) {
    const msg = (data.error_messages && data.error_messages.join(', ')) || data.status_message || `Midtrans error (${res.status})`;
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }
  return data;
}

function midtransPayload(order) {
  const items = order.items.map(i => ({ id: i.id, price: i.price, quantity: i.qty, name: i.name.slice(0, 50) }));
  if (order.tax > 0) items.push({ id: 'pajak', price: order.tax, quantity: 1, name: `Pajak ${order.taxPercent}%` });
  const phone = order.customer.phone || undefined;
  return {
    transaction_details: { order_id: order.id, gross_amount: order.total },
    item_details: items,
    customer_details: { first_name: order.customer.name.slice(0, 40), phone }
  };
}

async function createPayment(order, method) {
  const expiresAt = new Date(Date.now() + PAY_WINDOW_MIN * 60000).toISOString();
  const base = { method, expiresAt };

  if (MOCK) {
    return { ...base, provider: 'mock', snapToken: method === 'snap' ? 'mock' : null, qrString: method === 'qris' ? `MOCK-QRIS|${order.id}|${order.total}` : null };
  }

  if (method === 'snap') {
    const data = await midtransRequest(`${SNAP_BASE}/snap/v1/transactions`, {
      ...midtransPayload(order),
      expiry: { unit: 'minutes', duration: PAY_WINDOW_MIN }
    });
    return { ...base, provider: 'midtrans', snapToken: data.token };
  }

  // QRIS via Core API
  const data = await midtransRequest(`${API_BASE}/v2/charge`, {
    payment_type: 'qris',
    ...midtransPayload(order),
    qris: { acquirer: 'gopay' },
    custom_expiry: { expiry_duration: PAY_WINDOW_MIN, unit: 'minute' }
  });
  const qrAction = (data.actions || []).find(a => a.name === 'generate-qr-code');
  return { ...base, provider: 'midtrans', qrString: data.qr_string || null, qrUrl: qrAction ? qrAction.url : null, transactionId: data.transaction_id };
}

function applyMidtransStatus(order, tx) {
  const t = tx.transaction_status;
  const fraud = tx.fraud_status;
  let next = null;
  if (t === 'settlement' || (t === 'capture' && (!fraud || fraud === 'accept'))) next = 'paid';
  else if (t === 'expire') next = 'expired';
  else if (t === 'cancel' || t === 'deny') next = 'cancelled';
  if (!next || order.status !== 'pending_payment') return false;
  order.status = next;
  if (next === 'paid') order.payment.paidAt = new Date().toISOString();
  if (tx.transaction_id) order.payment.transactionId = tx.transaction_id;
  db.save();
  return true;
}

const lastSync = new Map();
async function syncWithMidtrans(order) {
  if (MOCK || order.status !== 'pending_payment') return;
  const now = Date.now();
  if (now - (lastSync.get(order.id) || 0) < 3500) return;
  lastSync.set(order.id, now);
  try {
    const tx = await midtransRequest(`${API_BASE}/v2/${encodeURIComponent(order.id)}/status`, null, 'GET');
    applyMidtransStatus(order, tx);
  } catch { /* pesanan belum punya transaksi / jaringan: abaikan, webhook tetap jalan */ }
}

function expireIfNeeded(order) {
  if (order.status === 'pending_payment' && Date.now() > new Date(order.payment.expiresAt).getTime() + 60000) {
    order.status = 'expired';
    db.save();
  }
}

// ---------- API publik ----------
app.get('/api/config', (req, res) => {
  const s = db.settings;
  res.json({
    name: s.name, tagline: s.tagline, address: s.address, hours: s.hours,
    lat: s.lat, lng: s.lng, radius: s.radius, geofence: s.geofenceEnabled,
    open: s.open, taxPercent: s.taxPercent,
    midtrans: {
      mode: MOCK ? 'mock' : IS_PROD ? 'production' : 'sandbox',
      clientKey: CLIENT_KEY,
      snapUrl: `${SNAP_BASE}/snap/snap.js`
    }
  });
});

app.get('/api/menu', (req, res) => {
  res.json(db.menu.map(({ id, category, name, desc, price, emoji, imageUrl, available }) => ({ id, category, name, desc, price, emoji, imageUrl, available })));
});

app.post('/api/location/check', limiter(40, 60000), (req, res) => {
  res.json(checkLocation(req.body));
});

app.post('/api/orders', limiter(10, 60000), wrap(async (req, res) => {
  const s = db.settings;
  if (!s.open) return res.status(403).json({ error: 'Restoran sedang tutup. Pemesanan belum bisa dilakukan.' });

  const body = req.body || {};
  const method = body.method === 'snap' ? 'snap' : body.method === 'qris' ? 'qris' : null;
  if (!method) return res.status(400).json({ error: 'Pilih metode pembayaran.' });

  const name = str(body.customer && body.customer.name, 60);
  const phone = str(body.customer && body.customer.phone, 20);
  const table = str(body.customer && body.customer.table, 10);
  if (!name) return res.status(400).json({ error: 'Nama pemesan wajib diisi.' });
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) return res.status(400).json({ error: 'Nomor HP tidak valid.' });

  // Geofence — dicek ulang di server saat pesanan dibuat.
  const geo = checkLocation(body.location);
  if (!geo.ok) return res.status(403).json({ error: geo.message || 'Lokasi di luar jangkauan.', geo });

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
    return res.status(400).json({ error: 'Keranjang kosong.' });
  }
  const merged = new Map();
  for (const it of body.items) {
    const qty = Number(it && it.qty);
    if (!it || typeof it.id !== 'string' || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return res.status(400).json({ error: 'Data pesanan tidak valid.' });
    }
    const cur = merged.get(it.id) || { qty: 0, note: '' };
    cur.qty += qty;
    cur.note = cur.note || str(it.note, 100);
    merged.set(it.id, cur);
  }

  const items = [];
  for (const [id, v] of merged) {
    const m = db.menu.find(x => x.id === id);
    if (!m || !m.available) return res.status(409).json({ error: `Menu "${m ? m.name : id}" sedang tidak tersedia. Perbarui keranjangmu.` });
    if (v.qty > 20) return res.status(400).json({ error: 'Maksimal 20 porsi per menu.' });
    items.push({ id: m.id, name: m.name, price: m.price, qty: v.qty, note: v.note });
  }

  const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
  const tax = Math.round((subtotal * s.taxPercent) / 100);
  const total = subtotal + tax;
  if (total < 1000) return res.status(400).json({ error: 'Total pesanan terlalu kecil.' });

  const order = {
    id: newOrderId(),
    createdAt: new Date().toISOString(),
    status: 'pending_payment',
    items, subtotal, taxPercent: s.taxPercent, tax, total,
    customer: { name, phone, table },
    location: { lat: body.location && body.location.lat, lng: body.location && body.location.lng, accuracy: body.location && body.location.accuracy, distance: geo.distance },
    payment: { method, provider: MOCK ? 'mock' : 'midtrans', expiresAt: new Date(Date.now() + PAY_WINDOW_MIN * 60000).toISOString() }
  };

  try {
    order.payment = await createPayment(order, method);
  } catch (e) {
    console.error('[midtrans]', e.message);
    return res.status(502).json({ error: 'Gagal membuat pembayaran. Coba lagi beberapa saat.' });
  }

  db.orders.push(order);
  db.save();
  res.status(201).json(publicOrder(order));
}));

app.get('/api/orders/:id', wrap(async (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  await syncWithMidtrans(order);
  expireIfNeeded(order);
  res.json(publicOrder(order));
}));

// Hanya aktif di MODE DEMO.
app.post('/api/orders/:id/simulate-pay', (req, res) => {
  if (!MOCK) return res.status(403).json({ error: 'Simulasi hanya tersedia di mode demo.' });
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  if (order.status !== 'pending_payment') return res.status(409).json({ error: 'Pesanan ini sudah tidak menunggu pembayaran.' });
  order.status = 'paid';
  order.payment.paidAt = new Date().toISOString();
  db.save();
  res.json(publicOrder(order));
});

// Webhook Midtrans: Dashboard > Settings > Payment > Notification URL
app.post('/api/midtrans/notification', (req, res) => {
  if (MOCK) return res.status(404).end();
  const b = req.body || {};
  const expected = crypto.createHash('sha512').update(`${b.order_id}${b.status_code}${b.gross_amount}${SERVER_KEY}`).digest('hex');
  const given = String(b.signature_key || '');
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Signature tidak valid.' });
  }
  const order = db.orders.find(o => o.id === b.order_id);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan.' });
  if (Math.round(parseFloat(b.gross_amount)) !== order.total) return res.status(400).json({ error: 'Nominal tidak cocok.' });
  applyMidtransStatus(order, b);
  res.json({ ok: true });
});

// ---------- Admin ----------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function adminAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return res.status(401).json({ error: 'Sesi berakhir. Masuk lagi.' });
  next();
}

app.post('/api/admin/login', limiter(10, 10 * 60000), (req, res) => {
  const { username, password } = req.body || {};
  const ok = safeEqual(String(username || ''), ADMIN_USER) & safeEqual(String(password || ''), ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: 'Username atau password salah.' });
  res.json({ token: sign({ u: ADMIN_USER, exp: Date.now() + 12 * 3600 * 1000 }) });
});

const admin = express.Router();
admin.use(adminAuth);

admin.get('/orders', wrap(async (req, res) => {
  const pend = db.orders.filter(o => o.status === 'pending_payment');
  await Promise.all(pend.map(syncWithMidtrans));
  pend.forEach(expireIfNeeded);
  const list = [...db.orders].reverse().slice(0, 300).map(o => ({
    ...publicOrder(o),
    phone: o.customer.phone,
    distance: o.location && o.location.distance
  }));
  res.json(list);
}));

admin.patch('/orders/:id', (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  const next = req.body && req.body.status;
  const allowed = {
    pending_payment: ['cancelled'],
    paid: ['preparing', 'cancelled'],
    preparing: ['ready', 'cancelled'],
    ready: ['completed', 'cancelled'],
    completed: [], cancelled: [], expired: []
  };
  if (!ORDER_STATUSES.includes(next) || !(allowed[order.status] || []).includes(next)) {
    return res.status(400).json({ error: 'Perubahan status tidak diizinkan.' });
  }
  order.status = next;
  db.save();
  res.json({ ok: true, status: next });
});

function readMenuBody(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) { out.name = str(b.name, 60); if (!out.name) return { error: 'Nama menu wajib diisi.' }; }
  if (!partial || b.category !== undefined) { if (!CATEGORIES.includes(b.category)) return { error: 'Kategori tidak valid.' }; out.category = b.category; }
  if (!partial || b.price !== undefined) {
    const p = Number(b.price);
    if (!Number.isInteger(p) || p < 0 || p > 10000000) return { error: 'Harga harus bilangan bulat rupiah (0 – 10.000.000).' };
    out.price = p;
  }
  if (b.desc !== undefined) out.desc = str(b.desc, 160);
  if (b.emoji !== undefined) out.emoji = str(b.emoji, 8) || '🍽️';
  if (b.imageUrl !== undefined) {
    const u = str(b.imageUrl, 300);
    if (u && !/^https?:\/\//i.test(u)) return { error: 'URL gambar harus diawali http:// atau https://' };
    out.imageUrl = u;
  }
  if (b.available !== undefined) out.available = !!b.available;
  return { value: out };
}

admin.get('/menu', (req, res) => res.json(db.menu));
admin.post('/menu', (req, res) => {
  const r = readMenuBody(req.body || {}, false);
  if (r.error) return res.status(400).json({ error: r.error });
  const item = { id: 'm-' + crypto.randomBytes(4).toString('hex'), desc: '', emoji: '🍽️', available: true, ...r.value };
  db.menu.push(item);
  db.save();
  res.status(201).json(item);
});
admin.put('/menu/:id', (req, res) => {
  const item = db.menu.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Menu tidak ditemukan.' });
  const r = readMenuBody(req.body || {}, true);
  if (r.error) return res.status(400).json({ error: r.error });
  Object.assign(item, r.value);
  db.save();
  res.json(item);
});
admin.delete('/menu/:id', (req, res) => {
  const i = db.menu.findIndex(m => m.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Menu tidak ditemukan.' });
  db.menu.splice(i, 1);
  db.save();
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => res.json({ ...db.settings, paymentMode: MOCK ? 'mock' : IS_PROD ? 'production' : 'sandbox' }));
admin.put('/settings', (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  const next = { ...s };
  if (b.name !== undefined) { next.name = str(b.name, 60); if (!next.name) return res.status(400).json({ error: 'Nama restoran wajib diisi.' }); }
  if (b.tagline !== undefined) next.tagline = str(b.tagline, 120);
  if (b.address !== undefined) next.address = str(b.address, 200);
  if (b.hours !== undefined) next.hours = str(b.hours, 80);
  if (b.lat !== undefined || b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Koordinat tidak valid.' });
    next.lat = lat; next.lng = lng;
  }
  if (b.radius !== undefined) {
    const r = Number(b.radius);
    if (!Number.isFinite(r) || r < 20 || r > 50000) return res.status(400).json({ error: 'Radius harus 20 – 50.000 meter.' });
    next.radius = Math.round(r);
  }
  if (b.maxAccuracy !== undefined) {
    const a = Number(b.maxAccuracy);
    if (!Number.isFinite(a) || a < 10 || a > 2000) return res.status(400).json({ error: 'Batas akurasi GPS harus 10 – 2000 meter.' });
    next.maxAccuracy = Math.round(a);
  }
  if (b.taxPercent !== undefined) {
    const t = Number(b.taxPercent);
    if (!Number.isFinite(t) || t < 0 || t > 30) return res.status(400).json({ error: 'Pajak harus 0 – 30%.' });
    next.taxPercent = t;
  }
  if (b.geofenceEnabled !== undefined) next.geofenceEnabled = !!b.geofenceEnabled;
  if (b.open !== undefined) next.open = !!b.open;
  Object.assign(db.settings, next);
  db.save();
  res.json({ ...db.settings, paymentMode: MOCK ? 'mock' : IS_PROD ? 'production' : 'sandbox' });
});

app.use('/api/admin', admin);

// ---------- Statis ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Terjadi kesalahan di server.' });
});

app.listen(PORT, () => {
  console.log(`\n  ${db.settings.name} berjalan di http://localhost:${PORT}`);
  console.log(`  Admin:      http://localhost:${PORT}/admin/`);
  console.log(`  Pembayaran: ${MOCK ? 'MODE DEMO (tanpa Midtrans, pembayaran disimulasikan)' : IS_PROD ? 'Midtrans PRODUCTION' : 'Midtrans SANDBOX'}`);
  if (!process.env.ADMIN_PASSWORD) console.log('  ⚠  ADMIN_PASSWORD belum diatur — memakai "admin123". Ganti di file .env sebelum online.');
  console.log('');
});
