const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');
const metaWAService = require('./metaWhatsappService');
const fonnteWAService = require('./fonnteWhatsappService');
const gowaWAService = require('./gowaWhatsappService');
const regional = require('../config/regional');

/* ═══ Helper periode & tunggakan (port upstream 105fcab) ═══ */
const INDONESIAN_MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

function getIndonesianMonthName(monthNumber) {
  // Nombre del mes según el locale configurado (es-PY -> "enero")
  const m = Number(monthNumber);
  if (!(m >= 1 && m <= 12)) return String(monthNumber || '');
  const name = new Date(Date.UTC(2000, m - 1, 15)).toLocaleString(regional.locale(), { month: 'long', timeZone: 'UTC' });
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Format Payment Success WhatsApp Message
 */
function formatPaymentSuccessMessage({
  customerName = '',
  invoiceId = '',
  customerUsername = '',
  customerCode = '',
  packageName = '',
  periodMonth = '',
  periodYear = '',
  amount = 0,
  paymentMethod = '',
  paidAt = null,
  companyName = '',
  companyPhone = '',
  portalUrl = '',
  linkPdf = '',
  receiver = '',
  csPhone = '',
  customTemplate = '',
  remainingUnpaidInvoices = null,
  customerId = null
}) {
  let template = String(customTemplate || DEFAULT_PAYMENT_SUCCESS_TEMPLATE).trim();
  if (!template) template = DEFAULT_PAYMENT_SUCCESS_TEMPLATE;

  const periodText = formatIndonesianPeriod(periodMonth, periodYear) || '-';

  const tz = getSetting('timezone', 'America/Asuncion');
  // Sufijo opcional tras la hora (ej. "PYT"); vacío por defecto
  const tzSuffix = String(getSetting('timezone_label', '') || '').trim();

  let formattedTime = '';
  try {
    const { formatDateLocal } = require('../config/settingsManager');
    formattedTime = `${formatDateLocal(paidAt || new Date())} ${tzSuffix}`;
  } catch {
    const now = new Date();
    formattedTime = `${now.toLocaleDateString(regional.locale())} ${now.toLocaleTimeString(regional.locale())} ${tzSuffix}`;
  }

  const formattedAmount = Number(amount || 0).toLocaleString(regional.locale());

  // Sisa tunggakan lain (struk pelunasan lengkap) — port upstream 105fcab
  let remainingList = remainingUnpaidInvoices;
  if (remainingList === null && customerId) {
    try {
      const billingSvc = require('./billingService.js');
      const allUnpaid = billingSvc.getUnpaidInvoicesByCustomerId(customerId) || [];
      remainingList = allUnpaid.filter(inv => String(inv.id) !== String(invoiceId));
    } catch (e) {}
  }
  let tunggakanInfo = '';
  if (remainingList && Array.isArray(remainingList) && remainingList.length > 0) {
    const summary = formatUnpaidInvoicesSummary(remainingList);
    tunggakanInfo = `\n⚠️ *Perhatian Tunggakan Lain:*\nMasih ada *${summary.count} tagihan lain* belum lunas:\n${summary.breakdownText}\n💰 *Total Sisa Tunggakan:* *${regional.currencySymbol()} ${summary.totalAmountStr}*\n_Mohon segera diselesaikan agar layanan tetap lancar._\n`;
  }

  const _invIdMatch = String(invoiceId || '').match(/\d+/);
  const pdfLink = (portalUrl && _invIdMatch) ? (String(portalUrl).replace(/\/$/, '') + '/invoice/' + _invIdMatch[0] + '/pdf') : (portalUrl || '-');

  let rendered = template
    .replace(/{{nama}}/gi, customerName || 'Pelanggan')
    .replace(/{{no_invoice}}/gi, String(invoiceId || '-'))
    .replace(/{{invoice_id}}/gi, String(invoiceId || '-'))
    .replace(/{{username}}/gi, customerUsername || '-')
    .replace(/{{id_pelanggan}}/gi, customerCode || customerUsername || '-')
    .replace(/{{penerima}}/gi, receiver || '-')
    .replace(/{{diterima_oleh}}/gi, receiver || '-')
    .replace(/{{cs_phone}}/gi, csPhone || companyPhone || '-')
    .replace(/{{paket}}/gi, packageName || '-')
    .replace(/{{periode}}/gi, periodText)
    .replace(/{{total}}/gi, formattedAmount)
    .replace(/{{metode}}/gi, paymentMethod || 'Admin / Kasir')
    .replace(/{{waktu}}/gi, formattedTime)
    .replace(/{{tanggal}}/gi, formattedTime)
    .replace(/{{company}}/gi, companyName || 'OPEN-ISP')
    .replace(/{{company_phone}}/gi, companyPhone || '-')
    .replace(/{{link_portal}}/gi, portalUrl || '-')
    .replace(/{{link}}/gi, portalUrl || '-')
    .replace(/{{link_pdf}}/gi, linkPdf || pdfLink)
    .replace(/{{pdf}}/gi, linkPdf || pdfLink)
    .replace(/{{pppoe}}/gi, customerUsername || '-')
    .replace(/{{tunggakan_info}}/gi, tunggakanInfo);

  // Sisipkan info tunggakan lain bila template tidak punya placeholder-nya
  if (tunggakanInfo && !template.includes('{{tunggakan_info}}')) {
    if (rendered.includes('───')) {
      const idx = rendered.lastIndexOf('───');
      rendered = rendered.slice(0, idx) + `${tunggakanInfo}\n` + rendered.slice(idx);
    } else {
      rendered += `\n${tunggakanInfo}`;
    }
  }

  // Process spintax {A|B|C} only if pipe is present
  rendered = rendered.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (match, choices) => {
    const arr = choices.split('|');
    return arr[Math.floor(Math.random() * arr.length)].trim();
  });

  return rendered;
}

// Jeda "mengetik manusiawi": meniru tempo menulis (proporsional panjang pesan).
// Dipakai sebelum kirim pada pengiriman massal (broadcast/cron) agar tidak terlihat bot.
function humanTypingDelay(messageText, opts = {}) {
  const len = String(messageText || '').length;
  const perChar = Number(opts.perChar) || 30;
  const min = Number(opts.min) || 700;
  const max = Number(opts.max) || 3500;
  const ms = Math.min(Math.max(len * perChar, min), max);
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  formatUnpaidInvoicesSummary,
  formatIndonesianPeriod,
  getIndonesianMonthName,
  sendWhatsAppMessage,
  humanTypingDelay,
  sendWA: sendWhatsAppMessage, // Alias untuk kompatibilitas fungsi lama
  getChatHistory,
  getRecentConversations,
  getIndonesianMonthName,
  formatPaymentSuccessMessage,
  DEFAULT_PAYMENT_SUCCESS_TEMPLATE
};
