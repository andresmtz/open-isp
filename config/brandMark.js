'use strict';
/**
 * Marca del sistema: el cuadrado con la inicial de la empresa (la misma del logo del panel y del ingreso).
 * Se usa para el favicon y, si app_icon_source = 'mark' (predeterminado), para los íconos de la app.
 * Con app_icon_source = 'logo' los íconos salen del logo subido (Ajustes → Logo PWA).
 *
 * Colores del diseño v2: tinta #17191a con letra crema #fbf8f2; en tema oscuro se invierte (#f1eee8 / #17191a).
 * El favicon SVG sigue el tema del navegador o del sistema (prefers-color-scheme).
 */
const { getSetting } = require('./settingsManager');

const INK = '#17191a', ON_INK = '#fbf8f2', INK_DARK = '#f1eee8', ON_INK_DARK = '#17191a';
const FONT = "Urbanist,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

// Letras dibujadas como figura (el servidor no tiene tipografías para dibujar texto en los PNG).
// Coordenadas en una caja de 100 de alto (altura de mayúscula), parecidas a Urbanist ExtraBold.
const GLYPHS = {
  F: { w: 60, d: 'M0 0H60V19H21V40H54V58H21V100H0Z' },
};
const xml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function letter() {
  const name = String(getSetting('company_header', '') || getSetting('company_name', '') || '').trim();
  return (name.match(/[\p{L}\p{N}]/u) || ['•'])[0].toUpperCase();
}
const source = () => (String(getSetting('app_icon_source', 'mark') || 'mark') === 'logo' ? 'logo' : 'mark');

/**
 * SVG de la marca.
 *  size: lado en px · full: cuadrado completo, sin esquinas redondeadas (íconos "maskable" y de iOS)
 *  pad: margen transparente alrededor (proporción del lado) · adaptive: invierte colores en tema oscuro
 */
function svg({ size = 64, full = false, pad = 0, adaptive = false, ch } = {}) {
  const L = xml(ch || letter());
  const box = size * (1 - pad * 2), o = size * pad, r = full ? 0 : box * 0.28;
  const fs = box * (full ? 0.5 : 0.62), y = o + box / 2 + fs * 0.355;
  const style = adaptive ? `<style>.b{fill:${INK}}.l{fill:${ON_INK}}@media (prefers-color-scheme:dark){.b{fill:${INK_DARK}}.l{fill:${ON_INK_DARK}}}</style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${style}`
    + `<rect class="b" x="${o}" y="${o}" width="${box}" height="${box}" rx="${r}" fill="${INK}"/>`
    + glyph(L, size, o, box, fs, y) + '</svg>';
}

function glyph(L, size, o, box, fs, y) {
  const g = GLYPHS[L];
  if (!g) return `<text class="l" x="${size / 2}" y="${y.toFixed(2)}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${fs.toFixed(2)}" fill="${ON_INK}">${L}</text>`;
  const k = (fs * 0.7) / 100; // altura de la mayúscula ≈ 70 % del tamaño de letra
  const x = o + box / 2 - (g.w * k) / 2, top = o + box / 2 - 50 * k;
  return `<path class="l" fill="${ON_INK}" transform="translate(${x.toFixed(2)} ${top.toFixed(2)}) scale(${k.toFixed(4)})" d="${g.d}"/>`;
}

/** Etiquetas del favicon para el <head> de todas las páginas */
function headLinks() {
  const v = encodeURIComponent(String(getSetting('logo_version', '') || '1'));
  return `<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${v}">\n  <link rel="icon" type="image/png" sizes="48x48" href="/img/icons/favicon-48.png?v=${v}">`;
}

module.exports = { svg, letter, source, headLinks, INK };
