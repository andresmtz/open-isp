'use strict';
/**
 * Datos que le faltan a la ficha del cliente y que el técnico puede completar en la visita:
 * foto de la casa y ubicación (sin cargar o marcada como aproximada).
 * No se piden en órdenes de retiro de equipo.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  // geo_approx = 1: la ubicación es aproximada (p. ej. la de un vecino) y hay que confirmarla en la visita
  if (!cols.includes('geo_approx')) db.exec('ALTER TABLE customers ADD COLUMN geo_approx INTEGER DEFAULT 0');
  // geo_request_at: se le pidió la ubicación al cliente por WhatsApp; la que mande en los días siguientes se guarda sola
  if (!cols.includes('geo_request_at')) db.exec('ALTER TABLE customers ADD COLUMN geo_request_at TEXT');
  _schema = true;
}

const hasGeo = (c) => c && c.lat !== null && c.lat !== '' && c.lng !== null && c.lng !== '' && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)) && Number(c.lat) !== 0;

/** { house: bool (falta foto), geo: 'falta' | 'aprox' | '' } o null si no falta nada. */
function gapsFor(customerId) {
  ensureSchema();
  const c = db.prepare('SELECT id, lat, lng, geo_approx FROM customers WHERE id=?').get(Number(customerId));
  if (!c) return null;
  const docs = require('./customerDocumentService');
  const house = docs.list(c.id, { kinds: ['casa'] }).length === 0;
  const geo = !hasGeo(c) ? 'falta' : (Number(c.geo_approx) === 1 ? 'aprox' : '');
  return house || geo ? { house, geo } : null;
}

/** Ubicación tomada por el GPS del celular del técnico en la casa del cliente. */
function saveLocation(customerId, lat, lng, accuracy, by) {
  ensureSchema();
  const la = Number(lat), lo = Number(lng), acc = Number(accuracy);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) throw new Error('Ubicación inválida');
  if (Number.isFinite(acc) && acc > 100) throw new Error(`El GPS tiene poca precisión (${Math.round(acc)} m). Salí al exterior, esperá unos segundos y volvé a intentar.`);
  const c = db.prepare('SELECT lat, lng, geo_approx FROM customers WHERE id=?').get(Number(customerId));
  if (!c) throw new Error('Cliente no encontrado');
  const prev = hasGeo(c) ? `${c.lat},${c.lng}${Number(c.geo_approx) === 1 ? ' (aproximada)' : ''}` : '(sin ubicación)';
  const v = `${la.toFixed(6)},${lo.toFixed(6)}`;
  db.prepare('UPDATE customers SET lat=?, lng=?, geo_approx=0 WHERE id=?').run(la.toFixed(6), lo.toFixed(6), Number(customerId));
  try {
    db.prepare("INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (?, 'ubicacion', ?, ?)")
      .run(Number(customerId), prev, `${v} (GPS del técnico ${by || ''} en la visita${Number.isFinite(acc) ? ', precisión ' + Math.round(acc) + ' m' : ''})`);
  } catch (_) {}
  logger.info(`[Ficha] Ubicación del cliente ${customerId} actualizada por el técnico ${by || '-'}`);
  return v;
}

const DEFAULT_REQUEST = 'Hola {{nombre}} 👋, te escribimos de *{{empresa}}*. Para tener bien registrada tu dirección y que el técnico llegue sin problemas, ¿nos podés compartir la *ubicación de tu casa*?\n\nEstando en tu casa, en este chat tocá 📎 → *Ubicación* → *Enviar tu ubicación actual*. ¡Gracias!';
const REQUEST_DAYS = 7;

function event(cid, oldV, newV) {
  try { db.prepare("INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (?, 'ubicacion', ?, ?)").run(Number(cid), oldV, newV); } catch (_) {}
}
const prevOf = (c) => hasGeo(c) ? `${c.lat},${c.lng}${Number(c.geo_approx) === 1 ? ' (a confirmar)' : ''}` : '(sin ubicación)';

/** La oficina marca la ubicación como incorrecta o a confirmar: el técnico la confirma en la próxima visita. */
function markToConfirm(customerId, reason, by) {
  ensureSchema();
  const c = db.prepare('SELECT id, lat, lng, geo_approx FROM customers WHERE id=?').get(Number(customerId));
  if (!c) throw new Error('Cliente no encontrado');
  db.prepare('UPDATE customers SET geo_approx=1 WHERE id=?').run(c.id);
  event(c.id, prevOf(c), `Marcada para confirmar por ${by || 'la oficina'}${reason ? ': ' + String(reason).slice(0, 200) : ''}`);
  return { ok: true };
}

/** Ubicación cargada a mano por la oficina (coordenadas o enlace de Google Maps). */
function parseCoords(text) {
  const t = String(text || '');
  const m = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/.exec(t) || /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(t);
  if (!m) throw new Error('No encontré coordenadas. Pegá algo como -25.4930, -54.8943 o un enlace de Google Maps con ellas.');
  return { lat: Number(m[1]), lng: Number(m[2]) };
}
function setManual(customerId, text, { approx = false, by = '' } = {}) {
  ensureSchema();
  const { lat, lng } = parseCoords(text);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('Coordenadas inválidas');
  const c = db.prepare('SELECT id, lat, lng, geo_approx FROM customers WHERE id=?').get(Number(customerId));
  if (!c) throw new Error('Cliente no encontrado');
  const v = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  db.prepare('UPDATE customers SET lat=?, lng=?, geo_approx=?, geo_request_at=NULL WHERE id=?').run(lat.toFixed(6), lng.toFixed(6), approx ? 1 : 0, c.id);
  event(c.id, prevOf(c), `${v} (cargada por ${by || 'la oficina'}${approx ? ', APROXIMADA' : ''})`);
  return v;
}

/** Pide la ubicación al cliente por WhatsApp. La que mande en los próximos días se guarda sola. */
async function requestFromCustomer(customerId, by) {
  ensureSchema();
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(customerId));
  if (!c) throw new Error('Cliente no encontrado');
  if (c.status === 'cancelled') throw new Error('El cliente está cancelado: no se le envían mensajes.');
  if (!require('../config/waGate').ready()) throw new Error('WhatsApp no está conectado.');
  const chat = require('./outageService').chatFor(c);
  if (!chat) throw new Error('El cliente no tiene un teléfono válido.');
  const { getSetting } = require('../config/settingsManager');
  const tpl = String(getSetting('geo_request_msg', '') || '') || DEFAULT_REQUEST;
  const first = String(c.name || '').trim().split(/\s+/)[0] || '';
  const text = tpl.replace(/\{\{nombre\}\}/g, first).replace(/\{\{empresa\}\}/g, getSetting('company_header', '') || '');
  await require('./conversationService').reply(chat.id, text, by || 'Oficina');
  db.prepare('UPDATE customers SET geo_request_at=? WHERE id=?').run(new Date().toISOString(), c.id);
  return { ok: true, convId: chat.id };
}

/** Ubicación recibida por WhatsApp: si se la habíamos pedido a ese cliente, se guarda en la ficha. */
function onLocationMessage(convId, lat, lng, ts) {
  try {
    ensureSchema();
    const conv = db.prepare('SELECT customer_id FROM wa_conversations WHERE id=?').get(Number(convId));
    if (!conv || !conv.customer_id) return;
    const c = db.prepare('SELECT id, name, lat, lng, geo_approx, geo_request_at, status FROM customers WHERE id=?').get(conv.customer_id);
    if (!c || !c.geo_request_at || c.status === 'cancelled') return;
    if (String(ts) < c.geo_request_at || Date.now() - Date.parse(c.geo_request_at) > REQUEST_DAYS * 86400e3) return;
    const la = Number(lat), lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return;
    const v = `${la.toFixed(6)},${lo.toFixed(6)}`;
    db.prepare('UPDATE customers SET lat=?, lng=?, geo_approx=0, geo_request_at=NULL WHERE id=?').run(la.toFixed(6), lo.toFixed(6), c.id);
    event(c.id, prevOf(c), `${v} (enviada por el cliente por WhatsApp a pedido de la oficina)`);
    logger.info(`[Ficha] Ubicación de ${c.name} actualizada desde WhatsApp`);
    require('./waNotifyService').notifyAdmin(`📍 ${c.name} mandó su ubicación por WhatsApp y quedó guardada en la ficha: https://maps.google.com/?q=${v}`).catch(() => {});
  } catch (e) { logger.warn('[Ficha] ubicación por WhatsApp: ' + e.message); }
}

module.exports = { ensureSchema, gapsFor, saveLocation, markToConfirm, setManual, parseCoords, requestFromCustomer, onLocationMessage, hasGeo, DEFAULT_REQUEST };
