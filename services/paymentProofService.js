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
  let prev = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/[^\p{L}\p{N}@:.,()\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const label = (line.split(':')[0] || '').replace(/[\d.\s]+$/, '').trim();
    for (const m of line.matchAll(/@([A-Za-z0-9_.]{3,})/g)) out.push({ type: 'user', value: m[1].toLowerCase(), label: prev || 'Billetera' });
    for (const m of line.matchAll(/\d[\d .]{4,}\d/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 6) out.push({ type: 'number', value: digits, label: (label && !/^\d/.test(label) && label.length < 40 ? label : prev) || 'Cuenta' });
    }
    if (!/\d{5,}|@/.test(line.replace(/[ .]/g, ''))) prev = line.replace(/:$/, '').slice(0, 40);
  }
  return out;
}
function holderName() {
  const m = /Titular\s*:\s*([^\n]+)/i.exec(String(getSetting('corte_payment_info', '')));
  return m ? m[1].trim() : '';
}

// ── Lectura de los datos del comprobante ─────────────────────────────────────────────────────────
const MESES = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
const toInt = (s) => { const n = parseInt(String(s).replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const NUM = /(?:gs\.?|₲|pyg)?\s*(\d{1,3}(?:[.,]\d{3})+|\d{4,9})(?:[.,]00\b)?\s*(?:gs\.?|₲|pyg)?/i;

function parse(text) {
  const t = String(text || '');
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const r = { amount: 0, date: '', time: '', ref: '', kind: 'Transferencia', origin: '', dest: null, holder: false, looksLike: false };
  // Monto: junto a una palabra clave (misma línea o la siguiente); si no, el primer importe con "Gs"
  for (let i = 0; i < lines.length && !r.amount; i++) {
    if (/\b(monto|importe|total|valor|debitado|transferido|enviado|acreditado|depositado)\b/i.test(lines[i]) && !/comisi[oó]n|saldo/i.test(lines[i])) {
      for (const l of [lines[i].replace(/^.*?(monto|importe|total|valor)[^0-9]*/i, ''), lines[i + 1] || '']) {
        const m = NUM.exec(l); if (m && toInt(m[1]) >= 1000) { r.amount = toInt(m[1]); break; }
      }
    }
  }
  if (!r.amount) { const m = /(?:gs\.?|₲)\s*(\d{1,3}(?:[.,]\d{3})+)|(\d{1,3}(?:[.,]\d{3})+)\s*(?:gs\b|₲)/i.exec(t); if (m) r.amount = toInt(m[1] || m[2]); }
  // Fecha y hora
  let m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(t);
  if (m) { const y = Number(m[3].length === 2 ? '20' + m[3] : m[3]); r.date = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  else if ((m = /(\d{1,2})[\s\-\/]*(?:de\s*)?(ene|jan|feb|mar|abr|apr|may|jun|jul|ago|aug|sep|set|oct|nov|dic|dec)[a-z]*\.?[\s\-\/]*(?:de\s*)?(\d{4})/i.exec(t))) r.date = `${m[3]}-${String(MESES[m[2].toLowerCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  if ((m = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(t))) r.time = `${m[1].padStart(2, '0')}:${m[2]}`;
  // N.º de comprobante / operación
  // (el primero que sea un número de 5+ dígitos y no una fecha: "Comprobante de transferencia" es solo el título)
  for (const x of t.matchAll(/(comprobante|transacci[oó]n|operaci[oó]n|referencia|ref\.?|nro\.?|n[°º]|ticket|c[oó]digo)(?:\s*(?:de|del|n[°º.]?)\s*(?:operaci[oó]n|transacci[oó]n|comprobante))?\s*[:#nº°.]*\s*([A-Z0-9][A-Z0-9-]{4,})/gi)) {
    const dg = x[2].replace(/\D/g, '');
    const isAccount = destinations().some(d => d.type === 'number' && dg.endsWith(d.value)) || /cuenta/i.test(t.slice(Math.max(0, x.index - 25), x.index));
    if (/\d{5,}/.test(x[2]) && !/^\d{1,2}[\/\-.]\d/.test(x[2]) && !isAccount) { r.ref = x[2].toUpperCase(); break; }
  }
  // Tipo
  if (/dep[oó]sito/i.test(t)) r.kind = 'Depósito';
  else if (/giro|tigo\s*money|billetera|mango|wally|zimple|eko|personal\s*pay/i.test(t)) r.kind = 'Giro';
  // Quién pagó (informativo): bloque "Origen" → "Nombre …", o Remitente / Ordenante / De
  const oi = lines.findIndex(l => /\b(origen|remitente|ordenante|depositante|enviado por|de:)/i.test(l));
  const ep = lines.findIndex(l => /^(enviado por|remitente|ordenante|depositante|de parte de)\s*:?\s*$/i.test(l));
  if (ep >= 0 && /^[A-Za-zÁÉÍÓÚÑáéíóúñ ]{6,}$/.test(lines[ep + 1] || '')) r.origin = lines[ep + 1].trim();
  if (!r.origin && oi >= 0) for (const l of lines.slice(oi, oi + 4)) { const n = /(?:[Nn]ombre|[Rr]emitente|[Oo]rdenante|[Dd]epositante|[Tt]itular)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ]{5,})/.exec(l); if (n) { r.origin = n[1].trim(); break; } }
  // Destino: una cuenta o billetera de la empresa
  const tokens = [...t.matchAll(/\d[\d .\-]{4,}\d/g)].map(x => x[0].replace(/\D/g, '')).filter(d => d.length >= 6);
  const low = t.toLowerCase();
  for (const d of destinations()) {
    if (d.type === 'user' && low.includes('@' + d.value)) { r.dest = d; break; }
    if (d.type === 'number' && tokens.some(x => x === d.value || (d.value.length >= 9 && x.slice(-9) === d.value.slice(-9)))) { r.dest = d; break; }
  }
  const hn = holderName().toUpperCase().split(/\s+/).filter(w => w.length > 3);
  r.holder = hn.length >= 2 && hn.filter(w => t.toUpperCase().includes(w)).length >= 2;
  r.looksLike = r.amount >= 1000 && /comprobante|transferencia|dep[oó]sito|giro|monto|importe|operaci[oó]n|enviad[oa]|enviaste|pagaste|transferiste|debitado|acreditado|billetera/i.test(t);
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
  const img = await sharp(buffer).rotate().resize({ width: 1600, withoutEnlargement: false }).greyscale().normalise().png().toBuffer();
  const { data } = await _worker.recognize(img);
  return String((data && data.text) || '');
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
  const vars = regional.phoneVariants(m[1]);
  const q = db.prepare(`SELECT id, name, status FROM customers WHERE phone IN (${vars.map(() => '?').join(',')}) AND status NOT IN ('cancelled') ORDER BY (status='inactive') ASC LIMIT 1`);
  return q.get(...vars) || null;
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
  } else out.push({ ok: null, text: 'No se leyó el N.º de comprobante: revisalo en la foto' });
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

module.exports = { reparse, ensureSchema, scan, processMessage, parse, destinations, checks, pending, get, filePath, assign, markApplied, reject, debtOf };
