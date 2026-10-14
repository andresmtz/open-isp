/**
 * Cobros, pagos parciales, saldo a favor y anulación con reversión completa.
 *
 * Modelo
 *  - payment_receipts: cada cobro (monto recibido, medio, quién cobró) + foto del estado previo del cliente.
 *  - payment_allocations: a qué facturas se aplicó cada recibo (permite pagos parciales).
 *  - invoices.amount_paid: total aplicado a la factura; queda 'paid' cuando cubre el monto.
 *  - customers.credit_balance + credit_ledger: saldo a favor (sobrante de un cobro) y sus movimientos.
 *
 * Reglas
 *  - Un cobro se aplica a las facturas pendientes más antiguas primero; lo que sobra va a saldo a favor.
 *  - Al emitirse una factura, se descuenta automáticamente el saldo a favor (billing_auto_apply_credit).
 *  - Una factura con pago parcial sigue pendiente (y se corta según el ciclo) hasta cubrir el total.
 *  - Anular un recibo revierte sus aplicaciones, el saldo a favor que generó/usó y el estado del cliente
 *    (corte, promesa, vencimiento prepago). Nada se borra: queda anulado con motivo, fecha y usuario.
 *  - Todas las vías de cobro existentes (caja, cobrador, app, bots, webhooks, auto-pagos) pasan por
 *    recordPayment() antes de marcar la factura pagada, así quedan registradas igual.
 */
const db = require('../config/database');
const cycle = require('../config/billingCycle');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS payment_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,        -- dinero recibido (0 si solo se usó saldo a favor)
    credit_used INTEGER NOT NULL DEFAULT 0,   -- saldo a favor consumido
    credit_added INTEGER NOT NULL DEFAULT 0,  -- sobrante que pasó a saldo a favor
    method TEXT DEFAULT '',
    paid_by TEXT DEFAULT '',
    note TEXT DEFAULT '',
    source TEXT DEFAULT 'manual',             -- manual | invoice | credit | legacy
    prev_customer_status TEXT,
    prev_promise_until TEXT,
    prev_expired_at TEXT,
    prev_unpaid_streak INTEGER,
    annulled_at TEXT,
    annul_reason TEXT,
    annulled_by TEXT,
    restored_status TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS payment_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER NOT NULL,
    invoice_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    prev_invoice_notes TEXT,
    prev_paid_at TEXT,
    prev_paid_by TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    receipt_id INTEGER,
    created_by TEXT DEFAULT ''
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON payment_allocations(invoice_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_alloc_receipt ON payment_allocations(receipt_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_customer ON payment_receipts(customer_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_credit_customer ON credit_ledger(customer_id)');
  try { db.exec('ALTER TABLE invoices ADD COLUMN amount_paid INTEGER DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE invoices ADD COLUMN payment_annulled_at TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE customers ADD COLUMN credit_balance INTEGER DEFAULT 0'); } catch (e) {}
  // Facturas pagadas antes de este registro (importadas, etc.): se consideran cubiertas por completo.
  db.exec("UPDATE invoices SET amount_paid = amount WHERE status='paid' AND COALESCE(amount_paid,0) = 0");
  _schemaOk = true;
}

const _cols = {};
function hasColumn(table, col) {
  if (!_cols[table]) _cols[table] = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
  return _cols[table].has(col);
}

function balanceOf(inv) { return Math.max(0, (Number(inv.amount) || 0) - (Number(inv.amount_paid) || 0)); }

function creditOf(customerId) {
  ensureSchema();
  const r = db.prepare('SELECT COALESCE(credit_balance,0) b FROM customers WHERE id=?').get(customerId);
  return r ? Number(r.b) || 0 : 0;
}

/** Deuda real del cliente: saldo pendiente de cada factura impaga (descuenta pagos parciales). */
function debtOf(customerId) {
  ensureSchema();
  const rows = db.prepare("SELECT id, period_month, period_year, amount, COALESCE(amount_paid,0) amount_paid FROM invoices WHERE customer_id=? AND status='unpaid' ORDER BY period_year, period_month, id").all(customerId);
  const items = rows.map(r => ({ id: r.id, period: `${r.period_month}/${r.period_year}`, amount: r.amount, paid: r.amount_paid, balance: balanceOf(r) }));
  return { count: items.length, total: items.reduce((s, i) => s + i.balance, 0), items, credit: creditOf(customerId) };
}

function snapshotCustomer(customerId) {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId) || {};
  return {
    prev_customer_status: c.status || null, prev_promise_until: c.promise_until || null,
    prev_expired_at: c.expired_at || null, prev_unpaid_streak: c.unpaid_streak == null ? null : Number(c.unpaid_streak),
  };
}

function insertReceipt(customerId, data) {
  const snap = snapshotCustomer(customerId);
  const r = db.prepare(`INSERT INTO payment_receipts (customer_id, created_at, amount, credit_used, credit_added, method, paid_by, note, source,
      prev_customer_status, prev_promise_until, prev_expired_at, prev_unpaid_streak) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(customerId, cycle.nowStamp(), data.amount || 0, data.credit_used || 0, data.credit_added || 0, data.method || '', data.paid_by || '',
      String(data.note || '').slice(0, 300), data.source || 'manual', snap.prev_customer_status, snap.prev_promise_until, snap.prev_expired_at, snap.prev_unpaid_streak);
  return Number(r.lastInsertRowid);
}

function moveCredit(customerId, delta, reason, receiptId, by) {
  if (!delta) return;
  const after = creditOf(customerId) + delta;
  db.prepare('UPDATE customers SET credit_balance=? WHERE id=?').run(after, customerId);
  db.prepare('INSERT INTO credit_ledger (customer_id, created_at, delta, balance_after, reason, receipt_id, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(customerId, cycle.nowStamp(), delta, after, reason, receiptId || null, by || '');
}

/** Aplica 'amount' a una factura dentro de un recibo. Marca pagada si queda cubierta. */
function allocate(receiptId, inv, amount, paidBy, note) {
  db.prepare('INSERT INTO payment_allocations (receipt_id, invoice_id, amount, prev_invoice_notes, prev_paid_at, prev_paid_by) VALUES (?,?,?,?,?,?)')
    .run(receiptId, inv.id, amount, inv.notes || '', inv.paid_at || null, inv.paid_by_name || '');
  const paid = (Number(inv.amount_paid) || 0) + amount;
  if (paid >= (Number(inv.amount) || 0)) {
    const notes = note ? (inv.notes ? `${inv.notes} | ${note}` : note) : (inv.notes || '');
    db.prepare("UPDATE invoices SET amount_paid=?, status='paid', paid_at=NOW_LOCAL(), paid_by_name=?, notes=? WHERE id=?").run(paid, paidBy || 'Admin', notes, inv.id);
    return true;
  }
  const partial = `Pago parcial ${cycle.nowStamp()}: ${amount} (${paidBy || 'Admin'})`;
  db.prepare('UPDATE invoices SET amount_paid=?, notes=? WHERE id=?').run(paid, inv.notes ? `${inv.notes} | ${partial}` : partial, inv.id);
  return false;
}

/**
 * Hook para las vías de cobro existentes: llamar ANTES de marcar la factura como pagada.
 * Registra un recibo por el saldo pendiente de la factura. No falla nunca (no debe frenar un cobro).
 */
function recordPayment(invoiceId, paidBy) {
  try {
    ensureSchema();
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
    if (!inv || inv.status === 'paid') return;
    const due = balanceOf(inv);
    const rid = insertReceipt(inv.customer_id, { amount: due, paid_by: paidBy, source: 'invoice', method: '' });
    db.prepare('INSERT INTO payment_allocations (receipt_id, invoice_id, amount, prev_invoice_notes, prev_paid_at, prev_paid_by) VALUES (?,?,?,?,?,?)')
      .run(rid, inv.id, due, inv.notes || '', inv.paid_at || null, inv.paid_by_name || '');
    // La vía de cobro marca 'paid' a continuación; acá solo dejamos el total aplicado.
    db.prepare('UPDATE invoices SET amount_paid=amount WHERE id=?').run(inv.id);
  } catch (e) {
    try { logger.warn('[Pagos] No se pudo registrar el cobro: ' + e.message); } catch (_) {}
  }
}

/**
 * Cobro de un monto libre: cubre facturas pendientes (más antiguas primero, o las indicadas primero)
 * y el sobrante queda como saldo a favor. Con useCredit también consume el saldo a favor.
 */
function receive(customerId, { amount, method, note, paidBy, invoiceIds, useCredit = false } = {}) {
  ensureSchema();
  const cid = Number(customerId);
  const c = db.prepare('SELECT id, name, status FROM customers WHERE id=?').get(cid);
  if (!c) throw new Error('Cliente no encontrado');
  const cash = Math.round(Number(amount) || 0);
  if (cash < 0) throw new Error('Monto inválido');
  const credit = useCredit ? creditOf(cid) : 0;
  if (cash <= 0 && credit <= 0) throw new Error('Ingresá un monto mayor a cero.');

  let pending = db.prepare("SELECT * FROM invoices WHERE customer_id=? AND status='unpaid' ORDER BY period_year, period_month, id").all(cid);
  if (Array.isArray(invoiceIds) && invoiceIds.length) {
    const want = new Set(invoiceIds.map(Number));
    pending = pending.filter(i => want.has(i.id)).concat(pending.filter(i => !want.has(i.id)));
  }

  const result = { receiptId: null, applied: [], fullyPaid: [], creditUsed: 0, creditAdded: 0, customer: c };
  db.transaction(() => {
    const rid = insertReceipt(cid, { amount: cash, method, paid_by: paidBy, note, source: cash ? 'manual' : 'credit' });
    result.receiptId = rid;
    let available = cash + credit;
    for (const inv of pending) {
      if (available <= 0) break;
      const due = balanceOf(inv);
      if (due <= 0) continue;
      const part = Math.min(due, available);
      const full = allocate(rid, inv, part, paidBy, note ? `Cobro #${rid}: ${note}` : `Cobro #${rid}`);
      available -= part;
      result.applied.push({ invoiceId: inv.id, period: `${inv.period_month}/${inv.period_year}`, amount: part, full, remaining: due - part });
      if (full) result.fullyPaid.push(inv.id);
    }
    // Lo aplicado sale primero del efectivo; el saldo a favor cubre el resto. El sobrante de efectivo va a saldo.
    const appliedTotal = (cash + credit) - available;
    result.creditUsed = Math.max(0, appliedTotal - cash);
    result.creditAdded = Math.max(0, cash - appliedTotal);
    if (result.creditUsed) moveCredit(cid, -result.creditUsed, `Usado en cobro #${rid}`, rid, paidBy);
    if (result.creditAdded) moveCredit(cid, result.creditAdded, `Sobrante del cobro #${rid}`, rid, paidBy);
    db.prepare('UPDATE payment_receipts SET credit_used=?, credit_added=? WHERE id=?').run(result.creditUsed, result.creditAdded, rid);
  })();
  if (result.fullyPaid.length && hasColumn('customers', 'unpaid_streak')) {
    try { db.prepare('UPDATE customers SET unpaid_streak=0 WHERE id=?').run(cid); } catch (e) {}
  }
  return result;
}

/** Descuenta el saldo a favor de las facturas pendientes (se usa al emitir facturas). */
function applyCredit(customerId, paidBy) {
  ensureSchema();
  const on = getSetting('billing_auto_apply_credit', true);
  if (on === false || on === 'false') return null;
  if (creditOf(customerId) <= 0) return null;
  if (!debtOf(customerId).count) return null;
  return receive(customerId, { amount: 0, useCredit: true, paidBy: paidBy || 'Saldo a favor', method: 'saldo a favor', note: 'Aplicación automática de saldo a favor' });
}

/** Ajuste manual del saldo a favor (positivo o negativo), con motivo. */
function adjustCredit(customerId, delta, reason, by) {
  ensureSchema();
  const d = Math.round(Number(delta) || 0);
  if (!d) throw new Error('Monto inválido');
  if (String(reason || '').trim().length < 3) throw new Error('El motivo es obligatorio.');
  if (creditOf(customerId) + d < 0) throw new Error('El saldo a favor no puede quedar negativo.');
  db.transaction(() => moveCredit(customerId, d, 'Ajuste manual: ' + String(reason).trim(), null, by))();
  return { balance: creditOf(customerId) };
}

/* ───────────────────────── Anulación ───────────────────────── */

const LABELS = { active: 'Activo', suspended: 'Cortado', ditangguhkan: 'Habilitado con promesa', cancelled: 'Cancelado', inactive: 'Inactivo' };

function lastReceiptForInvoice(invoiceId) {
  ensureSchema();
  return db.prepare(`SELECT r.* FROM payment_receipts r JOIN payment_allocations a ON a.receipt_id=r.id
    WHERE a.invoice_id=? AND r.annulled_at IS NULL ORDER BY r.id DESC LIMIT 1`).get(invoiceId) || null;
}

/** Vista previa de anular el último cobro que tocó la factura (o el recibo indicado). */
function preview(invoiceId, receiptId) {
  ensureSchema();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
  if (!inv) throw new Error('Factura no encontrada');
  const rec = receiptId ? db.prepare('SELECT * FROM payment_receipts WHERE id=? AND annulled_at IS NULL').get(receiptId) : lastReceiptForInvoice(inv.id);
  if (!rec && inv.status !== 'paid') throw new Error('La factura no tiene pagos para anular.');
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(inv.customer_id);
  const now = cycle.nowStamp();
  const warnings = [];
  let target, allocations, blocked = '';

  if (rec) {
    allocations = db.prepare('SELECT a.*, i.period_month, i.period_year FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE a.receipt_id=?').all(rec.id)
      .map(a => ({ invoiceId: a.invoice_id, period: `${a.period_month}/${a.period_year}`, amount: a.amount }));
    target = rec.prev_customer_status || c.status;
    const later = db.prepare('SELECT id FROM payment_receipts WHERE customer_id=? AND id>? AND annulled_at IS NULL').all(c.id, rec.id);
    if (later.length) warnings.push(`Hay ${later.length} cobro(s) posteriores de este cliente (#${later.map(l => l.id).join(', #')}). No se modifican.`);
    const laterInv = db.prepare('SELECT COUNT(*) n FROM invoices WHERE customer_id=? AND created_at > ?').get(c.id, rec.created_at).n;
    if (laterInv) warnings.push(`Se emitieron ${laterInv} factura(s) después de este cobro.`);
    if (rec.credit_added && creditOf(c.id) < rec.credit_added) {
      blocked = `Este cobro generó ${rec.credit_added} de saldo a favor y ya se usó (saldo actual ${creditOf(c.id)}). Anulá primero el cobro que usó ese saldo.`;
    }
    if (target === 'ditangguhkan' && rec.prev_promise_until && rec.prev_promise_until <= now) {
      warnings.push(`La promesa que tenía (hasta ${rec.prev_promise_until}) ya venció: el cliente quedará CORTADO.`);
      target = 'suspended';
    }
  } else {
    allocations = [{ invoiceId: inv.id, period: `${inv.period_month}/${inv.period_year}`, amount: inv.amount }];
    const cutPassed = cycle.cutStampFor(inv.period_year, inv.period_month, c) <= now;
    target = (cutPassed && Number(c.auto_isolate) !== 0) ? 'suspended' : c.status;
    warnings.push('Pago sin registro de cobro (importado o anterior a esta función): el estado se estima según la fecha de corte de la factura.');
  }
  if (c.status === 'cancelled') { warnings.push('El cliente está CANCELADO: solo se revierten los montos, no se toca el servicio.'); target = 'cancelled'; }

  return {
    receipt: rec ? { id: rec.id, created_at: rec.created_at, amount: rec.amount, credit_used: rec.credit_used, credit_added: rec.credit_added, paid_by: rec.paid_by, method: rec.method } : null,
    invoice: { id: inv.id, period: `${inv.period_month}/${inv.period_year}`, amount: inv.amount, paid_at: inv.paid_at, paid_by: inv.paid_by_name },
    allocations,
    customer: { id: c.id, name: c.name, status: c.status, credit: creditOf(c.id) },
    target, targetLabel: LABELS[target] || target, currentLabel: LABELS[c.status] || c.status,
    networkChange: c.status !== 'cancelled' && ((target === 'suspended') !== (c.status === 'suspended')),
    restorePromise: rec && target === 'ditangguhkan' ? rec.prev_promise_until : null,
    warnings, blocked, hasSnapshot: !!rec,
  };
}

async function annul(invoiceId, { reason, actor, receiptId } = {}) {
  ensureSchema();
  const why = String(reason || '').trim();
  if (why.length < 3) throw new Error('El motivo es obligatorio.');
  const pv = preview(invoiceId, receiptId);
  if (pv.blocked) throw new Error(pv.blocked);
  const who = (actor && actor.name) || 'admin';
  const now = cycle.nowStamp();
  const cid = pv.customer.id;
  const rec = pv.receipt ? db.prepare('SELECT * FROM payment_receipts WHERE id=?').get(pv.receipt.id) : null;
  const tag = rec ? `Cobro #${rec.id} anulado` : 'Pago anulado';
  const annulNote = (paidAt, paidBy) => `${tag} ${now} por ${who}: ${why} (antes: pagado ${paidAt || ''} por ${paidBy || '-'})`;

  db.transaction(() => {
    if (rec) {
      const allocs = db.prepare('SELECT * FROM payment_allocations WHERE receipt_id=?').all(rec.id);
      for (const a of allocs) {
        const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(a.invoice_id);
        if (!inv) continue;
        const paid = Math.max(0, (Number(inv.amount_paid) || 0) - a.amount);
        const note = annulNote(inv.paid_at, inv.paid_by_name || rec.paid_by);
        if (inv.status === 'void' || (inv.status === 'paid' && paid >= inv.amount)) {
          db.prepare('UPDATE invoices SET amount_paid=?, notes=? WHERE id=?').run(paid, inv.notes ? `${inv.notes} | ${note}` : note, inv.id);
        } else {
          const base = a.prev_invoice_notes || '';
          db.prepare("UPDATE invoices SET status='unpaid', amount_paid=?, paid_at=?, paid_by_name=?, notes=?, payment_annulled_at=? WHERE id=?")
            .run(paid, paid > 0 ? a.prev_paid_at : null, paid > 0 ? (a.prev_paid_by || '') : '', base ? `${base} | ${note}` : note, now, inv.id);
        }
      }
      if (rec.credit_added) moveCredit(cid, -rec.credit_added, `Anulación del cobro #${rec.id}`, rec.id, who);
      if (rec.credit_used) moveCredit(cid, rec.credit_used, `Devolución por anulación del cobro #${rec.id}`, rec.id, who);
      db.prepare('UPDATE payment_receipts SET annulled_at=?, annul_reason=?, annulled_by=?, restored_status=? WHERE id=?').run(now, why, who, pv.target, rec.id);
      if (hasColumn('customers', 'expired_at')) db.prepare('UPDATE customers SET expired_at=? WHERE id=?').run(rec.prev_expired_at, cid);
      if (hasColumn('customers', 'unpaid_streak') && rec.prev_unpaid_streak != null) db.prepare('UPDATE customers SET unpaid_streak=? WHERE id=?').run(rec.prev_unpaid_streak, cid);
      db.prepare("UPDATE collector_payment_requests SET decided_note = TRIM(COALESCE(decided_note,'') || ' | ' || ?) WHERE status='approved' AND invoice_id IN (SELECT invoice_id FROM payment_allocations WHERE receipt_id=?)")
        .run(`${tag}: ${why}`, rec.id);
    } else {
      const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId);
      const note = annulNote(inv.paid_at, inv.paid_by_name);
      db.prepare("UPDATE invoices SET status='unpaid', amount_paid=0, paid_at=NULL, paid_by_name='', notes=?, payment_annulled_at=? WHERE id=?")
        .run(inv.notes ? `${inv.notes} | ${note}` : note, now, inv.id);
      const rid = insertReceipt(cid, { amount: inv.amount, paid_by: inv.paid_by_name, source: 'legacy', note: 'Pago previo al registro de cobros' });
      db.prepare('INSERT INTO payment_allocations (receipt_id, invoice_id, amount) VALUES (?,?,?)').run(rid, inv.id, inv.amount);
      db.prepare('UPDATE payment_receipts SET annulled_at=?, annul_reason=?, annulled_by=?, restored_status=? WHERE id=?').run(now, why, who, pv.target, rid);
    }
  })();

  // Servicio: volver al estado previo
  const customerSvc = require('./customerService');
  const promiseSvc = require('./promiseService');
  let network = 'sin cambios';
  const cur = db.prepare('SELECT status FROM customers WHERE id=?').get(cid).status;
  try {
    if (pv.target === 'suspended' && cur !== 'suspended' && cur !== 'cancelled') {
      await customerSvc.suspendCustomer(cid);
      promiseSvc.close(cid, 'broken');
      network = 'cortado nuevamente';
    } else if (pv.target === 'ditangguhkan' && pv.restorePromise) {
      if (cur === 'suspended') await customerSvc.activateCustomer(cid, 'ditangguhkan');
      promiseSvc.ensureSchema();
      const last = db.prepare('SELECT id FROM payment_promises WHERE customer_id=? AND until=? ORDER BY id DESC LIMIT 1').get(cid, pv.restorePromise);
      if (last) db.prepare("UPDATE payment_promises SET status='active', closed_at=NULL WHERE id=?").run(last.id);
      db.prepare("UPDATE customers SET status='ditangguhkan', promise_until=? WHERE id=?").run(pv.restorePromise, cid);
      network = `promesa restaurada hasta ${pv.restorePromise}`;
    } else if (pv.target === 'active' && cur === 'suspended') {
      await customerSvc.activateCustomer(cid, 'active');
      network = 'habilitado (estaba activo antes del cobro)';
    }
  } catch (e) {
    network = 'ERROR al aplicar en la red: ' + e.message + ' — revisá el estado del cliente';
    logger.error(`[Pagos] Anulación factura ${invoiceId}: ${e.message}`);
  }

  try {
    require('./auditTrailService').logAuditTrail({
      action: 'ANNUL_PAYMENT', entity_type: 'invoice', entity_id: String(invoiceId),
      actor_type: (actor && actor.type) || 'admin', actor_name: who,
      details: { customer_id: cid, receipt: pv.receipt && pv.receipt.id, allocations: pv.allocations, reason: why, restored: pv.target, network, warnings: pv.warnings },
      ip_address: (actor && actor.ip) || null,
    });
  } catch (e) {}
  return { ok: true, restored: pv.target, restoredLabel: pv.targetLabel, network, warnings: pv.warnings, allocations: pv.allocations };
}

function receipts(customerId) {
  ensureSchema();
  return db.prepare('SELECT * FROM payment_receipts WHERE customer_id=? ORDER BY id DESC').all(customerId).map(r => ({
    ...r,
    allocations: db.prepare('SELECT a.invoice_id, a.amount, i.period_month, i.period_year FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE a.receipt_id=?').all(r.id),
  }));
}

function creditHistory(customerId) {
  ensureSchema();
  return db.prepare('SELECT * FROM credit_ledger WHERE customer_id=? ORDER BY id DESC').all(customerId);
}

module.exports = {
  ensureSchema, recordPayment, receive, applyCredit, adjustCredit, debtOf, creditOf,
  preview, annul, receipts, creditHistory, lastReceiptForInvoice,
};
