'use strict';
/**
 * Lectura de la foto de la cédula paraguaya (frente) que manda un interesado por WhatsApp.
 *
 * Las fotos suelen venir de costado y WhatsApp borra el dato de orientación, así que se prueba la imagen en los
 * cuatro giros y se queda con el que reconoce el texto de la cédula (REPÚBLICA DEL PARAGUAY, APELLIDOS, NOMBRES…).
 * Devuelve el número, los apellidos y los nombres que se pudieron leer, y el giro para guardar la foto derecha.
 * Es una ayuda: lo leído se muestra para que la persona lo revise antes de crear la solicitud.
 */
const sharp = require('sharp');
const path = require('path');

const KEYWORDS = /REP[UÚ]BLICA|PARAGUAY|IDENTIDAD|APELLID|[NH]OMBRES|NACIMIENTO|VENCIMIENTO|DONANTE/gi;

let _worker = null;
async function worker() {
  if (!_worker) {
    const T = require('tesseract.js');
    _worker = await T.createWorker('eng', 1, { cachePath: path.join(__dirname, '..', 'database', 'tessdata'), logger: () => {} });
  }
  return _worker;
}

/** Línea de valor que sigue a una etiqueta (APELLIDOS / NOMBRES): solo las palabras en mayúsculas, sin fechas ni ruido. */
function valueAfter(lines, labelRe) {
  const i = lines.findIndex(l => labelRe.test(l));
  if (i < 0) return '';
  for (const l of lines.slice(i + 1, i + 3)) {
    const words = l.replace(/\d{1,2}-\d{1,2}-\d{4}/g, ' ').split(/\s+/).filter(w => /^[A-ZÁÉÍÓÚÑÜ]{2,}$/.test(w));
    if (words.length) return words.join(' ');
  }
  return '';
}

function parse(text) {
  const lines = String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  // Número: 5 a 8 cifras (a veces con puntos), que no sea parte de una fecha
  const clean = String(text || '').replace(/\d{1,2}-\d{1,2}-\d{4}/g, ' ');
  const nums = [...clean.matchAll(/(?:N\s*[°ºo]\s*)?\b(\d{1,2}\.?\d{3}\.?\d{3}|\d{5,8})\b/g)].map(m => m[1].replace(/\./g, ''));
  const number = nums.find(n => n.length >= 5 && n.length <= 8) || '';
  const surnames = valueAfter(lines, /APELLID/i);
  const names = valueAfter(lines, /[NH]OMBRES/i);
  return { number, surnames, names };
}

/** Lee la cédula. Devuelve { ok, number, surnames, names, name, angle } (angle: giro en grados para dejarla derecha). */
async function read(buffer) {
  const w = await worker();
  let best = null;
  // primero sin girar; después los giros más comunes de una foto de costado
  for (const angle of [0, 270, 90, 180]) {
    const img = await sharp(buffer, { failOn: 'none' }).rotate().rotate(angle).resize({ width: 1800 }).greyscale().normalise().png().toBuffer();
    const text = String(((await w.recognize(img)).data || {}).text || '');
    const kw = (text.match(KEYWORDS) || []).length;
    if (!best || kw > best.kw) best = { kw, text, angle };
    if (kw >= 3) break;
  }
  if (!best || best.kw < 2) return { ok: false, angle: 0 };
  const p = parse(best.text);
  return { ok: !!(p.number || p.surnames || p.names), ...p, name: [p.names, p.surnames].filter(Boolean).join(' '), angle: best.angle };
}

/** Devuelve la foto girada para que quede derecha (JPEG). */
async function upright(buffer, angle) {
  return sharp(buffer, { failOn: 'none' }).rotate().rotate(angle || 0).jpeg({ quality: 88 }).toBuffer();
}

module.exports = { read, parse, upright };
