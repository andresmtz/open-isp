/**
 * Anulación de pagos con reversión completa.
 *
 * Cada vez que una factura pasa a pagada se guarda una "foto" del estado previo del cliente
 * (estado, promesa, vencimiento prepago, racha de impagos, notas de la factura) en payment_log.
 * Al anular el pago se restaura exactamente ese estado: si el pago lo había habilitado, se vuelve
 * a cortar; si estaba con promesa vigente, recupera la promesa; si estaba activo, sigue activo.
 * Se avisa si hubo movimientos posteriores (otros pagos, facturas nuevas, cancelación).
 * El registro del pago no se borra: queda marcado como anulado con motivo, fecha y usuario.
 */
const db = require('../config/database');
const cycle = require('../config/billingCycle');
const { logger } = require('../config/logger');

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS payment_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    amount INTEGER DEFAULT 0,
    paid_by TEXT DEFAULT '',
    prev_customer_status TEXT,
    prev_promise_until TEXT,
    prev_expired_at TEXT,
    prev_unpaid_streak INTEGER,
    prev_invoice_notes TEXT,
    annulled_at TEXT,
    annul_reason TEXT,
    annulled_by TEXT,
    restored_status TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_payment_log_invoice ON payment_log(invoice_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payment_log_customer ON payment_log(customer_id)');
  try { db.exec('ALTER TABLE invoices ADD COLUMN payment_annulled_at TEXT'); } catch (e) {}
  _schemaOk = true;
}

const _cols = {};
function hasColumn(table, col) {
  if (!_cols[table]) _cols[table] = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
  return _cols[table].has(col);
}

/** Llamar ANTES de marcar la factura como pagada. No falla nunca (no debe frenar un cobro). */
function recordPayment(invoiceId, paidBy) {
  try {
    ensureSchema();
    const inv = db.prepare('SELECT id, customer_id, amount, status, notes FROM invoices WHERE id=?').get(invoiceId);
    if (!inv || inv.status === 'paid') return;
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(inv.customer_id) || {};
    db.prepare(`INSERT INTO payment_log (invoice_id, customer_id, paid_at, amount, paid_by, prev_customer_status, prev_promise_until,
      prev_expired_at, prev_unpaid_streak, prev_invoice_notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(inv.id, inv.customer_id, cycle.nowStamp(), Number(inv.amount) || 0, paidBy || '', c.status || null,
        c.promise_until || null, c.expired_at || null, c.unpaid_streak == null ? null : Number(c.unpaid_streak), inv.notes || '');
  } catch (e) {
    try { logger.warn('[Pagos] No se pudo registrar el estado previo del pago: ' + e.message); } catch (_) {}
  }
}

function lastPayment(invoiceId) {
  ensureSchema();
  return db.prepare('SELECT * FROM payment_log WHERE invoice_id=? AND annulled_at IS NULL ORDER BY id DESC LIMIT 1').get(invoiceId) || null;
}

/** Estado al que volvería el cliente, más advertencias. */
function preview(invoiceId) {
  ensureSchema();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  if (!inv) throw new Error('Factura no encontrada');
  if (inv.status !== 'paid') throw new Error('La factura no está pagada.');
  const c = db.prepare('SELECT id, name, status, promise_until, auto_isolate, isolate_day FROM customers WHERE id=?').get(inv.customer_id);
  if (!c) throw new Error('Cliente no encontrado');
  const snap = lastPayment(inv.id);
  const warnings = [];
  const now = cycle.nowStamp();
  let target;

  if (snap) {
    target = snap.prev_customer_status || c.status;
    const laterPays = db.prepare(`SELECT l.paid_at, l.amount, i.period_month m, i.period_year y FROM payment_log l JOIN invoices i ON i.id=l.invoice_id
      WHERE l.customer_id=? AND l.id>? AND l.annulled_at IS NULL`).all(c.id, snap.id);
    if (laterPays.length) warnings.push(`Hay ${laterPays.length} pago(s) posteriores de este cliente: ` + laterPays.map(p => `${p.m}/${p.y} (${p.paid_at})`).join(', ') + '. No se modifican.');
    const laterInv = db.prepare("SELECT COUNT(*) n FROM invoices WHERE customer_id=? AND id<>? AND created_at > ?").get(c.id, inv.id, snap.paid_at).n;
    if (laterInv) warnings.push(`Se emitieron ${laterInv} factura(s) después de este pago.`);
    if (target === 'ditangguhkan' && snap.prev_promise_until && snap.prev_promise_until <= now) {
      warnings.push(`La promesa que tenía (hasta ${snap.prev_promise_until}) ya venció: el cliente quedará CORTADO.`);
      target = 'suspended';
    }
  } else {
    // Pago importado o anterior a este registro: se estima el estado según el corte de esa factura.
    const cutPassed = cycle.cutStampFor(inv.period_year, inv.period_month, c) <= now;
    target = (cutPassed && Number(c.auto_isolate) !== 0) ? 'suspended' : c.status;
    warnings.push('Pago sin estado previo registrado (importado o anterior a esta función): el estado se estima según la fecha de corte de la factura.');
  }
  if (c.status === 'cancelled') { warnings.push('El cliente está CANCELADO: solo se revierte la factura, no se toca el servicio.'); target = 'cancelled'; }

  const labels = { active: 'Activo', suspended: 'Cortado', ditangguhkan: 'Habilitado con promesa', cancelled: 'Cancelado', inactive: 'Inactivo' };
  return {
    invoice: { id: inv.id, period: `${inv.period_month}/${inv.period_year}`, amount: inv.amount, paid_at: inv.paid_at, paid_by: inv.paid_by_name },
    customer: { id: c.id, name: c.name, status: c.status },
    target, targetLabel: labels[target] || target, currentLabel: labels[c.status] || c.status,
    networkChange: target !== c.status && c.status !== 'cancelled',
    restorePromise: snap && target === 'ditangguhkan' ? snap.prev_promise_until : null,
    warnings, hasSnapshot: !!snap,
  };
}

async function annul(invoiceId, { reason, actor } = {}) {
  ensureSchema();
  const why = String(reason || '').trim();
  if (why.length < 3) throw new Error('El motivo es obligatorio.');
  const pv = preview(invoiceId);
  const snap = lastPayment(invoiceId);
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  const who = (actor && actor.name) || 'admin';
  const now = cycle.nowStamp();
  const annulNote = `Pago anulado ${now} por ${who}: ${why} (antes: pagado ${inv.paid_at || ''} por ${inv.paid_by_name || '-'})`;
  const baseNotes = snap ? (snap.prev_invoice_notes || '') : (inv.notes || '');

  // 1) Factura y datos del cliente (en una transacción)
  const tx = db.transaction(() => {
    db.prepare("UPDATE invoices SET status='unpaid', paid_at=NULL, paid_by_name='', notes=?, payment_annulled_at=? WHERE id=?")
      .run(baseNotes ? `${baseNotes} | ${annulNote}` : annulNote, now, inv.id);
    if (snap) {
      db.prepare('UPDATE payment_log SET annulled_at=?, annul_reason=?, annulled_by=?, restored_status=? WHERE id=?').run(now, why, who, pv.target, snap.id);
      if (hasColumn('customers', 'expired_at')) db.prepare('UPDATE customers SET expired_at=? WHERE id=?').run(snap.prev_expired_at, inv.customer_id);
      if (hasColumn('customers', 'unpaid_streak') && snap.prev_unpaid_streak != null) db.prepare('UPDATE customers SET unpaid_streak=? WHERE id=?').run(snap.prev_unpaid_streak, inv.customer_id);
    } else {
      db.prepare(`INSERT INTO payment_log (invoice_id, customer_id, paid_at, amount, paid_by, annulled_at, annul_reason, annulled_by, restored_status)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(inv.id, inv.customer_id, inv.paid_at || '', inv.amount, inv.paid_by_name || '', now, why, who, pv.target);
    }
    db.prepare("UPDATE collector_payment_requests SET decided_note = TRIM(COALESCE(decided_note,'') || ' | ' || ?) WHERE invoice_id=? AND status='approved'").run(annulNote, inv.id);
  });
  tx();

  // 2) Servicio: volver al estado previo
  const customerSvc = require('./customerService');
  const promiseSvc = require('./promiseService');
  let network = 'sin cambios';
  const cur = db.prepare('SELECT status FROM customers WHERE id=?').get(inv.customer_id).status;
  try {
    if (pv.target === 'suspended' && cur !== 'suspended' && cur !== 'cancelled') {
      await customerSvc.suspendCustomer(inv.customer_id);
      promiseSvc.close(inv.customer_id, 'broken');
      network = 'cortado nuevamente';
    } else if (pv.target === 'ditangguhkan' && pv.restorePromise) {
      if (cur === 'suspended') await customerSvc.activateCustomer(inv.customer_id, 'ditangguhkan');
      promiseSvc.ensureSchema();
      const last = db.prepare("SELECT id FROM payment_promises WHERE customer_id=? AND until=? ORDER BY id DESC LIMIT 1").get(inv.customer_id, pv.restorePromise);
      if (last) db.prepare("UPDATE payment_promises SET status='active', closed_at=NULL WHERE id=?").run(last.id);
      db.prepare("UPDATE customers SET status='ditangguhkan', promise_until=? WHERE id=?").run(pv.restorePromise, inv.customer_id);
      network = `promesa restaurada hasta ${pv.restorePromise}`;
    } else if (pv.target === 'active' && cur === 'suspended') {
      await customerSvc.activateCustomer(inv.customer_id, 'active');
      network = 'habilitado (estaba activo antes del pago)';
    }
  } catch (e) {
    network = 'ERROR al aplicar en la red: ' + e.message + ' — revisá el estado del cliente';
    logger.error(`[Pagos] Anulación factura ${inv.id}: ${e.message}`);
  }

  try {
    require('./auditTrailService').logAuditTrail({
      action: 'ANNUL_PAYMENT', entity_type: 'invoice', entity_id: String(inv.id),
      actor_type: (actor && actor.type) || 'admin', actor_name: who,
      details: { customer_id: inv.customer_id, period: pv.invoice.period, amount: inv.amount, reason: why, restored: pv.target, network, warnings: pv.warnings },
      ip_address: (actor && actor.ip) || null,
    });
  } catch (e) {}
  return { ok: true, restored: pv.target, restoredLabel: pv.targetLabel, network, warnings: pv.warnings };
}

function history(customerId) {
  ensureSchema();
  return db.prepare(`SELECT l.*, i.period_month, i.period_year FROM payment_log l JOIN invoices i ON i.id=l.invoice_id
    WHERE l.customer_id=? ORDER BY l.id DESC`).all(customerId);
}

module.exports = { ensureSchema, recordPayment, preview, annul, history, lastPayment };
