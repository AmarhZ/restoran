'use strict';
// Akun admin. Kata sandi TIDAK disimpan polos: hanya hash scrypt + salt di data/admin.json
// (folder data/ masuk .gitignore, jadi tidak ikut ke GitHub).
//
// Tiga mode, dari yang paling diutamakan:
//  env    : ADMIN_PASSWORD diisi lewat environment variable hosting (Railway/Render/VPS).
//  file   : akun dibuat lewat halaman /admin/ dan disimpan sebagai hash di data/admin.json.
//  setup  : belum ada akun. Server menampilkan KODE SETUP di konsol; hanya pemilik server yang melihatnya.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR } = require('./paths');
const FILE = path.join(DATA_DIR, 'admin.json');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');

let state = {};
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = {}; }

let warned = false;
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) {
    // Disk tidak bisa ditulis: akun tetap berjalan dari memori (hilang saat restart)
    if (!warned) { warned = true; console.warn('[admin] Tidak bisa menyimpan admin.json:', e.code || e.message); }
  }
}
if (!state.secret) { state.secret = crypto.randomBytes(32).toString('hex'); save(); }

const envUser = () => process.env.ADMIN_USER || 'admin';
const mode = () => (process.env.ADMIN_PASSWORD ? 'env' : state.hash ? 'file' : 'setup');
const setupCode = crypto.randomBytes(4).toString('hex'); // hanya di memori, berganti tiap server dinyalakan

const checkPw = pw => (typeof pw === 'string' && pw.length >= 8 && pw.length <= 100)
  ? null : 'Password minimal 8 karakter.';
const checkUser = u => (/^[a-zA-Z0-9._-]{3,30}$/.test(u)) ? null : 'Username 3–30 karakter: huruf, angka, titik, strip, atau garis bawah.';

function storeCredentials(user, pw) {
  state.user = user;
  state.salt = crypto.randomBytes(16).toString('hex');
  state.hash = hashPw(pw, state.salt);
  state.changedAt = new Date().toISOString();
  save();
}

module.exports = {
  mode,
  setupCode,
  // Kunci penanda tanda tangan sesi. Disimpan di data/admin.json agar sesi tidak hilang saat server restart.
  secret: () => process.env.SESSION_SECRET || state.secret,
  // Berubah saat password diganti, sehingga semua sesi lama otomatis tidak berlaku.
  version: () => (mode() === 'env' ? 'env' : (state.hash || '').slice(0, 12)),
  username: () => (mode() === 'env' ? envUser() : state.user),

  verify(user, pw) {
    const m = mode();
    if (m === 'env') return same(user, envUser()) & same(pw, process.env.ADMIN_PASSWORD) ? true : false;
    if (m !== 'file') return false;
    const okUser = same(user, state.user);
    const okPw = crypto.timingSafeEqual(Buffer.from(hashPw(pw, state.salt), 'hex'), Buffer.from(state.hash, 'hex'));
    return okUser && okPw;
  },

  setup(code, user, pw) {
    if (mode() !== 'setup') return 'Akun admin sudah dibuat.';
    if (!same(String(code || '').trim().toLowerCase(), setupCode)) return 'Kode setup salah. Lihat kode di jendela terminal tempat server berjalan.';
    const e = checkUser(user) || checkPw(pw);
    if (e) return e;
    storeCredentials(user, pw);
    return null;
  },

  change(current, user, pw) {
    if (mode() !== 'file') return 'Akun diatur lewat environment variable hosting, jadi tidak bisa diubah dari sini.';
    if (!this.verify(state.user, current)) return 'Password saat ini salah.';
    const e = checkUser(user) || checkPw(pw);
    if (e) return e;
    storeCredentials(user, pw);
    return null;
  }
};
