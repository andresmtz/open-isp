'use strict';
/**
 * Indicadores del negocio (solo administrador): crecimiento, bajas, cobro, ingreso promedio por cliente,
 * cobranza pendiente y zonas con más reclamos.
 *
 *  - Altas: clientes con fecha de instalación en el mes (no cuentan las solicitudes rechazadas o nunca instaladas).
 *  - Bajas: clientes cancelados en el mes (mismo criterio).
 *  - Activos al cierre del mes: instalados hasta ese mes y no cancelados antes de que termine.
 *  - Cobrado: facturas pagadas en el mes (monto cobrado). Facturado: facturas del período (sin anuladas).
 *  - Ingreso promedio por cliente: cobrado del mes / activos al cierre.
 *  - Zonas: puerto PON de la OLT donde está la ONU del cliente (hasta que se carguen las cajas NAP).
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');

const NEVER = "COALESCE(reg_cancel_reason,'') = ''"; // excluye solicitudes que nunca se instalaron

function months(n = 12) {
  const tz = getSetting('timezone', 'America/Asuncion');
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  let y = Number(p.year), m = Number(p.month);
  const out = [];
  for (let i = 0; i < n; i++) { out.unshift({ y, m, key: `${y}-${String(m).padStart(2, '0')}` }); m--; if (!m) { m = 12; y--; } }
  return out;
}
const endOf = (k) => { const [y, m] = k.split('-').map(Number); const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, '0')}-01`; };

function stats({ n = 12 } = {}) {
  const ms = months(n);
  const prev = months(n + 1)[0].key;
  const activeAt = (k) => db.prepare(`SELECT COUNT(*) n FROM customers WHERE ${NEVER} AND status != 'inactive'
    AND install_date IS NOT NULL AND install_date != '' AND install_date < ? AND (cancelled_at IS NULL OR cancelled_at = '' OR cancelled_at >= ?)`).get(endOf(k), endOf(k)).n;
  const rows = ms.map(({ y, m, key }) => {
    const altas = db.prepare(`SELECT COUNT(*) n FROM customers WHERE ${NEVER} AND status != 'inactive' AND substr(install_date,1,7)=?`).get(key).n;
    const bajas = db.prepare(`SELECT COUNT(*) n FROM customers WHERE ${NEVER} AND status='cancelled' AND substr(cancelled_at,1,7)=?`).get(key).n;
    const cobrado = db.prepare("SELECT COALESCE(SUM(COALESCE(amount_paid, amount)),0) s, COUNT(*) n FROM invoices WHERE status='paid' AND substr(paid_at,1,7)=?").get(key);
    const facturado = db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM invoices WHERE status != 'void' AND voided_at IS NULL AND period_year=? AND period_month=?").get(y, m);
    const pendiente = db.prepare("SELECT COALESCE(SUM(amount - COALESCE(amount_paid,0)),0) s FROM invoices WHERE status='unpaid' AND period_year=? AND period_month=?").get(y, m).s;
    const activos = activeAt(key);
    return { key, label: new Date(y, m - 1, 1).toLocaleDateString('es-PY', { month: 'short', year: '2-digit' }), altas, bajas, activos,
      cobrado: cobrado.s, pagos: cobrado.n, facturado: facturado.s, pendiente, arpu: activos ? Math.round(cobrado.s / activos) : 0 };
  });
  rows.forEach((r, i) => { const startActive = i ? rows[i - 1].activos : activeAt(prev); r.churn = startActive ? Math.round(1000 * r.bajas / startActive) / 10 : 0; });

  const year = rows.slice(-12);
  const totals = {
    activos: rows[rows.length - 1].activos,
    altas12: year.reduce((t, r) => t + r.altas, 0), bajas12: year.reduce((t, r) => t + r.bajas, 0),
    cobrado12: year.reduce((t, r) => t + r.cobrado, 0),
    arpu: rows[rows.length - 1].arpu || rows[rows.length - 2].arpu,
    churnAvg: Math.round(10 * year.reduce((t, r) => t + r.churn, 0) / year.length) / 10,
  };

  // Cobranza: deuda pendiente, promesas que vencen en 7 días
  const deuda = db.prepare(`SELECT COUNT(DISTINCT i.customer_id) clientes, COALESCE(SUM(i.amount - COALESCE(i.amount_paid,0)),0) total
    FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status='unpaid' AND c.status NOT IN ('cancelled','inactive')`).get();
  const in7 = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
  const promesas = db.prepare(`SELECT c.id, c.name, substr(c.promise_until,1,10) hasta, COALESCE(SUM(i.amount - COALESCE(i.amount_paid,0)),0) deuda
    FROM customers c JOIN invoices i ON i.customer_id = c.id AND i.status='unpaid'
    WHERE c.promise_until IS NOT NULL AND substr(c.promise_until,1,10) BETWEEN ? AND ? GROUP BY c.id ORDER BY c.promise_until`).all(today, in7);
  const porEstado = db.prepare(`SELECT c.status, COUNT(DISTINCT c.id) clientes, COALESCE(SUM(i.amount - COALESCE(i.amount_paid,0)),0) total
    FROM customers c JOIN invoices i ON i.customer_id = c.id AND i.status='unpaid' WHERE c.status NOT IN ('cancelled','inactive') GROUP BY c.status`).all();

  // Bajas por motivo (12 meses)
  const desde = ms[0].key + '-01';
  const motivos = db.prepare(`SELECT COALESCE(NULLIF(TRIM(cancel_reason),''),'Sin motivo cargado') motivo, COUNT(*) n FROM customers
    WHERE ${NEVER} AND status='cancelled' AND cancelled_at >= ? GROUP BY 1 ORDER BY n DESC`).all(desde);

  // Reclamos por zona (puerto PON) y clientes con más reclamos, últimos 90 días
  const d90 = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
  let zonas = [], topClientes = [];
  try {
    zonas = db.prepare(`SELECT COALESCE('EPON 0/' || o.port, 'Sin ONU asignada') zona, COUNT(t.id) reclamos, COUNT(DISTINCT t.customer_id) clientes,
        (SELECT COUNT(*) FROM onu_inventory o2 WHERE o2.port = o.port) equipos
      FROM tickets t LEFT JOIN onu_inventory o ON o.customer_id = t.customer_id
      WHERE substr(t.created_at,1,10) >= ? GROUP BY 1 ORDER BY reclamos DESC`).all(d90);
    topClientes = db.prepare(`SELECT c.id, c.name, COUNT(t.id) n FROM tickets t JOIN customers c ON c.id = t.customer_id
      WHERE substr(t.created_at,1,10) >= ? GROUP BY c.id HAVING n >= 2 ORDER BY n DESC LIMIT 8`).all(d90);
  } catch (_) {}

  return { rows, totals, deuda, promesas, porEstado, motivos, zonas, topClientes, months: n };
}

module.exports = { stats };
