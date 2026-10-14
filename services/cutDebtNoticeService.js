/**
 * Aviso de deuda periódico a clientes CORTADOS (suspendidos) con deuda pendiente.
 *
 * Configuración (Automatización → Ciclo de facturación → Aviso de deuda a cortados):
 *   cut_debt_notice_enabled  activar / desactivar
 *   cut_debt_notice_days     cada cuántos días se repite (también es la espera después del aviso de corte)
 *   cut_debt_notice_hour     hora del día en que se envía (0-23, hora local)
 *   plantilla: whatsapp_cut_debt_message
 *
 * Reglas: solo estado 'suspended', con teléfono y saldo pendiente > 0. Se deja de enviar cuando
 * paga (deja de estar cortado) o cuando se cancela. Los cancelados nunca reciben mensajes.
 * Requiere WhatsApp habilitado y configurado (config/waGate.js).
 */
const db = require('../config/database');
const cycle = require('../config/billingCycle');
const regional = require('../config/regional');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

const TEMPLATE_KEY = 'whatsapp_cut_debt_message';

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  try { db.exec('ALTER TABLE customers ADD COLUMN cut_notice_last_at TEXT'); } catch (e) {}
  _schemaOk = true;
}

function config() {
  const on = getSetting('cut_debt_notice_enabled', false);
  return {
    enabled: on === true || on === 'true',
    days: Math.min(60, Math.max(1, parseInt(getSetting('cut_debt_notice_days', 7), 10) || 7)),
    hour: Math.min(23, Math.max(0, parseInt(getSetting('cut_debt_notice_hour', 10), 10) || 10)),
  };
}

/** Anota que el cliente recibió un aviso ahora (también lo usa el aviso de corte). */
function markNotified(customerId) {
  ensureSchema();
  try { db.prepare('UPDATE customers SET cut_notice_last_at=? WHERE id=?').run(cycle.nowStamp(), customerId); } catch (_) {}
}

function publicLink() {
  const base = String(getSetting('public_base_url', '') || '').trim().replace(/\/+$/, '');
  return base ? base + '/login' : '';
}

function buildMessage(c, debt) {
  const { getDefault } = require('../config/waTemplates');
  const tpl = String(db.getAppSetting(TEMPLATE_KEY, getDefault(TEMPLATE_KEY)) || getDefault(TEMPLATE_KEY));
  const periods = debt.items.map(i => i.period).join(', ');
  const detail = debt.items.map(i => `• ${i.period}: ${regional.formatMoney(i.balance)}`).join('\n');
  return tpl
    .replace(/{{nama}}/gi, c.name || '-')
    .replace(/{{id_pelanggan}}/gi, c.customer_code || String(c.id))
    .replace(/{{paket}}/gi, c.package_name || '-')
    .replace(/{{tagihan}}|{{total}}/gi, regional.formatNumber(debt.total))
    .replace(/{{rincian_detail}}/gi, detail)
    .replace(/{{rincian}}|{{periode}}/gi, periods || '-')
    .replace(/{{pago}}/gi, String(getSetting('corte_payment_info', '') || '').trim() || 'Comuníquese con nosotros para coordinar el pago.')
    .replace(/{{link}}/gi, publicLink() || '-')
    .replace(/{{company}}/gi, getSetting('company_header', '') || '-')
    .replace(/{{company_phone}}/gi, getSetting('company_phone', '') || '-');
}

/** Clientes a los que corresponde avisar ahora. */
function due() {
  ensureSchema();
  const cfg = config();
  const limit = cycle.addDaysStamp(-cfg.days);
  const pay = require('./paymentReversalService');
  const rows = db.prepare(`SELECT c.*, p.name AS package_name FROM customers c LEFT JOIN packages p ON p.id = c.package_id
    WHERE c.status = 'suspended' AND COALESCE(c.phone,'') <> ''
      AND (c.cut_notice_last_at IS NULL OR c.cut_notice_last_at <= ?)`).all(limit);
  const out = [];
  for (const c of rows) {
    const debt = pay.debtOf(c.id);
    if (debt.total > 0) out.push({ customer: c, debt });
  }
  return out;
}

let _running = false;
/** Envía los avisos pendientes. force=true ignora la hora configurada (no la frecuencia). */
async function run({ force = false } = {}) {
  ensureSchema();
  const cfg = config();
  if (!cfg.enabled) return { skipped: 'desactivado' };
  if (!require('../config/waGate').ready()) return { skipped: 'whatsapp' };
  if (!force && cycle.nowLocal().hour !== cfg.hour) return { skipped: 'hora' };
  if (_running) return { skipped: 'en curso' };
  _running = true;
  const waNotify = require('./waNotifyService');
  const delayMs = Math.max(2, Number(getSetting('whatsapp_broadcast_delay', 5) || 5)) * 1000;
  let sent = 0, failed = 0;
  try {
    for (const { customer, debt } of due()) {
      try {
        const ok = await waNotify.sendText(customer.phone, buildMessage(customer, debt));
        if (ok) { markNotified(customer.id); sent++; } else failed++;
      } catch (e) { failed++; logger.error(`[Aviso a cortados] ${customer.name}: ${e.message}`); }
      await new Promise(r => setTimeout(r, delayMs));
    }
  } finally { _running = false; }
  if (sent || failed) logger.info(`[Aviso a cortados] enviados ${sent}, fallidos ${failed}.`);
  return { sent, failed };
}

module.exports = { ensureSchema, config, markNotified, buildMessage, due, run, TEMPLATE_KEY };
