# Warung Senja — Website Pemesanan Restoran

Landing page, pilih menu (makanan / minuman / snack), pembayaran **QRIS statis** dengan konfirmasi kasir,
pembatasan pemesanan **berdasarkan radius lokasi**, dan **panel admin**.

## Menjalankan

```bash
npm install
cp .env.example .env     # lalu isi ADMIN_PASSWORD
npm start
```

- Website: http://localhost:3000
- Admin:   http://localhost:3000/admin/  (default `admin` / `admin123` — **ganti di `.env`**)

## Langkah pertama (wajib)

1. Masuk **Admin > Pengaturan > Pembayaran QRIS**, unggah gambar QRIS restoran
   (PNG/JPG/WebP, maks. 2 MB) dan isi nama merchant. **Tanpa gambar ini pelanggan tidak bisa memesan.**
2. Di **Pengaturan > Lokasi & radius**, geser pin di peta ke lokasi restoran dan atur radius (mis. 200–300 m).
3. Ubah nama, alamat, jam buka, dan pajak. Lalu sesuaikan menu di **Admin > Menu**.

## Alur pembayaran (QRIS statis)

1. Pelanggan memilih menu, sistem mengecek lokasinya, lalu pesanan dibuat dengan status **Menunggu bayar**.
2. Halaman bayar menampilkan gambar QRIS restoran dan nominal. Pelanggan memindai QRIS,
   mengetik nominal yang tepat (ada tombol **Salin nominal**), lalu menekan **Saya sudah bayar**.
3. Di admin, pesanan muncul di tab **Perlu konfirmasi** dengan bunyi notifikasi.
   Kasir mengecek mutasi / notifikasi dari bank atau e-wallet, lalu menekan **Konfirmasi pembayaran**.
4. Pesanan berubah menjadi **Sudah dibayar**, halaman pelanggan ikut berubah, dan dapur memprosesnya:
   Disiapkan, Siap diantar, Selesai.

Catatan:
- **Sistem tidak bisa memeriksa uang masuk sendiri.** Konfirmasi dilakukan manusia, jadi selalu cocokkan
  nominal dan waktunya dengan mutasi sebelum menekan konfirmasi.
- Pelanggan harus mengetik nominal sendiri pada QRIS statis. Jika salah nominal, kasir bisa membatalkan
  pesanan dan mengembalikan uang secara manual.
- Pesanan yang belum ditandai "Saya sudah bayar" kedaluwarsa otomatis setelah 30 menit. Pesanan yang
  sudah ditandai menunggu kasir dan tidak kedaluwarsa. Pesanan kedaluwarsa masih bisa dikonfirmasi
  jika uangnya ternyata masuk.

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
server.js            API, geofence, QRIS statis, auth admin
lib/db.js            penyimpanan JSON (data/db.json), mudah diganti ke database SQL
data/                db.json dan gambar QRIS (dibuat otomatis, jangan dibagikan)
public/index.html    landing page + menu + panel pesanan (layout dashboard)
public/css/          site.css (dasar & halaman bayar), shell.css (layout dashboard)
public/bayar.html    halaman pembayaran QRIS + status pesanan
public/admin/        panel admin (pesanan, menu, QRIS, lokasi)
```

## Sebelum online (produksi)

- Ganti `ADMIN_PASSWORD` dan isi `SESSION_SECRET` di `.env`.
- Jalankan di belakang HTTPS (Nginx/Caddy) dan gunakan proses manager (PM2/systemd).
- Cadangkan folder `data/`. Untuk trafik tinggi, pindahkan ke PostgreSQL/MySQL.
- Ingin pembayaran otomatis tanpa konfirmasi kasir? Perlu payment gateway (mis. Midtrans, Xendit)
  yang menghasilkan QRIS dinamis. Kode versi Midtrans ada di berkas zip versi sebelumnya.
