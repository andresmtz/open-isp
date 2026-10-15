'use strict';
/**
 * Solicitudes de instalación ("Inscriptos") y su alta.
 *
 * Flujo:
 *  1. Solicitud: la carga el interesado (portal → "Solicitar instalación") o la oficina (Clientes → Nueva solicitud).
 *     Queda como cliente 'inactive' (Inscripto). Avisa a los administradores y al personal de oficina con
 *     permiso "Agregar y editar clientes". Los técnicos NO se enteran.
 *  2. Aprobar e instalar: se elige quién instala (técnico, personal de oficina o administrador), la fecha de
 *     instalación y el primer vencimiento. Se crea el usuario PPPoE, el cliente pasa a activo, se genera la
 *     primera factura y una orden de trabajo "Instalación" asignada (solo la ve quien instala).
 *     Al instalar, el cliente le paga al instalador UN MES COMPLETO del plan (no hay costo de instalación aparte);
 *     ese pago no pasa por la caja y cubre 30 días desde la instalación.
 *  3. Instalación realizada: al cerrar la orden de trabajo como resuelta, el cliente recibe la bienvenida por WhatsApp.
 *
 * Primera factura (prepago): el mes completo pagado al instalar cubre los días que quedan del mes de instalación y
 * el resto queda a favor para el mes siguiente. La primera factura es la mensualidad del mes siguiente menos ese saldo
 * (= el proporcional de los días del mes de instalación). Ej. plan Gs. 100.000, instala el 15/10:
 *   al instalar paga 100.000 al técnico (17 días de octubre = 55.000; quedan 45.000 a favor);
 *   factura de noviembre (vence 05/11): 100.000 − 45.000 = 55.000; diciembre: 100.000 normal.
 * Si el primer vencimiento se pone más adelante, se suman las mensualidades completas de los meses intermedios.
 * El ciclo mensual no vuelve a facturar ese período ni los anteriores (customers.first_invoice_period).
 *
 * Parámetros: billing_due_day (día de vencimiento), billing_round_to (redondeo de montos, Gs.).
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const regional = require('../config/regional');
const cycle = require('../config/billingCycle');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const pad = (n) => String(n).padStart(2, '0');
const fmtMoney = (n) => regional.formatMoney(Number(n) || 0);
const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || ''); };

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  const add = (table, col, type) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  add('customers', 'first_invoice_period', 'TEXT');
  add('customers', 'reg_installer', 'TEXT');
  add('customers', 'reg_welcome_sent', 'INTEGER DEFAULT 0');
  add('tickets', 'kind', 'TEXT');
  _schemaOk = true;
}

function roundTo() { return Math.max(0, parseInt(getSetting('billing_round_to', 1000), 10) || 0); }
function round(n) { const r = roundTo(); return r > 0 ? Math.round(n / r) * r : Math.round(n); }

/** Primer vencimiento sugerido: el día de vencimiento del mes siguiente a la instalación. */
function defaultDueDate(installDate) {
  const [y, m] = String(installDate).split('-').map(Number);
  const nx = cycle.shiftMonth(y, m, 1);
  const c = cycle.get();
  return `${nx.year}-${pad(nx.month)}-${pad(cycle.clampDay(nx.year, nx.month, c.dueDay))}`;
}

/**
 * Cálculo de la primera factura.
 * @param {number} price mensualidad del plan
 * @param {string} installDate 'YYYY-MM-DD'
 * @param {string} [dueDate] 'YYYY-MM-DD' (por defecto, el vencimiento del mes siguiente)
 */
function firstInvoicePlan(price, installDate, dueDate) {
  const today = cycle.nowStamp().slice(0, 10);
  const inst = /^\d{4}-\d{2}-\d{2}$/.test(String(installDate || '')) ? String(installDate) : today;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || '')) ? String(dueDate) : defaultDueDate(inst);
  const [iy, im, id] = inst.split('-').map(Number);
  const [dy, dm] = due.split('-').map(Number);
  if (dy * 12 + dm < iy * 12 + im) throw new Error('El primer vencimiento no puede ser anterior al mes de instalación.');
  const monthly = Math.max(0, Math.round(Number(price) || 0));
  const dim = cycle.daysInMonth(iy, im);
  const days = dim - id + 1; // del día de instalación hasta el 1 del mes siguiente
  const prorata = round(monthly * days / dim);
  // mensualidades completas desde el mes siguiente a la instalación hasta el período del vencimiento (inclusive)
  const months = (dy * 12 + dm) - (iy * 12 + im);
  if (months < 1) throw new Error('El primer vencimiento tiene que ser del mes siguiente a la instalación o posterior (el pago al instalar cubre el mes en curso).');
  const credit = monthly - prorata; // saldo del mes pagado al instalar que pasa al mes siguiente
  const first = cycle.shiftMonth(iy, im, 1);
  const lines = [
    { label: `Mensualidad ${MESES[first.month - 1]} ${first.year}`, amount: monthly },
    { label: `Menos saldo del pago al instalar (${fmtMoney(monthly)} − ${days} ${days === 1 ? 'día' : 'días'} de ${MESES[im - 1]} ${fmtMoney(prorata)})`, amount: -credit },
  ];
  for (let k = 2; k <= months; k++) {
    const p = cycle.shiftMonth(iy, im, k);
    lines.push({ label: `Mensualidad ${MESES[p.month - 1]} ${p.year}`, amount: monthly });
  }
  const total = lines.reduce((s2, l) => s2 + l.amount, 0);
  const installPayment = monthly;
  return { installDate: inst, dueDate: due, period: { year: dy, month: dm }, monthly, days, daysInMonth: dim, prorata, credit, months, lines, total, installPayment };
}

/** Quién puede instalar: técnicos activos, personal de oficina activo y el administrador. */
function installers() {
  const out = [{ key: 'admin', type: 'admin', id: 0, name: 'Administrador', phone: '' }];
  try {
    for (const c of db.prepare('SELECT id, name, phone FROM cashiers WHERE is_active = 1 ORDER BY name').all()) out.push({ key: `staff:${c.id}`, type: 'staff', id: c.id, name: c.name, phone: c.phone || '', group: 'Oficina' });
  } catch (_) {}
  try {
    for (const t of db.prepare('SELECT id, name, phone FROM technicians WHERE is_active = 1 ORDER BY name').all()) out.push({ key: `tech:${t.id}`, type: 'tech', id: t.id, name: t.name, phone: t.phone || '', group: 'Técnicos' });
  } catch (_) {}
  return out;
}
function findInstaller(key) { return installers().find(i => i.key === String(key || '')) || null; }

// ── Avisos ─────────────────────────────────────────────────────────────────────────
function waNotify() { return require('./waNotifyService'); }
const mapLink = (lat, lng) => (String(lat || '').trim() && String(lng || '').trim()) ? `https://maps.google.com/?q=${encodeURIComponent(String(lat).trim())},${encodeURIComponent(String(lng).trim())}` : '';

/** Personal de oficina que gestiona altas (permiso 'clientes_alta'). */
function officeRecipients() {
  const sp = require('../config/staffPermissions');
  try {
    return db.prepare("SELECT id, name, phone FROM cashiers WHERE is_active = 1 AND COALESCE(phone,'') != ''").all()
      .filter(c => sp.current(c.id).clientes_alta);
  } catch (_) { return []; }
}

async function sendTo(phone, text) {
  const n = regional.normalizePhone(String(phone || '').replace(/\D/g, ''));
  if (!n) return false;
  try { return !!(await waNotify().sendText(n, text)); } catch (_) { return false; }
}

/** Aviso de solicitud nueva: administradores + oficina con permiso de altas. Nunca a técnicos. */
async function notifyNewRequest(cust, pkgName, source) {
  const loc = mapLink(cust.lat, cust.lng);
  const msg = `🔔 *NUEVA SOLICITUD DE INSTALACIÓN*\n\n` +
    `👤 *Nombre:* ${cust.name}\n📞 *WhatsApp:* ${cust.phone || '-'}\n📍 *Dirección:* ${cust.address || '-'}\n📦 *Plan:* ${pkgName || '-'}` +
    (loc ? `\n🗺️ *Ubicación:* ${loc}` : '') +
    `\n📝 *Cargada por:* ${source}\n\nPara asignar la instalación: Clientes → Inscriptos → Aprobar e instalar.`;
  try { await waNotify().notifyAdmin(msg); } catch (_) {}
  for (const s of officeRecipients()) await sendTo(s.phone, msg);
}

// ── 1. Solicitud ──────────────────────────────────────────────────────────────────
/** Interpreta "lat,lng" o un enlace de Google Maps (…@lat,lng… / ?q=lat,lng). */
function parseLocation(text) {
  const s = String(text || '').trim();
  if (!s) return { lat: '', lng: '' };
  const m = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(decodeURIComponent(s));
  return m ? { lat: m[1], lng: m[2] } : { lat: '', lng: '' };
}

async function createRequest(data, { source = 'Portal web', actor = '' } = {}) {
  ensureSchema();
  const customerSvc = require('./customerService');
  const name = String(data.name || '').trim();
  let phone = String(data.phone || '').trim();
  const address = String(data.address || '').trim();
  const pkg = data.package_id ? customerSvc.getPackageById(data.package_id) : null;
  if (!name || !phone || !address || !pkg) throw new Error('Nombre, WhatsApp, dirección y plan son obligatorios.');
  if (!regional.isValidPhone(phone)) throw new Error(`Número de WhatsApp inválido. Ejemplo: ${regional.phoneExample()}`);
  phone = regional.toLocalPhone(phone);
  let { lat, lng } = data;
  if ((!lat || !lng) && data.location) ({ lat, lng } = parseLocation(data.location));
  const notes = [actor ? `Solicitud cargada por ${actor}` : 'Inscripto en línea', String(data.notes || '').trim()].filter(Boolean).join(' — ');
  const ins = customerSvc.createCustomer({
    name, phone, email: data.email || '', nik: data.nik || '', address, package_id: pkg.id,
    lat: String(lat || '').trim(), lng: String(lng || '').trim(), status: 'inactive', notes,
  });
  const id = Number(ins && ins.lastInsertRowid);
  try { db.prepare("UPDATE customers SET reg_status='pending' WHERE id=?").run(id); } catch (_) {}
  const cust = customerSvc.getCustomerById(id);
  notifyNewRequest(cust, pkg.name, actor ? `${actor} (${source})` : source).catch(() => {});
  return cust;
}

// ── 2. Aprobar e instalar ─────────────────────────────────────────────────────────
async function approve(customerId, { installer, installDate, dueDate, total, notes } = {}, actor = 'Admin') {
  ensureSchema();
  const customerSvc = require('./customerService');
  const mikrotikService = require('./mikrotikService');
  const id = Number(customerId);
  const cust = customerSvc.getCustomerById(id);
  if (!cust) throw new Error('Inscripto no encontrado');
  if (cust.status !== 'inactive') throw new Error('Este cliente ya no está pendiente de instalación.');
  const pkg = cust.package_id ? customerSvc.getPackageById(cust.package_id) : null;
  if (!pkg) throw new Error('El inscripto no tiene plan asignado.');
  const who = findInstaller(installer);
  if (!who) throw new Error('Elegí quién va a hacer la instalación.');

  const plan = firstInvoicePlan(pkg.price, installDate, dueDate);
  let amount = parseInt(total, 10);
  if (!Number.isFinite(amount) || amount < 0) amount = plan.total;

  // Usuario PPPoE (se genera si falta) y alta en el MikroTik
  let pppoeUser = cust.pppoe_username || '';
  let pppoePass = cust.pppoe_password || '';
  if (!pppoeUser && getSetting('pppoe_auto_generate', '1') !== '0') {
    const g = customerSvc.generatePppoeAccount(id); pppoeUser = g.username; pppoePass = g.password;
  }
  let mkWarn = '';
  try {
    const radius = getSetting('radius_enabled', '0') === '1' && Number(cust.is_radius) === 1;
    if (pppoeUser && !radius) {
      await mikrotikService.createPppoeSecret({ username: pppoeUser, password: pppoePass, profile: pkg.name, remoteAddress: cust.pppoe_remote_address || '', routerId: cust.router_id || null });
    }
  } catch (e) { mkWarn = e.message; logger.error('[Instalación] PPPoE en MikroTik: ' + e.message); }

  const P = plan.period;
  const periodKey = `${P.year}-${pad(P.month)}`;
  const breakdown = plan.lines.map(l => `${l.label}: ${regional.formatMoney(l.amount)}`).join(' | ') + (amount !== plan.total ? ` | Ajustado a ${regional.formatMoney(amount)}` : '');
  db.transaction(() => {
    const ex = db.prepare('SELECT id FROM invoices WHERE customer_id=? AND period_month=? AND period_year=?').get(id, P.month, P.year);
    if (!ex) db.prepare("INSERT INTO invoices (customer_id, period_month, period_year, amount, status, notes) VALUES (?,?,?,?, 'unpaid', ?)").run(id, P.month, P.year, amount, 'Primera factura: ' + breakdown);
    db.prepare(`UPDATE customers SET status='active', reg_status='approved', reg_total=?, reg_prorata=?, reg_install_fee=0, reg_due_date=?, install_date=?, first_invoice_period=?, reg_installer=? WHERE id=?`)
      .run(amount, plan.prorata, plan.dueDate, plan.installDate, periodKey, `${who.type}:${who.id}:${who.name}`, id);
  })();

  // Orden de trabajo: solo la ve quien instala (si es técnico, en su portal)
  const loc = mapLink(cust.lat, cust.lng);
  const body = `Instalación de ${pkg.name} para ${cust.name}.\n` +
    `Teléfono: ${cust.phone || '-'}\nDirección: ${cust.address || '-'}` + (loc ? `\nUbicación: ${loc}` : '') +
    `\nFecha prevista: ${fmtDate(plan.installDate)}` +
    (pppoeUser ? `\nPPPoE: ${pppoeUser} / ${pppoePass || '-'}` : '') +
    (String(notes || '').trim() ? `\nNotas: ${String(notes).trim()}` : '') +
    `\n\nCobrar al cliente al instalar: ${fmtMoney(plan.installPayment)} (primer mes del plan ${pkg.name}).` +
    `\nAl terminar, cerrá esta orden como resuelta: el cliente recibe la bienvenida.`;
  // (la foto de la casa, si se cargó, se ve en esta orden en el portal del técnico)
  const tk = require('./ticketService').createTicket(id, `Instalación nueva — ${cust.name}`, body, { technicianId: who.type === 'tech' ? who.id : null, status: 'in_progress' });
  const ticketId = Number(tk && tk.lastInsertRowid);
  try { db.prepare("UPDATE tickets SET kind='install', technician_notes=? WHERE id=?").run(who.type === 'tech' ? '' : `Instala: ${who.name}`, ticketId); } catch (_) {}

  // Aviso a quien instala (técnico, oficina o administrador) con los datos para configurar el equipo
  const waMsg = `🛠️ *INSTALACIÓN ASIGNADA*\n\n👤 *Cliente:* ${cust.name}\n📞 *Teléfono:* ${cust.phone || '-'}\n📍 *Dirección:* ${cust.address || '-'}` +
    (loc ? `\n🗺️ *Ubicación:* ${loc}` : '') + `\n📦 *Plan:* ${pkg.name}\n📅 *Fecha:* ${fmtDate(plan.installDate)}` +
    `\n\n💵 *Cobrar al instalar:* ${fmtMoney(plan.installPayment)} (primer mes del plan)` +
    (pppoeUser ? `\n\n📡 *PPPoE usuario:* ${pppoeUser}\n🔒 *PPPoE clave:* ${pppoePass || '-'}` : '') +
    (String(notes || '').trim() ? `\n\n📝 ${String(notes).trim()}` : '') +
    `\n\nAl terminar, cerrá la orden de trabajo N.º ${ticketId} como resuelta.`;
  let installerNotified = false;
  if (who.type === 'admin') { try { await waNotify().notifyAdmin(waMsg); installerNotified = true; } catch (_) {} }
  else {
    installerNotified = await sendTo(who.phone, waMsg);
    // Foto de la casa (nunca la cédula) para ubicar el domicilio
    try {
      const docs = require('./customerDocumentService');
      const casa = docs.list(id, { kinds: ['casa'] })[0];
      const fp = casa && docs.filePath(casa);
      const n = regional.normalizePhone(String(who.phone || '').replace(/\D/g, ''));
      if (fp && n) await waNotify().sendImage(n, require('fs').readFileSync(fp), `🏠 Casa de ${cust.name} — ${cust.address || ''}`.trim());
    } catch (e) { logger.warn('[Instalación] foto de la casa: ' + e.message); }
  }
  // El administrador siempre recibe las credenciales (si no es quien instala)
  if (who.type !== 'admin' && pppoeUser) {
    try { await waNotify().notifyAdmin(`🔑 *Alta de ${cust.name}*\nInstala: ${who.name}\nPPPoE: ${pppoeUser} / ${pppoePass || '-'}\nPrimera factura: ${regional.formatMoney(amount)} (vence ${fmtDate(plan.dueDate)})`); } catch (_) {}
  }
  logger.info(`[Instalación] ${cust.name} aprobado por ${actor}; instala ${who.name}; orden #${ticketId}; primera factura ${amount} período ${periodKey}`);
  return { customer: cust, installer: who, plan, amount, ticketId, pppoeUser, installerNotified, mkWarn };
}

// ── 3. Bienvenida ─────────────────────────────────────────────────────────────────
const DEFAULT_WELCOME =
`🎉 ¡Bienvenido/a a *{{company}}*, *{{nama}}*!

Su servicio de internet ya está instalado y funcionando.

🆔 *ID de cliente:* {{id_pelanggan}}
📦 *Plan:* {{paket}}
📅 *Primer vencimiento:* {{vencimiento}}

🌐 *Portal de clientes:* {{link}}
Ahí puede ver sus facturas, el nombre y la clave de su WiFi y los equipos conectados. Ingresa con su número de teléfono y recibe un código por WhatsApp.

{{pago}}

Ante cualquier consulta, escríbanos a este número.`;

function renderWelcome(cust) {
  const customerSvc = require('./customerService');
  const pkg = cust.package_id ? customerSvc.getPackageById(cust.package_id) : null;
  const base = String(getSetting('public_base_url', '') || '').replace(/\/$/, '');
  const tpl = String(db.getAppSetting('whatsapp_welcome_message', DEFAULT_WELCOME) || DEFAULT_WELCOME);
  return tpl
    .replace(/{{nama}}/gi, cust.name || '')
    .replace(/{{id_pelanggan}}/gi, cust.customer_code || String(cust.id))
    .replace(/{{paket}}/gi, (pkg && pkg.name) || cust.package_name || '-')
    .replace(/{{vencimiento}}/gi, cust.reg_due_date ? fmtDate(cust.reg_due_date) : '-')
    .replace(/{{link}}/gi, base ? `${base}/customer` : '-')
    .replace(/{{pago}}/gi, String(getSetting('corte_payment_info', '') || '').trim())
    .replace(/{{company}}/gi, getSetting('company_header', '') || '')
    .replace(/{{company_phone}}/gi, regional.publicContactPhone ? regional.publicContactPhone(require('../config/settingsManager').getSettingsWithCache()) : '')
    .replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, alts) => { const a = alts.split('|'); return a[Math.floor(Math.random() * a.length)]; })
    .replace(/\n{3,}/g, '\n\n');
}

async function sendWelcome(customerId, { force = false } = {}) {
  ensureSchema();
  const cust = require('./customerService').getCustomerById(Number(customerId));
  if (!cust || !cust.phone || cust.status === 'cancelled') return false;
  if (!force && Number(cust.reg_welcome_sent) === 1) return false;
  const ok = await sendTo(cust.phone, renderWelcome(cust));
  if (ok) db.prepare('UPDATE customers SET reg_welcome_sent=1 WHERE id=?').run(cust.id);
  logger.info(`[Instalación] Bienvenida a ${cust.name}: ${ok ? 'enviada' : 'NO enviada'}`);
  return ok;
}

/** Se llama al cambiar el estado de una orden: al resolver una instalación se envía la bienvenida. */
function onTicketStatus(ticketId, status) {
  if (String(status) !== 'resolved') return;
  try {
    ensureSchema();
    const t = db.prepare('SELECT customer_id, kind FROM tickets WHERE id=?').get(Number(ticketId));
    if (t && t.kind === 'install' && t.customer_id) sendWelcome(t.customer_id).catch(() => {});
  } catch (e) { logger.warn('[Instalación] bienvenida: ' + e.message); }
}

module.exports = {
  ensureSchema, firstInvoicePlan, defaultDueDate, installers, findInstaller, parseLocation,
  createRequest, approve, sendWelcome, renderWelcome, onTicketStatus, DEFAULT_WELCOME,
};
