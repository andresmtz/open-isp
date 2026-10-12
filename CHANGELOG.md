# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/) dan [Semantic Versioning](https://semver.org/).

## [Unreleased] — setelah v0.5.0

### Diubah
- **WhatsApp** kini **notifikasi keluar saja** (interaksi/bot perintah dimatikan); interaksi dipindah ke **Telegram**.
- **Telegram** jadi pusat monitoring admin: menu + `/sistem`, `/pendapatan`, `/tunggakan`, `/tiket`, `/offline`, `/aktif`, `/olt`, `/trafik`.
- Alert admin/monitoring (staff/GenieACS/cron) dikirim via **Telegram** (WA fallback).
- Footer & portal *brand-aware* (mengikuti `company_header`).

### Ditambahkan
- Toggle **`voucher_enabled`** (Pengaturan → Fitur Opsional) untuk menyalakan/mematikan fitur Beli Voucher.
- Notifikasi **tiket** menyertakan **Chat Pelanggan (wa.me)** + **Share Lokasi (Maps)**.

### Diperbaiki
- Spintax `{A|B|C}` diproses terpusat (teks/gambar/dokumen).
- `getTechById` (notifikasi tiket oleh admin yang sebelumnya gagal).
- Tabel `discount_logs` dibuat saat fresh-install (500 di `/admin/discounts`).
- `.devcontainer` + `.nvmrc` untuk Codespaces (Node 22).

## [0.5.0] — 2026-10-09 — "pickle-lime"

Rilis open-source perdana.

### Ditambahkan
- Billing otomatis, isolir otomatis, pengingat WhatsApp, jam kalong, FUP, sinkron pemakaian.
- Multi-router MikroTik (PPPoE & hotspot), voucher hotspot, backup konfigurasi.
- Multi-vendor OLT (Hioso/HSGQ via SNMP; ZTE/Huawei via CLI) + `scripts/olt-probe.js`.
- TR-069: ACS bawaan (built-in) + integrasi GenieACS.
- RADIUS (PAP/CHAP) untuk PPPoE/hotspot.
- Peta jaringan (Leaflet) admin & teknisi, ODP, jalur kabel.
- Portal: admin, kasir, teknisi, kolektor, pelanggan (PWA, offline).
- Notifikasi WhatsApp (GoWA/Baileys) & Telegram.
- Pembayaran QRIS + webhook, kode unik, gateway opsional.
- Antarmuka bilingual Indonesia/English.
- Docker (Dockerfile + docker-compose), data demo (`scripts/seed-demo.js`).
- Lisensi ISC + Wiki dokumentasi.

### Kredit
- Base kode & repo: [alijayanet/billing-rtrw](https://github.com/alijayanet/billing-rtrw) oleh **Alijaya Net**.
- Dikembangkan menjadi OPEN-ISP oleh [oxpoe](https://github.com/oxpoe).
