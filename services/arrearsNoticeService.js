'use strict';
/**
 * arrearsNoticeService.js
 * Notifikasi tunggakan: kirim TAGIHAN + PERINGATAN (menuju nonaktif/hapus).
 * Template editable di Admin → WhatsApp → Template Pesan:
 *  - whatsapp_auto_billing_message      (tagihan/pengingat)
 *  - whatsapp_arrears_warning_message   (peringatan tunggakan/menuju nonaktif)
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const billingSvc = require('./billingService');
const regional = require('../config/regional');

function portalLink() {
  let base = String(getSetting('public_base_url', '') || '').trim();
  if (!base) {
    const h = String(getSetting('server_host', '') || '').trim();
    if (h) base = (/^https?:\/\//i.test(h) ? h : 'http://' + h);
  }
  return (base ? base.replace(/\/+$/, '') : '') + '/customer';
}

function spintax(text) {
  return String(text || '').replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, function (m, choices) {
    const arr = choices.split('|');
    return arr[Math.floor(Math.random() * arr.length)].trim();
  });
}

function info(customer) {
  let invs = [];
  try { invs = billingSvc.getUnpaidInvoicesByCustomerId(customer.id) || []; } catch (e) {}
  const inv = invs.length ? invs[invs.length - 1] : null;
  let pkgName = inv && inv.package_name ? inv.package_name : '';
  if (!pkgName && customer.package_id) {
    try { const p = db.prepare('SELECT name FROM packages WHERE id=?').get(customer.package_id); if (p) pkgName = p.name; } catch (e) {}
  }
  return {
    inv,
    amount: inv ? Number(inv.amount || 0) : 0,
    period: inv ? (inv.period_month + '/' + inv.period_year) : '',
    pkgName: pkgName || '-',
    streak: Number(customer.unpaid_streak || 0),
    batas: Number(getSetting('auto_deactivate_months', 3) || 3),
  };
}

function applyVars(tpl, customer, d) {
  return String(tpl || '')
    .replace(/{{id_pelanggan}}/gi, customer.customer_code || ('ID:' + customer.id))
    .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
    .replace(/{{paket}}/gi, d.pkgName)
    .replace(/{{tagihan}}/gi, d.amount.toLocaleString(regional.locale()))
    .replace(/{{rincian}}/gi, d.period)
    .replace(/{{periode}}/gi, d.period)
    .replace(/{{bulan_nunggak}}/gi, String(d.streak))
    .replace(/{{batas}}/gi, String(d.batas))
    .replace(/{{link}}/gi, portalLink())
    .replace(/{{link_portal}}/gi, portalLink())
    .replace(/{{company}}/gi, getSetting('company_header', '') || '-')
    .replace(/{{company_phone}}/gi, getSetting('company_phone', '') || '-');
}

function buildArrearsMessage(customer) {
  const d = info(customer);
  const def = "*Aviso de deuda*\n\nEstimado/a *{{nama}}* (ID: {{id_pelanggan}}),\n\nLe informamos que su servicio de internet registra *{{bulan_nunggak}} mes(es)* sin pagar.\n\n📦 Plan: {{paket}}\n💰 Total adeudado: {{moneda}} {{tagihan}}\n📅 Período: {{rincian}}\n\nSi la deuda llega a {{batas}} meses, el servicio será dado de baja y para volver a conectarse deberá solicitar una nueva instalación.\n\nDetalle de su deuda: {{link}}\nAnte cualquier consulta, estamos a su disposición.\n— {{company}}";
  const tpl = db.getAppSetting('whatsapp_arrears_warning_message', def) || def;
  return spintax(applyVars(tpl, customer, d));
}

function buildBillMessage(customer) {
  const d = info(customer);
  const def = `Estimado/a {{nama}},\n\nLe enviamos el detalle de su factura de internet:\n\n📦 Plan: {{paket}}\n💰 Monto: {{moneda}} {{tagihan}}\n📅 Período: {{rincian}}\n\nDetalle y pago: {{link}}\n\nGracias.\n— {{company}}`;
  const tpl = db.getAppSetting('whatsapp_auto_billing_message', def) || def;
  return spintax(applyVars(tpl, customer, d));
}

async function sendTo(phone, text) {
  const waNotify = require('./waNotifyService');
  return waNotify.sendText(phone, text);
}

module.exports = { buildArrearsMessage, buildBillMessage, sendTo, info, portalLink, spintax };
