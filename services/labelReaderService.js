'use strict';
/**
 * Lectura de la etiqueta de la ONU (foto que sube el técnico) para identificar su MAC sin tipeo.
 *
 * 1. Códigos de barras / QR (zxing): la etiqueta suele traer la MAC como código de barras; tiene verificación
 *    propia, así que es la lectura más confiable. Se prueban varios tamaños y rotaciones.
 * 2. Respaldo: reconocimiento de texto (OCR, tesseract.js) si el código no se pudo leer.
 * 3. Seguridad: una MAC leída solo sirve si coincide con una ONU NUEVA de la OLT (sin descripción ni cliente).
 *    Con OCR se acepta una diferencia de 1 carácter (confusiones típicas 0/O, 8/B, 1/I) solo si hay una única
 *    ONU nueva que coincide. Si no hay coincidencia única, no se adivina: se avisa a la oficina.
 */
const sharp = require('sharp');
const { logger } = require('../config/logger');

const norm = (m) => String(m || '').toUpperCase().replace(/[^0-9A-F]/g, '');
const pretty = (m) => norm(m).match(/../g).join(':');

/**
 * MACs (12 hex) que aparecen en un texto: bloques completos (con ":" "-" "." o sin separador), que no estén
 * pegados a otras letras o números (así "MAC 80:07:…" no toma la "AC" de la palabra MAC). En OCR la letra O se
 * toma como cero solo dentro del bloque.
 */
function macsInText(text) {
  const out = new Set();
  const t = String(text || '').toUpperCase();
  const res = [
    /(?<![0-9A-Z])([0-9A-FO]{2}(?:([:\-.])[0-9A-FO]{2})(?:\2[0-9A-FO]{2}){4})(?![0-9A-Z])/g,
    /(?<![0-9A-Z])([0-9A-FO]{12})(?![0-9A-Z])/g,
  ];
  for (const re of res) {
    let m; while ((m = re.exec(t))) { const n = norm(m[1].replace(/O/g, '0')); if (n.length === 12 && !/^0+$|^F+$/.test(n)) out.add(n); }
  }
  return [...out];
}

async function decodeBarcodes(buffer) {
  let ZX;
  try { ZX = require('@zxing/library'); } catch (_) { return []; }
  const { MultiFormatReader, GenericMultipleBarcodeReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DecodeHintType, BarcodeFormat } = ZX;
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.ITF]);
  const texts = new Set();
  for (const width of [1800, 1200, 800]) {
    for (const angle of [0, 90, 180, 270]) {
      try {
        const { data, info } = await sharp(buffer).rotate().rotate(angle).resize({ width, withoutEnlargement: false }).greyscale().normalise().raw().toBuffer({ resolveWithObject: true });
        const src = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
        const bmp = new BinaryBitmap(new HybridBinarizer(src));
        const reader = new MultiFormatReader(); reader.setHints(hints);
        let results = [];
        try { results = new GenericMultipleBarcodeReader(reader).decodeMultiple(bmp, hints); } catch (_) {
          try { results = [reader.decode(bmp, hints)]; } catch (__) { results = []; }
        }
        for (const r of results) if (r && r.getText) texts.add(r.getText());
      } catch (_) { /* imagen inválida en ese tamaño/rotación */ }
    }
    if (texts.size) break;
  }
  return [...texts];
}

let _tess = null;
async function ocrText(buffer) {
  try {
    if (!_tess) {
      const T = require('tesseract.js');
      const path = require('path');
      _tess = await T.createWorker('eng', 1, { cachePath: path.join(__dirname, '..', 'database', 'tessdata'), logger: () => {} });
      await _tess.setParameters({ tessedit_char_whitelist: '0123456789ABCDEFabcdef:-. MACSN/IDGPONOLTW' });
    }
    const img = await sharp(buffer).rotate().resize({ width: 1800, withoutEnlargement: false }).greyscale().normalise().sharpen().png().toBuffer();
    const { data } = await _tess.recognize(img);
    return String(data && data.text || '');
  } catch (e) { logger.warn('[Etiqueta] OCR no disponible: ' + e.message); return ''; }
}

/** Lee la etiqueta: { barcodes, ocr, macs: [{mac, source}] } */
async function read(buffer) {
  const barcodes = await decodeBarcodes(buffer);
  const macs = [];
  for (const t of barcodes) for (const m of macsInText(t)) macs.push({ mac: m, source: 'código de barras' });
  let ocr = '';
  if (!macs.length) {
    ocr = await ocrText(buffer);
    for (const m of macsInText(ocr)) macs.push({ mac: m, source: 'texto (OCR)' });
  }
  const seen = new Set();
  return { barcodes, ocr: ocr.slice(0, 500), macs: macs.filter(x => !seen.has(x.mac) && seen.add(x.mac)) };
}

const CONFUSE = { '0': 'D', 'D': '0', '8': 'B', 'B': '8', '1': '7', '7': '1', '6': 'B', '5': 'S', '2': 'Z', 'E': 'F', 'F': 'E', 'C': '0' };
function distance(a, b) {
  if (a.length !== b.length) return 99;
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Busca la ONU nueva que corresponde a las MAC leídas.
 * @returns {{ match: object|null, how: string, exact: boolean }}
 */
function matchCandidates(readMacs, candidates) {
  const cands = (candidates || []).map(c => ({ ...c, _n: norm(c.mac) })).filter(c => c._n.length === 12);
  // 1) coincidencia exacta (código de barras u OCR)
  for (const r of readMacs) {
    const hits = cands.filter(c => c._n === r.mac);
    if (hits.length === 1) return { match: hits[0], how: `MAC ${pretty(r.mac)} leída por ${r.source}`, exact: true };
  }
  // 2) OCR con 1 carácter dudoso: solo si hay una única ONU nueva que coincide
  const fuzzy = [];
  for (const r of readMacs.filter(x => /OCR/.test(x.source))) for (const c of cands) if (distance(r.mac, c._n) === 1) fuzzy.push({ c, r });
  const uniq = [...new Map(fuzzy.map(f => [f.c.onu_ref, f])).values()];
  if (uniq.length === 1) return { match: uniq[0].c, how: `MAC ${pretty(uniq[0].c.mac)} (lectura OCR con 1 carácter dudoso: ${pretty(uniq[0].r.mac)})`, exact: false };
  // 3) Algunas ONU registran en la fibra una MAC correlativa a la impresa (mismo fabricante, últimos dígitos ±8):
  //    se acepta solo si hay una única ONU nueva así
  const near = [];
  for (const r of readMacs) for (const c of cands) {
    if (r.mac.slice(0, 6) !== c._n.slice(0, 6)) continue;
    const diff = Math.abs(parseInt(r.mac.slice(6), 16) - parseInt(c._n.slice(6), 16));
    if (diff > 0 && diff <= 8) near.push({ c, r, diff });
  }
  const uniqNear = [...new Map(near.map(f => [f.c.onu_ref, f])).values()];
  if (uniqNear.length === 1) return { match: uniqNear[0].c, how: `MAC de la fibra ${pretty(uniqNear[0].c.mac)} correlativa a la de la etiqueta ${pretty(uniqNear[0].r.mac)} (diferencia ${uniqNear[0].diff})`, exact: false };
  return { match: null, how: readMacs.length ? `Se leyó ${readMacs.map(r => pretty(r.mac)).join(', ')} pero no coincide con ninguna ONU nueva de la OLT.` : 'No se pudo leer ninguna MAC en la foto.', exact: false };
}

module.exports = { read, decodeBarcodes, macsInText, matchCandidates, norm, pretty, _confuse: CONFUSE };
