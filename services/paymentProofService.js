'use strict';
/**
 * Comprobantes de pago recibidos por WhatsApp (GoWA).
 *
 * 1. Cada 2 minutos se revisan los chats con mensajes nuevos (GoWA guarda el historial). Las fotos y PDF que mandan
 *    los clientes se descargan (GoWA las descifra) y se leen con OCR.
 * 2. Si parece un comprobante (transferencia, depósito o giro a billetera) se guarda con los datos leídos: monto, fecha,
 *    N.º de comprobante, cuenta destino y quién pagó, y se controla:
 *      - destino: una de las cuentas o billeteras de la empresa (se toman de las "formas de pago" de Configuración)
 *      - N.º de comprobante no usado antes
 *      - fecha reciente
 *      - monto contra la deuda del cliente
 *    El nombre de quien pagó es solo informativo (los clientes pagan desde cualquier cuenta o billetera).
 * 3. Se avisa a administración y a la oficina (permiso de cobrar). Nada se aplica solo: una persona toca "Aplicar pago"
 *    (usa el mismo cobro de "Registrar pago": comprobante al cliente, reconexión, historial) o "Rechazar".
 */
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const regional = require('../config/regional');

const DIR = path.join(__dirname, '..', 'database', 'payment_proofs');
let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS payment_proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT UNIQUE, chat_jid TEXT, phone TEXT, customer_id INTEGER,
    received_at TEXT, media_type TEXT, file TEXT, ocr_text TEXT,
    amount INTEGER, op_date TEXT, op_time TEXT, ref TEXT, kind TEXT, dest_label TEXT, origin_name TEXT,
    status TEXT NOT NULL DEFAULT 'pendiente', decided_by TEXT, decided_at TEXT, decision_note TEXT, receipt_id INTEGER,
    created_at TEXT DEFAULT (NOW_LOCAL()))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_payment_proofs_status ON payment_proofs(status)');
  _schemaOk = true;
}

// ── Cuentas y billeteras de la empresa (de las formas de pago de Configuración) ─────────────────────
function destinations() {
  const text = [getSetting('corte_payment_info', ''), getSetting('payment_proof_destinations', '')].join('\n');
  const out = [];
  let prev = '', bank = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[^\p{L}\p{N}@:.,()\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const label = (line.split(':')[0] || '').replace(/[\d.\s]+$/, '').trim();
    for (const m of line.matchAll(/@([A-Za-z0-9_.]{3,})/g)) out.push({ type: 'user', value: m[1].toLowerCase(), label: prev || 'Billetera', kind: 'Billetera' });
    for (const m of line.matchAll(/\d[\d .]{4,}\d/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length < 6) continue;
      let lb = (label && !/^\d/.test(label) && label.length < 40 ? label : prev) || 'Cuenta';
      // "Alias (C.I.): 4.020.592" debajo de "Bancop: 0310176859" → es esa misma cuenta de Bancop
      if (/^alias\b/i.test(lb) && bank) lb = bank;
      else bank = /tigo|giro|billetera|mango|wally|zimple|celular|tel[eé]fono/i.test(lb + ' ' + prev) ? '' : lb;
      out.push({ type: 'number', value: digits, label: lb, kind: kindOfDest(lb + ' ' + prev) });
    }
    if (!/\d{5,}|@/.test(line.replace(/[ .]/g, ''))) prev = line.replace(/:$/, '').slice(0, 40);
  }
  return out;
}
// Tipo de pago según el destino: cuenta bancaria → transferencia; Tigo → giro; Mango, Wally… → billetera
function kindOfDest(text) {
  if (/tigo|giro/i.test(text)) return 'Giro';
  if (/billetera|mango|wally|zimple|personal\s*pay/i.test(text)) return 'Billetera';
  return 'Transferencia';
}
// Bancos y billeteras de Paraguay (para saber desde dónde pagó; es informativo)
const BANKS = [['Banco Familiar', /familiar|\beko\b/i], ['Ueno Bank', /\bueno\b/i], ['Itaú', /ita[uú]/i], ['Banco Continental', /continental/i],
  ['Bancop', /bancop/i], ['Banco BASA', /\bbasa\b/i], ['Banco GNB', /\bgnb\b/i], ['Sudameris', /sudameris/i], ['Visión Banco', /visi[oó]n/i],
  ['Banco Atlas', /\batlas\b/i], ['Interfisa', /interfisa/i], ['Banco Río', /banco\s*r[ií]o\b/i], ['Zeta Banco', /\bzeta\b/i], ['Banco Nacional de Fomento', /\bbnf\b|fomento/i],
  ['Tigo Money', /tigo\s*money/i], ['Billetera Personal', /billetera\s*personal|personal\s*pay/i], ['Wally', /\bwally\b/i], ['Mango', /\bmango\b/i], ['Zimple', /zimple/i], ['Cooperativa', /cooperativa/i]];
const bankIn = (text) => { for (const [name, re] of BANKS) if (re.test(text)) return name; return ''; };

function holderName() {
  const m = /Titular\s*:\s*([^\n]+)/i.exec(String(getSetting('corte_payment_info', '')));
  return m ? m[1].trim() : '';
}

// ── Lectura de los datos del comprobante ─────────────────────────────────────────────────────────
const MESES = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
const toInt = (s) => { const n = parseInt(String(s).replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const NUM = /(?:gs\.?|₲|pyg)?\s*(\d{1,3}(?:[.,]\d{3})+|(?<!\d)\d{4,7}(?!\d))(?:[.,]00\b)?\s*(?:gs\.?|₲|pyg)?/i;

// Fecha de la operación: la primera válida en cualquiera de los formatos habituales de bancos y billeteras
const pad2 = (n) => String(n).padStart(2, '0');
function findDate(t) {
  t = String(t).replace(/(\d[\s\/\-.]*)0(ct)/gi, '$1o$2');
  const ok = (y, mo, d) => y >= 2020 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad2(mo)}-${pad2(d)}` : '';
  const found = [];
  for (const m of t.matchAll(/\b(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/g)) found.push([m.index, ok(+m[1], +m[2], +m[3])]);
  for (const m of t.matchAll(/(?<![\d.,])(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})(?![\d.,])/g)) found.push([m.index, ok(+(m[3].length === 2 ? '20' + m[3] : m[3]), +m[2], +m[1])]);
  for (const m of t.matchAll(/(\d{1,2})[\s\-\/]*(?:de\s*)?(ene|jan|feb|mar|abr|apr|may|jun|jul|ago|aug|sep|set|oct|nov|dic|dec)[a-z]*\.?[\s\-\/,]*(?:de(?:l)?\s*)?(\d{4})/gi)) found.push([m.index, ok(+m[3], MESES[m[2].toLowerCase()], +m[1])]);
  for (const m of t.matchAll(/\b(ene|jan|feb|mar|abr|apr|may|jun|jul|ago|aug|sep|set|oct|nov|dic|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/gi)) found.push([m.index, ok(+m[3], MESES[m[1].toLowerCase()], +m[2])]);
  const v = found.filter(x => x[1]).sort((a, b) => a[0] - b[0]);
  return v.length ? v[0][1] : '';
}

function parse(text) {
  const t = String(text || '');
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const r = { amount: 0, date: '', time: '', ref: '', kind: 'Transferencia', origin: '', dest: null, holder: false, looksLike: false };
  // Monto: junto a una palabra clave (misma línea o la siguiente); si no, el primer importe con "Gs"
  const TIERS = [/\b(mont[oa]|transferido|enviado|env[ií]o|enviaste|transferiste|pagaste)\b/i, /\b(importe|inporte|valor|debitado|acreditado|depositado)\b/i, /\btotal\b/i];
  for (const kw of TIERS) {
    for (let i = 0; i < lines.length && !r.amount; i++) {
      if (!kw.test(lines[i]) || /comisi[oó]n|saldo|cargo|costo|disponible|referencia|remitente|destino|tel[eé]fono|celular|cuenta|cta\.?/i.test(lines[i])) continue;
      const nx = lines[i + 1] || '';
      for (const l of [lines[i].replace(/^.*?(mont[oa]|importe|inporte|total|valor)[^0-9]*/i, ''), /[a-z]{4,}\s*:/i.test(nx) ? '' : nx]) {
        const m = NUM.exec(l); if (m && toInt(m[1]) >= 1000 && toInt(m[1]) <= 50000000) { r.amount = toInt(m[1]); break; }
      }
    }
    if (r.amount) break;
  }
  // "Gs." / "₲" que el lector suele confundir: cs, 6s, G5, G$, gS, ¢, €, £…
  if (!r.amount) { const m = /(?:\b[gc6][s5$]\.?|[₲¢€£])\s*(\d{1,3}(?:[.,]\d{3})+)|(\d{1,3}(?:[.,]\d{3})+)\s*(?:\b[gc6][s5$]\b|[₲¢€£])/i.exec(t); if (m) r.amount = toInt(m[1] || m[2]); }
  // Comprobante evidente sin "Gs" legible: el importe que aparece solo en su línea
  if (!r.amount && /comprobante de (transferencia|dep[oó]sito|pago)|transferencia (exitosa|realizada|solicitada)|solicitamos el env[ií]o|enviaste|pago exitoso/i.test(t)) {
    for (const l of lines) { const m2 = /^\W{0,4}[a-z₲$]{0,3}\.?\s*(\d{1,3}(?:\.\d{3})+)\s*$/i.exec(l.trim()); if (m2 && toInt(m2[1]) >= 1000) { r.amount = toInt(m2[1]); break; } }
  }
  // Fecha y hora
  r.date = findDate(t);
  let m;
  if ((m = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(t))) r.time = `${m[1].padStart(2, '0')}:${m[2]}`;
  // N.º de comprobante / operación
  // (el primero que sea un número de 5+ dígitos y no una fecha: "Comprobante de transferencia" es solo el título)
  for (const x of t.matchAll(/(comprobante|transacci[oó]n|operaci[oó]n|referencia|ref\.?|nro\.?|n[°º]|ticket|c[oó]digo|n[uú]mero|\bid|autorizaci[oó]n|boleta)(?:\s*(?:de|del|n[°º.]?)\s*(?:operaci[oó]n|transacci[oó]n|comprobante))?\s*[:#nº°.]*\s*([A-Z0-9][A-Z0-9-]{4,})/gi)) {
    const dg = x[2].replace(/\D/g, '');
    const isAccount = destinations().some(d => d.type === 'number' && dg.endsWith(d.value)) || /cuenta/i.test(t.slice(Math.max(0, x.index - 25), x.index));
    const masked = /^\s*[*•·xX]/.test(t.slice(x.index + x[0].length, x.index + x[0].length + 2)); // cuenta enmascarada "0000000310****"
    if (/\d{5,}/.test(x[2]) && !/^\d{1,2}[\/\-.]\d/.test(x[2]) && !isAccount && !masked) { r.ref = x[2].toUpperCase(); break; }
  }
  // Quién pagó (informativo): bloque "Origen" → "Nombre …", o Remitente / Ordenante / De
  const oi = lines.findIndex(l => /\b(origen|remitente|ordenante|depositante|enviado por|de:)/i.test(l));
  const ep = lines.findIndex(l => /^(enviado por|remitente|ordenante|depositante|de parte de|de)\s*:?\s*$/i.test(l));
  const ep2 = ep >= 0 ? ep : lines.findIndex(l => /^(enviado por|remitente|ordenante|depositante|de parte de)\b\W{0,3}.{0,4}$/i.test(l));
  if (ep2 >= 0) {
    const nm = String(lines[ep2 + 1] || '').replace(/\s+[^\sA-Za-zÁÉÍÓÚÑáéíóúñ]\S*.*$/, '').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ ]+$/, '').replace(/(\s+[A-ZÁÉÍÓÚÑ]{1,2})+$/, '').trim();
    if (/^[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}( [A-Za-zÁÉÍÓÚÑáéíóúñ]{2,})+$/.test(nm)) r.origin = nm;
  }
  if (!r.origin && oi >= 0) for (const l of lines.slice(oi, oi + 4)) { const n = /(?:[Nn]ombre|[Rr]emitente|[Oo]rdenante|[Dd]epositante|[Tt]itular)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ]{5,})/.exec(l); if (n) { r.origin = n[1].trim(); break; } }
  // Banco o billetera desde el que pagó: lo que dice el bloque "Enviado por" / "Origen" (o, si no, la app del comprobante)
  {
    const from = ep2 >= 0 ? ep2 : oi;
    const to = lines.findIndex((l, i) => i > from && /^(enviado a|destino|destinatario|beneficiario|para)\b/i.test(l));
    const block = from >= 0 ? lines.slice(from, to > from ? to : from + 5).join(' ') : '';
    r.originBank = bankIn(block) || (/\beko\b/i.test(t) ? 'Banco Familiar' : '');
    if (r.originBank && r.origin && !r.origin.includes('(')) r.origin += ` (${r.originBank})`;
    else if (r.originBank && !r.origin) r.origin = r.originBank;
  }
  // Destino: una cuenta o billetera de la empresa
  const tokens = [...t.matchAll(/\d[\d .\-]{4,}\d/g)].map(x => x[0].replace(/\D/g, '')).filter(d => d.length >= 6);
  const low = t.toLowerCase();
  for (const d of destinations()) {
    if (d.type === 'user' && low.includes('@' + d.value)) { r.dest = d; break; }
    const dv = d.value.replace(/^0+/, '');
    if (d.type === 'number' && tokens.some(x => x === d.value || x.replace(/^0+/, '') === dv || (d.value.length >= 9 && x.slice(-9) === d.value.slice(-9)))) { r.dest = d; break; }
  }
  // un dígito mal leído en un número largo (celular o cuenta de 9+ cifras): se acepta si es el único que coincide así
  if (!r.dest) {
    const off1 = (a, b) => a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length === 1;
    const near = destinations().filter(d => d.type === 'number' && d.value.replace(/^0+/, '').length >= 9 && tokens.some(x => off1(x.replace(/^0+/, ''), d.value.replace(/^0+/, ''))));
    if (near.length === 1) r.dest = near[0];
  }
  // titular de la empresa (sin tildes: el lector las pierde o las cambia)
  const plain = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const hn = plain(holderName()).split(/\s+/).filter(w => w.length > 3), T = plain(t);
  r.holder = hn.length >= 2 && hn.filter(w => T.includes(w)).length >= 2;
  // cuenta no leída (oculta o mal leída) pero a nombre del titular y en un banco donde la empresa tiene cuenta
  if (!r.dest && r.holder) {
    const di = lines.findIndex(l => /^(enviado a|a la cuenta de|destino|destinatario|beneficiario|cuenta destino|para)\b/i.test(l));
    const b = di >= 0 ? bankIn(lines.slice(di, di + 5).join(' ')) : '';
    const d = b && destinations().find(x => x.type === 'number' && bankIn(x.label) === b);
    if (d) r.dest = d;
  }
  if (!r.ref) { const mt = /ref\.?\s*tigo\s*\w+\s*:?\s*(\d{6,})/i.exec(t); if (mt) r.ref = mt[1]; }
  if (!r.ref) { const mx = /transacci[oó]n\s*(?:n[°º.]?|nro\.?)?\s*:?\s*([a-z0-9]{10,40})\b/i.exec(t); if (mx && (mx[1].match(/\d/g) || []).length >= 3) r.ref = mx[1].toUpperCase(); }
  // Tipo: depósito (escrito) > según la cuenta de destino > "transferencia" escrita > giro / billetera
  if (/dep[oó]sito/i.test(t) && !/transferencia/i.test(t)) r.kind = 'Depósito';
  else if (r.dest && r.dest.kind) r.kind = r.dest.kind;
  else if (/transferencia|transferiste|sipap|sistema nacional de pagos/i.test(t)) r.kind = 'Transferencia';
  else if (/giro|tigo\s*money/i.test(t)) r.kind = 'Giro';
  else if (/billetera|mango|wally|zimple|personal\s*pay/i.test(t)) r.kind = 'Billetera';
  // Es comprobante si tiene monto, o si va a una cuenta/billetera de la empresa o a nombre del titular aunque el monto no
  // se haya podido leer (queda para revisar con el monto en "?": mejor que lo vea una persona a que se pierda)
  r.looksLike = (r.amount >= 1000 || !!r.dest || r.holder) && /env[ií]o|exitos[ao]|sipap|sistema nacional de pagos|a la cuenta de|comprobante|transferencia|dep[oó]sito|giro|monto|importe|operaci[oó]n|enviad[oa]|enviaste|pagaste|transferiste|debitado|acreditado|billetera/i.test(t);
  return r;
}

// ── OCR ─────────────────────────────────────────────────────────────────────────────────────────
let _worker = null;
async function ocr(buffer) {
  if (!_worker) {
    const T = require('tesseract.js');
    _worker = await T.createWorker('eng', 1, { cachePath: path.join(__dirname, '..', 'database', 'tessdata'), logger: () => {} });
  }
  const sharp = require('sharp');
  // capturas en modo oscuro (letra clara sobre fondo oscuro): se invierten, el lector lee mucho mejor negro sobre blanco
  let dark = false;
  try { dark = (await sharp(buffer).rotate().greyscale().stats()).channels[0].mean < 110; } catch (_) {}
  const prep = (width, threshold) => {
    let g = sharp(buffer).rotate().resize({ width, withoutEnlargement: false }).greyscale();
    if (dark) g = g.negate({ alpha: false });
    g = g.normalise();
    if (threshold) g = g.threshold(threshold);
    return g.png().toBuffer();
  };
  const read = async (img) => String(((await _worker.recognize(img)).data || {}).text || '');
  const score = (r) => (r.amount ? 3 : 0) + (r.dest ? 2 : 0) + (r.date ? 1 : 0) + (r.time ? 1 : 0) + (r.ref ? 1 : 0) + (r.origin ? 1 : 0);
  const t1 = await read(await prep(1600));
  const r1 = parse(t1);
  if (r1.amount && r1.dest && r1.date) return t1;
  // faltan datos: segunda lectura más grande y en blanco y negro puro; se queda con la que leyó más
  const t2 = await read(await prep(2200, 150));
  let best = score(parse(t2)) > score(r1) ? t2 : t1;
  const rb = parse(best);
  if (rb.amount && rb.dest) return best;
  // fotos de tickets de papel o de pantallas: contraste local (CLAHE)
  try {
    let g = sharp(buffer).rotate().resize({ width: 2000, withoutEnlargement: false }).greyscale();
    if (dark) g = g.negate({ alpha: false });
    const t3 = await read(await g.clahe({ width: 64, height: 64, maxSlope: 3 }).png().toBuffer());
    if (score(parse(t3)) > score(rb)) best = t3;
  } catch (_) {}
  return best;
}

// ── GoWA ────────────────────────────────────────────────────────────────────────────────────────
async function gowa(pathq) {
  const g = require('./gowaWhatsappService');
  const u = String(getSetting('gowa_username', '') || '').trim(), p = String(getSetting('gowa_password', '') || '').trim();
  const raw = String(getSetting('gowa_basic_auth', '') || '').trim();
  const H = {};
  if ((u && p) || raw) H.Authorization = 'Basic ' + Buffer.from(u && p ? u + ':' + p : raw).toString('base64');
  const dev = await g.resolveDeviceId(); if (dev) H['X-Device-Id'] = dev;
  const r = await fetch(g.baseUrl() + pathq, { headers: H, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('GoWA ' + r.status);
  return r;
}

function customerByJid(jid) {
  const m = /^(\d{8,15})@s\.whatsapp\.net$/.exec(String(jid || ''));
  if (!m) return null;
  const c = require('../config/customerPhones').findByPhone(m[1]);
  return c && c.status !== 'cancelled' ? c : null;
}

function debtOf(customerId) {
  const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0) t FROM invoices WHERE customer_id=? AND status='unpaid'").get(customerId);
  return { count: r.n, total: Number(r.t) || 0 };
}

/** Controles de un comprobante (para mostrar en verde / rojo). */
function checks(p) {
  const out = [];
  const maxDays = Math.max(1, Number(getSetting('payment_proof_max_days', 7)) || 7);
  out.push(p.dest_label ? { ok: true, text: `Destino: ${p.dest_label}` } : { ok: false, text: 'No se encontró una cuenta o billetera de la empresa en el comprobante' });
  if (p.ref) {
    const dup = db.prepare("SELECT id, customer_id FROM payment_proofs WHERE ref=? AND id<>? AND status IN ('pendiente','aplicado') LIMIT 1").get(p.ref, p.id);
    out.push(dup ? { ok: false, text: `N.º ${p.ref} ya figura en otro comprobante (#${dup.id})` } : { ok: true, text: `N.º de comprobante ${p.ref} (no usado antes)` });
  } else {
    // sin número (Eko, Familiar y otros no lo muestran): se controla por monto + fecha + hora + quién pagó
    const twin = p.amount && p.op_date && p.op_time && db.prepare(`SELECT id FROM payment_proofs WHERE id<>? AND status IN ('pendiente','aplicado')
      AND amount=? AND op_date=? AND op_time=? AND COALESCE(origin_name,'')=COALESCE(?, '') LIMIT 1`).get(p.id, p.amount, p.op_date, p.op_time, p.origin_name || '');
    out.push(twin ? { ok: false, text: `Mismo monto, fecha, hora y remitente que el comprobante #${twin.id}: puede ser repetido` }
      : { ok: null, text: 'El comprobante no trae N.º de operación (normal en algunas apps): se controló por monto, fecha y hora' });
  }
  if (p.op_date) {
    const d = new Date(p.op_date + 'T12:00:00'), now = new Date();
    const days = Math.floor((now - d) / 86400000);
    out.push(days < -1 ? { ok: false, text: `Fecha futura (${p.op_date.split('-').reverse().join('/')})` }
      : days > maxDays ? { ok: false, text: `Fecha vieja: ${p.op_date.split('-').reverse().join('/')} (hace ${days} días)` }
        : { ok: true, text: `Fecha ${p.op_date.split('-').reverse().join('/')}${p.op_time ? ' ' + p.op_time : ''}` });
  } else out.push({ ok: null, text: 'No se leyó la fecha' });
  if (p.customer_id) {
    const debt = debtOf(p.customer_id);
    if (!p.amount) out.push({ ok: null, text: 'No se leyó el monto' });
    else if (!debt.count) out.push({ ok: null, text: `El cliente no tiene deuda: ${regional.formatMoney(p.amount)} quedaría como saldo a favor` });
    else if (p.amount === debt.total) out.push({ ok: true, text: `Monto ${regional.formatMoney(p.amount)} = su deuda` });
    else if (p.amount < debt.total) out.push({ ok: null, text: `Pago parcial: ${regional.formatMoney(p.amount)} de ${regional.formatMoney(debt.total)}` });
    else out.push({ ok: null, text: `Paga ${regional.formatMoney(p.amount)}, debe ${regional.formatMoney(debt.total)}: ${regional.formatMoney(p.amount - debt.total)} a favor` });
  } else out.push({ ok: false, text: 'El número que lo envió no es de un cliente: elegí a qué cliente corresponde' });
  // ¿Ya se cobró a mano? Mismo monto registrado desde el día anterior al comprobante (evita cobrar dos veces)
  if (p.customer_id && p.amount) {
    const since = p.op_date || String(p.received_at || '').slice(0, 10);
    const dup = since && db.prepare(`SELECT id, created_at FROM payment_receipts WHERE customer_id=? AND amount=? AND annulled_at IS NULL
      AND date(created_at) >= date(?, '-1 day') ORDER BY id LIMIT 1`).get(p.customer_id, p.amount, since);
    if (dup) out.push({ ok: false, text: `Ya hay un cobro de ${regional.formatMoney(p.amount)} registrado el ${String(dup.created_at).slice(8, 10)}/${String(dup.created_at).slice(5, 7)} ${String(dup.created_at).slice(11, 16)} (cobro #${dup.id}): probablemente ya está aplicado` });
  }
  return out;
}

async function notifyNew(p, cust) {
  const ok = checks(p);
  const bad = ok.filter(c => c.ok === false).length;
  const msg = `🧾 *Comprobante recibido por WhatsApp*\n` + (cust ? `Cliente: ${cust.name}\n` : `Número no registrado: ${p.phone || '-'}\n`) +
    `${p.kind}: ${p.amount ? regional.formatMoney(p.amount) : 'monto no leído'}${p.dest_label ? ' → ' + p.dest_label : ''}\n` +
    (bad ? `⚠️ ${ok.filter(c => c.ok === false).map(c => c.text).join(' · ')}` : '✅ Controles OK') +
    `\n\nRevisalo y aplicalo en Pagos pendientes → Comprobantes por revisar.`;
  try { await require('./waNotifyService').notifyAdmin(msg); } catch (_) {}
  try {
    const sp = require('../config/staffPermissions');
    for (const s of db.prepare("SELECT id, phone FROM cashiers WHERE is_active=1 AND COALESCE(phone,'')<>''").all()) {
      if (sp.current(s.id).cobrar) await require('./installationService')._sendTo(s.phone, msg);
    }
  } catch (_) {}
}

/** Procesa un mensaje entrante con foto o PDF. */
async function processMessage(chatJid, m) {
  ensureSchema();
  if (db.prepare('SELECT 1 FROM payment_proofs WHERE msg_id=?').get(m.id)) return null;
  const cust = customerByJid(chatJid);
  const phone = (/^(\d+)@/.exec(chatJid) || [])[1] || '';
  const isPdf = m.media_type === 'document' && /pdf/i.test(String(m.filename || m.mimetype || ''));
  if (m.media_type !== 'image' && !isPdf) return null;
  // descarga (GoWA descifra y la deja servible en /statics)
  const dl = await (await gowa(`/message/${encodeURIComponent(m.id)}/download?phone=${encodeURIComponent(chatJid)}`)).json();
  const rel = String((dl.results && dl.results.file_path) || '').replace(/^.*?statics\//, 'statics/');
  if (!rel) throw new Error('GoWA no devolvió el archivo');
  const buf = Buffer.from(await (await gowa('/' + rel)).arrayBuffer());
  fs.mkdirSync(DIR, { recursive: true });
  let text = '', file = '';
  if (isPdf) { file = `${Date.now()}-${m.id}.pdf`; fs.writeFileSync(path.join(DIR, file), buf); }
  else {
    file = `${Date.now()}-${m.id}.jpg`;
    await require('sharp')(buf).rotate().resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(path.join(DIR, file));
    text = await ocr(buf);
  }
  const r = parse(text);
  const status = isPdf || r.looksLike ? 'pendiente' : 'ignorado';
  if (status === 'ignorado') { try { fs.unlinkSync(path.join(DIR, file)); } catch (_) {} file = ''; }
  const id = Number(db.prepare(`INSERT INTO payment_proofs (msg_id, chat_jid, phone, customer_id, received_at, media_type, file, ocr_text, amount, op_date, op_time, ref, kind, dest_label, origin_name, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(m.id, chatJid, phone, cust ? cust.id : null, (m.timestamp ? new Date(m.timestamp).toLocaleString('sv-SE', { timeZone: regional.timezone() }) : ''),
    isPdf ? 'pdf' : 'image', file, text.slice(0, 4000), r.amount || null, r.date || null, r.time || null, r.ref || null, r.kind,
    r.dest ? r.dest.label : (r.holder ? 'titular de la empresa (cuenta no leída)' : null), r.origin || null, status).lastInsertRowid);
  if (status === 'pendiente') {
    logger.info(`[Comprobantes] #${id} de ${cust ? cust.name : phone}: ${r.kind} ${r.amount || '?'}${r.dest ? ' → ' + r.dest.label : ''}`);
    await notifyNew(get(id), cust);
  }
  return id;
}

/** Vuelve a analizar los descartados recientes con el lector actual; los que ahora son comprobantes se bajan de nuevo. */
async function retryIgnored({ days = 7 } = {}) {
  ensureSchema();
  const rows = db.prepare("SELECT * FROM payment_proofs WHERE status='ignorado' AND ocr_text != '' AND created_at >= datetime('now', ?)").all(`-${Math.max(1, Number(days) || 7)} days`);
  let found = 0;
  for (const p of rows) {
    if (!parse(p.ocr_text).looksLike) continue;
    db.prepare('DELETE FROM payment_proofs WHERE id=?').run(p.id);
    try {
      const id = await processMessage(p.chat_jid, { id: p.msg_id, media_type: p.media_type === 'pdf' ? 'document' : 'image', filename: p.media_type === 'pdf' ? 'x.pdf' : '', timestamp: p.received_at ? new Date(String(p.received_at).replace(' ', 'T') + '-03:00').toISOString() : null });
      if (id && get(id) && get(id).status === 'pendiente') found++;
    } catch (e) { logger.warn('[Comprobantes] reintento #' + p.id + ': ' + e.message); }
  }
  return { revisados: rows.length, nuevos: found };
}

/** Revisa los chats con mensajes nuevos desde la última vez. */
let _busy = false;
async function scan({ sinceHours = null } = {}) {
  if (_busy) return { skipped: true };
  if (String(getSetting('payment_proof_enabled', true)) === 'false') return { disabled: true };
  if (String(getSetting('wa_gateway_type', 'gowa') || '').toLowerCase() !== 'gowa') return { disabled: true };
  _busy = true;
  ensureSchema();
  const res = { chats: 0, messages: 0, proofs: 0, errors: 0 };
  try {
    const last = db.getAppSetting('payment_proof_scan_at', '');
    const since = sinceHours != null ? new Date(Date.now() - sinceHours * 3600000) : (last ? new Date(last) : new Date(Date.now() - 24 * 3600000));
    const startedAt = new Date();
    const chats = (((await (await gowa('/chats?limit=40')).json()).results || {}).data || [])
      .filter(c => /@s\.whatsapp\.net$/.test(c.jid) && new Date(c.last_message_time) >= new Date(since.getTime() - 120000));
    for (const c of chats) {
      res.chats++;
      try {
        const msgs = (((await (await gowa(`/chat/${encodeURIComponent(c.jid)}/messages?limit=15`)).json()).results || {}).data || []);
        for (const m of msgs) {
          if (m.is_from_me || !m.media_type || new Date(m.timestamp) < new Date(since.getTime() - 120000)) continue;
          res.messages++;
          try { if (await processMessage(c.jid, m)) res.proofs++; } catch (e) { res.errors++; logger.warn(`[Comprobantes] mensaje ${m.id}: ${e.message}`); }
        }
      } catch (e) { res.errors++; logger.warn(`[Comprobantes] chat: ${e.message}`); }
    }
    db.saveAppSetting('payment_proof_scan_at', startedAt.toISOString());
  } catch (e) { res.errors++; logger.warn('[Comprobantes] ' + e.message); }
  finally { _busy = false; }
  return res;
}

function get(id) {
  ensureSchema();
  return db.prepare(`SELECT p.*, c.name AS customer_name, c.customer_code, c.status AS customer_status FROM payment_proofs p LEFT JOIN customers c ON c.id = p.customer_id WHERE p.id=?`).get(Number(id)) || null;
}
function pending() {
  ensureSchema();
  return db.prepare(`SELECT p.*, c.name AS customer_name, c.customer_code, c.status AS customer_status FROM payment_proofs p LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.status='pendiente' ORDER BY p.received_at`).all().map(p => ({ ...p, checks: checks(p), debt: p.customer_id ? debtOf(p.customer_id) : null }));
}
function filePath(p) { return p && p.file ? path.join(DIR, path.basename(p.file)) : null; }

function assign(id, customerRef, by) {
  const p = get(id); if (!p || p.status !== 'pendiente') throw new Error('Comprobante no disponible.');
  const ref = String(customerRef || '').trim();
  const c = db.prepare("SELECT id, name FROM customers WHERE (id=? OR customer_code=? OR pppoe_username=?) AND status<>'cancelled'").get(Number(ref) || -1, ref, ref);
  if (!c) throw new Error('No se encontró el cliente (usá el ID, el código ISP-… o el usuario PPPoE).');
  db.prepare('UPDATE payment_proofs SET customer_id=? WHERE id=?').run(c.id, p.id);
  logger.info(`[Comprobantes] #${p.id} asignado a ${c.name} por ${by}`);
  return c;
}
function markApplied(id, { by, receiptId, amount, note }) {
  db.prepare("UPDATE payment_proofs SET status='aplicado', decided_by=?, decided_at=(NOW_LOCAL()), receipt_id=?, amount=COALESCE(?, amount), decision_note=? WHERE id=?").run(by, receiptId || null, amount || null, note || null, Number(id));
}
function reject(id, reason, by) {
  const p = get(id); if (!p || p.status !== 'pendiente') throw new Error('Comprobante no disponible.');
  if (String(reason || '').trim().length < 3) throw new Error('Indicá el motivo.');
  db.prepare("UPDATE payment_proofs SET status='rechazado', decided_by=?, decided_at=(NOW_LOCAL()), decision_note=? WHERE id=?").run(by, String(reason).trim().slice(0, 200), p.id);
  if (p.customer_id) { try { db.prepare("INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (?, 'install', NULL, ?)").run(p.customer_id, `Comprobante por WhatsApp rechazado por ${by}: ${String(reason).trim()}`); } catch (_) {} }
  return p;
}

/** Vuelve a leer los datos de un comprobante pendiente a partir del texto ya guardado. */
function reparse(id) {
  const p = get(id); if (!p || p.status !== 'pendiente' || !p.ocr_text) return null;
  const r = parse(p.ocr_text);
  db.prepare('UPDATE payment_proofs SET amount=COALESCE(?,amount), op_date=COALESCE(?,op_date), op_time=COALESCE(?,op_time), ref=COALESCE(?,ref), kind=?, dest_label=COALESCE(?,dest_label), origin_name=COALESCE(?,origin_name) WHERE id=?')
    .run(r.amount || null, r.date || null, r.time || null, r.ref || null, r.kind, r.dest ? r.dest.label : null, r.origin || null, p.id);
  return get(id);
}

module.exports = { retryIgnored, reparse, ensureSchema, scan, processMessage, parse, destinations, checks, pending, get, filePath, assign, markApplied, reject, debtOf };
