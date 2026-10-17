'use strict';
/**
 * Actualización de datos de clientes ya registrados: se les pide por WhatsApp solo lo que le falta a su ficha
 * (foto del frente de la casa, foto de la cédula, ubicación).
 *
 *  - Desde la ficha (un cliente) o en tandas desde la pantalla "Actualizar datos" (varios, en horario hábil).
 *  - La ubicación que mande se guarda sola (customerGapsService.onLocationMessage).
 *  - Las fotos se guardan desde Conversaciones con "Guardar como cédula / fachada" (alguien confirma que corresponden).
 *  - Nunca a clientes cancelados ni a inscriptos.
 *
 * Parámetros: data_request_msg, data_request_hours, data_request_per_run, data_request_days.
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

const ITEMS = {
  casa: { label: 'Foto de la casa', line: '✅ Una foto del *frente de tu casa*' },
  cedula: { label: 'Cédula', line: '✅ Una foto del *frente de tu cédula*' },
  ubicacion: { label: 'Ubicación', line: '✅ Tu *ubicación*: estando en tu casa, tocá 📎 → *Ubicación* → *Enviar tu ubicación actual*' },
};
const DEFAULT_MSG = 'Hola {{nombre}} 👋, te escribimos de *{{empresa}}*. Estamos actualizando los datos de nuestros clientes. ¿Nos podés enviar por este chat:\n\n{{lista}}\n\n¡Muchas gracias!';
const CLIENT_STATUSES = ['active', 'suspended', 'ditangguhkan'];

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  require('./customerGapsService').ensureSchema();
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  if (!cols.includes('data_request_at')) db.exec('ALTER TABLE customers ADD COLUMN data_request_at TEXT');
  if (!cols.includes('data_request_items')) db.exec("ALTER TABLE customers ADD COLUMN data_request_items TEXT DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS data_request_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, queued_by TEXT DEFAULT '',
    queued_at TEXT DEFAULT (datetime('now')), sent_at TEXT, status TEXT DEFAULT 'pendiente', error TEXT DEFAULT '')`);
  // fotos del chat ya guardadas en la ficha (para no duplicarlas)
  db.exec('CREATE TABLE IF NOT EXISTS wa_saved_docs (msg_id INTEGER PRIMARY KEY, customer_id INTEGER, doc_id INTEGER, kind TEXT, saved_by TEXT, saved_at TEXT DEFAULT (datetime(\'now\')))');
  _schema = true;
}

const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };

/** Qué le falta a la ficha: ['casa','cedula','ubicacion'] (ubicación también si está "a confirmar"). */
function missingFor(customerId) {
  ensureSchema();
  const c = db.prepare('SELECT id, lat, lng, geo_approx FROM customers WHERE id=?').get(Number(customerId));
  if (!c) return [];
  const docs = require('./customerDocumentService');
  const kinds = new Set(docs.list(c.id).map(d => d.kind));
  const out = [];
  if (!kinds.has('casa')) out.push('casa');
  if (!kinds.has('cedula')) out.push('cedula');
  if (!require('./customerGapsService').hasGeo(c) || Number(c.geo_approx) === 1) out.push('ubicacion');
  return out;
}

function textFor(c, items) {
  const tpl = String(getSetting('data_request_msg', '') || '') || DEFAULT_MSG;
  const first = String(c.name || '').trim().split(/\s+/)[0] || '';
  const lista = items.map(k => ITEMS[k].line).join('\n');
  return tpl.replace(/\{\{nombre\}\}/g, first).replace(/\{\{empresa\}\}/g, getSetting('company_header', '') || '').replace(/\{\{lista\}\}/g, lista);
}

/** Envía el pedido ya. items: los que faltan (por defecto, todos los que faltan). */
async function sendNow(customerId, by, items) {
  ensureSchema();
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(customerId));
  if (!c) throw new Error('Cliente no encontrado');
  if (!CLIENT_STATUSES.includes(c.status)) throw new Error(c.status === 'cancelled' ? 'El cliente está cancelado: no se le envían mensajes.' : 'Solo se pide a clientes con servicio instalado.');
  const want = (items && items.length ? items : missingFor(c.id)).filter(k => ITEMS[k]);
  if (!want.length) throw new Error('La ficha ya tiene foto de la casa, cédula y ubicación: no hay nada que pedir.');
  if (!require('../config/waGate').ready()) throw new Error('WhatsApp no está conectado.');
  const chat = require('./outageService').chatFor(c);
  if (!chat) throw new Error('El cliente no tiene un teléfono válido.');
  await require('./conversationService').reply(chat.id, textFor(c, want), by || 'Oficina');
  const now = new Date().toISOString();
  db.prepare('UPDATE customers SET data_request_at=?, data_request_items=?' + (want.includes('ubicacion') ? ', geo_request_at=?' : '') + ' WHERE id=?')
    .run(...[now, want.join(','), ...(want.includes('ubicacion') ? [now] : []), c.id]);
  try { db.prepare("INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (?, 'datos', '', ?)").run(c.id, 'Pedido de actualización de datos por WhatsApp: ' + want.map(k => ITEMS[k].label).join(', ') + ` (${by || 'oficina'})`); } catch (_) {}
  return { ok: true, items: want, convId: chat.id };
}

/** Clientes con datos faltantes y el estado del pedido. */
function list() {
  ensureSchema();
  const rows = db.prepare(`SELECT id, name, customer_code, phone, status, data_request_at, data_request_items FROM customers
    WHERE status IN (${CLIENT_STATUSES.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE`).all(...CLIENT_STATUSES);
  const queued = new Set(db.prepare("SELECT customer_id FROM data_request_queue WHERE status='pendiente'").all().map(r => r.customer_id));
  return rows.map(r => Object.assign(r, { missing: missingFor(r.id), queued: queued.has(r.id) })).filter(r => r.missing.length);
}

/** Encola varios clientes: se envían en tandas, en horario hábil. Saltea a quien se le pidió hace poco. */
function enqueue(ids, by) {
  ensureSchema();
  const days = num('data_request_days', 15);
  let added = 0, skipped = 0;
  for (const id of [...new Set((ids || []).map(Number).filter(Boolean))]) {
    const c = db.prepare('SELECT id, status, data_request_at FROM customers WHERE id=?').get(id);
    const recent = c && c.data_request_at && Date.now() - Date.parse(c.data_request_at) < days * 86400e3;
    const already = db.prepare("SELECT 1 FROM data_request_queue WHERE customer_id=? AND status='pendiente'").get(id);
    if (!c || !CLIENT_STATUSES.includes(c.status) || recent || already || !missingFor(id).length) { skipped++; continue; }
    db.prepare('INSERT INTO data_request_queue (customer_id, queued_by) VALUES (?,?)').run(id, String(by || '').slice(0, 80));
    added++;
  }
  return { added, skipped, days };
}

function inHours(date) {
  const spec = String(getSetting('data_request_hours', '1-6 08:00-19:00') || '').trim();
  const tz = getSetting('timezone', 'America/Asuncion') || 'America/Asuncion';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date || new Date());
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.find(p => p.type === 'weekday').value];
  const hm = Number(parts.find(p => p.type === 'hour').value) % 24 * 60 + Number(parts.find(p => p.type === 'minute').value);
  return spec.split(';').some(seg => {
    const m = /^\s*(\d)(?:-(\d))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(seg);
    if (!m) return false;
    const d1 = +m[1], d2 = m[2] ? +m[2] : d1;
    return wd >= d1 && wd <= d2 && hm >= (+m[3]) * 60 + (+m[4]) && hm < (+m[5]) * 60 + (+m[6]);
  });
}

let _busy = false;
async function processQueue() {
  if (_busy) return;
  _busy = true;
  try {
    ensureSchema();
    if (!inHours() || !require('../config/waGate').ready()) return;
    const rows = db.prepare("SELECT * FROM data_request_queue WHERE status='pendiente' ORDER BY id LIMIT ?").all(num('data_request_per_run', 3));
    for (const r of rows) {
      try {
        await sendNow(r.customer_id, r.queued_by || 'Oficina');
        db.prepare("UPDATE data_request_queue SET status='enviado', sent_at=? WHERE id=?").run(new Date().toISOString(), r.id);
      } catch (e) {
        db.prepare("UPDATE data_request_queue SET status='error', error=? WHERE id=?").run(String(e.message).slice(0, 300), r.id);
        logger.warn(`[Actualizar datos] cliente ${r.customer_id}: ${e.message}`);
      }
      await new Promise(ok => setTimeout(ok, 8000 + Math.random() * 7000));
    }
  } finally { _busy = false; }
}
function cancelQueue() { ensureSchema(); return db.prepare("UPDATE data_request_queue SET status='cancelado' WHERE status='pendiente'").run().changes; }
function queueCount() { ensureSchema(); return db.prepare("SELECT COUNT(*) n FROM data_request_queue WHERE status='pendiente'").get().n; }

/** Foto del chat de un cliente registrado → documento de su ficha (cédula o casa). */
async function saveChatPhoto(convId, msgId, kind, by) {
  ensureSchema();
  if (!['cedula', 'casa'].includes(kind)) throw new Error('Tipo inválido');
  const conv = require('./conversationService');
  const cv = db.prepare('SELECT id, customer_id FROM wa_conversations WHERE id=?').get(Number(convId));
  if (!cv || !cv.customer_id) throw new Error('Esta conversación no está vinculada a un cliente.');
  const m = db.prepare("SELECT * FROM wa_messages WHERE id=? AND conv_id=? AND media_type='image'").get(Number(msgId), cv.id);
  if (!m) throw new Error('Esa foto no es de esta conversación.');
  const prev = db.prepare('SELECT * FROM wa_saved_docs WHERE msg_id=?').get(m.id);
  if (prev) throw new Error('Esa foto ya está guardada en la ficha como ' + (prev.kind === 'casa' ? 'foto de la casa' : 'cédula') + '.');
  const full = conv.message(m.id);
  const rel = await conv.mediaPathFor(full, full.jid);
  const r = await conv.fetchMedia(rel);
  if (!r || !r.ok) throw new Error('No se pudo descargar la foto de WhatsApp.');
  const docs = require('./customerDocumentService');
  const d = await docs.add(cv.customer_id, kind, Buffer.from(await r.arrayBuffer()), by || 'Oficina');
  db.prepare('INSERT INTO wa_saved_docs (msg_id, customer_id, doc_id, kind, saved_by) VALUES (?,?,?,?,?)').run(m.id, cv.customer_id, d.id, kind, String(by || '').slice(0, 80));
  return { ok: true, kind, label: docs.KINDS[kind] };
}
function savedFor(convId) {
  ensureSchema();
  return db.prepare('SELECT s.msg_id, s.kind FROM wa_saved_docs s JOIN wa_messages m ON m.id=s.msg_id WHERE m.conv_id=?').all(Number(convId));
}

/** Ubicación del chat → ficha (cuando la oficina la confirma a mano). */
function saveChatLocation(convId, msgId, by) {
  ensureSchema();
  const cv = db.prepare('SELECT id, customer_id FROM wa_conversations WHERE id=?').get(Number(convId));
  if (!cv || !cv.customer_id) throw new Error('Esta conversación no está vinculada a un cliente.');
  const m = db.prepare('SELECT lat, lng FROM wa_messages WHERE id=? AND conv_id=? AND lat IS NOT NULL').get(Number(msgId), cv.id);
  if (!m) throw new Error('Ese mensaje no tiene ubicación.');
  const v = require('./customerGapsService').setManual(cv.customer_id, `${m.lat},${m.lng}`, { by: (by || 'Oficina') + ' desde el chat de WhatsApp' });
  return { ok: true, value: v };
}

function settings() {
  return {
    data_request_msg: String(getSetting('data_request_msg', '') || '') || DEFAULT_MSG,
    data_request_hours: String(getSetting('data_request_hours', '1-6 08:00-19:00') || ''),
    data_request_per_run: num('data_request_per_run', 3),
    data_request_days: num('data_request_days', 15),
  };
}

module.exports = { ITEMS, DEFAULT_MSG, ensureSchema, missingFor, textFor, sendNow, list, enqueue, processQueue, cancelQueue, queueCount, saveChatPhoto, savedFor, saveChatLocation, settings, inHours };
