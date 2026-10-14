/**
 * Habilitación de WhatsApp: ningún envío automático sale si WhatsApp no está HABILITADO en la
 * configuración y el proveedor elegido no tiene sus datos cargados.
 *
 *   whatsapp_enabled = true    y según wa_gateway_type:
 *     gowa     → gowa_base_url
 *     fonnte   → fonnte_token
 *     meta     → meta_phone_number_id + meta_access_token
 *     baileys  → sesión vinculada (se verifica al enviar)
 *
 * Los botones de "probar conexión" de la configuración no pasan por acá, para poder probar
 * los datos antes de habilitar.
 */
const { getSetting } = require('./settingsManager');

const REQUIRED = {
  gowa: [['gowa_base_url', 'URL del servidor GoWA']],
  fonnte: [['fonnte_token', 'token de Fonnte']],
  meta: [['meta_phone_number_id', 'Phone Number ID de Meta'], ['meta_access_token', 'Access Token de Meta']],
  baileys: [],
};

function on(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

function status() {
  const enabled = on(getSetting('whatsapp_enabled', false));
  const gateway = String(getSetting('wa_gateway_type', 'gowa') || 'gowa').toLowerCase();
  const req = REQUIRED[gateway];
  const missing = [];
  if (!req) missing.push(`proveedor "${gateway}" no soportado`);
  else for (const [key, label] of req) if (!String(getSetting(key, '') || '').trim()) missing.push(label);
  const configured = missing.length === 0;
  let reason = '';
  if (!enabled) reason = 'WhatsApp está deshabilitado en la configuración';
  else if (!configured) reason = 'WhatsApp no está configurado: falta ' + missing.join(', ');
  return { enabled, gateway, configured, missing, ok: enabled && configured, reason };
}

function ready() { return status().ok; }

let _lastLog = 0;
/** Lanza error si WhatsApp no está listo (registra el motivo como máximo una vez por minuto). */
function assertReady() {
  const s = status();
  if (s.ok) return s;
  const now = Date.now();
  if (now - _lastLog > 60000) {
    _lastLog = now;
    try { require('./logger').logger.info(`[WhatsApp] Envío omitido: ${s.reason}.`); } catch (_) {}
  }
  const e = new Error(s.reason);
  e.code = 'WA_NOT_READY';
  throw e;
}

module.exports = { status, ready, assertReady };
