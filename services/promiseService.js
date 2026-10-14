/**
 * Promesa de pago: habilita a un cliente con deuda hasta una fecha límite.
 * - Si paga todo antes del vencimiento → promesa CUMPLIDA y vuelve a 'active'.
 * - Si vence con deuda → promesa INCUMPLIDA y se corta automáticamente.
 * Mientras dura, el cliente queda en estado 'ditangguhkan' (habilitado con deuda, sin corte automático).
 * Límites en Configuración → Automatización → Ciclo de facturación.
 */
const db = require('../config/database');
const cycle = require('../config/billingCycle');
const { logger } = require('../config/logger');

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  try { db.exec("ALTER TABLE customers ADD COLUMN promise_until TEXT"); } catch (e) {}
  db.exec(`CREATE TABLE IF NOT EXISTS payment_promises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    until TEXT NOT NULL,
    debt_amount INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    status TEXT DEFAULT 'active',   -- active | kept | broken | cancelled
    closed_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_promises_customer ON payment_promises(customer_id, status)');
  _schemaOk = true;
}

function debtOf(customerId) {
  const d = require('./paymentReversalService').debtOf(customerId);
  return { count: d.count, total: d.total };
}

function activePromise(customerId) {
  ensureSchema();
  return db.prepare("SELECT * FROM payment_promises WHERE customer_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(customerId) || null;
}

function history(customerId) {
  ensureSchema();
  return db.prepare('SELECT * FROM payment_promises WHERE customer_id=? ORDER BY id DESC').all(customerId);
}

function promisesThisMonth(customerId) {
  const n = cycle.nowLocal();
  const prefix = `${n.year}-${String(n.month).padStart(2, '0')}`;
  return db.prepare("SELECT COUNT(*) c FROM payment_promises WHERE customer_id=? AND substr(created_at,1,7)=? AND status!='cancelled'").get(customerId, prefix).c;
}

/** Datos para el formulario: deuda, límites y si se puede otorgar. */
function preview(customerId) {
  ensureSchema();
  const cfg = cycle.get();
  const c = db.prepare('SELECT id, name, status, promise_until FROM customers WHERE id=?').get(customerId);
  if (!c) throw new Error('Cliente no encontrado');
  const debt = debtOf(c.id);
  const used = promisesThisMonth(c.id);
  const active = activePromise(c.id);
  let blocked = '';
  if (c.status === 'cancelled') blocked = 'El cliente está cancelado.';
  else if (!debt.count) blocked = 'El cliente no tiene deuda pendiente.';
  else if (!active && cfg.promiseMaxPerMonth > 0 && used >= cfg.promiseMaxPerMonth) blocked = `Ya usó ${used} promesa(s) este mes (máximo ${cfg.promiseMaxPerMonth}).`;
  return {
    customer: c, debt, active, usedThisMonth: used, blocked,
    maxDays: cfg.promiseMaxDays, defaultDays: cfg.promiseDefaultDays, maxPerMonth: cfg.promiseMaxPerMonth,
  };
}

/**
 * Otorga (o extiende) una promesa. days ≤ promise_max_days.
 * Si el cliente estaba cortado, lo habilita en el MikroTik.
 */
async function grant(customerId, { days, until: untilText, note, actor } = {}) {
  ensureSchema();
  const cfg = cycle.get();
  const pv = preview(customerId);
  if (pv.blocked) throw new Error(pv.blocked);
  // Fecha y hora límite exacta ('DD/MM/AAAA HH:MM' o 'AAAA-MM-DD HH:MM'), o cantidad de días desde ahora.
  let until;
  let d;
  if (untilText) {
    until = parseLocalStamp(untilText);
    if (!until) throw new Error('Fecha límite inválida. Usá DD/MM/AAAA HH:MM.');
    if (until <= cycle.nowStamp()) throw new Error('La fecha límite ya pasó.');
    if (until > cycle.addDaysStamp(cfg.promiseMaxDays)) throw new Error(`La promesa no puede superar ${cfg.promiseMaxDays} días.`);
    d = null;
  } else {
    d = parseInt(days, 10) || cfg.promiseDefaultDays;
    if (d < 1 || d > cfg.promiseMaxDays) throw new Error(`La promesa debe ser de 1 a ${cfg.promiseMaxDays} días.`);
    until = cycle.addDaysStamp(d);
  }
  const c = pv.customer;

  if (c.status === 'suspended' || c.status === 'isolated') {
    const customerSvc = require('./customerService');
    await customerSvc.activateCustomer(c.id, 'ditangguhkan');
  } else if (c.status !== 'ditangguhkan') {
    db.prepare("UPDATE customers SET status='ditangguhkan' WHERE id=?").run(c.id);
  }

  const now = cycle.nowStamp();
  const tx = db.transaction(() => {
    if (pv.active) db.prepare("UPDATE payment_promises SET status='cancelled', closed_at=? WHERE id=?").run(now, pv.active.id);
    db.prepare('INSERT INTO payment_promises (customer_id, created_at, until, debt_amount, note, created_by) VALUES (?,?,?,?,?,?)')
      .run(c.id, now, until, pv.debt.total, String(note || '').slice(0, 300), (actor && actor.name) || '');
    db.prepare('UPDATE customers SET promise_until=? WHERE id=?').run(until, c.id);
  });
  tx();
  try {
    require('./auditTrailService').logAuditTrail({
      action: 'PAYMENT_PROMISE', entity_type: 'customer', entity_id: String(c.id),
      actor_type: (actor && actor.type) || 'admin', actor_name: (actor && actor.name) || null,
      details: { until, days: d, debt: pv.debt.total, note: note || '', extended: !!pv.active },
      ip_address: (actor && actor.ip) || null,
    });
  } catch (e) {}
  return { until, days: d, debt: pv.debt, extended: !!pv.active, wasSuspended: c.status === 'suspended' };
}

/** 'DD/MM/AAAA HH:MM' | 'AAAA-MM-DD HH:MM' | 'AAAA-MM-DDTHH:MM' → 'AAAA-MM-DD HH:MM' (hora local configurada) */
function parseLocalStamp(text) {
  const t = String(text || '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(t);
  let y, mo, da, h, mi;
  if (m) { da = +m[1]; mo = +m[2]; y = +m[3]; h = m[4] != null ? +m[4] : 23; mi = m[5] != null ? +m[5] : 59; }
  else {
    m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
    if (!m) return null;
    y = +m[1]; mo = +m[2]; da = +m[3]; h = m[4] != null ? +m[4] : 23; mi = m[5] != null ? +m[5] : 59;
  }
  if (mo < 1 || mo > 12 || da < 1 || da > cycle.daysInMonth(y, mo) || h > 23 || mi > 59) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(da)} ${p(h)}:${p(mi)}`;
}

/**
 * Registra una promesa ya otorgada en otro sistema (migración). No toca el router:
 * el cliente ya está habilitado allá. Idempotente por 'ref'.
 */
function importExisting(customerId, { createdAt, until, note, createdBy, ref, debt } = {}) {
  ensureSchema();
  const prev = ref ? db.prepare('SELECT id, status, until FROM payment_promises WHERE customer_id=? AND note LIKE ?').get(customerId, '%' + ref + '%') : null;
  if (prev) {
    if (prev.status !== 'active') return { skipped: 'ya importada (' + prev.status + ')' };
    if (prev.until === until) return { skipped: 'ya importada' };
    db.prepare('UPDATE payment_promises SET until=? WHERE id=?').run(until, prev.id);
    db.prepare('UPDATE customers SET promise_until=? WHERE id=?').run(until, customerId);
    return { updated: true, from: prev.until };
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE payment_promises SET status='cancelled', closed_at=? WHERE customer_id=? AND status='active'").run(cycle.nowStamp(), customerId);
    db.prepare('INSERT INTO payment_promises (customer_id, created_at, until, debt_amount, note, created_by) VALUES (?,?,?,?,?,?)')
      .run(customerId, createdAt || cycle.nowStamp(), until, debt || debtOf(customerId).total, [note, ref].filter(Boolean).join(' — '), createdBy || '');
    db.prepare("UPDATE customers SET status='ditangguhkan', promise_until=? WHERE id=?").run(until, customerId);
  });
  tx();
  return { imported: true };
}

function close(customerId, status) {
  ensureSchema();
  const now = cycle.nowStamp();
  db.prepare("UPDATE payment_promises SET status=?, closed_at=? WHERE customer_id=? AND status='active'").run(status, now, customerId);
  db.prepare('UPDATE customers SET promise_until=NULL WHERE id=?').run(customerId);
}

/**
 * Revisión periódica (cron): cierra promesas cumplidas y corta las vencidas con deuda.
 * Devuelve { kept, broken }.
 */
async function review() {
  ensureSchema();
  const now = cycle.nowStamp();
  const rows = db.prepare("SELECT id, name, promise_until FROM customers WHERE status='ditangguhkan'").all();
  let kept = 0, broken = 0;
  for (const c of rows) {
    const debt = debtOf(c.id);
    if (!debt.count) {
      db.prepare("UPDATE customers SET status='active' WHERE id=?").run(c.id);
      close(c.id, 'kept');
      kept++;
      continue;
    }
    if (!c.promise_until) continue; // habilitado con deuda sin promesa (legado): lo decide el corte normal
    if (c.promise_until <= now) {
      try {
        await require('./customerService').suspendCustomer(c.id);
        close(c.id, 'broken');
        broken++;
        logger.info(`[Promesa] Vencida con deuda → corte: ${c.name} (hasta ${c.promise_until})`);
      } catch (e) {
        logger.error(`[Promesa] No se pudo cortar a ${c.name}: ${e.message}`);
      }
    }
  }
  return { kept, broken };
}

module.exports = { ensureSchema, preview, grant, review, history, activePromise, close, parseLocalStamp, importExisting };
