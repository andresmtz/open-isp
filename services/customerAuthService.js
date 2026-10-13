'use strict';
/**
 * Autenticación de clientes con código de un solo uso (OTP) por WhatsApp.
 *
 * - El código se envía SIEMPRE al teléfono registrado del cliente, nunca al que se escribe.
 * - 6 dígitos con crypto.randomInt; se guarda solo el hash (sha256 + sal).
 * - Vence a los 10 minutos; máximo 5 intentos por código.
 * - Límite de envíos por cliente: 1 cada 60 s y 5 por hora.
 * - Las respuestas no revelan si un teléfono/ID existe (evita enumerar clientes).
 */
const crypto = require('crypto');
const db = require('../config/database');
const { logger } = require('../config/logger');

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;

db.exec(`
  CREATE TABLE IF NOT EXISTS customer_otp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    channel TEXT DEFAULT 'web',
    ip TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_customer_otp_customer ON customer_otp(customer_id, created_at);
`);

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(salt + ':' + code).digest('hex');
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return '****';
  return '*'.repeat(Math.max(0, d.length - 3)) + d.slice(-3);
}

/** Busca el cliente por teléfono, código de cliente, usuario PPPoE o etiqueta (coincidencia exacta). */
function findCustomer(loginId) {
  const customerSvc = require('./customerService');
  const raw = String(loginId || '').trim();
  if (!raw || raw.length > 64) return null;
  let c = customerSvc.findCustomerByAny(raw);
  if (!c) {
    const byPppoe = db.prepare('SELECT id FROM customers WHERE pppoe_username = ? COLLATE NOCASE').get(raw);
    if (byPppoe) c = customerSvc.getCustomerById(byPppoe.id);
  }
  return c || null;
}

/**
 * Genera y envía un código. Devuelve { ok, reason, maskedPhone, customerId }.
 * reason: 'not_found' | 'no_phone' | 'cooldown' | 'too_many' | 'wa_unavailable' | 'send_failed'
 * (el llamador NO debe mostrar 'not_found' / 'no_phone' al usuario).
 */
async function requestOtp(loginId, { channel = 'web', ip = '' } = {}) {
  const customer = findCustomer(loginId);
  if (!customer) return { ok: false, reason: 'not_found' };
  if (!customer.phone) return { ok: false, reason: 'no_phone' };

  const now = Date.now();
  const last = db.prepare('SELECT created_at FROM customer_otp WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1').get(customer.id);
  if (last && now - last.created_at < RESEND_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', retryInSec: Math.ceil((RESEND_COOLDOWN_MS - (now - last.created_at)) / 1000), maskedPhone: maskPhone(customer.phone), customerId: customer.id };
  }
  const sentLastHour = db.prepare('SELECT COUNT(*) c FROM customer_otp WHERE customer_id = ? AND created_at > ?').get(customer.id, now - 3600 * 1000).c;
  if (sentLastHour >= MAX_SENDS_PER_HOUR) return { ok: false, reason: 'too_many', customerId: customer.id };

  const waNotify = require('./waNotifyService');
  let connected = false;
  try { connected = await waNotify.isConnected(); } catch (_) { connected = false; }
  if (!connected) return { ok: false, reason: 'wa_unavailable', customerId: customer.id };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  const company = String(require('../config/settingsManager').getSetting('company_header', '') || '').trim();
  const msg = `🔐 Su código de ingreso${company ? ' a ' + company : ''} es: *${code}*\n\nVálido por 10 minutos. No comparta este código con nadie: nunca se lo pediremos.`;

  const sent = await waNotify.sendText(customer.phone, msg);
  if (!sent) return { ok: false, reason: 'send_failed', customerId: customer.id };

  // Invalida los códigos anteriores del cliente y guarda el nuevo
  db.prepare('UPDATE customer_otp SET used = 1 WHERE customer_id = ? AND used = 0').run(customer.id);
  db.prepare('INSERT INTO customer_otp (customer_id, code_hash, salt, expires_at, channel, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(customer.id, hashCode(code, salt), salt, now + OTP_TTL_MS, channel, String(ip || '').slice(0, 64), now);
  logger.info(`[CustomerAuth] Código enviado al cliente #${customer.id} (${channel})`);
  return { ok: true, maskedPhone: maskPhone(customer.phone), customerId: customer.id };
}

/** Verifica el código del cliente. Devuelve { ok, customer, reason } con reason: 'expired' | 'invalid' | 'locked'. */
function verifyOtp(customerId, code) {
  const id = Number(customerId);
  const clean = String(code || '').replace(/\D/g, '');
  if (!id) return { ok: false, reason: 'expired' };
  const row = db.prepare('SELECT * FROM customer_otp WHERE customer_id = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(id);
  if (!row || Date.now() > row.expires_at) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };

  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(hashCode(clean, row.salt), 'hex');
  const match = clean.length === 6 && expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!match) {
    db.prepare('UPDATE customer_otp SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    if (left <= 0) db.prepare('UPDATE customer_otp SET used = 1 WHERE id = ?').run(row.id);
    return { ok: false, reason: left <= 0 ? 'locked' : 'invalid', attemptsLeft: Math.max(0, left) };
  }
  db.prepare('UPDATE customer_otp SET used = 1 WHERE id = ?').run(row.id);
  const customer = require('./customerService').getCustomerById(id);
  return customer ? { ok: true, customer } : { ok: false, reason: 'expired' };
}

/** Limpieza de códigos viejos (se puede llamar desde un cron). */
function purgeOld() {
  return db.prepare('DELETE FROM customer_otp WHERE created_at < ?').run(Date.now() - 7 * 24 * 3600 * 1000).changes;
}

const MESSAGES = {
  cooldown: (r) => `Ya le enviamos un código. Espere ${r.retryInSec || 60} segundos para pedir otro.`,
  too_many: () => 'Se pidieron demasiados códigos. Intente de nuevo en una hora.',
  wa_unavailable: () => 'El ingreso por código de WhatsApp no está disponible en este momento. Comuníquese con la empresa.',
  send_failed: () => 'No pudimos enviar el código por WhatsApp. Comuníquese con la empresa.',
  expired: () => 'El código venció o no es válido. Pida uno nuevo.',
  invalid: (r) => `Código incorrecto. Le quedan ${r.attemptsLeft} intento(s).`,
  locked: () => 'Demasiados intentos fallidos. Pida un código nuevo.'
};

function messageFor(result) {
  const f = MESSAGES[result && result.reason];
  return f ? f(result) : 'No se pudo completar el ingreso.';
}

module.exports = { requestOtp, verifyOtp, findCustomer, maskPhone, purgeOld, messageFor, OTP_TTL_MS, MAX_ATTEMPTS };
