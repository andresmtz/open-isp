'use strict';
/**
 * Pasarelas de pago automáticas (QRIS, Tripay, Midtrans, Xendit, webhook de billeteras, "auto-saldado" por
 * notificaciones, códigos únicos de monto, compra de fichas en línea, donaciones al autor original).
 * Son de Indonesia y no aplican en Paraguay: quedan DESACTIVADAS por defecto (parámetro
 * payment_gateways_enabled). Desactivadas: sus rutas responden 404, sus menús y opciones no se muestran,
 * el recordatorio de factura no suma códigos únicos y no se generan imágenes QR.
 * El pago se informa con las formas de pago de Configuración (corte_payment_info) y el comprobante por WhatsApp.
 */
const { getSetting } = require('./settingsManager');

const on = (v) => v === true || v === 'true' || v === 1 || v === '1';
function gatewaysEnabled() { return on(getSetting('payment_gateways_enabled', false)); }

/**
 * Funciones opcionales (desactivadas por defecto; se habilitan por parámetro, pensado para el SaaS):
 *   gateways          payment_gateways_enabled   pasarelas de Indonesia (ver arriba)
 *   wisphub_migration wisphub_migration_enabled  herramienta de migración desde WispHub (Sistema → Migración WispHub)
 *   github_update     github_update_enabled      "Actualizar desde GitHub" (traería el código original y pisaría
 *                                                las personalizaciones de esta instalación)
 *   staff_attendance  staff_attendance_enabled   control de asistencia del personal
 *   mobile_api        mobile_api_enabled         API de la app móvil (/api/customer); salta los permisos del panel
 *   public_register   public_register_enabled    registro público de clientes desde el portal
 */
const FEATURES = {
  gateways: { setting: 'payment_gateways_enabled', routes: null },
  wisphub_migration: { setting: 'wisphub_migration_enabled', routes: [/^\/admin\/wisphub/i] },
  github_update: { setting: 'github_update_enabled', routes: [/^\/admin\/update/i, /^\/admin\/api\/system\/update/i] },
  // API de la app móvil (/api/customer): tiene su propio login de administrador, oficina, cobrador y técnico
  // que NO respeta los permisos del panel. No hay app en uso: queda apagada.
  mobile_api: { setting: 'mobile_api_enabled', routes: [/^\/api\/customer(\/|$)/i] },
  // Registro público de clientes desde el portal (las solicitudes las carga la oficina o el técnico)
  public_register: { setting: 'public_register_enabled', routes: [/^\/customer\/register(\/|$)/i] },
  // Control de asistencia del personal (entrada/salida con foto): oficina, técnicos y cobradores
  staff_attendance: { setting: 'staff_attendance_enabled', routes: [/^\/admin\/(cashiers\/)?attendance/i, /^\/admin\/api\/attendance/i, /^\/(tech|collector)\/(api\/)?attendance/i] },
};
function featureEnabled(name) { const f = FEATURES[name]; return !!f && on(getSetting(f.setting, false)); }

// Rutas de pasarelas (método opcional, expresión sobre la ruta completa)
const GATEWAY_ROUTES = [
  /^\/customer\/qris\//i,
  /^\/customer\/check-billing/i,          // consulta pública de deuda por ID + pago QRIS
  /^\/customer\/voucher(\/|$)/i,          // compra pública de fichas con pago en línea
  /^\/customer\/voucher\/qris\//i,
  /^\/customer\/public\/voucher\/create-payment/i,
  /^\/customer\/public\/payment\/create\//i,
  /^\/customer\/payment\/(create|status)\//i,
  /^\/customer\/payment\/callback/i,
  /^\/isolated\/quick-qris\//i,
  /^\/api\/webhook\/v1\/payment-notif/i,
  /^\/api\/webhook\/mayar/i,             // pasarela Mayar (Indonesia): marcaba facturas pagadas sin clave
  /^\/api\/voucher-payment\//i,
  /^\/api\/customer\/invoices\/\d+\/qris-image/i,
  /^\/admin\/billing\/\d+\/qris-(assign|clear)/i,
  /^\/admin\/settings\/qris-upload/i,
  /^\/admin\/ewallet-logs/i,
  /^\/admin\/payment-unmatched/i,
  /^\/admin\/autolunas/i,
  /^\/admin\/api\/webhook\/payment-notif/i,
  /^\/(public\/)?(donate|donasi)/i,
  /^\/qris/i,
];

function isGatewayPath(p) { return GATEWAY_ROUTES.some(re => re.test(String(p || ''))); }

/** Middleware: con las pasarelas desactivadas, sus rutas no existen. */
function guard(req, res, next) {
  const gw = gatewaysEnabled();
  res.locals.gatewaysOn = gw;
  res.locals.attendanceOn = featureEnabled('staff_attendance');
  if (!gw && isGatewayPath(req.path)) return res.status(404).send('No disponible');
  // Registro público apagado: los botones "Registrarse" llevan al WhatsApp de la empresa (ahí se toman los datos)
  if (req.method === 'GET' && /^\/customer\/register\/?$/i.test(req.path) && !featureEnabled('public_register')) {
    try {
      const regional = require('./regional');
      const num = regional.normalizePhone(String(getSetting('company_whatsapp', '') || getSetting('company_phone', '') || '').replace(/\D/g, ''));
      if (num && num.length >= 9) return res.redirect(302, 'https://wa.me/' + num + '?text=' + encodeURIComponent('Hola, quiero contratar el servicio de internet.'));
    } catch (_) {}
  }
  for (const [name, f] of Object.entries(FEATURES)) {
    if (f.routes && f.routes.some(re => re.test(req.path)) && !featureEnabled(name)) return res.status(404).send('No disponible');
  }
  next();
}

module.exports = { gatewaysEnabled, featureEnabled, isGatewayPath, guard, GATEWAY_ROUTES, FEATURES };
