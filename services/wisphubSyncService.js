'use strict';
/**
 * Sincronización WispHub → Open-ISP (migración).
 *
 * Lee la API oficial de WispHub (https://api.wisphub.net, cabecera "Authorization: Api-Key <clave>")
 * y actualiza la base de Open-ISP. NUNCA escribe en el MikroTik: solo en la base de datos.
 *
 *   - Planes      → packages (por nombre del plan)
 *   - Clientes    → customers (por id_servicio de WispHub; se omiten los cancelados)
 *   - Facturas    → invoices (por id de factura de WispHub; pendientes, pagadas y anuladas)
 *
 * Es idempotente: se puede ejecutar muchas veces; solo cambia lo que cambió en WispHub.
 * Con dryRun = true calcula los cambios sin escribir nada.
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const regional = require('../config/regional');

// ── Esquema: columnas para vincular registros con WispHub ──────────────────────
function ensureSchema() {
  const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(r => r.name);
  if (!cols('customers').includes('wisphub_id')) db.exec('ALTER TABLE customers ADD COLUMN wisphub_id INTEGER');
  if (!cols('invoices').includes('wisphub_invoice_id')) db.exec('ALTER TABLE invoices ADD COLUMN wisphub_invoice_id INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_wisphub_id ON customers(wisphub_id) WHERE wisphub_id IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_wisphub_id ON invoices(wisphub_invoice_id) WHERE wisphub_invoice_id IS NOT NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS customer_usage_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    bytes_in INTEGER DEFAULT 0,
    bytes_out INTEGER DEFAULT 0,
    source TEXT DEFAULT 'openisp',
    UNIQUE(customer_id, day)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS wisphub_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT, finished_at TEXT, dry_run INTEGER, ok INTEGER,
    summary TEXT, details TEXT
  )`);
}
ensureSchema();

// ── Cliente HTTP de la API ─────────────────────────────────────────────────────
function apiConfig() {
  const key = String(getSetting('wisphub_api_key', '') || '').trim();
  const base = String(getSetting('wisphub_api_url', 'https://api.wisphub.net') || 'https://api.wisphub.net').trim().replace(/\/+$/, '');
  if (!key) throw new Error('Falta la API key de WispHub (Configuración → Migración WispHub).');
  return { key, base };
}

async function apiGet(path, params = {}) {
  const { key, base } = apiConfig();
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Api-Key ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (revisá la API key y los permisos del usuario en WispHub)' : '';
    throw new Error(`WispHub ${res.status} en ${path}${hint}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); } catch (_) { throw new Error(`Respuesta no JSON de WispHub en ${path}`); }
}

/** Recorre todas las páginas (limit/offset) y devuelve todos los registros. */
async function apiGetAll(path, params = {}, pageSize = 200) {
  const out = [];
  for (let offset = 0, guard = 0; guard < 500; guard++) {
    const data = await apiGet(path, { ...params, limit: pageSize, offset });
    const rows = Array.isArray(data) ? data : (data.results || data.data || []);
    out.push(...rows);
    const total = Array.isArray(data) ? rows.length : Number(data.count || 0);
    offset += rows.length;
    if (!rows.length || Array.isArray(data) || (!data.next && (!total || offset >= total))) break;
  }
  return out;
}

// ── Utilidades de mapeo (tolerantes a variaciones de nombres de campo) ────────
const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
};
const str = (v) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };

/** "28/09/2026", "2026-09-28" o "2026-09-28T..." → {y, m, d} */
function parseDate(v) {
  const s = str(v);
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  return null;
}
const isoDate = (p) => (p ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null);

/**
 * Período facturado a partir de la fecha de emisión. En tu configuración de WispHub (prepago)
 * la factura se emite el día 28 del mes anterior: si el día de emisión es >= 20, corresponde al mes siguiente.
 */
function periodFromIssue(p) {
  if (!p) return null;
  let { y, m } = p;
  if (p.d >= Number(getSetting('wisphub_period_next_month_from_day', 20) || 20)) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return { month: m, year: y };
}

function mapStatus(estado) {
  const e = str(estado).toLowerCase();
  if (e.startsWith('activo') || e === '1') return 'active';
  if (e.startsWith('suspend') || e === '2') return 'suspended';
  if (e.startsWith('cancel') || e === '3') return 'cancelled';
  if (e.startsWith('gratis')) return 'active';
  return e || 'active';
}

function mapInvoiceStatus(estado) {
  const e = str(estado).toLowerCase();
  if (e === '2' || e.startsWith('pagad')) return 'paid';
  if (e === '3' || e.startsWith('cancel') || e === '5' || e.startsWith('se transfi')) return 'void';
  if (e === '1' || e.startsWith('pendiente') || e === '4' || e.startsWith('en revis')) return 'unpaid';
  return 'unpaid';
}

/** "PLAN180MB" → 180000 kbps (Open-ISP guarda kbps). */
function speedFromPlanName(name) {
  const m = String(name || '').match(/(\d+(?:[.,]\d+)?)\s*(G|M|K)?B?/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = (m[2] || 'M').toUpperCase();
  return Math.round(unit === 'G' ? n * 1e6 : unit === 'K' ? n : n * 1000);
}

// ── Sincronización ──────────────────────────────────────────────────────────────
async function run({ dryRun = true, invoicesMonths = 12, source = null } = {}) {
  const started = new Date().toISOString();
  const report = {
    dryRun, plans: { created: 0, updated: 0 }, customers: { created: 0, updated: 0, unchanged: 0, skippedCancelled: 0 },
    invoices: { created: 0, updated: 0, unchanged: 0, skippedNoCustomer: 0 }, warnings: [], sample: {}
  };
  const warn = (m) => { if (report.warnings.length < 200) report.warnings.push(m); };

  // 1) Clientes y planes
  // source: datos exportados desde la web de WispHub ({ clients, invoices }); si no, se usa la API
  const clients = source ? (source.clients || []) : await apiGetAll('/api/clientes/');
  report.sample.customerKeys = clients[0] ? Object.keys(clients[0]) : [];
  const routerRow = db.prepare('SELECT id FROM routers ORDER BY id LIMIT 1').get();
  const routerId = routerRow ? routerRow.id : null;

  const planOf = (c) => str(pick(c, 'plan_internet.nombre', 'plan_internet.name', 'plan_internet'));
  const priceOf = (c) => num(pick(c, 'plan_internet.precio', 'plan_internet__precio', 'precio_plan'));
  const plans = new Map();
  for (const c of clients) { const n = planOf(c); if (n && !plans.has(n)) plans.set(n, priceOf(c)); }

  const plannedCustomers = new Set(); // id_servicio que la simulación crearía
  const tx = db.transaction(() => {
    const pkgIdByName = new Map(db.prepare('SELECT id, name FROM packages').all().map(p => [p.name, p.id]));
    for (const [name, price] of plans) {
      const speed = speedFromPlanName(name);
      if (pkgIdByName.has(name)) {
        const cur = db.prepare('SELECT price FROM packages WHERE id = ?').get(pkgIdByName.get(name));
        if (price && cur && Number(cur.price) !== price) {
          report.plans.updated++;
          if (!dryRun) db.prepare('UPDATE packages SET price = ? WHERE id = ?').run(price, pkgIdByName.get(name));
        }
      } else {
        report.plans.created++;
        if (!dryRun) {
          const r = db.prepare(`INSERT INTO packages (name, price, speed_down, speed_up, description, billing_type, duration_days, is_active, router_id)
            VALUES (?, ?, ?, ?, ?, 'postpaid', 30, 1, ?)`).run(name, price || 0, speed, speed, 'Importado de WispHub', routerId);
          pkgIdByName.set(name, r.lastInsertRowid);
        } else pkgIdByName.set(name, -1);
      }
    }

    const { generateCustomerCode } = require('./customerIdService');
    const isolateDay = Number(getSetting('wisphub_isolate_day', 10) || 10);
    for (const c of clients) {
      const wid = num(pick(c, 'id_servicio', 'id'));
      if (!wid) { warn('Cliente sin id_servicio: omitido'); continue; }
      const status = mapStatus(pick(c, 'estado', 'estado_servicio'));
      if (status === 'cancelled') {
        // Cancelado en WispHub: no se importa; si ya estaba importado, pasa a "Cancelado"
        const prev = db.prepare('SELECT id, status FROM customers WHERE wisphub_id = ?').get(wid);
        if (prev && prev.status !== 'cancelled') { report.customers.updated++; if (!dryRun) db.prepare("UPDATE customers SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, NOW_LOCAL()), cancel_reason = COALESCE(NULLIF(cancel_reason, ''), 'Cancelado en WispHub'), auto_isolate = 0 WHERE id = ?").run(prev.id); }
        else report.customers.skippedCancelled++;
        continue;
      }

      const coords = str(pick(c, 'coordenadas')).split(',').map(s => s.trim());
      const addressParts = [pick(c, 'direccion', 'perfil.direccion', 'user__perfilusuario__direccion', 'usuario.direccion'), pick(c, 'localidad', 'user__perfilusuario__localidad'), pick(c, 'ciudad', 'user__perfilusuario__ciudad')].map(str).filter(Boolean);
      const data = {
        name: str(pick(c, 'nombre', 'usuario.nombre', 'cliente', 'user.first_name', 'user')) || `Cliente ${wid}`,
        phone: regional.toLocalPhone(str(pick(c, 'telefono', 'perfil.telefono', 'user__perfilusuario__telefono', 'usuario.telefono'))) || '',
        nik: str(pick(c, 'cedula', 'perfil.cedula', 'user__perfilusuario__cedula', 'usuario.cedula')),
        email: str(pick(c, 'email', 'user__email', 'usuario.email')),
        address: addressParts.join(', '),
        lat: coords.length === 2 && num(coords[0]) ? String(num(coords[0])) : '',
        lng: coords.length === 2 && num(coords[1]) ? String(num(coords[1])) : '',
        pppoe_username: str(pick(c, 'usuario_rb', 'cliente_rb', 'usuario_servicio', 'user__username')),
        pppoe_password: str(pick(c, 'password_servicio', 'password_rb')),
        pppoe_remote_address: str(pick(c, 'ip', 'ip_cliente')),
        mac_address: str(pick(c, 'mac_cpe')),
        package_id: pkgIdByName.get(planOf(c)) || null,
        status,
        install_date: isoDate(parseDate(pick(c, 'fecha_instalacion'))),
        notes: `WispHub #${wid}`
      };
      if (!data.pppoe_username) warn(`Cliente #${wid} (${data.name}) sin usuario PPPoE`);
      if (!data.phone) warn(`Cliente #${wid} (${data.name}) sin teléfono`);

      const existing = db.prepare('SELECT * FROM customers WHERE wisphub_id = ?').get(wid)
        || (data.pppoe_username ? db.prepare('SELECT * FROM customers WHERE pppoe_username = ? AND wisphub_id IS NULL').get(data.pppoe_username) : null);
      if (!existing) {
        report.customers.created++;
        plannedCustomers.add(wid);
        if (!dryRun) {
          db.prepare(`INSERT INTO customers (customer_code, wisphub_id, name, phone, nik, email, address, lat, lng, package_id, router_id,
              connection_type, pppoe_username, pppoe_password, pppoe_remote_address, mac_address, isolir_profile, status, install_date,
              notes, auto_isolate, isolate_day)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pppoe', ?, ?, ?, ?, 'isolir', ?, ?, ?, 1, ?)`)
            .run(generateCustomerCode(), wid, data.name, data.phone, data.nik, data.email, data.address, data.lat, data.lng, data.package_id, routerId,
              data.pppoe_username, data.pppoe_password, data.pppoe_remote_address, data.mac_address, data.status, data.install_date, data.notes, isolateDay);
        }
      } else {
        const fields = ['name', 'phone', 'nik', 'email', 'address', 'lat', 'lng', 'package_id', 'pppoe_username', 'pppoe_password', 'pppoe_remote_address', 'mac_address', 'status', 'install_date'];
        // No pisar datos cargados a mano en Open-ISP con valores vacíos de WispHub
        const changes = fields.filter(f => data[f] !== '' && data[f] !== null && String(existing[f] ?? '') !== String(data[f]));
        if (existing.wisphub_id == null) changes.push('wisphub_id');
        if (!changes.length) { report.customers.unchanged++; continue; }
        report.customers.updated++;
        if (!dryRun) {
          const set = changes.map(f => `${f} = ?`).join(', ');
          db.prepare(`UPDATE customers SET ${set} WHERE id = ?`).run(...changes.map(f => (f === 'wisphub_id' ? wid : data[f])), existing.id);
        }
      }
    }
  });
  tx();

  // 2) Facturas (últimos N meses por fecha de emisión)
  const from = new Date(); from.setMonth(from.getMonth() - Number(invoicesMonths || 12));
  const to = new Date(); to.setDate(to.getDate() + 40);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const invoices = source ? (source.invoices || []) : await apiGetAll('/api/facturas/', { fecha_emision__range_0: fmt(from), fecha_emision__range_1: fmt(to) });
  report.sample.invoiceKeys = invoices[0] ? Object.keys(invoices[0]) : [];

  const txInv = db.transaction(() => {
    for (const f of invoices) {
      const fid = num(pick(f, 'id_factura', 'id', 'folio'));
      if (!fid) continue;
      const wid = num(pick(f, 'cliente__user_cliente__id_servicio', 'cliente.id_servicio', 'servicio.id_servicio', 'id_servicio', 'cliente.servicio', 'servicio'));
      let cust = wid ? db.prepare('SELECT id FROM customers WHERE wisphub_id = ?').get(wid) : null;
      if (!cust && dryRun && plannedCustomers.has(wid)) cust = { id: -wid }; // cliente que se crearía
      if (!cust) { report.invoices.skippedNoCustomer++; continue; }
      const issued = parseDate(pick(f, 'fecha_emision'));
      const period = periodFromIssue(issued);
      if (!period) { warn(`Factura WispHub #${fid} sin fecha de emisión`); continue; }
      const status = mapInvoiceStatus(pick(f, 'estado'));
      const paid = parseDate(pick(f, 'fecha_pago'));
      const amount = Math.round(num(pick(f, 'total', 'monto', 'total_factura', 'sub_total')));
      const method = str(pick(f, 'forma_pago.nombre', 'forma_pago'));
      const cashier = str(pick(f, 'cajero', 'cajero.username', 'registrado_por'));
      const notes = [`WispHub #${fid}`, method && `Forma de pago: ${method}`, str(pick(f, 'referencia')) && `Ref: ${str(pick(f, 'referencia'))}`].filter(Boolean).join(' | ');
      const row = {
        customer_id: cust.id, period_month: period.month, period_year: period.year, amount, status,
        paid_at: status === 'paid' && paid ? `${isoDate(paid)} 12:00:00` : null,
        paid_by_name: status === 'paid' ? (cashier ? `WispHub (${cashier})` : 'WispHub') : '',
        notes, created_at: issued ? `${isoDate(issued)} 01:00:00` : null
      };
      const existing = db.prepare('SELECT * FROM invoices WHERE wisphub_invoice_id = ?').get(fid);
      if (!existing) {
        // Evita duplicar una factura que Open-ISP ya generó para el mismo período
        const same = db.prepare('SELECT id FROM invoices WHERE customer_id = ? AND period_month = ? AND period_year = ? AND wisphub_invoice_id IS NULL').get(cust.id, period.month, period.year);
        if (same) warn(`Cliente ${cust.id}: ya existía una factura de Open-ISP para ${period.month}/${period.year}; se vincula con WispHub #${fid}`);
        report.invoices.created++;
        if (!dryRun) {
          if (same) db.prepare('UPDATE invoices SET wisphub_invoice_id = ?, amount = ?, status = ?, paid_at = ?, paid_by_name = ?, notes = ? WHERE id = ?')
            .run(fid, row.amount, row.status, row.paid_at, row.paid_by_name, row.notes, same.id);
          else db.prepare(`INSERT INTO invoices (customer_id, period_month, period_year, amount, status, paid_at, paid_by_name, notes, created_at, wisphub_invoice_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW_LOCAL()), ?)`)
            .run(row.customer_id, row.period_month, row.period_year, row.amount, row.status, row.paid_at, row.paid_by_name, row.notes, row.created_at, fid);
        }
      } else {
        const changed = ['amount', 'status', 'paid_at'].some(k => String(existing[k] ?? '') !== String(row[k] ?? ''));
        if (!changed) { report.invoices.unchanged++; continue; }
        report.invoices.updated++;
        if (!dryRun) db.prepare('UPDATE invoices SET amount = ?, status = ?, paid_at = ?, paid_by_name = ?, notes = ? WHERE id = ?')
          .run(row.amount, row.status, row.paid_at, row.paid_by_name, row.notes, existing.id);
      }
    }
  });
  txInv();

  report.totals = { wisphubClients: clients.length, wisphubInvoices: invoices.length };
  const summary = `Clientes: +${report.customers.created} ~${report.customers.updated} =${report.customers.unchanged} (cancelados omitidos ${report.customers.skippedCancelled}) · Facturas: +${report.invoices.created} ~${report.invoices.updated} =${report.invoices.unchanged} · Planes: +${report.plans.created}`;
  if (!dryRun) {
    db.prepare('INSERT INTO wisphub_sync_runs (started_at, finished_at, dry_run, ok, summary, details) VALUES (?, ?, 0, 1, ?, ?)')
      .run(started, new Date().toISOString(), summary, JSON.stringify(report).slice(0, 200000));
  }
  logger.info(`[WispHub] ${dryRun ? 'SIMULACIÓN' : 'Sincronización'}: ${summary}`);
  report.summary = summary;
  return report;
}

/** Prueba la conexión: pide 1 cliente y 1 factura y devuelve los nombres de campos (sin datos personales). */
async function testConnection() {
  const c = await apiGet('/api/clientes/', { limit: 1, offset: 0 });
  const rows = Array.isArray(c) ? c : (c.results || []);
  return { ok: true, totalClientes: Array.isArray(c) ? rows.length : c.count, campos: rows[0] ? Object.keys(rows[0]) : [] };
}

function lastRuns(limit = 10) {
  return db.prepare('SELECT id, started_at, finished_at, dry_run, ok, summary FROM wisphub_sync_runs ORDER BY id DESC LIMIT ?').all(limit);
}

/**
 * Importa el historial de consumo DIARIO exportado de WispHub (pantalla Tráfico → Mes).
 * data: { "<id_servicio>": [["DD/MM/AAAA", descarga_MiB, subida_MiB], ...], ... }
 * Guarda cada día en customer_usage_daily y recalcula los totales mensuales en customer_usage.
 */
function importTraffic(data, { dryRun = true } = {}) {
  const MIB = 1024 * 1024;
  const out = { days: 0, customers: 0, months: 0, skippedNoCustomer: 0 };
  const tx = db.transaction(() => {
    for (const [wid, rows] of Object.entries(data || {})) {
      const cust = db.prepare('SELECT id FROM customers WHERE wisphub_id = ?').get(Number(wid));
      if (!cust) { out.skippedNoCustomer++; continue; }
      out.customers++;
      const months = new Map();
      for (const [day, down, up] of rows || []) {
        const p = parseDate(day); if (!p) continue;
        const iso = isoDate(p);
        const bin = Math.round(num(down) * MIB), bout = Math.round(num(up) * MIB);
        out.days++;
        if (!dryRun) db.prepare(`INSERT INTO customer_usage_daily (customer_id, day, bytes_in, bytes_out, source) VALUES (?, ?, ?, ?, 'wisphub')
          ON CONFLICT(customer_id, day) DO UPDATE SET bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out, source = 'wisphub'`).run(cust.id, iso, bin, bout);
        const k = `${p.y}-${p.m}`; const m = months.get(k) || { y: p.y, m: p.m, bin: 0, bout: 0 }; m.bin += bin; m.bout += bout; months.set(k, m);
      }
      for (const m of months.values()) {
        out.months++;
        if (dryRun) continue;
        const ex = db.prepare('SELECT id, bytes_in, bytes_out FROM customer_usage WHERE customer_id = ? AND period_month = ? AND period_year = ?').get(cust.id, m.m, m.y);
        // Se conserva el mayor valor (Open-ISP pudo haber medido parte del mes actual)
        if (ex) db.prepare('UPDATE customer_usage SET bytes_in = MAX(bytes_in, ?), bytes_out = MAX(bytes_out, ?), updated_at = NOW_LOCAL() WHERE id = ?').run(m.bin, m.bout, ex.id);
        else db.prepare('INSERT INTO customer_usage (customer_id, period_month, period_year, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?)').run(cust.id, m.m, m.y, m.bin, m.bout);
      }
    }
  });
  tx();
  return out;
}

/**
 * Importa promesas de pago vigentes desde la lista de WispHub (/promesas-de-pago/).
 * rows: [{ factura: '0000671', creado: 'DD/MM/AAAA HH:MM', limite: 'DD/MM/AAAA HH:MM', creado_por }]
 * WispHub muestra las horas en la zona de la cuenta (sourceOffset, ej. '-05:00'); se convierten a la zona configurada.
 */
function importPromises(rows, { dryRun = true, sourceOffset = '-05:00' } = {}) {
  ensureSchema();
  const cycle = require('../config/billingCycle');
  const promiseSvc = require('./promiseService');
  promiseSvc.ensureSchema();
  const toLocal = (txt) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(String(txt || '').trim());
    if (!m) return null;
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00${sourceOffset}`);
    return isNaN(d.getTime()) ? null : cycle.nowStamp(d);
  };
  const now = cycle.nowStamp();
  const out = { imported: [], skipped: [] };
  for (const r of rows || []) {
    const num = parseInt(String(r.factura || '').replace(/\D/g, ''), 10);
    const inv = num ? db.prepare('SELECT i.id, i.customer_id, i.status, c.name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.wisphub_invoice_id=?').get(num) : null;
    const until = toLocal(r.limite);
    if (!inv) { out.skipped.push({ factura: r.factura, motivo: 'factura no importada' }); continue; }
    if (!until) { out.skipped.push({ factura: r.factura, motivo: 'fecha límite inválida' }); continue; }
    if (until <= now) { out.skipped.push({ factura: r.factura, cliente: inv.name, motivo: 'promesa vencida (' + until + ')' }); continue; }
    if (inv.status !== 'unpaid') { out.skipped.push({ factura: r.factura, cliente: inv.name, motivo: 'la factura ya no está pendiente' }); continue; }
    const item = { factura: r.factura, cliente: inv.name, hasta: until, creado: toLocal(r.creado) };
    if (!dryRun) {
      const res = promiseSvc.importExisting(inv.customer_id, { createdAt: item.creado, until, note: 'Importada de WispHub', createdBy: r.creado_por || '', ref: 'WispHub factura ' + num });
      if (res.skipped) { out.skipped.push({ ...item, motivo: res.skipped }); continue; }
    }
    out.imported.push(item);
  }
  return out;
}

module.exports = { run, testConnection, lastRuns, importTraffic, importPromises, apiGet };
