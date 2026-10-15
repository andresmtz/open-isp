'use strict';
/**
 * Equipo del cliente: ONU actual e historial de equipos (con la foto de la etiqueta), y el WiFi guardado en la ficha.
 *
 *  - customer_equipment: una fila por ONU que tuvo el cliente (activa | retirada), con MAC, modelo, posición en la OLT,
 *    foto de la etiqueta (customer_documents), fechas, motivo del cambio, quién lo hizo y la orden de trabajo.
 *  - customers.wifi_ssid / wifi_key: el WiFi vigente del cliente. Se guarda en cada cambio (instalación, portal, oficina)
 *    y se toma una foto inicial de las ONU compatibles. Sirve para configurar una ONU de reemplazo aunque la vieja
 *    ya no encienda.
 *  - Cargo opcional por un cambio de equipo: se suma a la próxima factura (customers.carry_over).
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS customer_equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, olt_id INTEGER, onu_ref TEXT, mac TEXT, type TEXT,
    label_doc_id INTEGER, status TEXT NOT NULL DEFAULT 'activa', installed_at TEXT DEFAULT (NOW_LOCAL()), installed_by TEXT,
    removed_at TEXT, removed_reason TEXT, removed_by TEXT, ticket_id INTEGER, notes TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_customer_equipment_c ON customer_equipment(customer_id, status)');
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  for (const [c, t] of [['wifi_ssid', 'TEXT'], ['wifi_key', 'TEXT'], ['wifi_updated_at', 'TEXT'], ['carry_over', 'INTEGER DEFAULT 0']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE customers ADD COLUMN ${c} ${t}`);
  }
  _schemaOk = true;
}

/** Registro inicial: cada ONU ya vinculada en el inventario pasa a ser el equipo activo de su cliente (sin foto). */
function backfill() {
  ensureSchema();
  const rows = db.prepare(`SELECT i.* , c.install_date FROM onu_inventory i JOIN customers c ON c.id = i.customer_id
    WHERE NOT EXISTS (SELECT 1 FROM customer_equipment e WHERE e.customer_id = i.customer_id AND e.status = 'activa')`).all();
  const ins = db.prepare(`INSERT INTO customer_equipment (customer_id, olt_id, onu_ref, mac, type, status, installed_at, installed_by, notes)
    VALUES (?,?,?,?,?, 'activa', ?, 'registro inicial', 'Equipo existente al iniciar el registro de equipos')`);
  for (const r of rows) ins.run(r.customer_id, r.olt_id, r.onu_ref, r.mac, r.type, r.install_date ? `${r.install_date} 12:00` : null);
  return rows.length;
}

function latestLabelDoc(customerId) {
  try { return db.prepare("SELECT id FROM customer_documents WHERE customer_id=? AND kind='etiqueta' ORDER BY id DESC LIMIT 1").get(customerId) || null; } catch (_) { return null; }
}

/** Registra la ONU como equipo activo del cliente (retira la anterior si se indica). */
function attach(customerId, inv, { by = '', ticketId = null, labelDocId = null } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const doc = labelDocId || (latestLabelDoc(id) || {}).id || null;
  const ex = db.prepare("SELECT id FROM customer_equipment WHERE customer_id=? AND onu_ref=? AND olt_id IS ? AND status='activa'").get(id, inv.onu_ref, inv.olt_id);
  if (ex) { if (doc) db.prepare('UPDATE customer_equipment SET label_doc_id=COALESCE(label_doc_id, ?), mac=?, type=? WHERE id=?').run(doc, inv.mac, inv.type, ex.id); return ex.id; }
  return Number(db.prepare(`INSERT INTO customer_equipment (customer_id, olt_id, onu_ref, mac, type, label_doc_id, status, installed_by, ticket_id)
    VALUES (?,?,?,?,?,?, 'activa', ?, ?)`).run(id, inv.olt_id, inv.onu_ref, inv.mac, inv.type, doc, by, ticketId).lastInsertRowid);
}

function retire(equipmentId, { reason = '', by = '' } = {}) {
  ensureSchema();
  db.prepare("UPDATE customer_equipment SET status='retirada', removed_at=(NOW_LOCAL()), removed_reason=?, removed_by=? WHERE id=?").run(String(reason).slice(0, 200), by, equipmentId);
}

function current(customerId) {
  ensureSchema();
  return db.prepare("SELECT * FROM customer_equipment WHERE customer_id=? AND status='activa' ORDER BY id DESC LIMIT 1").get(Number(customerId)) || null;
}

function history(customerId) {
  ensureSchema();
  return db.prepare('SELECT * FROM customer_equipment WHERE customer_id=? ORDER BY id DESC').all(Number(customerId));
}

/** Guarda el WiFi vigente del cliente (se llama tras cada cambio verificado). */
function saveWifi(customerId, name, key) {
  ensureSchema();
  if (!name || !key) return;
  db.prepare('UPDATE customers SET wifi_ssid=?, wifi_key=?, wifi_updated_at=(NOW_LOCAL()) WHERE id=?').run(String(name), String(key), Number(customerId));
}

/** Foto inicial del WiFi: lee de la OLT las ONU compatibles de clientes que todavía no lo tienen guardado. */
async function snapshotWifi({ limit = 100 } = {}) {
  ensureSchema();
  const onu = require('./onuManageService');
  const rows = db.prepare(`SELECT DISTINCT c.id FROM customers c JOIN onu_inventory i ON i.customer_id = c.id
    WHERE i.compatible = 1 AND lower(i.status) = 'online' AND (c.wifi_ssid IS NULL OR c.wifi_ssid = '') LIMIT ?`).all(limit);
  let saved = 0;
  for (const r of rows) {
    try {
      const d = await onu.readDetail(r.id, { includeKeys: true });
      if (d && d.ok && d.wifi24 && d.wifi24.name && d.wifi24.key) { saveWifi(r.id, d.wifi24.name, d.wifi24.key); saved++; }
    } catch (e) { logger.warn(`[Equipo] WiFi del cliente ${r.id}: ${e.message}`); }
  }
  if (rows.length) logger.info(`[Equipo] WiFi guardado en la ficha de ${saved} de ${rows.length} clientes`);
  return { checked: rows.length, saved };
}

/** Cargo opcional (ej. ONU dañada por el cliente): se suma a la próxima factura. */
function addCharge(customerId, amount, reason, by) {
  ensureSchema();
  const n = Math.round(Number(amount) || 0);
  if (n <= 0) throw new Error('Monto inválido');
  if (String(reason || '').trim().length < 3) throw new Error('Indicá el motivo del cargo.');
  db.prepare('UPDATE customers SET carry_over=COALESCE(carry_over,0)+? WHERE id=?').run(n, Number(customerId));
  try { db.prepare("INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (?, 'install', NULL, ?)").run(Number(customerId), `Cargo para la próxima factura: ${n} — ${reason} (por ${by})`); } catch (_) {}
  return { ok: true, amount: n };
}

module.exports = { ensureSchema, backfill, attach, retire, current, history, saveWifi, snapshotWifi, addCharge, latestLabelDoc };
