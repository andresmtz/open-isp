# OPEN-ISP v0.5.1 (pickle-lime) — Patch Keamanan & Stabilitas

Tanggal: 2026-10-13

Rilis patch yang menutup seluruh temuan kerentanan dependensi, sekaligus memperkuat **backup/restore** dan **logging**.

## Keamanan
- `npm audit`: **16 → 0** kerentanan.
  - Menghapus `@whiskeysockets/baileys` (tidak dipakai).
  - Memperbarui `axios`, `multer`, `brace-expansion`, `proxy-addr`.
  - `xlsx` → build resmi **SheetJS 0.20.3** (API sama).
  - `node-telegram-bot-api` **0.66 → 2.1.0** (memakai adapter v1→v2 internal; modul bot tidak dirombak).
- Memperbaiki bug **`trust proxy`**: `X-Forwarded-For` terbalik sehingga IP bisa dipalsukan (berdampak pada rate-limit/login).
- `cookie_secure` sebaiknya diaktifkan saat aplikasi dipublikasikan via **HTTPS**.

## Backup & Restore
- Backup database memakai **`VACUUM INTO`** → snapshot **konsisten** walau database berjalan di mode **WAL** (sebelumnya menyalin file mentah berisiko kehilangan transaksi terbaru).
- **Restore diterapkan saat startup** (sebelum koneksi DB dibuka) → menghindari kerusakan data karena menimpa file DB di bawah koneksi hidup. Aplikasi **restart otomatis** untuk menerapkan restore.
- Restore settings memakai pemuatan ulang otomatis (tanpa restart).

## Logging
- Berkas log **diputar otomatis** (10MB × 5) — tidak lagi menumpuk memenuhi disk.
- Seluruh `console.*` sisi server diarahkan ke **logger** → log **seragam** dan tersimpan di `logs/`.

## Lainnya
- `settings.json` di-set permission `600` (rahasia tidak world-readable).
- Versi dinaikkan ke **0.5.1**.

## Cara Update
- **Docker:** `docker compose pull` / `docker compose up -d --build`.
- **Manual:** `git pull` lalu `npm ci --omit=dev` dan restart aplikasi.
