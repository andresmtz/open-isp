/**
 * Permisos del personal de oficina (sesiones de "cajero": secretaría, caja, atención).
 *
 * Regla general: TODO lo que no está habilitado acá queda prohibido (denegar por defecto).
 * El administrador elige qué puede hacer CADA persona en Usuarios → Personal de oficina → Permisos.
 * Se guarda por usuario en cashiers.permissions (JSON { clave: true|false }).
 *
 * Siempre solo del administrador (no aparecen como opción): configuración, automatización,
 * respaldos, actualizaciones, routers/MikroTik/OLT (escritura), usuarios, planes (edición),
 * anular pagos, ajustar saldo a favor, borrar clientes o facturas, importar.
 */
const { getSetting } = require('./settingsManager');

const ID = '\\d+';

// Lo mínimo para trabajar: panel (sin ingresos), planes, zonas y su asistencia.
const BASE = [
  ['GET', '^/$'],
  ['GET', '^/api/stats$'],
  ['GET|POST', '^/logout$'],
  ['GET', '^/set-active-router$'],
  ['GET', '^/areas$'],
  ['GET|POST', '^/cashiers/attendance(/checkin|/checkout)?$'],
];

// `needs`: al habilitar un permiso se habilitan también estos (no se puede cobrar sin ver clientes y facturas).
const CATALOG = [
  { key: 'ver_clientes', label: 'Ver clientes', help: 'Lista y ficha de clientes, conexión, consumo y etiquetas de ONU. Solo consulta.', def: true, rules: [
    ['GET', '^/customers$'],
    ['GET', `^/customers/${ID}/sticker-onu$`],
    ['GET', `^/customers/${ID}/history$`],
    ['GET', `^/customers/${ID}/ficha$`],
    ['GET', `^/customers/${ID}/onu-power$`],
    ['GET', `^/customers/${ID}/documents(/${ID})?$`],
    ['GET', `^/customers/${ID}/extras$`],
    ['GET', `^/api/customers/${ID}/pppoe-traffic$`],
    ['GET', '^/api/customers/live-sessions$'],
    ['GET', `^/api/odps/${ID}/ports$`],
    ['GET', '^/onu-stickers$'],
  ] },
  { key: 'ver_facturas', label: 'Ver montos: facturas, deudas y precios', help: 'Facturas, deuda y saldo de cada cliente, precios de los planes, imprimir facturas. Sin este permiso no ve ningún monto. Solo consulta.', def: true, rules: [
    ['GET', '^/billing$'],
    ['GET', '^/packages$'],
    ['GET', `^/billing/${ID}/(pdf|print|print-thermal)$`],
    ['GET', `^/api/billing/unpaid/${ID}$`],
    ['GET', `^/api/customers/${ID}/(billing-year|paid-months)$`],
    ['GET', `^/customers/${ID}/payment-info$`],
    ['GET', `^/customers/${ID}/portal-preview$`],
  ] },
  { key: 'cobrar', label: 'Cobrar y registrar pagos', help: 'Cobrar a clientes (pago total o parcial), marcar facturas como pagadas y ver su propio reporte de cobros.', def: true, needs: ['ver_clientes', 'ver_facturas'], rules: [
    ['GET', '^/cashiers/reports$'],
    ['GET', '^/pending-payments$'],
    ['POST', `^/customers/${ID}/(receive|billing/pay)$`],
    ['POST', `^/billing/${ID}/pay$`],
    ['POST', '^/billing/pay-bulk$'],
    ['GET', `^/payment-proofs/${ID}/file$`],
    ['POST', `^/payment-proofs/${ID}/(apply|reject|assign)$`],
    ['POST', '^/payment-proofs/scan$'],
  ] },
  { key: 'enviar_facturas', label: 'Enviar facturas y comprobantes por WhatsApp', help: 'Botones de enviar factura o comprobante a un cliente.', def: true, needs: ['ver_facturas'], rules: [
    ['POST', `^/billing/${ID}/(whatsapp|send-pdf-wa)$`],
  ] },
  { key: 'conversaciones', label: 'Conversaciones de WhatsApp', help: 'Ver y responder las conversaciones de WhatsApp de clientes e interesados, y recibir el aviso cuando Meta AI deriva a una persona.', def: false, needs: ['ver_clientes'], rules: [
    ['GET', '^/conversations$'],
    ['GET', '^/conversations/(list|counts)$'],
    ['GET', `^/conversations/${ID}/messages$`],
    ['GET', `^/conversations/media/${ID}$`],
    ['POST', `^/conversations/${ID}/(reply|state|update|read|org|link|create-request)$`],
    ['GET', '^/conversations/(customer-search|quick-replies)$'],
    ['POST', '^/conversations/bulk$'],
    ['POST', `^/conversations/${ID}/(save-doc|save-geo)$`],
    ['POST', '^/conversations/sync$'],
  ] },
  { key: 'promesas', label: 'Dar promesas de pago', help: 'Respeta el máximo de días y de promesas por mes de Automatización.', def: true, needs: ['ver_clientes', 'ver_facturas'], rules: [
    ['GET', `^/customers/${ID}/promise-preview$`],
    ['POST', `^/customers/${ID}/promise$`],
  ] },
  { key: 'clientes_alta', label: 'Agregar y editar clientes', help: 'Alta de clientes nuevos (crea el usuario PPPoE en el MikroTik), edición de datos y aprobación de solicitudes.', def: true, needs: ['ver_clientes'], rules: [
    ['POST', `^/customers/${ID}/geo$`],
    ['GET', '^/data-update$'],
    ['POST', '^/data-update/(queue|cancel)$'],
    ['POST', `^/customers/${ID}/extras$`],
    ['POST', `^/customers/extras/${ID}/(update|end)$`],
    ['POST', '^/customers$'],
    ['POST', `^/customers/${ID}/(update|generate-pppoe)$`],
    ['POST', `^/registrations/${ID}/(approve|reject|installed|cancel-install|reassign|reactivate|resend)$`],
    ['GET', '^/registrations/installers$'],
    ['GET', '^/registrations/duplicates$'],
    ['POST', '^/registrations$'],
    ['POST', `^/customers/${ID}/documents(/${ID}/delete)?$`],
    ['GET|POST', `^/customers/${ID}/equipment$`],
    ['GET', `^/customers/${ID}/onu-power$`],
    ['GET', `^/registrations/${ID}/plan$`],
    ['POST', `^/customers/${ID}/withdraw(/(resend|cancel))?$`],
    ['GET', '^/api/mikrotik/(users|profiles|hotspot-user-profiles)(/\\d+)?$'],
  ] },
  { key: 'clientes_baja', label: 'Cancelar servicios (después del retiro del equipo)', help: 'Solo cuando el técnico ya marcó el equipo como retirado. Borra el usuario PPPoE, libera la IP, da de baja la ONU en la OLT y anula las facturas pendientes.', def: false, needs: ['clientes_alta'], rules: [
    ['GET', `^/customers/${ID}/cancel-preview$`],
    ['POST', `^/customers/${ID}/cancel$`],
  ] },
  { key: 'reclamos', label: 'Reclamos de clientes', help: 'Ver, crear y actualizar reclamos (no borrarlos).', def: true, rules: [
    ['GET', '^/tickets$'],
    ['POST', '^/tickets/create$'],
    ['GET', '^/tickets/quick-info$'],
    ['POST', '^/tickets/quick$'],
    ['POST', `^/tickets/${ID}/update$`],
    ['GET', `^/tickets/${ID}/detail$`],
    ['POST', `^/tickets/${ID}/note$`],
    ['GET', '^/outages$'],
    ['POST', `^/outages/${ID}/close$`],
  ] },
  { key: 'mapa', label: 'Ver mapa de red', help: 'Solo consulta.', def: true, rules: [
    ['GET', '^/map$'],
    ['GET', '^/api/customers/live-sessions$'],
    ['GET', `^/api/odps/${ID}/ports$`],
    ['GET', `^/api/customers/${ID}/cable-path$`],
  ] },
  { key: 'whatsapp_chat', label: 'Chat de WhatsApp con clientes', help: 'Leer y responder conversaciones desde el número de la empresa. No incluye envíos masivos ni la configuración.', def: false, rules: [
    ['GET', '^/whatsapp/live-chat$'],
    ['GET', '^/api/whatsapp/(conversations|messages)$'],
    ['POST', '^/api/whatsapp/send-direct$'],
  ] },
  { key: 'corte_manual', label: 'Cortar y reactivar manualmente', help: 'Botones de cortar, reactivar, desconectar y sincronizar con el MikroTik.', def: false, needs: ['ver_clientes'], rules: [
    ['POST', `^/customers/${ID}/(isolate|unisolate|disconnect|sync-mikrotik)$`],
  ] },
  { key: 'facturar', label: 'Generar facturas y aplicar descuentos', help: 'Emitir facturas fuera del ciclo automático y aplicar descuentos.', def: false, needs: ['ver_clientes', 'ver_facturas'], rules: [
    ['POST', `^/customers/${ID}/billing/generate$`],
    ['POST', '^/billing/generate$'],
    ['POST', `^/billing/${ID}/discount$`],
    ['GET', '^/discounts$'],
    ['POST', '^/discounts/apply$'],
  ] },
  { key: 'finanzas', label: 'Ver finanzas', help: 'Ingresos en el panel, reporte financiero, otros ingresos y gastos (cargar, no borrar).', def: false, rules: [
    ['GET', '^/reports(/export-csv|/pdf|/print)?$'],
    ['GET|POST', '^/finance/(cash-in|expenses)$'],
  ] },
  { key: 'cobradores', label: 'Aprobar cobros de cobradores', help: 'Aprobar o rechazar lo que cargan los cobradores y conciliar pagos sin identificar.', def: false, needs: ['ver_facturas'], rules: [
    ['GET', '^/collector-payments$'],
    ['POST', `^/collector-payments/${ID}/(approve|reject)$`],
    ['GET', '^/payment-unmatched$'],
    ['POST', `^/payment-unmatched/${ID}/(match|dismiss)$`],
  ] },
  { key: 'exportar', label: 'Exportar el listado de clientes', help: 'Descargar la base de clientes en archivo.', def: false, needs: ['ver_clientes'], rules: [
    ['GET', '^/customers/export$'],
  ] },
  { key: 'inventario', label: 'Inventario', help: 'Ver y cargar stock (no borrar categorías).', def: false, rules: [
    ['GET', '^/inventory$'],
    ['POST', `^/inventory/(stock/add|item/add|item/edit/${ID})$`],
  ] },
  { key: 'wifi_clientes', label: 'Gestionar WiFi de clientes', help: 'Ver el equipo del cliente (ONU, redes 2.4/5G, puertos con cable), ver la clave del WiFi y cambiarla. Recibe aviso por WhatsApp si un cambio falla.', def: false, needs: ['ver_clientes'], rules: [
    ['GET', `^/customers/${ID}/onu(/clients)?$`],
    ['POST', `^/customers/${ID}/onu/(wifi|recheck|clients/name)$`],
  ] },
  { key: 'red_ver', label: 'Ver estado de la red', help: 'MikroTik, OLT y ONU en modo consulta. No puede cambiar nada.', def: false, rules: [
    ['GET', '^/mikrotik(/display)?$'],
    ['GET', '^/api/mikrotik/(active-pppoe|active-hotspot|monitoring-display-data)$'],
    ['GET', '^/olts$'],
    ['GET', '^/onu-inventory$'],
    ['GET', `^/olts/(${ID}|all)/stats$`],
    ['GET', '^/devices$'],
    ['GET', '^/api/devices$'],
  ] },
];

const compile = (rules) => rules.map(([m, re]) => ({ methods: m.split('|'), re: new RegExp(re) }));
const BASE_C = compile(BASE);
const CATALOG_C = CATALOG.map(p => ({ key: p.key, rules: compile(p.rules) }));

// ── Permisos por persona (columna cashiers.permissions, JSON) ───────────────────────────
let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  const db = require('./database');
  const cols = db.prepare('PRAGMA table_info(cashiers)').all().map(c => c.name);
  if (!cols.includes('permissions')) {
    db.exec('ALTER TABLE cashiers ADD COLUMN permissions TEXT');
    // Migración: los usuarios que ya existían conservan los permisos generales que tenían
    let legacy = getSetting('staff_permissions', null);
    if (typeof legacy === 'string') { try { legacy = JSON.parse(legacy); } catch (_) { legacy = null; } }
    if (legacy && typeof legacy === 'object') db.prepare('UPDATE cashiers SET permissions = ?').run(JSON.stringify(normalize(legacy)));
  }
  _schemaOk = true;
}

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';

function withNeeds(out) {
  for (const p of CATALOG) if (out[p.key]) for (const n of (p.needs || [])) out[n] = true;
  return out;
}

/** Solo claves conocidas; lo que falta queda apagado (nunca se otorga acceso sin que el admin lo marque). */
function normalize(input) {
  const out = {};
  for (const p of CATALOG) out[p.key] = !!(input && truthy(input[p.key]));
  return withNeeds(out);
}

const _cache = new Map(); // id → { at, perms } (evita leer la BD varias veces por página)
function current(cashierId) {
  const id = Number(cashierId) || 0;
  const hit = _cache.get(id);
  if (hit && Date.now() - hit.at < 3000) return hit.perms;
  ensureSchema();
  let raw = null;
  try { raw = require('./database').prepare('SELECT permissions FROM cashiers WHERE id = ?').get(id); } catch (_) {}
  let obj = null;
  try { obj = raw && raw.permissions ? JSON.parse(raw.permissions) : null; } catch (_) { obj = null; }
  const perms = normalize(obj);
  _cache.set(id, { at: Date.now(), perms });
  return perms;
}

function save(cashierId, input) {
  ensureSchema();
  const out = normalize(input);
  require('./database').prepare('UPDATE cashiers SET permissions = ? WHERE id = ?').run(JSON.stringify(out), Number(cashierId));
  _cache.delete(Number(cashierId));
  return out;
}

/** Resumen corto para la lista de usuarios. */
function summary(perms) {
  return CATALOG.filter(p => perms[p.key]).map(p => p.label);
}

const isStaff = (session) => !!(session && session.isCashier && !session.isAdmin);
const has = (session, key) => !isStaff(session) || !!current(session.cashierId)[key];

/** ¿Puede esta sesión hacer METHOD path? (path relativo a /admin). Los administradores siempre pueden. */
function allows(session, method, path) {
  if (!isStaff(session)) return true;
  const m = method === 'HEAD' ? 'GET' : method;
  const p = String(path || '/').replace(/\/+$/, '') || '/';
  const hit = (rules) => rules.some(r => r.methods.includes(m) && r.re.test(p));
  if (hit(BASE_C)) return true;
  const perms = current(session.cashierId);
  return CATALOG_C.some(c => perms[c.key] && hit(c.rules));
}

/** Middleware para el panel /admin: personal de oficina solo donde tiene permiso. */
function guard(req, res, next) {
  if (!isStaff(req.session)) return next();
  // Cuenta desactivada o borrada → cerrar la sesión
  try {
    const db = require('./database');
    const row = db.prepare('SELECT is_active FROM cashiers WHERE id = ?').get(req.session.cashierId);
    if (!row || !row.is_active) return req.session.destroy(() => res.redirect('/admin/login'));
  } catch (_) {}
  if (allows(req.session, req.method, req.path)) return next();
  const wantsJson = req.xhr || /json/i.test(req.get('accept') || '') || /json/i.test(req.get('content-type') || '') || req.path.startsWith('/api/');
  const msg = 'No tenés permiso para esta acción. Pedíselo al administrador.';
  if (wantsJson) return res.status(403).json({ ok: false, success: false, message: msg, error: msg });
  req.session._msg = { type: 'error', text: msg };
  return res.redirect(req.method === 'GET' && req.path === '/' ? '/admin/logout' : '/admin');
}

// Campos con montos que se quitan de los datos enviados a la página si no tiene permiso de ver montos
const MONEY_FIELDS = ['package_price', 'unpaid_balance', 'unpaid_count', 'credit_balance', 'carry_over', 'balance',
  'reg_install_fee', 'reg_prorata', 'reg_discount', 'reg_total', 'price', 'promo_price', 'amount', 'amount_paid'];
function redactMoney(session, rows) {
  if (has(session, 'ver_facturas') || !Array.isArray(rows)) return rows;
  return rows.map(r => { const o = { ...r }; for (const f of MONEY_FIELDS) delete o[f]; return o; });
}

module.exports = { CATALOG, BASE, current, save, normalize, summary, ensureSchema, allows, has, isStaff, guard, redactMoney };
