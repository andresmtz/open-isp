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

module.exports = { ensureSchema, gapsFor, saveLocation };
