'use strict';
/**
 * Números de WhatsApp adicionales de un cliente (customers.alt_phones), además del principal (customers.phone).
 * Sirven para reconocer al cliente cuando escribe desde otro número: comprobantes de pago por WhatsApp, ingreso al
 * portal por teléfono y búsqueda. Los avisos se siguen mandando al número principal.
 * Se guardan en formato local separados por coma y con comas en los extremos (",0981123456,0982…,") para buscar exacto.
 */
const db = require('./database');
const regional = require('./regional');
const MAX = 3;

let _ok = false;
function ensureSchema() {
  if (_ok) return;
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  if (!cols.includes('alt_phones')) db.exec('ALTER TABLE customers ADD COLUMN alt_phones TEXT');
  _ok = true;
}

/** Lista de números válidos (formato local). Lanza error si alguno es inválido o es de otro cliente. */
function parse(input, { exceptId = null, main = '' } = {}) {
  ensureSchema();
  const parts = String(input || '').split(/[,;\/\n]+/).map(s => s.trim()).filter(Boolean);
  const mainLocal = main ? regional.toLocalPhone(main) : '';
  const out = [];
  for (const p of parts) {
    if (!regional.isValidPhone(p)) throw new Error(`Número adicional inválido "${p}". ${regional.phoneHelp()}`);
    const loc = regional.toLocalPhone(p);
    if (loc === mainLocal || out.includes(loc)) continue;
    const other = findByPhone(loc, { exceptId });
    if (other) throw new Error(`El número ${loc} ya es de otro cliente: ${other.name}.`);
    out.push(loc);
  }
  if (out.length > MAX) throw new Error(`Hasta ${MAX} números adicionales.`);
  return out;
}

function save(customerId, list) {
  ensureSchema();
  db.prepare('UPDATE customers SET alt_phones=? WHERE id=?').run(list.length ? ',' + list.join(',') + ',' : null, Number(customerId));
}

function list(customer) { return String((customer && customer.alt_phones) || '').split(',').filter(Boolean); }

/** Cliente con ese número como principal o adicional (no cancelado primero). */
function findByPhone(phone, { exceptId = null } = {}) {
  ensureSchema();
  const loc = regional.toLocalPhone(phone);
  if (!loc) return null;
  const vars = regional.phoneVariants(loc);
  return db.prepare(`SELECT id, name, status FROM customers
    WHERE (phone IN (${vars.map(() => '?').join(',')}) OR alt_phones LIKE ?) AND id IS NOT ?
    ORDER BY (status='cancelled') ASC, (status='inactive') ASC LIMIT 1`).get(...vars, `%,${loc},%`, exceptId) || null;
}

module.exports = { ensureSchema, parse, save, list, findByPhone, MAX };
