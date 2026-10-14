/**
 * Permisos del personal de oficina (sesiones de "cajero": secretaría, caja, atención).
 *
 * Regla general: TODO lo que no está habilitado acá queda prohibido (denegar por defecto).
 * El administrador elige qué puede hacer el personal en Usuarios → Personal de oficina.
 * Se guarda en el ajuste `staff_permissions` ({ clave: true|false }).
 *
 * Siempre solo del administrador (no aparecen como opción): configuración, automatización,
 * respaldos, actualizaciones, routers/MikroTik/OLT (escritura), usuarios, planes (edición),
 * cancelar clientes, anular pagos, ajustar saldo a favor, borrar clientes o facturas, importar.
 */
const { getSetting, saveSettings } = require('./settingsManager');

const ID = '\\d+';

// Lo mínimo para trabajar: panel (sin ingresos), planes, zonas y su asistencia.
const BASE = [
  ['GET', '^/$'],
  ['GET', '^/api/stats$'],
  ['GET|POST', '^/logout$'],
  ['GET', '^/set-active-router$'],
  ['GET', '^/packages$'],
  ['GET', '^/areas$'],
  ['GET|POST', '^/cashiers/attendance(/checkin|/checkout)?$'],
];

// `needs`: al habilitar un permiso se habilitan también estos (no se puede cobrar sin ver clientes y facturas).
const CATALOG = [
  { key: 'ver_clientes', label: 'Ver clientes', help: 'Lista y ficha de clientes, conexión, consumo y etiquetas de ONU. Solo consulta.', def: true, rules: [
    ['GET', '^/customers$'],
    ['GET', `^/customers/${ID}/sticker-onu$`],
    ['GET', `^/api/customers/${ID}/pppoe-traffic$`],
    ['GET', '^/api/customers/live-sessions$'],
    ['GET', `^/api/odps/${ID}/ports$`],
    ['GET', '^/onu-stickers$'],
  ] },
  { key: 'ver_facturas', label: 'Ver facturas y deudas', help: 'Facturas, deuda de cada cliente, imprimir facturas. Solo consulta.', def: true, rules: [
    ['GET', '^/billing$'],
    ['GET', `^/billing/${ID}/(pdf|print|print-thermal)$`],
    ['GET', `^/api/billing/unpaid/${ID}$`],
    ['GET', `^/api/customers/${ID}/(billing-year|paid-months)$`],
    ['GET', `^/customers/${ID}/payment-info$`],
  ] },
  { key: 'cobrar', label: 'Cobrar y registrar pagos', help: 'Cobrar a clientes (pago total o parcial), marcar facturas como pagadas y ver su propio reporte de cobros.', def: true, needs: ['ver_clientes', 'ver_facturas'], rules: [
    ['GET', '^/cashiers/reports$'],
    ['POST', `^/customers/${ID}/(receive|billing/pay)$`],
    ['POST', `^/billing/${ID}/pay$`],
    ['POST', '^/billing/pay-bulk$'],
  ] },
  { key: 'enviar_facturas', label: 'Enviar facturas y comprobantes por WhatsApp', help: 'Botones de enviar factura o comprobante a un cliente.', def: true, needs: ['ver_facturas'], rules: [
    ['POST', `^/billing/${ID}/(whatsapp|send-pdf-wa)$`],
  ] },
  { key: 'promesas', label: 'Dar promesas de pago', help: 'Respeta el máximo de días y de promesas por mes de Automatización.', def: true, needs: ['ver_clientes', 'ver_facturas'], rules: [
    ['GET', `^/customers/${ID}/promise-preview$`],
    ['POST', `^/customers/${ID}/promise$`],
  ] },
  { key: 'clientes_alta', label: 'Agregar y editar clientes', help: 'Alta de clientes nuevos (crea el usuario PPPoE en el MikroTik), edición de datos y aprobación de solicitudes.', def: true, needs: ['ver_clientes'], rules: [
    ['POST', '^/customers$'],
    ['POST', `^/customers/${ID}/(update|generate-pppoe)$`],
    ['POST', `^/registrations/${ID}/(approve|reject)$`],
    ['GET', '^/api/mikrotik/(users|profiles|hotspot-user-profiles)(/\\d+)?$'],
  ] },
  { key: 'reclamos', label: 'Reclamos de clientes', help: 'Ver, crear y actualizar reclamos (no borrarlos).', def: true, rules: [
    ['GET', '^/tickets$'],
    ['POST', '^/tickets/create$'],
    ['POST', `^/tickets/${ID}/update$`],
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
  { key: 'red_ver', label: 'Ver estado de la red', help: 'MikroTik, OLT y ONU en modo consulta. No puede cambiar nada.', def: false, rules: [
    ['GET', '^/mikrotik(/display)?$'],
    ['GET', '^/api/mikrotik/(active-pppoe|active-hotspot|monitoring-display-data)$'],
    ['GET', '^/olts$'],
    ['GET', `^/olts/(${ID}|all)/stats$`],
    ['GET', '^/devices$'],
    ['GET', '^/api/devices$'],
  ] },
];

const compile = (rules) => rules.map(([m, re]) => ({ methods: m.split('|'), re: new RegExp(re) }));
const BASE_C = compile(BASE);
const CATALOG_C = CATALOG.map(p => ({ key: p.key, rules: compile(p.rules) }));

function current() {
  let stored = getSetting('staff_permissions', null);
  if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch (_) { stored = null; } }
  const out = {};
  for (const p of CATALOG) {
    // Permisos nuevos que no estaban cuando el admin guardó: quedan apagados (nunca se otorga acceso sin que lo marque)
    const v = stored && typeof stored === 'object' ? (Object.prototype.hasOwnProperty.call(stored, p.key) ? stored[p.key] : false) : p.def;
    out[p.key] = v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  }
  return withNeeds(out);
}

function withNeeds(out) {
  for (const p of CATALOG) if (out[p.key]) for (const n of (p.needs || [])) out[n] = true;
  return out;
}

function save(input) {
  const out = {};
  for (const p of CATALOG) out[p.key] = !!(input && (input[p.key] === true || input[p.key] === 'on' || input[p.key] === '1' || input[p.key] === 'true'));
  withNeeds(out);
  saveSettings({ staff_permissions: out });
  return out;
}

const isStaff = (session) => !!(session && session.isCashier && !session.isAdmin);
const has = (session, key) => !isStaff(session) || !!current()[key];

/** ¿Puede esta sesión hacer METHOD path? (path relativo a /admin). Los administradores siempre pueden. */
function allows(session, method, path) {
  if (!isStaff(session)) return true;
  const m = method === 'HEAD' ? 'GET' : method;
  const p = String(path || '/').replace(/\/+$/, '') || '/';
  const hit = (rules) => rules.some(r => r.methods.includes(m) && r.re.test(p));
  if (hit(BASE_C)) return true;
  const perms = current();
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

module.exports = { CATALOG, BASE, current, save, allows, has, isStaff, guard };
