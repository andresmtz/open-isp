/**
 * Cola de reintentos de acciones de red (MikroTik).
 *
 * Cuando cortar o habilitar a un cliente falla en el router (router caído, API sin respuesta, etc.),
 * el estado del cliente se guarda igual y la acción queda acá. Un cron la reintenta con espera
 * creciente hasta que el router la confirma.
 *  - Siempre se aplica el estado ACTUAL del cliente: si mientras tanto pagó o lo cortaron a mano,
 *    se reintenta lo que corresponde ahora (no la acción vieja).
 *  - Una sola acción pendiente por cliente (la nueva reemplaza a la anterior).
 *  - Tras MAX_ATTEMPTS queda como 'failed' y se muestra en Automatización → Cola de red para
 *    reintentarla a mano.
 *  - Con el MikroTik en solo lectura (migración) no se encola ni se reintenta nada.
 */
const db = require('../config/database');
const cycle = require('../config/billingCycle');
const { logger } = require('../config/logger');

const BACKOFF_MIN = [1, 2, 5, 10, 15, 30, 60]; // luego cada 60 min
const MAX_ATTEMPTS = 30;

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS network_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    action TEXT NOT NULL,                 -- suspend | activate
    status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | superseded
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    next_try_at TEXT NOT NULL,
    finished_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_netq_status ON network_actions(status, next_try_at)');
  _schemaOk = true;
}

function readOnly() {
  try { return require('./mikrotikService').isMikrotikReadOnly(); } catch (_) { return false; }
}

function stampIn(minutes) { return cycle.addDaysStamp(minutes / 1440); }

function enqueue(customerId, action, error) {
  ensureSchema();
  if (readOnly()) return null;
  const now = cycle.nowStamp();
  db.prepare("UPDATE network_actions SET status='superseded', finished_at=? WHERE customer_id=? AND status IN ('pending','failed')").run(now, customerId);
  const r = db.prepare('INSERT INTO network_actions (customer_id, action, last_error, created_at, next_try_at) VALUES (?,?,?,?,?)')
    .run(customerId, action, String(error || '').slice(0, 500), now, stampIn(BACKOFF_MIN[0]));
  return Number(r.lastInsertRowid);
}

/** El router confirmó una acción para el cliente: lo pendiente queda resuelto. */
function resolved(customerId) {
  ensureSchema();
  db.prepare("UPDATE network_actions SET status='superseded', finished_at=? WHERE customer_id=? AND status IN ('pending','failed')").run(cycle.nowStamp(), customerId);
}

function desiredAction(status) {
  if (status === 'suspended' || status === 'isolated') return 'suspend';
  if (status === 'active' || status === 'ditangguhkan') return 'activate';
  return null; // cancelado / inactivo: nada que aplicar
}

async function runOne(row) {
  const cs = require('./customerService');
  const c = cs.getCustomerById(row.customer_id);
  const now = cycle.nowStamp();
  const want = c ? desiredAction(c.status) : null;
  if (!want) {
    db.prepare("UPDATE network_actions SET status='superseded', finished_at=?, last_error=? WHERE id=?").run(now, 'El cliente ya no requiere acción de red', row.id);
    return 'skipped';
  }
  const routerId = cs.getEffectiveRouterId ? cs.getEffectiveRouterId(c.router_id) : c.router_id;
  const attempts = row.attempts + 1;
  try {
    if (want === 'suspend') await cs.applySuspendNetwork(c, routerId);
    else await cs.applyActivateNetwork(c, routerId);
    db.prepare("UPDATE network_actions SET status='done', attempts=?, action=?, finished_at=?, last_error=NULL WHERE id=?").run(attempts, want, now, row.id);
    logger.info(`[Cola de red] ${c.name}: ${want === 'suspend' ? 'corte' : 'habilitación'} aplicada en el intento ${attempts}.`);
    return 'done';
  } catch (e) {
    const failed = attempts >= MAX_ATTEMPTS;
    const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)];
    db.prepare('UPDATE network_actions SET status=?, attempts=?, action=?, last_error=?, next_try_at=?, finished_at=? WHERE id=?')
      .run(failed ? 'failed' : 'pending', attempts, want, String(e.message || e).slice(0, 500), stampIn(wait), failed ? now : null, row.id);
    if (failed) logger.error(`[Cola de red] ${c.name}: se agotaron los reintentos (${attempts}). Último error: ${e.message}`);
    return failed ? 'failed' : 'retry';
  }
}

/** Procesa las acciones vencidas (cron). */
async function processDue(limit = 20) {
  ensureSchema();
  if (readOnly()) return { skipped: 'readonly' };
  const rows = db.prepare("SELECT * FROM network_actions WHERE status='pending' AND next_try_at <= ? ORDER BY next_try_at LIMIT ?").all(cycle.nowStamp(), limit);
  const out = { done: 0, retry: 0, failed: 0, skipped: 0 };
  for (const r of rows) out[await runOne(r)]++;
  return out;
}

/** Reintento manual inmediato (desde la pantalla). */
async function retryNow(id) {
  ensureSchema();
  if (readOnly()) throw new Error('El MikroTik está en modo solo lectura.');
  const row = db.prepare("SELECT * FROM network_actions WHERE id=? AND status IN ('pending','failed')").get(id);
  if (!row) throw new Error('La acción ya no está pendiente.');
  if (row.status === 'failed') { db.prepare("UPDATE network_actions SET status='pending', attempts=0 WHERE id=?").run(id); row.attempts = 0; }
  return runOne(row);
}

function list({ includeDone = false, limit = 100 } = {}) {
  ensureSchema();
  const where = includeDone ? '1=1' : "a.status IN ('pending','failed')";
  return db.prepare(`SELECT a.*, c.name customer_name, c.status customer_status FROM network_actions a LEFT JOIN customers c ON c.id=a.customer_id
    WHERE ${where} ORDER BY a.id DESC LIMIT ?`).all(limit);
}

function counts() {
  ensureSchema();
  const r = db.prepare("SELECT SUM(status='pending') pending, SUM(status='failed') failed FROM network_actions").get();
  return { pending: Number(r.pending) || 0, failed: Number(r.failed) || 0 };
}

module.exports = { ensureSchema, enqueue, resolved, processDue, retryNow, list, counts, MAX_ATTEMPTS };
