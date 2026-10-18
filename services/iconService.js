'use strict';
/**
 * iconService.js — Generate ikon PWA & apple-touch-icon dari logo (pakai sharp).
 * Dipanggil saat upload logo / tombol "Generate Ikon PWA".
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ICON_DIR = path.join(__dirname, '..', 'public', 'img', 'icons');
const IMG_DIR = path.join(__dirname, '..', 'public', 'img');
const BG = { r: 10, g: 13, b: 20, alpha: 1 }; // #0A0D14

async function writeIcon(srcBuf, size, outPath, opts) {
  const maskable = !!(opts && opts.maskable);
  const bg = (opts && opts.bg) || (maskable ? BG : { r: 0, g: 0, b: 0, alpha: 0 });
  const pad = maskable ? Math.round(size * 0.12) : 0; // safe zone maskable
  const inner = Math.max(1, size - pad * 2);
  const logo = await sharp(srcBuf)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: logo, top: pad, left: pad }])
    .png()
    .toFile(outPath);
}

async function generatePwaIcons(srcBuf) {
  if (!srcBuf || !srcBuf.length) throw new Error('No hay logo de origen');
  if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });
  await writeIcon(srcBuf, 192, path.join(ICON_DIR, 'icon-192.png'), {});
  await writeIcon(srcBuf, 512, path.join(ICON_DIR, 'icon-512.png'), {});
  await writeIcon(srcBuf, 192, path.join(ICON_DIR, 'icon-maskable-192.png'), { maskable: true });
  await writeIcon(srcBuf, 512, path.join(ICON_DIR, 'icon-maskable-512.png'), { maskable: true });
  await writeIcon(srcBuf, 180, path.join(ICON_DIR, 'apple-touch-icon.png'), { bg: BG });
  await writeIcon(srcBuf, 180, path.join(IMG_DIR, 'apple-touch-icon.png'), { bg: BG });
  await writeIcon(srcBuf, 48, path.join(ICON_DIR, 'favicon-48.png'), {});
  return { ok: true };
}

// Íconos con la marca (cuadrado con la inicial, ver config/brandMark.js)
const STAMP = path.join(ICON_DIR, '.marca');
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();
async function generateMarkIcons() {
  const mark = require('../config/brandMark');
  if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });
  const out = [
    [192, 'icon-192.png', { pad: 0.04 }], [512, 'icon-512.png', { pad: 0.04 }],
    [192, 'icon-maskable-192.png', { full: true }], [512, 'icon-maskable-512.png', { full: true }],
    [180, 'apple-touch-icon.png', { full: true }], [48, 'favicon-48.png', {}],
  ];
  for (const [size, file, o] of out) fs.writeFileSync(path.join(ICON_DIR, file), await png(mark.svg(Object.assign({ size }, o))));
  fs.copyFileSync(path.join(ICON_DIR, 'apple-touch-icon.png'), path.join(IMG_DIR, 'apple-touch-icon.png'));
  fs.writeFileSync(STAMP, mark.letter());
  return { ok: true };
}

/** Al arrancar: con la marca como ícono, rehace los PNG si faltan o cambió la inicial de la empresa. */
async function ensureMarkIcons() {
  const mark = require('../config/brandMark');
  if (mark.source() !== 'mark') return false;
  let cur = ''; try { cur = fs.readFileSync(STAMP, 'utf8'); } catch (_) {}
  if (cur === mark.letter()) return false;
  await generateMarkIcons();
  return true;
}

module.exports = { generatePwaIcons, generateMarkIcons, ensureMarkIcons };
