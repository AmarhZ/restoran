'use strict';
// Penyimpanan sederhana berbasis file JSON (tanpa dependensi native).
// Cukup untuk satu restoran dengan trafik kecil-menengah.
// Untuk skala besar, ganti dengan PostgreSQL/MySQL tanpa mengubah API di server.js.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');

const seed = () => ({
  settings: {
    name: 'Warung Senja',
    tagline: 'Masakan rumahan, diantar ke mejamu.',
    address: 'Jl. Contoh No. 12, Jakarta Pusat',
    hours: 'Setiap hari, 10.00 – 22.00',
    // Titik pusat restoran. Ubah lewat Admin > Pengaturan.
    lat: -6.1754,
    lng: 106.8272,
    radius: 300, // meter
    maxAccuracy: 150, // meter; GPS lebih buruk dari ini ditolak
    geofenceEnabled: true,
    open: true,
    taxPercent: 10
  },
  menu: [
    { id: 'm-nasgor', category: 'makanan', name: 'Nasi Goreng Kampung', desc: 'Telur mata sapi, acar, kerupuk, sambal terasi.', price: 32000, emoji: '🍛', available: true },
    { id: 'm-ayam', category: 'makanan', name: 'Ayam Bakar Taliwang', desc: 'Ayam bakar pedas khas Lombok dengan plecing kangkung.', price: 38000, emoji: '🍗', available: true },
    { id: 'm-soto', category: 'makanan', name: 'Soto Ayam Lamongan', desc: 'Kuah kuning bening, koya gurih, perasan jeruk nipis.', price: 28000, emoji: '🍲', available: true },
    { id: 'm-gado', category: 'makanan', name: 'Gado-gado Siram', desc: 'Sayur rebus, tahu, tempe, lontong, saus kacang kental.', price: 25000, emoji: '🥗', available: true },
    { id: 'm-mie', category: 'makanan', name: 'Mie Aceh Goreng', desc: 'Mie tebal, bumbu kari, irisan daging sapi.', price: 34000, emoji: '🍜', available: true },
    { id: 'm-ikan', category: 'makanan', name: 'Ikan Bakar Rica-rica', desc: 'Ikan kakap bakar, sambal rica, nasi putih.', price: 45000, emoji: '🐟', available: true },
    { id: 'm-esteh', category: 'minuman', name: 'Es Teh Manis', desc: 'Teh melati, gula batu, es batu.', price: 8000, emoji: '🧋', available: true },
    { id: 'm-kopi', category: 'minuman', name: 'Kopi Susu Gula Aren', desc: 'Espresso, susu segar, gula aren cair.', price: 20000, emoji: '☕', available: true },
    { id: 'm-jeruk', category: 'minuman', name: 'Es Jeruk Peras', desc: 'Jeruk peras asli tanpa pemanis tambahan.', price: 14000, emoji: '🍊', available: true },
    { id: 'm-wedang', category: 'minuman', name: 'Wedang Jahe', desc: 'Jahe bakar, serai, gula merah. Disajikan panas.', price: 12000, emoji: '🍵', available: true },
    { id: 'm-kelapa', category: 'minuman', name: 'Es Kelapa Muda', desc: 'Daging kelapa muda, sirup, es serut.', price: 18000, emoji: '🥥', available: true },
    { id: 'm-pisang', category: 'snack', name: 'Pisang Goreng Madu', desc: 'Pisang kepok, tepung renyah, siraman madu.', price: 18000, emoji: '🍌', available: true },
    { id: 'm-tahu', category: 'snack', name: 'Tahu Crispy', desc: 'Tahu putih goreng tepung, cabai garam.', price: 15000, emoji: '🥟', available: true },
    { id: 'm-kentang', category: 'snack', name: 'Kentang Goreng Sambal Matah', desc: 'Kentang goreng, sambal matah segar khas Bali.', price: 22000, emoji: '🍟', available: true },
    { id: 'm-mendoan', category: 'snack', name: 'Tempe Mendoan', desc: 'Tempe tipis setengah matang, sambal kecap.', price: 14000, emoji: '🌿', available: true },
    { id: 'm-singkong', category: 'snack', name: 'Singkong Goreng Keju', desc: 'Singkong empuk, taburan keju parut.', price: 15000, emoji: '🍠', available: true }
  ],
  orders: []
});

let state = null;

function load() {
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    state = seed();
    save();
  }
  // Pastikan field baru tetap ada jika file lama dimuat.
  const def = seed();
  state.settings = { ...def.settings, ...(state.settings || {}) };
  state.menu = Array.isArray(state.menu) ? state.menu : def.menu;
  state.orders = Array.isArray(state.orders) ? state.orders : [];
  return state;
}

let saving = false;
let dirty = false;

function save() {
  if (saving) { dirty = true; return; }
  saving = true;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } finally {
    saving = false;
    if (dirty) { dirty = false; save(); }
  }
}

load();

module.exports = {
  get settings() { return state.settings; },
  get menu() { return state.menu; },
  get orders() { return state.orders; },
  save
};
