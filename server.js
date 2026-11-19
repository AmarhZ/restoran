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
const auth = require('./lib/admin');

const PORT = Number(process.env.PORT) || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const PAY_WINDOW_MIN = 30; // batas waktu bayar jika pelanggan belum menekan "Saya sudah bayar"
const MAX_QRIS_BYTES = 2 * 1024 * 1024;
const QRIS_EXT = ['png', 'jpg', 'webp'];
const CATEGORIES = ['makanan', 'minuman', 'snack'];
const ORDER_STATUSES = ['pending_payment', 'paid', 'preparing', 'ready', 'completed', 'cancelled', 'expired'];

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

const newOrderId = () => 'WS-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(6).toString('hex').toUpperCase();

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
      expiresAt: o.payment.expiresAt,
      claimedAt: o.payment.claimedAt || null,
      paidAt: o.payment.paidAt || null
    }
  };
}

// Pesanan kedaluwarsa jika tidak dibayar. Jika pelanggan sudah menekan "Saya sudah bayar",
// pesanan menunggu kasir dan tidak kedaluwarsa otomatis.
function expireIfNeeded(order) {
  if (order.status === 'pending_payment' && !order.payment.claimedAt &&
      Date.now() > new Date(order.payment.expiresAt).getTime() + 60000) {
    order.status = 'expired';
    db.save();
  }
}

// ---------- Auth admin ----------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', auth.secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', auth.secret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() && p.v === auth.version() ? p : null;
  } catch { return null; }
}
function adminAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return res.status(401).json({ error: 'Sesi berakhir. Masuk lagi.' });
  next();
}

// ---------- Gambar QRIS ----------
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function removeQrisFiles(except) {
  for (const ext of QRIS_EXT) {
    if (ext === except) continue;
    try { fs.unlinkSync(path.join(DATA_DIR, `qris.${ext}`)); } catch { /* tidak ada */ }
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'geolocation=(self)');
  next();
});

// Unggah QRIS memakai parser JSON sendiri (batas lebih besar), jadi harus sebelum parser global.
app.put('/api/admin/qris', adminAuth, express.json({ limit: '3mb' }), (req, res) => {
  const data = req.body && typeof req.body.image === 'string' ? req.body.image : '';
  const comma = data.indexOf(',');
  if (comma < 0 || !/^data:image\/(png|jpeg|webp);base64$/.test(data.slice(0, comma))) {
    return res.status(400).json({ error: 'File harus berupa gambar PNG, JPG, atau WebP.' });
  }
  const buf = Buffer.from(data.slice(comma + 1), 'base64');
  if (buf.length > MAX_QRIS_BYTES) return res.status(400).json({ error: 'Ukuran gambar maksimal 2 MB.' });
  const ext = sniffImage(buf);
  if (!ext) return res.status(400).json({ error: 'Isi file bukan gambar PNG, JPG, atau WebP yang valid.' });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, `qris.${ext}`);
  fs.writeFileSync(target + '.tmp', buf);
  fs.renameSync(target + '.tmp', target);
  removeQrisFiles(ext);
  db.settings.qrisImage = `qris.${ext}`;
  db.settings.qrisVersion = Date.now();
  db.save();
  res.json({ qrisImage: db.settings.qrisImage, qrisVersion: db.settings.qrisVersion });
});

app.use(express.json({ limit: '50kb' }));

// ---------- API publik ----------
app.get('/api/config', (req, res) => {
  const s = db.settings;
  res.json({
    name: s.name, tagline: s.tagline, address: s.address, hours: s.hours,
    lat: s.lat, lng: s.lng, radius: s.radius, geofence: s.geofenceEnabled,
    open: s.open, taxPercent: s.taxPercent,
    payment: { ready: !!s.qrisImage, merchant: s.qrisMerchant || '', version: s.qrisVersion || 0 }
  });
});

app.get('/api/menu', (req, res) => {
  res.json(db.menu.map(({ id, category, name, desc, price, emoji, imageUrl, available }) => ({ id, category, name, desc, price, emoji, imageUrl, available })));
});

app.get('/api/qris', (req, res) => {
  const m = /^qris\.(png|jpg|webp)$/.exec(db.settings.qrisImage || '');
  const file = m && path.join(DATA_DIR, m[0]);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Gambar QRIS belum diunggah.' });
  res.set('Cache-Control', 'no-cache');
  res.sendFile(file);
});

app.post('/api/location/check', limiter(40, 60000), (req, res) => {
  res.json(checkLocation(req.body));
});

app.post('/api/orders', limiter(10, 60000), (req, res) => {
  const s = db.settings;
  if (!s.open) return res.status(403).json({ error: 'Restoran sedang tutup. Pemesanan belum bisa dilakukan.' });
  if (!s.qrisImage) return res.status(503).json({ error: 'Pembayaran QRIS belum diatur oleh restoran. Silakan hubungi kasir.' });

  const body = req.body || {};
  const name = str(body.customer && body.customer.name, 60);
  const phone = str(body.customer && body.customer.phone, 20);
  const table = str(body.customer && body.customer.table, 10);
  if (!name) return res.status(400).json({ error: 'Nama pemesan wajib diisi.' });
  if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) return res.status(400).json({ error: 'Nomor HP tidak valid.' });

  // Geofence — dicek ulang di server saat pesanan dibuat.
  const geo = checkLocation(body.location);
  if (!geo.ok) return res.status(403).json({ error: geo.message || 'Lokasi di luar jangkauan.', geo });

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
    return res.status(400).json({ error: 'Pesanan kosong.' });
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
    if (!m || !m.available) return res.status(409).json({ error: `Menu "${m ? m.name : id}" sedang tidak tersedia. Perbarui pesananmu.` });
    if (v.qty > 20) return res.status(400).json({ error: 'Maksimal 20 porsi per menu.' });
    items.push({ id: m.id, name: m.name, price: m.price, qty: v.qty, note: v.note });
  }

  // Harga selalu dihitung ulang di server dari daftar menu.
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
    payment: { method: 'qris_static', expiresAt: new Date(Date.now() + PAY_WINDOW_MIN * 60000).toISOString(), claimedAt: null, paidAt: null }
  };
  db.orders.push(order);
  db.save();
  res.status(201).json(publicOrder(order));
});

app.get('/api/orders/:id', (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  expireIfNeeded(order);
  res.json(publicOrder(order));
});

// Pelanggan menekan "Saya sudah bayar". Ini hanya menandai; kasir yang mengonfirmasi.
app.post('/api/orders/:id/claim', limiter(20, 60000), (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  expireIfNeeded(order);
  if (order.status !== 'pending_payment') return res.status(409).json({ error: 'Pesanan ini sudah tidak menunggu pembayaran.' });
  if (!order.payment.claimedAt) {
    order.payment.claimedAt = new Date().toISOString();
    db.save();
  }
  res.json(publicOrder(order));
});

// ---------- Admin ----------
app.get('/api/admin/status', (req, res) => res.json({ mode: auth.mode() }));

const issue = () => sign({ u: auth.username(), v: auth.version(), exp: Date.now() + 12 * 3600 * 1000 });

app.post('/api/admin/login', limiter(10, 10 * 60000), (req, res) => {
  if (auth.mode() === 'setup') return res.status(409).json({ error: 'Akun admin belum dibuat.' });
  const { username, password } = req.body || {};
  if (!auth.verify(String(username || ''), String(password || ''))) return res.status(401).json({ error: 'Username atau password salah.' });
  res.json({ token: issue() });
});

// Pembuatan akun pertama: butuh kode setup yang hanya tampil di terminal server
app.post('/api/admin/setup', limiter(8, 10 * 60000), (req, res) => {
  const { code, username, password } = req.body || {};
  const err = auth.setup(code, String(username || '').trim(), password);
  if (err) return res.status(400).json({ error: err });
  res.json({ token: issue() });
});

const admin = express.Router();
admin.use(adminAuth);

admin.post('/password', limiter(8, 10 * 60000), (req, res) => {
  const { current, username, password } = req.body || {};
  const err = auth.change(String(current || ''), String(username || '').trim(), password);
  if (err) return res.status(400).json({ error: err });
  res.json({ token: issue() });
});

admin.get('/orders', (req, res) => {
  db.orders.filter(o => o.status === 'pending_payment').forEach(expireIfNeeded);
  const list = [...db.orders].reverse().slice(0, 300).map(o => ({
    ...publicOrder(o),
    phone: o.customer.phone,
    distance: o.location && o.location.distance
  }));
  res.json(list);
});

admin.patch('/orders/:id', (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  const next = req.body && req.body.status;
  const allowed = {
    pending_payment: ['paid', 'cancelled'], // 'paid' = kasir mengonfirmasi uang sudah masuk
    paid: ['preparing', 'cancelled'],
    preparing: ['ready', 'cancelled'],
    ready: ['completed', 'cancelled'],
    completed: [], cancelled: [],
    expired: ['paid'] // pelanggan terlambat bayar tetapi uangnya masuk
  };
  if (!ORDER_STATUSES.includes(next) || !(allowed[order.status] || []).includes(next)) {
    return res.status(400).json({ error: 'Perubahan status tidak diizinkan.' });
  }
  order.status = next;
  if (next === 'paid') order.payment.paidAt = new Date().toISOString();
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

admin.delete('/qris', (req, res) => {
  removeQrisFiles();
  db.settings.qrisImage = '';
  db.save();
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => res.json(db.settings));
admin.put('/settings', (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  const next = { ...s };
  if (b.name !== undefined) { next.name = str(b.name, 60); if (!next.name) return res.status(400).json({ error: 'Nama restoran wajib diisi.' }); }
  if (b.tagline !== undefined) next.tagline = str(b.tagline, 120);
  if (b.address !== undefined) next.address = str(b.address, 200);
  if (b.hours !== undefined) next.hours = str(b.hours, 80);
  if (b.qrisMerchant !== undefined) next.qrisMerchant = str(b.qrisMerchant, 80);
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
  res.json(db.settings);
});

app.use('/api/admin', admin);

// ---------- Statis ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Ukuran data terlalu besar.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Format data tidak valid.' });
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Terjadi kesalahan di server.' });
});

app.listen(PORT, () => {
  console.log(`\n  ${db.settings.name} berjalan di http://localhost:${PORT}`);
  console.log(`  Admin:      http://localhost:${PORT}/admin/`);
  console.log(`  Pembayaran: QRIS statis dengan konfirmasi kasir`);
  if (!db.settings.qrisImage) console.log('  ⚠  Gambar QRIS belum diunggah — buka Admin > Pengaturan > Pembayaran QRIS agar pelanggan bisa memesan.');
  if (auth.mode() === 'setup') {
    console.log('  ⚠  Akun admin belum dibuat. Buka /admin/ lalu masukkan kode setup berikut:');
    console.log(`        KODE SETUP: ${auth.setupCode}   (berlaku selama server ini menyala)`);
  }
  console.log('');
});
