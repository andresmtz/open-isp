'use strict';
/**
 * Servicios adicionales por cliente (IPTV, cámaras, alquiler de equipos…): cargo mensual fijo que se suma
 * a la factura del plan de internet. El precio se negocia con cada cliente, así que se fija al agregarlo
 * (el catálogo solo sugiere un precio). Si el servicio lleva un equipo en comodato (ej. decodificador),
 * queda registrado con su número de serie para el retiro.
 */
const db = require('../config/database');
const regional = require('../config/regional');

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS extra_service_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      default_price INTEGER DEFAULT 0,
      equipment TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS customer_extra_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      catalog_id INTEGER,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      equipment TEXT DEFAULT '',
      serial TEXT DEFAULT '',
      note TEXT DEFAULT '',
      start_date TEXT,
      active INTEGER DEFAULT 1,
      ended_at TEXT, ended_reason TEXT DEFAULT '', ended_by TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cust_extra ON customer_extra_services(customer_id, active);
  `);
  if (!db.prepare('SELECT 1 FROM extra_service_catalog LIMIT 1').get()) {
    db.prepare("INSERT INTO extra_service_catalog (name, default_price, equipment) VALUES ('IPTV', 40000, 'Decodificador')").run();
  }
  _schema = true;
}

const money = (n) => `${regional.currencySymbol()} ${Number(n || 0).toLocaleString(regional.locale())}`;
const event = (customerId, oldV, newV) => {
  try { db.prepare("INSERT INTO customer_events (customer_id, created_at, type, old_value, new_value) VALUES (?, datetime('now','localtime'), 'servicio_adicional', ?, ?)").run(customerId, oldV, newV); } catch (_) {}
};

// ── catálogo ────────────────────────────────────────────────────────────────
function catalog({ all = false } = {}) {
  ensureSchema();
  return db.prepare(`SELECT * FROM extra_service_catalog ${all ? '' : 'WHERE active=1'} ORDER BY name`).all();
}
function saveCatalog({ id, name, default_price, equipment, active }) {
  ensureSchema();
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw new Error('El servicio necesita un nombre');
  const price = Math.max(0, Math.round(Number(default_price) || 0));
  const eq = String(equipment || '').trim().slice(0, 60);
  if (id) {
    db.prepare('UPDATE extra_service_catalog SET name=?, default_price=?, equipment=?, active=? WHERE id=?').run(n, price, eq, active === undefined ? 1 : (Number(active) ? 1 : 0), Number(id));
    return Number(id);
  }
  if (db.prepare('SELECT 1 FROM extra_service_catalog WHERE lower(name)=lower(?)').get(n)) throw new Error(`Ya existe un servicio llamado "${n}"`);
  return Number(db.prepare('INSERT INTO extra_service_catalog (name, default_price, equipment) VALUES (?,?,?)').run(n, price, eq).lastInsertRowid);
}

// ── servicios de un cliente ─────────────────────────────────────────────────
function forCustomer(customerId, { all = false } = {}) {
  ensureSchema();
  return db.prepare(`SELECT * FROM customer_extra_services WHERE customer_id=? ${all ? '' : 'AND active=1'} ORDER BY active DESC, id`).all(Number(customerId));
}
function monthlyTotal(customerId) {
  ensureSchema();
  return Number(db.prepare('SELECT COALESCE(SUM(price),0) t FROM customer_extra_services WHERE customer_id=? AND active=1').get(Number(customerId)).t) || 0;
}

function add(customerId, data, actor) {
  ensureSchema();
  const cid = Number(customerId);
  const cust = db.prepare('SELECT id, name, status FROM customers WHERE id=?').get(cid);
  if (!cust) throw new Error('Cliente no encontrado');
  if (cust.status === 'cancelled') throw new Error('El cliente está cancelado');
  const cat = data.catalog_id ? db.prepare('SELECT * FROM extra_service_catalog WHERE id=?').get(Number(data.catalog_id)) : null;
  const name = String((cat && cat.name) || data.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Elegí el servicio');
  const raw = String(data.price == null ? '' : data.price).replace(/[^\d]/g, '');
  if (raw === '') throw new Error('Indicá el precio mensual acordado');
  const price = Math.round(Number(raw));
  const equipment = String(data.equipment != null ? data.equipment : (cat ? cat.equipment : '') || '').trim().slice(0, 60);
  const serial = String(data.serial || '').trim().slice(0, 60);
  const note = String(data.note || '').trim().slice(0, 300);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(data.start_date || '')) ? data.start_date : new Date().toISOString().slice(0, 10);
  const r = db.prepare(`INSERT INTO customer_extra_services (customer_id, catalog_id, name, price, equipment, serial, note, start_date, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(cid, cat ? cat.id : null, name, price, equipment, serial, note, start, String(actor || '').slice(0, 80));
  event(cid, '', `Alta: ${name} · ${money(price)}/mes` + (equipment ? ` · ${equipment}${serial ? ' ' + serial : ''} en comodato` : '') + (actor ? ` (por ${actor})` : ''));
  return Number(r.lastInsertRowid);
}

function update(id, data, actor) {
  ensureSchema();
  const s = db.prepare('SELECT * FROM customer_extra_services WHERE id=?').get(Number(id));
  if (!s || !s.active) throw new Error('Servicio no encontrado');
  const set = {};
  if (data.price != null && String(data.price) !== '') set.price = Math.round(Number(String(data.price).replace(/[^\d]/g, '')) || 0);
  if (data.serial !== undefined) set.serial = String(data.serial || '').trim().slice(0, 60);
  if (data.note !== undefined) set.note = String(data.note || '').trim().slice(0, 300);
  const keys = Object.keys(set);
  if (!keys.length) return;
  db.prepare(`UPDATE customer_extra_services SET ${keys.map(k => k + '=?').join(', ')} WHERE id=?`).run(...keys.map(k => set[k]), s.id);
  if (set.price !== undefined && set.price !== s.price) event(s.customer_id, `${s.name} · ${money(s.price)}/mes`, `${s.name} · ${money(set.price)}/mes` + (actor ? ` (por ${actor})` : ''));
}

function end(id, reason, actor) {
  ensureSchema();
  const s = db.prepare('SELECT * FROM customer_extra_services WHERE id=?').get(Number(id));
  if (!s || !s.active) throw new Error('Servicio no encontrado o ya dado de baja');
  db.prepare("UPDATE customer_extra_services SET active=0, ended_at=datetime('now','localtime'), ended_reason=?, ended_by=? WHERE id=?")
    .run(String(reason || '').slice(0, 200), String(actor || '').slice(0, 80), s.id);
  event(s.customer_id, `${s.name} · ${money(s.price)}/mes`, `Baja${reason ? ': ' + reason : ''}` + (s.equipment ? ` · ${s.equipment} a retirar` : '') + (actor ? ` (por ${actor})` : ''));
}

/** Al cancelar el servicio del cliente: se dan de baja todos sus adicionales. */
function endAllFor(customerId, reason, actor) {
  ensureSchema();
  const list = forCustomer(customerId);
  for (const s of list) end(s.id, reason || 'Cancelación del servicio', actor);
  return list.length;
}

/** Equipos en comodato de los adicionales activos (para el retiro). */
function equipmentFor(customerId) {
  ensureSchema();
  return forCustomer(customerId).filter(s => s.equipment).map(s => ({ name: s.name, equipment: s.equipment, serial: s.serial }));
}

/** Para la factura: suma y detalle de los adicionales activos. */
function forInvoice(customerId) {
  const list = forCustomer(customerId);
  return { total: list.reduce((a, s) => a + (Number(s.price) || 0), 0), parts: list.map(s => `${s.name} ${money(s.price)}`) };
}

module.exports = { ensureSchema, catalog, saveCatalog, forCustomer, monthlyTotal, add, update, end, endAllFor, equipmentFor, forInvoice };
