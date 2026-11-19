'use strict';
// Lokasi penyimpanan data. Urutan: env DATA_DIR → ./data → folder sementara sistem.
// Hosting serverless (Vercel, Netlify, dsb.) memakai file system read-only; hanya /tmp yang bisa ditulis
// dan isinya HILANG saat instance berganti. Untuk data permanen gunakan hosting dengan disk/volume persisten.
const fs = require('fs');
const os = require('os');
const path = require('path');

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.w-${process.pid}`);
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

let dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
let temporary = false;
if (!writable(dir)) {
  dir = path.join(os.tmpdir(), 'warung-senja');
  temporary = writable(dir);
  console.warn(temporary
    ? `[data] Folder data/ tidak bisa ditulis (read-only). Memakai folder sementara ${dir}: data akan hilang saat server restart/deploy ulang.`
    : '[data] Tidak ada folder yang bisa ditulis. Data hanya disimpan di memori dan hilang saat server restart.');
}

module.exports = { DATA_DIR: dir, temporary, persistent: !temporary && writable(dir) };
