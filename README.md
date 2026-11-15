# Warung Senja — Website Pemesanan Restoran

Landing page, pilih menu (makanan / minuman / snack), pembayaran **Midtrans (Snap)** dan **QRIS**,
pembatasan pemesanan **berdasarkan radius lokasi**, dan **panel admin**.

## Menjalankan

```bash
npm install
cp .env.example .env     # lalu isi nilainya
npm start
```

- Website: http://localhost:3000
- Admin:   http://localhost:3000/admin/  (default `admin` / `admin123` — **ganti di `.env`**)

Tanpa kunci Midtrans, aplikasi berjalan di **mode demo**: alur pembayaran bisa dicoba
dengan tombol "Simulasikan pembayaran berhasil".

## Langkah pertama setelah jalan

1. Masuk ke **Admin > Pengaturan**, geser pin di peta ke lokasi restoran, atur radius (mis. 200–300 m).
2. Ubah nama, alamat, jam buka, dan pajak.
3. Di **Admin > Menu**, sesuaikan menu dan harga.

## Mengaktifkan Midtrans / QRIS

1. Daftar di https://dashboard.midtrans.com, ambil **Server Key** dan **Client Key** (mulai dari Sandbox).
2. Isi di `.env`:
   ```
   MIDTRANS_SERVER_KEY=SB-Mid-server-xxxx
   MIDTRANS_CLIENT_KEY=SB-Mid-client-xxxx
   MIDTRANS_IS_PRODUCTION=false
   ```
3. Di dashboard Midtrans: **Settings > Payment > Notification URL**, isi
   `https://DOMAIN-ANDA/api/midtrans/notification`.
4. Aktifkan QRIS di **Settings > Payment** (untuk Production perlu proses persetujuan Midtrans).
5. Jika sudah lolos uji di Sandbox, ganti kunci ke Production dan `MIDTRANS_IS_PRODUCTION=true`.

Dua metode pembayaran:
- **QRIS** — Core API `/v2/charge` (acquirer gopay), QR ditampilkan di halaman bayar.
- **Metode lain** — Snap (transfer bank, e-wallet, kartu, dll.).

Status pesanan diperbarui lewat webhook (signature SHA-512 diverifikasi) dan juga dicek ke
Midtrans saat halaman bayar membuka status, jadi tetap jalan saat dites di `localhost`.

## Cara kerja pembatasan radius

1. Browser mengambil GPS pelanggan (`navigator.geolocation`).
2. **Server** menghitung jarak (Haversine) ke titik restoran dan menolak jika di luar radius
   atau akurasi GPS lebih buruk dari batas yang diatur.
3. Pengecekan diulang di server saat pesanan dibuat, sehingga tidak bisa dilewati lewat browser.

Catatan penting:
- Geolocation browser **hanya jalan di HTTPS** (atau `localhost`). Untuk uji di ponsel gunakan
  tunnel HTTPS (mis. Cloudflare Tunnel / ngrok) atau deploy dengan sertifikat TLS.
- GPS bisa dipalsukan dengan aplikasi *fake GPS*. Untuk perlindungan lebih kuat, kombinasikan
  dengan QR di setiap meja (kode meja sebagai token) atau konfirmasi pelayan.

## Struktur

```
server.js            API, Midtrans, geofence, auth admin
lib/db.js            penyimpanan JSON (data/db.json), mudah diganti ke database SQL
public/index.html    landing page + menu + keranjang
public/bayar.html    halaman pembayaran + status pesanan
public/admin/        panel admin (pesanan, menu, pengaturan lokasi)
```

## Sebelum online (produksi)

- Ganti `ADMIN_PASSWORD` dan isi `SESSION_SECRET` di `.env`.
- Jalankan di belakang HTTPS (Nginx/Caddy) dan gunakan proses manager (PM2/systemd).
- Cadangkan `data/db.json`. Untuk trafik tinggi, pindahkan ke PostgreSQL/MySQL.
- Gunakan kunci Midtrans Production dan pastikan Notification URL benar.
