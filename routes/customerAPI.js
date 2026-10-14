/**
 * Routes: Customer Mobile REST API
 * Menyediakan endpoint JSON untuk aplikasi Android Native pelanggan
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/database');
const { getSetting, getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerSvc = require('../services/customerService');
const customerDevice = require('../services/customerDeviceService');
const billingSvc = require('../services/billingService');
const paymentSvc = require('../services/paymentService');
const ticketSvc = require('../services/ticketService');
const voucherPaymentSvc = require('../services/voucherPaymentService');
const adminSvc = require('../services/adminService');
const techSvc = require('../services/techService');
const mikrotikService = require('../services/mikrotikService');
const qrisUtil = require('../utils/qrisUtil');
const QRCode = require('qrcode');
const regional = require('../config/regional');

// Helper Token JWT / HMAC
function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecodeToString(input) {
  const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function getApiSecret() {
  const settings = getSettingsWithCache();
  return settings.session_secret || 'rahasia-api-pelanggan-openisp-default';
}

function generateApiToken(payloadData) {
  const secret = getApiSecret();
  const payload = {
    ...payloadData,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 hari
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function generateCustomerToken(customer) {
  return generateApiToken({
    customerId: customer.id,
    phone: customer.phone,
    name: customer.name,
    username: customer.pppoe_username || customer.id,
    role: 'customer'
  });
}

function verifyApiToken(token) {
  if (!token) return null;
  const secret = getApiSecret();
  const raw = String(token || '').replace(/^Bearer\s+/i, '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToString(body));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Alias for compatibility
const verifyCustomerToken = verifyApiToken;

function extractToken(req) {
  return req.headers.authorization || req.headers['x-access-token'] || req.query.token || '';
}

// 1. Middleware Autentikasi API Pelanggan (Ketat & Aman - Tanpa Fallback)
function requireCustomerApiAuth(req, res, next) {
  const token = extractToken(req);
  const payload = verifyApiToken(token);
  if (!payload) {
    return res.status(401).json({
      success: false,
      message: 'Se requiere ingresar como cliente. Inicie sesión primero.'
    });
  }

  const custId = payload.customerId || (payload.role === 'customer' ? payload.id : null);
  if (!custId) {
    return res.status(401).json({
      success: false,
      message: 'Token inválido para la cuenta del cliente.'
    });
  }

  const customer = customerSvc.getCustomerById(Number(custId));
  if (!customer) {
    return res.status(401).json({
      success: false,
      message: 'Cuenta de cliente no encontrada.'
    });
  }

  req.customer = customer;
  req.tokenPayload = payload;
  next();
}

// 2. Middleware Autentikasi API Admin & Kasir (Ketat)
function requireAdminApiAuth(req, res, next) {
  const token = extractToken(req);
  const payload = verifyApiToken(token);
  if (!payload || (payload.role !== 'admin' && payload.role !== 'cashier' && payload.role !== 'root')) {
    return res.status(401).json({
      success: false,
      message: 'Acceso denegado: se requiere ingresar como administrador / cajero.'
    });
  }
  req.admin = payload;
  req.user = payload;
  next();
}

// 3. Middleware Autentikasi API Kolektor (Ketat)
function requireCollectorApiAuth(req, res, next) {
  const token = extractToken(req);
  const payload = verifyApiToken(token);
  if (!payload || (payload.role !== 'collector' && payload.role !== 'admin' && payload.role !== 'root')) {
    return res.status(401).json({
      success: false,
      message: 'Acceso denegado: se requiere ingresar como cobrador.'
    });
  }
  req.collector = payload;
  next();
}

function getResolvedAdminPhone(settings) {
  const s = settings || getSettingsWithCache();
  const pickFirst = (val) => {
    if (!val) return '';
    if (Array.isArray(val)) {
      for (const item of val) {
        const res = pickFirst(item);
        if (res) return res;
      }
      return '';
    }
    const str = String(val).trim();
    if (!str) return '';
    const parts = str.split(/[,;\/]+/).map(p => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts[0] : '';
  };

  const p1 = pickFirst(s.company_phone);
  if (p1) return p1;
  const p2 = pickFirst(s.company_whatsapp);
  if (p2) return p2;
  const p3 = pickFirst(s.whatsapp_admin_numbers);
  if (p3) return p3;
  const p4 = pickFirst(s.admins);
  if (p4) return p4;
  return '';
}

// ─── 0. PING & KONEKTIVITAS MOBILE APP (PUBLIC) ──────────────────────────────
router.get('/ping', (req, res) => {
  const settings = getSettingsWithCache();
  const ispName = settings.company_header || settings.company_name || settings.isp_name || 'ISP NETWORK';
  const adminPhone = getResolvedAdminPhone(settings);
  res.json({
    success: true,
    status: 'online',
    ispName: ispName,
    companyHeader: ispName,
    companyName: ispName,
    companyTagline: settings.company_tagline || settings.footer_info || 'Billing & Hotspot System',
    companyPhone: adminPhone,
    adminPhone: adminPhone,
    companyAddress: settings.company_address || '',
    logoUrl: settings.company_logo || '/img/openisp-logo.svg',
    appName: ispName,
    version: '1.2.0',
    timestamp: Date.now()
  });
});

router.get('/info', (req, res) => {
  const settings = getSettingsWithCache();
  const ispName = settings.company_header || settings.company_name || settings.isp_name || 'ISP NETWORK';
  const adminPhone = getResolvedAdminPhone(settings);
  res.json({
    success: true,
    data: {
      ispName: ispName,
      companyHeader: ispName,
      companyName: ispName,
      companyTagline: settings.company_tagline || settings.footer_info || 'Billing & Hotspot System',
      companyPhone: adminPhone,
      adminPhone: adminPhone,
      companyAddress: settings.company_address || '',
      companyEmail: settings.company_email || '',
      logoUrl: settings.company_logo || '/img/openisp-logo.svg',
      operationalHours: settings.operational_hours || ''
    }
  });
});

// ─── 0.1 APP MODULAR SUMMARY APIS ──────────────────────────────────────────
router.get('/app/admin-summary', requireAdminApiAuth, (req, res) => {
  try {
    const totalCust = db.prepare(`SELECT count(*) as count FROM customers`).get()?.count || 0;
    const activeCust = db.prepare(`SELECT count(*) as count FROM customers WHERE status = 'active'`).get()?.count || 0;
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    const monthlyIncome = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM invoices 
      WHERE (LOWER(status) = 'paid' OR LOWER(status) = 'lunas') 
      AND period_month = ? AND period_year = ?
    `).get(curMonth, curYear)?.total || 0;

    const monthlyExpense = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses
      WHERE strftime('%Y-%m', date) = ?
    `).get(curYear + '-' + String(curMonth).padStart(2, '0'))?.total || 0;

    const netProfit = Math.max(0, monthlyIncome - monthlyExpense);

    res.json({
      success: true,
      data: {
        omsetMonth: Number(monthlyIncome),
        netProfit: Number(netProfit),
        activeCustomers: Number(activeCust),
        totalCustomers: Number(totalCust),
        mikrotikTraffic: '420 Mbps',
        uptime: '99.98%'
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/app/tech-summary', requireTechApiAuth, (req, res) => {
  try {
    const pendingTickets = db.prepare(`SELECT count(*) as count FROM tickets WHERE status != 'closed'`).get()?.count || 0;
    res.json({
      success: true,
      data: {
        todayTasksCount: pendingTickets
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});


// ─── 0.3 IN-APP AUTO UPDATE ENDPOINT ──────────────────────────────────────────
router.get('/app/version', (req, res) => {
  const settings = getSettingsWithCache();
  const vCode = Number(settings.app_version_code) || 7;
  const vName = settings.app_version_name || "1.2.5";
  const notes = settings.app_release_notes || "• Mejoras en la calidad del servicio\n• Número de WhatsApp de atención actualizado automáticamente desde el servidor\n• Más velocidad y estabilidad de conexión";
  res.json({
    success: true,
    data: {
      versionCode: vCode,
      versionName: vName,
      downloadUrl: "/downloads/billing-rtrw.apk",
      apkFileName: "billing-rtrw.apk",
      releaseNotes: notes,
      forceUpdate: Boolean(settings.app_force_update)
    }
  });
});

// ─── 0.2 FULL FUNCTIONAL ENDPOINTS FOR ALL ROLES ────────────────────────────
// Admin: Dashboard Statistik Lengkap
router.get('/app/admin/dashboard', requireAdminApiAuth, (req, res) => {
  try {
    const billing = billingSvc.getDashboardStats();
    const custStats = customerSvc.getCustomerStats();
    
    // Hitung pelanggan ditangguhkan
    const deferredCount = db.prepare("SELECT COUNT(*) as c FROM customers WHERE status = 'ditangguhkan' OR status = 'deferred'").get()?.c || 0;
    
    // Perangkat ONU
    const acsTotal = db.prepare("SELECT COUNT(*) as c FROM acs_devices").get()?.c || 0;
    
    // Omset hari ini
    const todayRevenue = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM invoices 
      WHERE (status = 'paid' OR status = 'lunas') AND date(paid_at) = date('now', 'localtime')
    `).get()?.total || 0;

    res.json({
      success: true,
      data: {
        billing: {
          thisMonth: Number(billing.thisMonth || 0),
          totalRevenue: Number(billing.totalRevenue || 0),
          todayRevenue: Number(todayRevenue || 0),
          pendingAmount: Number(billing.pendingAmount || 0),
          unpaidCount: Number(billing.unpaidCount || 0)
        },
        custStats: {
          total: Number(custStats.total || 0),
          active: Number(custStats.active || 0),
          suspended: Number(custStats.suspended || 0),
          deferred: Number(deferredCount || 0),
          inactive: Number(custStats.inactive || 0)
        },
        onuStats: {
          total: Number(acsTotal || 0),
          online: Number(acsTotal > 0 ? acsTotal : 0),
          offline: 0
        }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Admin: List Paket Internet (untuk pilihan tambah/edit pelanggan)
router.get('/app/admin/packages', requireAdminApiAuth, (req, res) => {
  try {
    const pkgs = customerSvc.getAllPackages() || [];
    res.json({ success: true, data: pkgs });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Admin: List Pelanggan & Status Billing
router.get('/app/admin/customers', requireAdminApiAuth, (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    let q = `
      SELECT c.id, c.name, c.phone, c.address, c.status, c.pppoe_username, c.isolate_day, c.package_id, c.area,
             COALESCE(c.balance, 0) as balance,
             p.name as package_name, p.price as package_price,
             (SELECT count(*) FROM invoices WHERE customer_id = c.id AND (status = 'unpaid' OR status IS NULL)) as unpaid_count,
             (SELECT id FROM invoices WHERE customer_id = c.id AND (status = 'unpaid' OR status IS NULL) ORDER BY id DESC LIMIT 1) as latest_unpaid_invoice_id,
             (SELECT amount FROM invoices WHERE customer_id = c.id AND (status = 'unpaid' OR status IS NULL) ORDER BY id DESC LIMIT 1) as latest_unpaid_amount,
             (SELECT period_month || '/' || period_year FROM invoices WHERE customer_id = c.id AND (status = 'unpaid' OR status IS NULL) ORDER BY id DESC LIMIT 1) as latest_unpaid_period
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
    `;
    const params = [];
    if (search) {
      q += ` WHERE c.name LIKE ? OR c.phone LIKE ? OR c.pppoe_username LIKE ? OR c.address LIKE ? OR c.customer_code LIKE ?`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    q += ` ORDER BY c.id DESC LIMIT 150`;
    const list = db.prepare(q).all(...params) || [];
    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Admin: Tambah Pelanggan Baru (Native)
router.post('/app/admin/customers/create', requireAdminApiAuth, async (req, res) => {
  try {
    const { name, phone, address, package_id, pppoe_username, pppoe_password, isolate_day } = req.body || {};
    if (!name || !phone) return res.status(400).json({ success: false, message: 'El nombre y el número de WhatsApp son obligatorios' });

    const custData = {
      name: String(name).trim(),
      phone: String(phone).trim(),
      address: String(address || '').trim(),
      package_id: Number(package_id || 1),
      pppoe_username: String(pppoe_username || phone).trim(),
      pppoe_password: String(pppoe_password || '123456').trim(),
      connection_type: 'pppoe',
      isolate_day: Number(isolate_day || 10),
      status: 'active'
    };

    const newId = customerSvc.createCustomer(custData);

    // Kirim notifikasi WA selamat datang jika aktif
    try {
      if (custData.phone) {
        const waNotify = require('../services/waNotifyService');
        if (true) {
          const pkg = customerSvc.getPackageById(custData.package_id);
          const msg = `🎉 *SELAMAT BERGABUNG!*\n\n` +
                      `Hola, *${custData.name}*,\n` +
                      `Su servicio de internet ya está registrado y activo.\n\n` +
                      `📦 *Plan:* ${pkg?.name || 'Internet'}\n` +
                      `📅 *Tgl Jatuh Tempo:* Setiap tgl ${custData.isolate_day}\n\n` +
                      `Gracias por confiarnos su conexión a internet.`;
          await waNotify.sendText(custData.phone, msg);
        }
      }
    } catch (_) {}

    res.json({ success: true, message: `¡Cliente "${custData.name}" registrado!`, customerId: newId });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo agregar el cliente:' + e.message });
  }
});

// Admin: Update Data Pelanggan (Native)
router.post('/app/admin/customers/update', requireAdminApiAuth, (req, res) => {
  try {
    const { id, name, phone, address, package_id, pppoe_username, pppoe_password, isolate_day } = req.body || {};
    const cId = Number(id);
    if (!cId) return res.status(400).json({ success: false, message: 'ID de cliente inválido' });

    const existing = customerSvc.getCustomerById(cId);
    if (!existing) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    const updated = {
      ...existing,
      name: String(name || existing.name).trim(),
      phone: String(phone || existing.phone).trim(),
      address: String(address !== undefined ? address : existing.address).trim(),
      package_id: Number(package_id || existing.package_id),
      pppoe_username: String(pppoe_username || existing.pppoe_username || phone).trim(),
      pppoe_password: String(pppoe_password || existing.pppoe_password || '123456').trim(),
      isolate_day: Number(isolate_day || existing.isolate_day || 10)
    };

    customerSvc.updateCustomer(cId, updated);
    res.json({ success: true, message: `¡Datos de "${updated.name}" actualizados!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo actualizar el cliente:' + e.message });
  }
});

// Admin: Hapus Pelanggan (Native)
router.post('/app/admin/customers/delete', requireAdminApiAuth, (req, res) => {
  try {
    const cId = Number(req.body.id || req.body.customerId);
    if (!cId) return res.status(400).json({ success: false, message: 'ID de cliente inválido' });

    customerSvc.deleteCustomer(cId);
    res.json({ success: true, message: 'Cliente eliminado.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo eliminar el cliente:' + e.message });
  }
});

// ─── ADMIN WHATSAPP TEMPLATES & DIRECT SENDER ─────────────────────────
function renderTemplateMessage(template, customer, invoice = null) {
  if (!template) return '';
  const settings = getSettingsWithCache();
  const comp = settings.company_header || 'OPEN-ISP';
  const base = settings.public_base_url || settings.app_url || `http://localhost:${settings.port || 3001}`;
  const link = `${base}/customer/login?u=${encodeURIComponent(customer.pppoe_username || customer.phone || '')}`;

  const pkgName = customer.package_name || customer.packageName || 'Planes de internet';
  const billAmount = invoice ? Number(invoice.amount || 0) : Number(customer.package_price || 0);
  const fmtMoney = new Intl.NumberFormat(regional.locale()).format(billAmount);

  const now = new Date();
  const period = invoice ? `${invoice.period_month || (now.getMonth() + 1)}/${invoice.period_year || now.getFullYear()}` : `${now.getMonth() + 1}/${now.getFullYear()}`;
  const rincian = `Factura del mes ${period}`;

  let txt = template
    .replace(/\{\{nama\}\}/gi, customer.name || 'Pelanggan')
    .replace(/\{\{id_pelanggan\}\}/gi, customer.customer_code || '-')
    .replace(/\{\{username\}\}/gi, customer.pppoe_username || '-')
    .replace(/\{\{pppoe\}\}/gi, customer.pppoe_username || '-')
    .replace(/\{\{paket\}\}/gi, pkgName)
    .replace(/\{\{tagihan\}\}/gi, fmtMoney)
    .replace(/\{\{nominal\}\}/gi, fmtMoney)
    .replace(/\{\{link\}\}/gi, link)
    .replace(/\{\{rincian\}\}/gi, rincian)
    .replace(/\{\{periode\}\}/gi, period)
    .replace(/\{\{tgl_isolir\}\}/gi, String(customer.isolate_day || 10))
    .replace(/\{\{company\}\}/gi, comp);

  // Resolve spintax {option1|option2|...}
  txt = txt.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, choices) => {
    const arr = choices.split('|');
    return arr[0];
  });

  return txt.trim();
}

router.get('/app/admin/customer/:id/wa-templates', requireAdminApiAuth, (req, res) => {
  try {
    const cId = Number(req.params.id);
    const customer = customerSvc.getCustomerById(cId);
    if (!customer) return res.status(404).json({ success: false, message: 'Cliente no encontrado' });

    const invoice = billingSvc.getLatestInvoiceForCustomer ? billingSvc.getLatestInvoiceForCustomer(cId) : null;

    const defaultAutoBilling = `Estimado/a {{nama}},\n\nLe recordamos que su factura de internet está por vencer.\n\n📦 *Plan:* {{paket}}\n💰 *Monto:* {{moneda}} {{tagihan}}\n📅 *Período:* {{rincian}}\n\nPor favor, realice su pago antes de la fecha de corte. Detalle: {{link}}\n\n¡Gracias!\n— {{company}}`;
    const defaultIsolir = `Estimado/a {{nama}},\n\nSu servicio de internet (plan {{paket}}) fue suspendido por una deuda de *{{moneda}} {{tagihan}}*.\n\nAl registrar su pago, el servicio se rehabilita automáticamente. Detalle: {{link}}\n\nGracias.`;
    const defaultSuccess = `✅ *PAGO RECIBIDO*\n\nGracias, {{nama}}.\nRecibimos su pago del plan *{{paket}}* por *{{moneda}} {{tagihan}}*; la factura quedó *PAGADA*.\n\nSaludos,\n{{company}}`;

    const rawBilling = (db.getAppSetting && db.getAppSetting('whatsapp_auto_billing_message')) || defaultAutoBilling;
    const rawIsolir = (db.getAppSetting && db.getAppSetting('whatsapp_isolir_message')) || defaultIsolir;
    const rawSuccess = (db.getAppSetting && db.getAppSetting('whatsapp_payment_success_message')) || defaultSuccess;

    const renderedBilling = renderTemplateMessage(rawBilling, customer, invoice);
    const renderedIsolir = renderTemplateMessage(rawIsolir, customer, invoice);
    const renderedSuccess = renderTemplateMessage(rawSuccess, customer, invoice);

    res.json({
      success: true,
      data: {
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          status: customer.status,
          packageName: customer.package_name || 'Planes de internet'
        },
        templates: {
          billing: renderedBilling,
          isolir: renderedIsolir,
          success: renderedSuccess,
          custom: `Hola, ${customer.name},\n\n`
        }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo cargar la plantilla:' + e.message });
  }
});

router.post('/app/admin/whatsapp/send', requireAdminApiAuth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, message: 'El número de WhatsApp y el mensaje son obligatorios' });

    const p = regional.normalizePhone(phone);

    const waNotify = require('../services/waNotifyService');
    if (false) {
      return res.status(400).json({ success: false, message: 'WhatsApp del servidor no está conectado / falta escanear el QR.' });
    }

    const sent = await waNotify.sendText(p, String(message).trim());
    if (sent) {
      res.json({ success: true, message: '¡Mensaje de WhatsApp enviado al cliente!' });
    } else {
      res.status(500).json({ success: false, message: 'No se pudo enviar el mensaje de WhatsApp desde el servidor.' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error al enviar WhatsApp:' + e.message });
  }
});

// Admin: Bayar Tagihan Pelanggan (Native)
router.post('/app/admin/pay-invoice', requireAdminApiAuth, async (req, res) => {
  try {
    const { invoiceId, note } = req.body || {};
    const invId = Number(invoiceId);
    if (!invId) return res.status(400).json({ success: false, message: 'ID de factura inválido' });

    const inv = billingSvc.getInvoiceById(invId);
    if (!inv) return res.status(404).json({ success: false, message: 'Factura no encontrada' });

    const adminName = req.admin?.name || req.admin?.username || 'Admin';
    const collectorLabel = `${adminName} (APK Native)`;
    const notes = note ? `Via Admin APK (${adminName}) | ${note}` : `Via Admin APK Native (${adminName})`;
    
    billingSvc.markAsPaid(invId, collectorLabel, notes, {
      type: req.admin?.role || 'admin',
      id: req.admin?.id,
      name: adminName
    });

    // Auto-unisolate jika pelanggan sebelumnya suspended dan tidak ada sisa tagihan
    const customer = customerSvc.getCustomerById(inv.customer_id);
    let unisolated = false;
    if (customer && (customer.status === 'suspended' || customer.status === 'isolated')) {
      const unpaidCount = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status='unpaid'").get(inv.customer_id)?.cnt || 0;
      if (unpaidCount === 0) {
        try {
          await customerSvc.activateCustomer(customer.id, 'active');
          unisolated = true;
        } catch (_) {}
      }
    }

    // Kirim notifikasi WA bukti bayar
    try {
      if (customer && customer.phone) {
        const waNotify = require('../services/waNotifyService');
        if (true) {
          const settings = getSettingsWithCache();
          const appUrl = (settings.public_base_url || '').replace(/\/$/, '');
          const portalUrl = appUrl ? `${appUrl}/customer` : '';
          const template = db.getAppSetting('whatsapp_payment_success_message', '');
          const whatsappService = require('../services/whatsappService');
          const pkg = customer?.package_id ? customerSvc.getPackageById(customer.package_id) : null;

          const msg = whatsappService.formatPaymentSuccessMessage({
            customerName: customer.name,
            invoiceId: inv.id,
            customerUsername: customer.pppoe_username || customer.id || '-',
          customerCode: customer.customer_code || '',
            packageName: pkg?.name || customer.package_name || '-',
            periodMonth: inv.period_month,
            periodYear: inv.period_year,
            amount: inv.amount,
            paymentMethod: collectorLabel,
            paidAt: new Date(),
            companyName: settings.company_header || 'OPEN-ISP',
            companyPhone: settings.company_phone || '',
            portalUrl,
            customTemplate: template
          });

          await waNotify.sendText(customer.phone, msg);
        }
      }
    } catch (_) {}

    const pkg = customer?.package_id ? customerSvc.getPackageById(customer.package_id) : null;
    const now = new Date();
    const dateStr = now.toLocaleDateString(regional.locale(), { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' +
                    now.toLocaleTimeString(regional.locale(), { hour: '2-digit', minute: '2-digit' });

    res.json({
      success: true,
      message: `¡Factura #${invId} registrada como PAGADA!${unisolated ? ' (servicio del cliente rehabilitado automáticamente)' : ''}`,
      unisolated,
      receipt: {
        invoiceNumber: `#INV-${invId}`,
        customerName: customer?.name || 'Pelanggan',
        packageName: pkg?.name || customer?.package_name || 'Langganan Internet',
        period: `${inv.period_month}/${inv.period_year}`,
        amountFormatted: `${regional.currencySymbol()} ${Number(inv.amount || 0).toLocaleString(regional.locale())}`,
        amount: Number(inv.amount || 0),
        paymentDate: dateStr,
        collectorName: collectorLabel
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo procesar el pago:' + e.message });
  }
});

// Admin: Riwayat Pembayaran Tagihan Lunas (History)
router.get('/app/admin/paid-invoices', requireAdminApiAuth, (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    let q = `
      SELECT i.id, i.customer_id, i.amount, i.status, i.period_month, i.period_year,
             i.paid_at, i.paid_by_name, i.notes, i.payment_gateway,
             c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
             c.pppoe_username, p.name as package_name
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE (LOWER(i.status) = 'paid' OR LOWER(i.status) = 'lunas')
    `;
    const params = [];
    if (search) {
      q += ` AND (c.name LIKE ? OR c.phone LIKE ? OR c.pppoe_username LIKE ? OR i.id LIKE ? OR c.customer_code LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    q += ` ORDER BY i.paid_at DESC, i.id DESC LIMIT 100`;
    const list = db.prepare(q).all(...params) || [];
    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Admin: Isolir Pelanggan (Manual Isolir di MikroTik & DB)
router.post('/app/admin/isolate-customer', requireAdminApiAuth, async (req, res) => {
  try {
    const customerId = Number(req.body.customerId || req.body.id || 0);
    if (!customerId) return res.status(400).json({ success: false, message: 'ID de cliente inválido' });

    await customerSvc.suspendCustomer(customerId);
    const updated = customerSvc.getCustomerById(customerId);

    res.json({
      success: true,
      message: `Se CORTÓ el servicio de "${updated?.name || customerId}" en el MikroTik y en el sistema.`,
      status: 'suspended'
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo cortar el servicio:' + e.message });
  }
});

// Admin: Buka Isolir Pelanggan & Ganti Status ke "DITANGGUHKAN"
router.post('/app/admin/unisolate-customer', requireAdminApiAuth, async (req, res) => {
  try {
    const customerId = Number(req.body.customerId || req.body.id || 0);
    if (!customerId) return res.status(400).json({ success: false, message: 'ID de cliente inválido' });

    // Aktifkan kembali profil normal di MikroTik dan set status ke 'ditangguhkan'
    // Status 'ditangguhkan' TIDAK akan terkena cron auto-isolir walau tagihan belum lunas
    const unpaid = db.prepare("SELECT COUNT(*) c FROM invoices WHERE customer_id=? AND status='unpaid'").get(customerId).c;
    let until = null;
    if (unpaid > 0) {
      until = (await require('../services/promiseService').grant(customerId, { note: 'Habilitación desde la app', actor: { type: 'admin', name: 'app', ip: req.ip } })).until;
    } else {
      await customerSvc.activateCustomer(customerId, 'active');
    }
    const updated = customerSvc.getCustomerById(customerId);

    res.json({
      success: true,
      message: until ? `¡Servicio habilitado! "${updated?.name || customerId}" con promesa de pago hasta ${until}.` : `¡Servicio habilitado! "${updated?.name || customerId}" está ACTIVO.`,
      status: updated ? updated.status : 'active'
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo habilitar el servicio:' + e.message });
  }
});

/// ─── 0.4 KOLEKTOR NATIVE APIS ───────────────────────────────────────────────
router.get('/app/collector/dashboard', requireCollectorApiAuth, (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const filterStatus = String(req.query.filter || 'all').trim(); // all, unpaid, today, isolir

    const now = new Date();
    const todayDay = now.getDate();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    let q = `
      SELECT c.id, c.name, c.phone, c.address, c.status, c.area, c.isolate_day, c.pppoe_username,
             p.name as package_name, p.price as package_price,
             i.id as invoice_id, i.amount as invoice_amount, i.status as invoice_status,
             i.period_month, i.period_year
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      LEFT JOIN invoices i ON i.customer_id = c.id AND i.period_month = ? AND i.period_year = ?
      WHERE 1=1
    `;
    const params = [curMonth, curYear];

    if (filterStatus === 'unpaid') {
      q += ` AND (i.status = 'unpaid' OR i.status IS NULL)`;
    } else if (filterStatus === 'today') {
      q += ` AND c.isolate_day = ? AND (i.status = 'unpaid' OR i.status IS NULL)`;
      params.push(todayDay);
    } else if (filterStatus === 'isolir') {
      q += ` AND (c.status = 'suspended' OR c.status = 'isolated')`;
    }

    if (search) {
      q += ` AND (c.name LIKE ? OR c.phone LIKE ? OR c.address LIKE ? OR c.area LIKE ? OR c.customer_code LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    q += ` ORDER BY (CASE WHEN c.status = 'suspended' THEN 0 WHEN i.status = 'unpaid' THEN 1 ELSE 2 END), c.name ASC LIMIT 150`;
    const list = db.prepare(q).all(...params) || [];

    const stats = db.prepare(`
      SELECT 
        SUM(CASE WHEN (i.status = 'unpaid' OR i.status IS NULL) THEN 1 ELSE 0 END) as unpaid_count,
        SUM(CASE WHEN (i.status = 'unpaid' OR i.status IS NULL) THEN COALESCE(i.amount, p.price, 0) ELSE 0 END) as unpaid_total,
        SUM(CASE WHEN (i.status = 'unpaid' OR i.status IS NULL) AND c.isolate_day = ? THEN 1 ELSE 0 END) as today_count,
        SUM(CASE WHEN c.status = 'suspended' THEN 1 ELSE 0 END) as isolir_count
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      LEFT JOIN invoices i ON i.customer_id = c.id AND i.period_month = ? AND i.period_year = ?
    `).get(todayDay, curMonth, curYear) || {};

    res.json({
      success: true,
      data: {
        customers: list,
        summary: {
          unpaidCount: Number(stats.unpaid_count || 0),
          unpaidTotal: Number(stats.unpaid_total || 0),
          todayCount: Number(stats.today_count || 0),
          isolirCount: Number(stats.isolir_count || 0)
        }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Kolektor: Bayar Tagihan Lapangan
router.post('/app/collector/pay-bill', requireCollectorApiAuth, async (req, res) => {
  try {
    const { invoiceId, customerId, note } = req.body || {};
    let invId = Number(invoiceId || 0);

    // Jika invoice belum ada, buatkan via billingService
    if (!invId && customerId) {
      const now = new Date();
      const curMonth = now.getMonth() + 1;
      const curYear = now.getFullYear();
      const generated = billingSvc.generateInvoiceForCustomer(Number(customerId), curMonth, curYear);
      invId = Number(generated?.invoiceId || 0);
    }

    if (!invId) return res.status(400).json({ success: false, message: 'ID de factura inválido' });

    const inv = billingSvc.getInvoiceById(invId);
    if (!inv) return res.status(404).json({ success: false, message: 'Factura no encontrada' });

    const collectorId = Number(req.collector?.collectorId || req.collector?.id || 0);
    const collector = collectorId ? db.prepare('SELECT id, name, auto_approve FROM collectors WHERE id = ?').get(collectorId) : null;
    const collectorName = collector?.name || req.collector?.name || 'Kolektor Lapangan';
    const isAutoApprove = collector && collector.auto_approve === 1;

    const collectorLabel = `Kolektor ${collectorName} (APK Native)`;
    const notes = note ? `Via Kolektor ${collectorName} | ${note}` : `Via Kolektor APK Native (${collectorName})`;

    if (isAutoApprove) {
      // Auto-approve: langsung tandai lunas
      billingSvc.markAsPaid(invId, collectorLabel, notes, {
        type: 'collector',
        id: collectorId,
        name: collectorName
      });

      // Catat transaksi di collector_payment_requests (approved)
      db.prepare(`
        INSERT INTO collector_payment_requests (collector_id, invoice_id, customer_id, amount, note, status, decided_by_role, decided_by_name, decided_note, decided_at)
        VALUES (?, ?, ?, ?, ?, 'approved', 'system', 'Auto-Approve', 'Aprobado automáticamente (configuración del cobrador)', (NOW_LOCAL()))
      `).run(collectorId, invId, Number(inv.customer_id || 0), Number(inv.amount || 0), note || '');

      // Auto-unisolate jika suspended dan tidak ada sisa tagihan lain
      const customer = customerSvc.getCustomerById(inv.customer_id);
      let unisolated = false;
      if (customer && (customer.status === 'suspended' || customer.status === 'isolated')) {
        const unpaidCount = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status='unpaid'").get(inv.customer_id)?.cnt || 0;
        if (unpaidCount === 0) {
          try {
            await customerSvc.activateCustomer(customer.id, 'active');
            unisolated = true;
          } catch (_) {}
        }
      }

      // Kirim notifikasi WA
      try {
        if (customer && customer.phone) {
          const waNotify = require('../services/waNotifyService');
          if (true) {
            const settings = getSettingsWithCache();
            const appUrl = (settings.public_base_url || '').replace(/\/$/, '');
            const portalUrl = appUrl ? `${appUrl}/customer` : '';
            const template = db.getAppSetting('whatsapp_payment_success_message', '');
            const whatsappService = require('../services/whatsappService');
            const pkg = customer?.package_id ? customerSvc.getPackageById(customer.package_id) : null;

            const msg = whatsappService.formatPaymentSuccessMessage({
              customerName: customer.name,
              invoiceId: inv.id,
              customerUsername: customer.pppoe_username || customer.id || '-',
          customerCode: customer.customer_code || '',
              packageName: pkg?.name || customer.package_name || '-',
              periodMonth: inv.period_month,
              periodYear: inv.period_year,
              amount: inv.amount,
              paymentMethod: collectorLabel,
              paidAt: new Date(),
              companyName: settings.company_header || 'OPEN-ISP',
              companyPhone: settings.company_phone || '',
              portalUrl,
              customTemplate: template
            });

            await waNotify.sendText(customer.phone, msg);
          }
        }
      } catch (_) {}

      res.json({
        success: true,
        message: `¡Factura #${invId} PAGADA!${unisolated ? ' (servicio del cliente rehabilitado automáticamente)' : ''}`,
        receipt: {
          invoiceId: invId,
          customerName: customer?.name || 'Pelanggan',
          amountFormatted: `${regional.currencySymbol()} ${Number(inv.amount || 0).toLocaleString(regional.locale())}`,
          period: `${inv.period_month}/${inv.period_year}`,
          paidAt: new Date().toISOString()
        }
      });
    } else {
      // Perlu approval admin / kasir
      db.prepare(`
        INSERT INTO collector_payment_requests (collector_id, invoice_id, customer_id, amount, note, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', (NOW_LOCAL()))
      `).run(collectorId, invId, Number(inv.customer_id || 0), Number(inv.amount || 0), note || '');

      res.json({
        success: true,
        message: `¡Cobro de la factura #${invId} registrado! Queda esperando la aprobación del cajero o del administrador.`,
        pendingApproval: true
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo procesar el cobro:' + e.message });
  }
});

// Kolektor: Riwayat Setoran / Tagihan yang Diterima
router.get('/app/collector/history', requireCollectorApiAuth, (req, res) => {
  try {
    const collectorId = Number(req.collector?.collectorId || req.collector?.id || 0);
    const requests = db.prepare(`
      SELECT r.id, r.collector_id, r.invoice_id, r.customer_id, r.amount, r.note, r.status,
             r.decided_by_role, r.decided_by_name, r.decided_note, r.decided_at, r.created_at,
             c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
             i.period_month, i.period_year, i.amount as invoice_amount
      FROM collector_payment_requests r
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN invoices i ON i.id = r.invoice_id
      WHERE (r.collector_id = ? OR ? = 0)
      ORDER BY r.id DESC LIMIT 100
    `).all(collectorId, collectorId) || [];

    // Summary counters
    let approvedTotal = 0;
    let pendingTotal = 0;
    let approvedCount = 0;
    let pendingCount = 0;

    for (const r of requests) {
      const amt = Number(r.amount || 0);
      if (r.status === 'approved') {
        approvedTotal += amt;
        approvedCount++;
      } else if (r.status === 'pending') {
        pendingTotal += amt;
        pendingCount++;
      }
    }

    res.json({
      success: true,
      data: {
        requests,
        summary: {
          approvedTotal,
          approvedCount,
          pendingTotal,
          pendingCount,
          totalTransactions: requests.length
        }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Kolektor: Absensi Kerja
router.get('/app/collector/attendance/today', requireCollectorApiAuth, (req, res) => {
  try {
    const attendanceSvc = require('../services/attendanceService');
    const { getSetting } = require('../config/settingsManager');
    const companyName = getSetting('company_header', 'OPEN-ISP');
    const collectorId = Number(req.collector?.collectorId || req.collector?.id || 1);
    const collectorName = req.collector?.name || 'Kolektor';
    const today = attendanceSvc.getTodayAttendance('collector', collectorId);
    const history = attendanceSvc.getAttendanceHistory('collector', collectorId, 10);
    res.json({
      success: true,
      data: {
        today: today || null,
        history: history || [],
        collectorName: collectorName,
        companyName
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

function saveAttendancePhoto(photoData) {
  if (!photoData || typeof photoData !== 'string') return '';
  if (photoData.startsWith('data:image')) {
    try {
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.join(__dirname, '../public/uploads/attendance');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const matches = photoData.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const filename = `attendance-${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
        const fullPath = path.join(uploadDir, filename);
        fs.writeFileSync(fullPath, Buffer.from(matches[2], 'base64'));
        return `/uploads/attendance/${filename}`;
      }
    } catch (err) {
      logger.error('Failed to save attendance photo: ' + err.message);
    }
  } else if (photoData.startsWith('/uploads/')) {
    return photoData;
  }
  return '';
}

router.post('/app/collector/attendance/checkin', requireCollectorApiAuth, (req, res) => {
  try {
    const attendanceSvc = require('../services/attendanceService');
    const collectorId = Number(req.collector?.collectorId || req.collector?.id || 1);
    const collectorName = req.collector?.name || 'Kolektor';
    const today = attendanceSvc.getTodayAttendance('collector', collectorId);
    if (today) {
      return res.status(400).json({ success: false, message: '¡Ya registraste tu entrada hoy!' });
    }

    let { lat, lng, note, photo } = req.body || {};
    const { getSetting } = require('../config/settingsManager');
    const officeLat = getSetting('office_lat', '0');
    const officeLng = getSetting('office_lng', '0');
    if ((!lat || !lng || String(lat).trim() === '' || String(lat).trim() === '0') && officeLat && officeLng) {
      lat = officeLat;
      lng = officeLng;
    }

    const photoPath = saveAttendancePhoto(photo);

    const result = attendanceSvc.checkIn({
      employee_type: 'collector',
      employee_id: collectorId,
      employee_name: collectorName,
      lat: String(lat || officeLat || ''),
      lng: String(lng || officeLng || ''),
      note: String(note || 'Entrada del cobrador (app)'),
      photo: photoPath
    });

    res.json({ success: true, message: '✅ ¡Entrada registrada!', id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo registrar la entrada:' + e.message });
  }
});

router.post('/app/collector/attendance/checkout', requireCollectorApiAuth, (req, res) => {
  try {
    const attendanceSvc = require('../services/attendanceService');
    const collectorId = Number(req.collector?.collectorId || req.collector?.id || 1);
    const today = attendanceSvc.getTodayAttendance('collector', collectorId);
    if (!today) {
      return res.status(400).json({ success: false, message: '¡Todavía no registraste tu entrada hoy!' });
    }
    if (today.status === 'checked_out') {
      return res.status(400).json({ success: false, message: '¡Ya registraste tu salida hoy!' });
    }

    let { lat, lng, note, photo } = req.body || {};
    const { getSetting } = require('../config/settingsManager');
    const officeLat = getSetting('office_lat', '0');
    const officeLng = getSetting('office_lng', '0');
    if ((!lat || !lng || String(lat).trim() === '' || String(lat).trim() === '0') && officeLat && officeLng) {
      lat = officeLat;
      lng = officeLng;
    }

    const photoPath = saveAttendancePhoto(photo);

    attendanceSvc.checkOut(today.id, {
      lat: String(lat || officeLat || ''),
      lng: String(lng || officeLng || ''),
      note: String(note || 'Salida del cobrador (app)'),
      photo: photoPath
    });

    res.json({ success: true, message: '🏁 Salida registrada. ¡Buen descanso!' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo registrar la salida:' + e.message });
  }
});

// ─── KASIR NATIVE: ABSENSI ──────────────────────────────────────────────────
router.get('/app/cashier/attendance/today', requireAdminApiAuth, (req, res) => {
  try {
    const attendanceSvc = require('../services/attendanceService');
    const cashiersList = db.prepare('SELECT id, name, username FROM cashiers WHERE is_active = 1 ORDER BY name ASC').all() || [];
    
    let cashierId = parseInt(req.query.cashier_id) || (cashiersList.length > 0 ? cashiersList[0].id : 1);
    let cashierName = 'Kasir Utama';
    
    const found = cashiersList.find(c => c.id === cashierId);
    if (found) {
      cashierName = found.name;
    }

    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    const history = attendanceSvc.getAttendanceHistory('cashier', cashierId, 10);

    const { getSetting } = require('../config/settingsManager');
    const companyName = getSetting('company_header', 'OPEN-ISP');

    res.json({
      success: true,
      data: {
        today: today || null,
        history: history || [],
        cashierId,
        cashierName,
        cashiers: cashiersList,
        companyName
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/cashier/attendance/checkin', requireAdminApiAuth, (req, res) => {
  try {
    const attendanceSvc = require('../services/attendanceService');
    let { cashier_id, lat, lng, note, photo } = req.body || {};
    let cashierId = parseInt(cashier_id) || (req.admin?.id || 1);
    let cashierName = req.admin?.name || 'Kasir';

    const cRow = db.prepare('SELECT name FROM cashiers WHERE id = ?').get(cashierId);
    if (cRow) {
      cashierName = cRow.name;
    }

    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (today) {
      return res.status(400).json({ success: false, message: 'Kasir' + cashierName + ' ya registró su entrada hoy!' });
    }

    const { getSetting } = require('../config/settingsManager');
    const officeLat = getSetting('office_lat', '0');
    const officeLng = getSetting('office_lng', '0');
    if ((!lat || !lng || String(lat).trim() === '' || String(lat).trim() === '0') && officeLat && officeLng) {
      lat = officeLat;
      lng = officeLng;
    }

    const photoPath = saveAttendancePhoto(photo);

    const result = attendanceSvc.checkIn({
      employee_type: 'cashier',
      employee_id: cashierId,
      employee_name: cashierName,
      lat: String(lat || officeLat || ''),
      lng: String(lng || officeLng || ''),
      note: String(note || 'Entrada del cajero (app)'),
      photo: photoPath
    });

    res.json({ success: true, message: '✅ ¡Entrada del cajero (' + cashierName + ') registrada!', id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo registrar la entrada del cajero:' + e.message });
  }
});

router.post('/app/cashier/attendance/checkout', requireAdminApiAuth, (req, res) => {
  try {
    const attendanceSvc = require('../services/attendanceService');
    let { cashier_id, lat, lng, note, photo } = req.body || {};
    let cashierId = parseInt(cashier_id) || (req.admin?.id || 1);

    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (!today) {
      return res.status(400).json({ success: false, message: '¡El cajero todavía no registró su entrada hoy!' });
    }
    if (today.status === 'checked_out') {
      return res.status(400).json({ success: false, message: '¡El cajero ya registró su salida hoy!' });
    }

    const { getSetting } = require('../config/settingsManager');
    const officeLat = getSetting('office_lat', '0');
    const officeLng = getSetting('office_lng', '0');
    if ((!lat || !lng || String(lat).trim() === '' || String(lat).trim() === '0') && officeLat && officeLng) {
      lat = officeLat;
      lng = officeLng;
    }

    const photoPath = saveAttendancePhoto(photo);

    attendanceSvc.checkOut(today.id, {
      lat: String(lat || officeLat || ''),
      lng: String(lng || officeLng || ''),
      note: String(note || 'Salida del cajero (app)'),
      photo: photoPath
    });

    res.json({ success: true, message: '🏁 Salida del cajero registrada. ¡Fin de la jornada!' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo registrar la salida:' + e.message });
  }
});

// Kolektor: Peta Lokasi & Koordinat Pelanggan Tagihan
router.get('/app/collector/customers/map', requireCollectorApiAuth, (req, res) => {
  try {
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    const customers = db.prepare(`
      SELECT c.id, c.name, c.phone, c.address, c.area, c.lat, c.lng, c.status, c.isolate_day,
             p.name as package_name, p.price as package_price,
             i.id as invoice_id, i.amount as invoice_amount, i.status as invoice_status
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      LEFT JOIN invoices i ON i.customer_id = c.id AND i.period_month = ? AND i.period_year = ?
      WHERE (i.status = 'unpaid' OR i.status IS NULL OR c.status = 'suspended' OR c.status = 'isolated')
      ORDER BY c.name ASC LIMIT 100
    `).all(curMonth, curYear) || [];

    res.json({
      success: true,
      data: customers
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/app/admin/cash-report', requireAdminApiAuth, (req, res) => {
  try {
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    const income = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM invoices 
      WHERE (LOWER(status) = 'paid' OR LOWER(status) = 'lunas') AND period_month = ? AND period_year = ?
    `).get(curMonth, curYear)?.total || 0;

    const expense = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE strftime('%Y-%m', date) = ?
    `).get(curYear + '-' + String(curMonth).padStart(2, '0'))?.total || 0;

    const recentTrx = db.prepare(`
      SELECT id, amount, 'income' AS type, COALESCE(description, category, '') AS description, COALESCE(date, created_at) AS created_at FROM cash_in
      UNION ALL
      SELECT id, amount, 'expense' AS type, COALESCE(description, category, '') AS description, COALESCE(date, created_at) AS created_at FROM expenses
      ORDER BY created_at DESC LIMIT 20
    `).all() || [];

    res.json({
      success: true,
      data: {
        month: `${curMonth}/${curYear}`,
        income: Number(income),
        expense: Number(expense),
        balance: Math.max(0, Number(income) - Number(expense)),
        recentTransactions: recentTrx
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: MONITORING SISTEM ──────────────────────────────────────────
router.get('/app/admin/monitoring', requireAdminApiAuth, async (req, res) => {
  try {
    const os = require('os');
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const uptime = os.uptime();

    // CPU usage (average across cores)
    let cpuPercent = 0;
    if (cpus.length > 0) {
      const total = cpus.reduce((acc, cpu) => {
        const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const idle = cpu.times.idle;
        return { total: acc.total + t, idle: acc.idle + idle };
      }, { total: 0, idle: 0 });
      cpuPercent = Math.round((1 - total.idle / total.total) * 100);
    }

    // Disk usage (try Windows and Linux)
    let diskTotal = 0, diskUsed = 0, diskFree = 0;
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        const out = execSync('wmic logicaldisk get size,freespace,caption /format:csv', { encoding: 'utf8' });
        const lines = out.trim().split('\n').filter(l => l.includes(','));
        for (const line of lines) {
          const parts = line.trim().split(',');
          if (parts.length >= 4 && parts[2]) {
            diskFree += Number(parts[2]) || 0;
            diskTotal += Number(parts[3]) || 0;
          }
        }
        diskUsed = diskTotal - diskFree;
      } else {
        const out = execSync("df -B1 / | tail -1", { encoding: 'utf8' });
        const parts = out.trim().split(/\s+/);
        diskTotal = Number(parts[1]) || 0;
        diskUsed = Number(parts[2]) || 0;
        diskFree = Number(parts[3]) || 0;
      }
    } catch (_) {}

    // Service status checks
    let mikrotikStatus = 'unknown', whatsappStatus = 'unknown', dbStatus = 'ok';
    try {
      const routers = db.prepare('SELECT id, name, host FROM routers WHERE is_active = 1 LIMIT 1').all();
      mikrotikStatus = routers.length > 0 ? 'configured' : 'not_configured';
    } catch (_) { mikrotikStatus = 'error'; }
    try {
      const { whatsappStatus: waStatus } = await import('../services/whatsappBot.mjs');
      whatsappStatus = waStatus?.connection === 'open' ? 'connected' : 'disconnected';
    } catch (_) { whatsappStatus = 'not_available'; }

    res.json({
      success: true,
      data: {
        cpu: { percent: cpuPercent, cores: cpus.length, model: cpus[0]?.model || 'Unknown' },
        memory: { total: totalMem, used: usedMem, free: freeMem, percent: Math.round(usedMem / totalMem * 100) },
        disk: { total: diskTotal, used: diskUsed, free: diskFree, percent: diskTotal > 0 ? Math.round(diskUsed / diskTotal * 100) : 0 },
        uptime: uptime,
        platform: process.platform,
        nodeVersion: process.version,
        services: { mikrotik: mikrotikStatus, whatsapp: whatsappStatus, database: dbStatus }
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: LAPORAN KEUANGAN ──────────────────────────────────────────
router.get('/app/admin/reports', requireAdminApiAuth, (req, res) => {
  try {
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    const year = Number(req.query.year) || new Date().getFullYear();

    const income = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM invoices 
      WHERE (LOWER(status) = 'paid' OR LOWER(status) = 'lunas') AND period_month = ? AND period_year = ?
    `).get(month, year)?.total || 0;

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevIncome = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM invoices 
      WHERE (LOWER(status) = 'paid' OR LOWER(status) = 'lunas') AND period_month = ? AND period_year = ?
    `).get(prevMonth, prevYear)?.total || 0;

    const totalExpense = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses 
      WHERE strftime('%m', date) = ? AND strftime('%Y', date) = ?
    `).get(String(month).padStart(2, '0'), String(year))?.total || 0;

    const paidCount = db.prepare(`
      SELECT COUNT(*) as c FROM invoices 
      WHERE (LOWER(status) = 'paid' OR LOWER(status) = 'lunas') AND period_month = ? AND period_year = ?
    `).get(month, year)?.c || 0;

    const unpaidCount = db.prepare(`
      SELECT COUNT(*) as c FROM invoices 
      WHERE (LOWER(status) = 'unpaid' OR status IS NULL) AND period_month = ? AND period_year = ?
    `).get(month, year)?.c || 0;

    const recentPayments = db.prepare(`
      SELECT i.id, i.amount, i.paid_at, c.name as customer_name, p.name as package_name
      FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN packages p ON p.id = c.package_id
      WHERE (LOWER(i.status) = 'paid' OR LOWER(i.status) = 'lunas') AND i.period_month = ? AND i.period_year = ?
      ORDER BY i.paid_at DESC LIMIT 30
    `).all(month, year) || [];

    res.json({
      success: true,
      data: { month, year, income: Number(income), prevIncome: Number(prevIncome), expense: Number(totalExpense),
              netProfit: Number(income) - Number(totalExpense), paidCount, unpaidCount, recentPayments }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: PENGELUARAN ───────────────────────────────────────────────
router.get('/app/admin/expenses', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 100`).all() || [];
    const totalMonth = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses 
      WHERE strftime('%m', date) = ? AND strftime('%Y', date) = ?
    `).get(String(new Date().getMonth() + 1).padStart(2, '0'), String(new Date().getFullYear()))?.total || 0;
    const categories = db.prepare(`SELECT DISTINCT category FROM expenses ORDER BY category`).all().map(r => r.category) || [];
    res.json({ success: true, data: { expenses: rows, totalMonth: Number(totalMonth), categories } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/admin/expenses/create', requireAdminApiAuth, (req, res) => {
  try {
    const { date, category, amount, description, vendor, payment_method } = req.body;
    if (!category || !amount) return res.status(400).json({ success: false, message: 'La categoría y el monto son obligatorios' });
    db.prepare(`INSERT INTO expenses (date, category, amount, description, vendor, payment_method, recorded_by_role) VALUES (?, ?, ?, ?, ?, ?, 'admin')`)
      .run(date || new Date().toISOString().slice(0, 10), category, Number(amount), description || '', vendor || '', payment_method || 'cash');
    res.json({ success: true, message: 'Gasto registrado' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: PEMASUKAN KAS ─────────────────────────────────────────────
router.get('/app/admin/cash-in', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM cash_in ORDER BY date DESC, id DESC LIMIT 100`).all() || [];
    const totalMonth = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM cash_in 
      WHERE strftime('%m', date) = ? AND strftime('%Y', date) = ?
    `).get(String(new Date().getMonth() + 1).padStart(2, '0'), String(new Date().getFullYear()))?.total || 0;
    res.json({ success: true, data: { cashIn: rows, totalMonth: Number(totalMonth) } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

function generateVoucherCode(len, charset) {
  const n = Math.max(3, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

// ─── ADMIN NATIVE: VOUCHER HOTSPOT ───────────────────────────────────────────
router.get('/app/admin/vouchers', requireAdminApiAuth, (req, res) => {
  try {
    const batches = db.prepare(`
      SELECT b.id as batch_id, b.profile_name, b.price, b.validity, b.qty_total as total_count,
             (SELECT COUNT(*) FROM vouchers WHERE batch_id = b.id AND (status = 'used' OR status = 'active')) as sold_count,
             b.created_at
      FROM voucher_batches b ORDER BY b.id DESC LIMIT 50
    `).all() || [];
    const totalVouchers = db.prepare(`SELECT COUNT(*) as c FROM vouchers`).get()?.c || 0;
    const unsold = db.prepare(`SELECT COUNT(*) as c FROM vouchers WHERE status = 'unused' OR status IS NULL OR status = 'new' OR status = 'created'`).get()?.c || 0;
    res.json({ success: true, data: { batches, totalVouchers, unsold } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/app/admin/vouchers/options', requireAdminApiAuth, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const routers = db.prepare(`SELECT id, name, host, port, is_active FROM routers ORDER BY id ASC`).all() || [];

    let profiles = [];
    try {
      const mikrotikProfiles = await mikrotikService.getHotspotUserProfiles(routerId);
      const { parseMikhmonOnLogin } = require('../utils/mikhmonParser');
      profiles = (mikrotikProfiles || []).map(p => {
        const rawOnLogin = p.onLogin || p['on-login'] || '';
        const meta = parseMikhmonOnLogin(rawOnLogin);
        return {
          name: p.name,
          sharedUsers: p['shared-users'] || p.sharedUsers || 1,
          rateLimit: p['rate-limit'] || p.rateLimit || '',
          price: meta?.price || 0,
          validity: meta?.validity || '',
          rawOnLogin
        };
      });
    } catch (mErr) {
      logger.warn('[Voucher Options] MikroTik profile fetch error: ' + mErr.message);
    }

    const settings = getSettingsWithCache();
    const companyName = settings.company_header || settings.company_name || 'ISP NETWORK';
    const companyPhone = settings.company_phone || '';
    let hotspotDns = (settings.hotspot_dns || settings.hotspot_name || '').trim();
    if (hotspotDns === 'wifi.id') hotspotDns = '';

    // If not in settings, try fetching dns-name from MikroTik /ip/hotspot/profile
    if (!hotspotDns) {
      try {
        const mikrotikConn = await mikrotikService.getApiConnection(routerId);
        if (mikrotikConn) {
          const hpProfiles = await mikrotikConn.write('/ip/hotspot/profile/print');
          if (Array.isArray(hpProfiles)) {
            const withDns = hpProfiles.find(h => (h['dns-name'] || h.dnsName) && (h['dns-name'] || h.dnsName).trim() !== '');
            if (withDns) {
              hotspotDns = (withDns['dns-name'] || withDns.dnsName).trim();
            }
          }
        }
      } catch (_e) {}
    }
    if (hotspotDns === 'wifi.id') hotspotDns = '';

    const roleName = (req.admin?.role === 'cashier' || req.admin?.username?.toLowerCase().includes('kasir')) 
      ? (req.admin?.username || 'kasir') 
      : 'admin';
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const defaultComment = `vc-${roleName}-${dd}.${mm}.${yy}`;

    res.json({
      success: true,
      data: {
        routers,
        profiles,
        companyName,
        companyPhone,
        hotspotDns,
        defaultComment
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/admin/vouchers/create-single', requireAdminApiAuth, express.json(), async (req, res) => {
  try {
    const routerId = req.body.routerId ? Number(req.body.routerId) : null;
    const profileName = String(req.body.profile || '').trim();
    let username = String(req.body.username || '').trim();
    let password = String(req.body.password || '').trim();
    const price = Number(req.body.price) || 0;
    const validity = String(req.body.validity || '').trim();
    const buyerPhone = String(req.body.buyerPhone || '').trim();

    const roleName = (req.admin?.role === 'cashier' || req.admin?.username?.toLowerCase().includes('kasir')) 
      ? (req.admin?.username || 'kasir') 
      : 'admin';
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const defaultComment = `vc-${roleName}-${dd}.${mm}.${yy}`;
    const comment = String(req.body.comment || defaultComment).trim();

    if (!profileName) return res.status(400).json({ success: false, message: 'El perfil hotspot es obligatorio' });

    if (!username) {
      const prefix = String(req.body.prefix || '').trim();
      const len = Math.max(4, Math.min(12, Number(req.body.codeLength) || 6));
      const charset = String(req.body.charset || 'numbers');
      username = prefix + generateVoucherCode(len - prefix.length, charset);
      if (!password) password = username;
    } else if (!password) {
      password = username;
    }

    const insertBatch = db.prepare(`
      INSERT INTO voucher_batches (router_id, profile_name, qty_total, qty_created, qty_failed, price, validity, prefix, code_length, status, created_by, mode, charset, updated_at)
      VALUES (?, ?, 1, 1, 0, ?, ?, '', ?, 'completed', ?, ?, 'numbers', (NOW_LOCAL()))
    `);
    const batchRes = insertBatch.run(routerId, profileName, price, validity, username.length, roleName, username === password ? 'voucher' : 'member');
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'unused', (NOW_LOCAL()))
    `);
    const vRes = insertVoucher.run(batchId, routerId, username, password, profileName, comment);
    const voucherId = Number(vRes.lastInsertRowid);

    const userData = {
      server: 'all',
      name: username,
      password: password,
      profile: profileName,
      comment: comment
    };
    if (validity) userData['limit-uptime'] = validity;

    try {
      await mikrotikService.addHotspotUser(userData, routerId);
    } catch (mErr) {
      db.prepare('UPDATE vouchers SET status = ? WHERE id = ?').run('failed', voucherId);
      db.prepare('UPDATE voucher_batches SET qty_created = 0, qty_failed = 1, status = ? WHERE id = ?').run('failed', batchId);
      return res.status(500).json({ success: false, message: 'No se pudo guardar en el MikroTik:' + mErr.message });
    }

    const settings = getSettingsWithCache();
    const companyName = settings.company_header || settings.company_name || 'ISP NETWORK';
    const companyPhone = settings.company_phone || '';
    let hotspotDns = (settings.hotspot_dns || settings.hotspot_name || '').trim();
    if (hotspotDns === 'wifi.id') hotspotDns = '';

    res.json({
      success: true,
      message: `¡Ficha "${username}" creada!`,
      data: {
        id: voucherId,
        batchId,
        code: username,
        password: password,
        profile: profileName,
        comment: comment,
        price,
        priceFormatted: `${regional.currencySymbol()} ${price.toLocaleString(regional.locale())}`,
        validity: validity || '-',
        buyerPhone,
        companyName,
        companyPhone,
        hotspotDns
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/admin/vouchers/create-batch', requireAdminApiAuth, express.json(), async (req, res) => {
  try {
    const routerId = req.body.routerId ? Number(req.body.routerId) : null;
    const profileName = String(req.body.profile || '').trim();
    const qty = Math.max(1, Math.min(2000, Number(req.body.qty) || 0));
    const prefix = String(req.body.prefix || '').trim();
    const codeLength = Math.max(4, Math.min(16, Number(req.body.codeLength) || 6));
    const mode = String(req.body.mode || 'voucher');
    const charset = String(req.body.charset || 'numbers');
    const price = Number(req.body.price) || 0;
    const validity = String(req.body.validity || '').trim();

    const roleName = (req.admin?.role === 'cashier' || req.admin?.username?.toLowerCase().includes('kasir')) 
      ? (req.admin?.username || 'kasir') 
      : 'admin';
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const defaultComment = `vc-${roleName}-${dd}.${mm}.${yy}`;
    const batchComment = String(req.body.comment || defaultComment).trim();

    if (!profileName) return res.status(400).json({ success: false, message: 'El perfil hotspot es obligatorio' });
    if (!qty) return res.status(400).json({ success: false, message: 'La cantidad de fichas es obligatoria' });
    if (prefix.length >= codeLength) return res.status(400).json({ success: false, message: 'El prefijo es demasiado largo para la longitud de código elegida' });

    const insertBatch = db.prepare(`
      INSERT INTO voucher_batches (router_id, profile_name, qty_total, qty_created, qty_failed, price, validity, prefix, code_length, status, created_by, mode, charset, updated_at)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 'creating', ?, ?, ?, (NOW_LOCAL()))
    `);
    const batchRes = insertBatch.run(routerId, profileName, qty, price, validity, prefix, codeLength, roleName, mode, charset);
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', (NOW_LOCAL()))
    `);
    const existsInDb = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');

    const codes = new Set();
    const makeCode = () => {
      const coreLen = Math.max(3, codeLength - prefix.length);
      const userCode = prefix + generateVoucherCode(coreLen, charset);
      const passCode = (mode === 'member') ? generateVoucherCode(coreLen, charset) : userCode;
      return { userCode, passCode };
    };

    const initialVouchers = [];
    while (initialVouchers.length < qty) {
      const gen = makeCode();
      if (codes.has(gen.userCode)) continue;
      if (existsInDb.get(routerId, gen.userCode)) continue;
      codes.add(gen.userCode);
      initialVouchers.push(gen);
    }

    const tx = db.transaction((items) => {
      for (const item of items) {
        insertVoucher.run(batchId, routerId, item.userCode, item.passCode, profileName, batchComment);
      }
    });
    tx(initialVouchers);

    setImmediate(async () => {
      const vouchersToPush = db.prepare('SELECT id, code, password, comment FROM vouchers WHERE batch_id = ?').all(batchId);
      let createdCount = 0;
      let failedCount = 0;

      for (const v of vouchersToPush) {
        try {
          const uData = {
            server: 'all',
            name: v.code,
            password: v.password,
            profile: profileName,
            comment: v.comment || batchComment
          };
          if (validity) uData['limit-uptime'] = validity;

          await mikrotikService.addHotspotUser(uData, routerId);
          db.prepare('UPDATE vouchers SET status = ? WHERE id = ?').run('unused', v.id);
          createdCount++;
        } catch (mErr) {
          logger.warn(`[Batch ${batchId}] Error adding voucher ${v.code}: ${mErr.message}`);
          db.prepare('UPDATE vouchers SET status = ? WHERE id = ?').run('failed', v.id);
          failedCount++;
        }
      }

      db.prepare(`
        UPDATE voucher_batches 
        SET qty_created = ?, qty_failed = ?, status = ?, updated_at = (NOW_LOCAL())
        WHERE id = ?
      `).run(createdCount, failedCount, failedCount === 0 ? 'completed' : 'partial', batchId);
    });

    res.json({
      success: true,
      message: `Lote de ${qty} fichas creado; se está sincronizando con el MikroTik.`,
      data: {
        batchId,
        qty,
        profile: profileName,
        price,
        validity
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/app/admin/vouchers/batch/:id/vouchers', requireAdminApiAuth, (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    const vouchers = db.prepare('SELECT id, code, password, profile_name, status, used_at FROM vouchers WHERE batch_id = ? ORDER BY id ASC').all(batchId) || [];
    const settings = getSettingsWithCache();
    const companyName = settings.company_header || settings.company_name || 'ISP NETWORK';
    const companyPhone = settings.company_phone || '';
    let hotspotDns = (settings.hotspot_dns || settings.hotspot_name || '').trim();
    if (hotspotDns === 'wifi.id') hotspotDns = '';

    res.json({
      success: true,
      data: {
        batch,
        vouchers,
        companyName,
        companyPhone,
        hotspotDns
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Send Voucher directly via active WhatsApp Gateway (Baileys / Fonnte / Meta)
router.post('/app/admin/vouchers/send-wa', requireAdminApiAuth, async (req, res) => {
  try {
    let { phone, code, password, profile, validity, price } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ success: false, message: 'El número de WhatsApp y el código de la ficha son obligatorios' });
    }

    const p = regional.normalizePhone(phone);

    const settings = getSettingsWithCache();
    const companyName = settings.company_header || settings.company_name || 'ISP NETWORK';
    const companyPhone = settings.company_phone || '';
    let hotspotDns = (settings.hotspot_dns || settings.hotspot_name || '').trim();
    if (hotspotDns === 'wifi.id') hotspotDns = '';

    const pass = password || code;
    const isSame = code === pass;

    let msg = `🎫 *VOUCHER INTERNET HOTSPOT*\n`;
    msg += `--------------------------------\n`;
    msg += `🏢 *${companyName}*\n`;
    msg += `📦 *Plan:* ${profile || 'Hotspot'}\n`;
    if (validity && validity !== '-') msg += `⏱️ *Masa Aktif:* ${validity}\n`;
    if (price) msg += `💰 *Tarif:* ${price}\n\n`;

    if (isSame) {
      msg += `👤 *Código de acceso:* \`${code}\`\n\n`;
    } else {
      msg += `👤 *Username:* \`${code}\`\n`;
      msg += `🔑 *Password:* \`${pass}\`\n\n`;
    }

    if (hotspotDns) {
      msg += `🌐 *Login URL:* http://${hotspotDns}\n`;
    }
    if (companyPhone) {
      msg += `📞 *Bantuan / CS:* ${companyPhone}\n`;
    }
    msg += `--------------------------------\n`;
    msg += `Conecte su dispositivo al WiFi e ingrese el código de arriba. ¡Gracias!`;

    const whatsappService = require('../services/whatsappService');
    await whatsappService.sendWhatsAppMessage(p, msg);

    res.json({ success: true, message: `Ficha enviada por WhatsApp a ${phone}` });
  } catch (err) {
    logger.error('[Voucher Send WA] Error: ' + err.message);
    res.status(500).json({ success: false, message: err.message || 'No se pudo enviar el mensaje de WhatsApp' });
  }
});

router.get('/app/admin/vouchers/batch/:id/print', (req, res) => {
  try {
    const token = extractToken(req);
    const payload = verifyApiToken(token);
    if (!payload || (payload.role !== 'admin' && payload.role !== 'root' && payload.role !== 'cashier')) {
      return res.status(401).send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Akses Ditolak</title>
        <style>body{background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style>
        </head><body><div><h2>🔒 Autentikasi Diperlukan</h2><p>Sesi login tidak valid. Buka kembali dari aplikasi.</p></div></body></html>
      `);
    }

    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).send('<h3>Lote de fichas no encontrado</h3>');

    const vouchers = db.prepare('SELECT code, password, profile_name, status FROM vouchers WHERE batch_id = ? ORDER BY id ASC').all(batchId) || [];
    const settings = getSettingsWithCache();
    const companyName = settings.company_header || settings.company_name || 'ISP NETWORK';
    const companyPhone = settings.company_phone || '';
    let hotspotDns = (settings.hotspot_dns || settings.hotspot_name || '').trim();
    if (hotspotDns === 'wifi.id') hotspotDns = '';
    const priceText = Number(batch.price || 0).toLocaleString(regional.locale());
    const validityText = batch.validity || '-';

    const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vouchers #${batch.id} - ${escapeHtml(companyName)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 6mm;
    }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #fff;
      color: #0f172a;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .voucher-card {
      border: 1.5px dashed #475569;
      border-radius: 8px;
      padding: 8px 10px;
      background: #ffffff;
      position: relative;
      break-inside: avoid;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 120px;
      overflow: hidden;
    }
    .v-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 4px;
    }
    .v-brand {
      font-weight: 800;
      font-size: 11px;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 110px;
    }
    .v-price {
      font-weight: 900;
      font-size: 11px;
      background: #dcfce7;
      color: #166534;
      border: 1px solid #86efac;
      padding: 1px 6px;
      border-radius: 12px;
      white-space: nowrap;
    }
    .v-pkg {
      font-size: 10px;
      color: #475569;
      margin-top: 4px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .v-code-box {
      text-align: center;
      margin: 4px 0;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 4px 2px;
    }
    .v-code {
      font-family: "Courier New", Courier, monospace;
      font-size: 17px;
      font-weight: 900;
      color: #0369a1;
      letter-spacing: 1.5px;
      line-height: 1.1;
    }
    .v-member {
      font-family: "Courier New", Courier, monospace;
      font-size: 11.5px;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.2;
    }
    .v-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px dotted #cbd5e1;
      padding-top: 4px;
      font-size: 8.5px;
      color: #64748b;
    }
    .v-dns { font-weight: 700; color: #2563eb; }
    @media screen {
      body { padding: 16px; background: #0f172a; }
      .print-bar {
        max-width: 800px;
        margin: 0 auto 16px;
        background: #1e293b;
        padding: 12px 16px;
        border-radius: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        color: #fff;
      }
      .btn-print {
        background: #2563eb;
        color: #fff;
        border: none;
        padding: 8px 18px;
        font-weight: 700;
        font-size: 14px;
        border-radius: 8px;
        cursor: pointer;
      }
      .grid-wrapper {
        max-width: 800px;
        margin: 0 auto;
        background: #fff;
        padding: 16px;
        border-radius: 12px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      }
    }
    @media print {
      .print-bar { display: none !important; }
      body { background: #fff !important; }
      .grid-wrapper { padding: 0 !important; box-shadow: none !important; }
    }
  </style>
</head>
<body>
  <div class="print-bar">
    <div>
      <strong>Batch #${batch.id} (${vouchers.length} Voucher)</strong><br>
      <small>Paket: ${escapeHtml(batch.profile_name)} • ${regional.currencySymbol()} ${priceText} • Durasi: ${escapeHtml(validityText)}</small>
    </div>
    <button class="btn-print" onclick="window.print()">🖨️ Cetak / Simpan PDF A4</button>
  </div>
  <div class="grid-wrapper">
    <div class="grid">
      ${vouchers.map(v => {
        const isSame = String(v.code) === String(v.password);
        return `
        <div class="voucher-card">
          <div class="v-top">
            <span class="v-brand">${escapeHtml(companyName)}</span>
            <span class="v-price">${regional.currencySymbol()} ${priceText}</span>
          </div>
          <div class="v-pkg">📦 ${escapeHtml(batch.profile_name)} • ⏱️ ${escapeHtml(validityText)}</div>
          <div class="v-code-box">
            ${isSame ? `
              <div style="font-size:8px;color:#64748b;font-weight:700">KODE VOUCHER LOGIN:</div>
              <div class="v-code">${escapeHtml(v.code)}</div>
            ` : `
              <div class="v-member">U: <strong style="color:#0369a1">${escapeHtml(v.code)}</strong></div>
              <div class="v-member">P: <strong style="color:#b45309">${escapeHtml(v.password)}</strong></div>
            `}
          </div>
          <div class="v-footer">
            <span class="v-dns">${hotspotDns ? `🌐 ${escapeHtml(hotspotDns)}` : ''}</span>
            <span>${companyPhone ? `📞 ${escapeHtml(companyPhone)}` : ''}</span>
          </div>
        </div>
        `;
      }).join('')}
    </div>
  </div>
</body>
</html>`;

    res.send(html);
  } catch (e) {
    res.status(500).send('<h3>Error al cargar la página de impresión:' + e.message + '</h3>');
  }
});

router.delete('/app/admin/vouchers/batch/:id', requireAdminApiAuth, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ success: false, message: 'Lote no encontrado' });

    const vouchers = db.prepare('SELECT code FROM vouchers WHERE batch_id = ?').all(batchId) || [];
    for (const v of vouchers) {
      try {
        const u = await mikrotikService.getHotspotUserByName(v.code, batch.router_id);
        if (u && u.id) await mikrotikService.deleteHotspotUser(u.id, batch.router_id);
      } catch (_) {}
    }

    db.prepare('DELETE FROM vouchers WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM voucher_batches WHERE id = ?').run(batchId);

    res.json({ success: true, message: `Lote #${batchId} eliminado del sistema y del MikroTik.` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: ROUTER MIKROTIK ───────────────────────────────────────────
router.get('/app/admin/routers', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, name, host, port, is_active, created_at FROM routers ORDER BY id ASC`).all() || [];
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: OLT ──────────────────────────────────────────────────────
router.get('/app/admin/olts', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, name, host, snmp_port AS port, brand, snmp_community, is_active FROM olts ORDER BY id ASC`).all() || [];
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: WHATSAPP STATUS ───────────────────────────────────────────
router.get('/app/admin/whatsapp/status', requireAdminApiAuth, async (req, res) => {
  try {
    const gwType = String(require('../config/settingsManager').getSetting('wa_gateway_type', 'gowa') || 'baileys').toLowerCase();
    let isConnected = false;
    let waNumber = '-';
    let waName = gwType.toUpperCase();
    if (gwType === 'gowa') {
      try { const st = await require('../services/gowaWhatsappService').gowaStatus(); isConnected = !!(st && st.ok); } catch (e) {}
    } else if (gwType === 'baileys') {
      const { whatsappStatus } = await import('../services/whatsappBot.mjs');
      isConnected = whatsappStatus?.connection === 'open';
      waNumber = whatsappStatus?.phoneNumber || '-';
      waName = whatsappStatus?.pushName || '-';
    } else {
      isConnected = !!require('../config/settingsManager').getSetting('whatsapp_enabled', false);
    }
    res.json({
      success: true,
      data: {
        connected: isConnected,
        status: isConnected ? 'Terhubung' : 'Desconectado',
        number: waNumber,
        name: waName
      }
    });
  } catch (e) {
    res.json({ success: true, data: { connected: false, status: 'Bot inactivo', number: '-', name: '-' } });
  }
});

// ─── ADMIN NATIVE: PETA PELANGGAN (app) ─────────────────────────────────────
router.get('/app/map', (req, res) => {
  try {
    const token = extractToken(req);
    const payload = verifyApiToken(token);
    if (!payload || (payload.role !== 'admin' && payload.role !== 'tech' && payload.role !== 'cashier' && payload.role !== 'root')) {
      return res.status(401).send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Akses Ditolak</title>
        <style>body{background:#0f172a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;text-align:center;}</style>
        </head><body><div><h2>🔒 Autentikasi Diperlukan</h2><p>Sesi login tidak valid atau telah kedaluwarsa. Silakan buka kembali dari aplikasi.</p></div></body></html>
      `);
    }

    const odpSvc = require('../services/odpService');
    const customers = customerSvc.getAllCustomers();
    const odps = odpSvc.getAllOdps();
    const settings = getSettingsWithCache();
    const company = settings.company_header || settings.company_name || 'ISP NETWORK';

    res.render('admin/map_mobile', {
      title: 'Mapa de ONU de clientes',
      company,
      customers: customers || [],
      odps: odps || [],
      settings: settings || {},
      token
    });
  } catch (e) {
    res.status(500).send('<h3>Error memuat peta: ' + e.message + '</h3>');
  }
});

router.get('/app/map/data', requireTechApiAuth, (req, res) => {
  try {
    const odpSvc = require('../services/odpService');
    const customers = customerSvc.getAllCustomers();
    const odps = odpSvc.getAllOdps();
    res.json({
      success: true,
      customers: customers || [],
      odps: odps || []
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: PENGATURAN SISTEM ─────────────────────────────────────────
router.get('/app/admin/settings', requireAdminApiAuth, (req, res) => {
  try {
    const s = getSettingsWithCache();
    res.json({
      success: true,
      data: {
        company_header: s.company_header || '', company_subheader: s.company_subheader || '',
        company_phone: s.company_phone || '', company_address: s.company_address || '',
        server_port: s.server_port || '3001', timezone: s.timezone || 'America/Asuncion',
        payment_gateway: s.payment_gateway || '', qris_enabled: s.qris_enabled || '0',
        whatsapp_enabled: s.whatsapp_enabled || '0', telegram_enabled: s.telegram_enabled || '0',
        radius_enabled: s.radius_enabled || '0',
        multi_router_mode: s.multi_router_mode || 'disabled',
        auto_isolate_enabled: s.auto_isolate_enabled || '1',
        webhook_secret: s.webhook_secret || 'billing-rtrw-secret-key'
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/admin/settings/update', requireAdminApiAuth, (req, res) => {
  try {
    const allowed = ['company_header', 'company_subheader', 'company_phone', 'company_address', 'timezone', 'qris_enabled', 'auto_isolate_enabled', 'webhook_secret'];
    const updates = req.body || {};
    const settingsPath = require('../config/paths').settingsPath;
    const current = JSON.parse(require('fs').readFileSync(settingsPath, 'utf8'));
    let changed = 0;
    for (const key of allowed) {
      if (updates[key] !== undefined) { current[key] = updates[key]; changed++; }
    }
    if (changed > 0) require('fs').writeFileSync(settingsPath, JSON.stringify(current, null, 2));
    res.json({ success: true, message: `${changed} ajustes actualizados` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: WEBHOOK GATEWAY LOGS & TEST ──────────────────────────────
router.get('/app/admin/webhook/logs', requireAdminApiAuth, (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT id, service, content, parsed_amount, parsed_ok, matched_invoice_id, matched_voucher_order_id, matched_donation_order_id, created_at
      FROM webhook_payment_notifs
      ORDER BY id DESC
      LIMIT 20
    `).all();
    res.json({ success: true, data: logs || [] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/admin/webhook/test', requireAdminApiAuth, (req, res) => {
  try {
    const s = getSettingsWithCache();
    const secret = s.webhook_secret || 'billing-rtrw-secret-key';
    res.json({
      success: true,
      message: '¡Conexión con el webhook correcta!',
      server_time: new Date().toISOString(),
      secret_configured: !!secret
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: TEKNISI ──────────────────────────────────────────────────
router.get('/app/admin/technicians', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, name, username, phone, area, is_active, created_at FROM technicians ORDER BY id DESC`).all() || [];
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: KASIR ────────────────────────────────────────────────────
router.get('/app/admin/cashiers', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, name, username, phone, is_active, created_at FROM cashiers ORDER BY id DESC`).all() || [];
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: KOLEKTOR ─────────────────────────────────────────────────
router.get('/app/admin/collectors', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, name, username, phone, area, is_active, created_at FROM collectors ORDER BY id DESC`).all() || [];
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: AGEN ─────────────────────────────────────────────────────
router.post('/app/admin/customers/topup', requireAdminApiAuth, async (req, res) => {
  try {
    const { customerId, amount, actionType, note, sendWhatsApp } = req.body;
    const cid = Number(customerId);
    const amt = Number(amount);
    const action = actionType === 'deduct' ? 'deduct' : 'add';
    const actorName = req.admin?.name || req.admin?.username || (req.admin?.role === 'cashier' ? 'Kasir' : 'Admin');
    const sendWa = sendWhatsApp !== false && sendWhatsApp !== 'false';

    if (!cid || !amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'El ID de cliente y un monto válido son obligatorios.' });
    }

    const result = await customerSvc.topupCustomerBalance(cid, amt, note, actorName, action, sendWa);
    const actionText = action === 'deduct' ? 'dipotong' : 'ditambahkan';

    res.json({
      success: true,
      message: `Saldo de "${result.customer?.name || ''}": ${actionText} ${regional.currencySymbol()} ${amt.toLocaleString(regional.locale())}. Saldo actual: ${regional.currencySymbol()} ${result.after.toLocaleString(regional.locale())}`,
      data: {
        customerId: cid,
        customerName: result.customer?.name,
        before: result.before,
        after: result.after,
        delta: result.delta,
        actionType: action
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── ADMIN NATIVE: APPROVAL PEMBAYARAN KOLEKTOR ─────────────────────────────
router.get('/app/admin/collector-payments', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT cp.*, c.name as customer_name, c.phone as customer_phone, col.name as collector_name
      FROM collector_payment_requests cp
      LEFT JOIN customers c ON c.id = cp.customer_id
      LEFT JOIN collectors col ON col.id = cp.collector_id
      ORDER BY cp.id DESC LIMIT 50
    `).all() || [];
    const pending = rows.filter(r => r.status === 'pending').length;
    res.json({ success: true, data: { payments: rows, pendingCount: pending } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/app/admin/collector-payments/approve', requireAdminApiAuth, async (req, res) => {
  try {
    const payId = Number(req.body.paymentId || req.body.id);
    if (!payId) return res.status(400).json({ success: false, message: 'ID de pago inválido' });
    const pay = db.prepare(`
      SELECT cp.*, col.name as collector_name
      FROM collector_payment_requests cp
      LEFT JOIN collectors col ON col.id = cp.collector_id
      WHERE cp.id = ?
    `).get(payId);
    if (!pay) return res.status(404).json({ success: false, message: 'Pago no encontrado' });
    if (pay.status !== 'pending') return res.status(400).json({ success: false, message: 'Pembayaran sudah diproses' });

    const adminName = req.admin?.name || 'Admin';
    db.prepare(`UPDATE collector_payment_requests SET status = 'approved', decided_at = (NOW_LOCAL()), decided_by_role = 'admin', decided_by_name = ? WHERE id = ?`).run(adminName, payId);

    if (pay.invoice_id) {
      const collectorLabel = `Kolektor: ${pay.collector_name || 'Kolektor'}`;
      billingSvc.markAsPaid(pay.invoice_id, collectorLabel, pay.note || 'Approved via APK Admin', {
        type: req.admin?.role || 'admin',
        id: req.admin?.id,
        name: adminName
      });

      const unpaidCount = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status='unpaid'").get(pay.customer_id)?.cnt || 0;
      if (unpaidCount === 0) {
        try { await customerSvc.activateCustomer(pay.customer_id); } catch (_) {}
      }
    }
    res.json({ success: true, message: 'Pago aprobado y factura marcada como PAGADA' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: AREA WILAYAH ─────────────────────────────────────────────
router.get('/app/admin/areas', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM customers WHERE area = a.name) as customer_count 
      FROM areas a ORDER BY a.name ASC
    `).all() || [];
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: INVENTARIS / GUDANG ──────────────────────────────────────
router.get('/app/admin/inventory', requireAdminApiAuth, (req, res) => {
  try {
    const items = db.prepare(`SELECT * FROM inventory_items ORDER BY name ASC`).all() || [];
    const lowStock = items.filter(i => i.quantity <= (i.min_stock || 5));
    res.json({ success: true, data: { items, lowStockCount: lowStock.length } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: TIKET DUKUNGAN ───────────────────────────────────────────
router.get('/app/admin/tickets', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, c.name as customer_name, c.phone as customer_phone
      FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id
      ORDER BY t.created_at DESC LIMIT 50
    `).all() || [];
    const openCount = rows.filter(r => r.status === 'open' || r.status === 'pending').length;
    res.json({ success: true, data: { tickets: rows, openCount } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/app/admin/tickets/update-status', requireAdminApiAuth, (req, res) => {
  try {
    const { ticketId, status, note } = req.body;
    if (!ticketId) return res.status(400).json({ success: false, message: 'ID de ticket inválido' });
    db.prepare('UPDATE tickets SET status = ?, updated_at = datetime("now","localtime") WHERE id = ?').run(status || 'resolved', Number(ticketId));
    res.json({ success: true, message: 'Estado del ticket actualizado' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: BACKUP DATABASE ──────────────────────────────────────────
router.get('/app/admin/backups', requireAdminApiAuth, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../backups');
    let files = [];
    if (fs.existsSync(backupDir)) {
      files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db') || f.endsWith('.zip') || f.endsWith('.gz'))
        .map(f => ({ name: f, size: fs.statSync(path.join(backupDir, f)).size, date: fs.statSync(path.join(backupDir, f)).mtime }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    res.json({ success: true, data: files });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/app/admin/backup/create', requireAdminApiAuth, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupDir, `billing_backup_${ts}.db`);
    const src = path.join(__dirname, '../database/billing.db');
    fs.copyFileSync(src, dest);
    const size = fs.statSync(dest).size;
    res.json({ success: true, message: `Respaldo creado: billing_backup_${ts}.db (${(size / 1024).toFixed(1)} KB)` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─── ADMIN NATIVE: AUDIT LOG ────────────────────────────────────────────────
router.get('/app/admin/audit-logs', requireAdminApiAuth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, action, actor_name as performed_by, details, created_at FROM audit_trail ORDER BY id DESC LIMIT 100`).all() || [];
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});



router.get('/app/tech/dashboard', requireTechApiAuth, (req, res) => {
  try {
    const techId = resolveTechId(req);
    const stats = techSvc.getTechStats(techId);
    const assignedTickets = techSvc.getAssignedTickets(techId);
    const openTickets = techSvc.getOpenTickets();
    const resolvedTickets = techSvc.getResolvedTickets(techId);
    const techInfo = techSvc.getTechById(techId);

    res.json({
      success: true,
      data: {
        tech: techInfo || { id: techId, name: req.tech?.name || 'Técnico de campo', username: req.tech?.username || 'teknisi', area: 'Semua Area' },
        stats: stats || { total: 0, open: 0, inProgress: 0, resolved: 0 },
        assignedTickets: assignedTickets || [],
        openTickets: openTickets || [],
        resolvedTickets: resolvedTickets || []
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/tech/tickets/take', requireTechApiAuth, (req, res) => {
  try {
    const ticketId = Number(req.body.ticketId || req.body.id);
    const techId = resolveTechId(req);
    if (!ticketId) return res.status(400).json({ success: false, message: 'ID de ticket inválido' });

    techSvc.takeTicket(ticketId, techId);
    res.json({ success: true, message: `¡Ticket #${ticketId} tomado! Ya podés empezar a trabajarlo.` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo tomar el ticket:' + e.message });
  }
});

router.post('/app/tech/tickets/update', requireTechApiAuth, async (req, res) => {
  try {
    const ticketId = Number(req.body.ticketId || req.body.id);
    const techId = resolveTechId(req);
    const status = String(req.body.status || 'in_progress').trim();
    const notes = String(req.body.notes || '').trim();
    if (!ticketId) return res.status(400).json({ success: false, message: 'ID de ticket inválido' });

    techSvc.updateTicketStatus(ticketId, techId, status, { notes });

    // WhatsApp notification if resolved
    if (status === 'resolved') {
      try {
        const settings = getSettingsWithCache();
        if (settings.whatsapp_enabled) {
          const waNotify = require('../services/waNotifyService');
          const ticketService = require('../services/ticketService');
          const ticket = ticketService.getTicketById(ticketId);
          const tech = techSvc.getTechById(techId);

          if (ticket && ticket.customer_phone) {
            const waMsg = `✅ *RECLAMO RESUELTO*\n\n` +
              `🎫 *Ticket:* #${ticket.id}\n` +
              `👤 *Cliente:* ${ticket.customer_name}\n` +
              `📝 *Subjek:* ${ticket.subject}\n` +
              `🛠️ *Técnico:* ${tech?.name || 'Técnico de campo'}\n` +
              `💬 *Nota:* ${notes || 'Reparado'}\n\n` +
              `Su servicio de internet ya funciona con normalidad. ¡Gracias!`;
            await waNotify.sendText(ticket.customer_phone, waMsg);
          }
        }
      } catch (_) {}
    }

    res.json({ success: true, message: `¡Estado del ticket #${ticketId} actualizado a ${status.toUpperCase()}!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo actualizar el estado:' + e.message });
  }
});

router.get('/app/tech/odps', requireTechApiAuth, (req, res) => {
  try {
    const odpSvc = require('../services/odpService');
    const odps = odpSvc.getAllOdps();
    res.json({ success: true, data: odps || [] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── MIKROTIK PPPOE MANAGEMENT FOR TECHNICIAN ─────────────────────────
router.get('/app/tech/mikrotik/secrets', requireTechApiAuth, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    const activeMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());

    const result = (Array.isArray(users) ? users : []).map(u => {
      const uname = String(u.name || '').trim();
      const isActive = uname && activeMap.has(uname.toLowerCase());
      const activeInfo = isActive ? activeMap.get(uname.toLowerCase()) : null;
      return {
        id: u['.id'] || u.id || '',
        name: uname,
        password: u.password || '',
        profile: u.profile || 'default',
        service: u.service || 'pppoe',
        disabled: u.disabled === 'true' || u.disabled === true,
        comment: u.comment || '',
        callerId: u['caller-id'] || '',
        active: isActive,
        activeIp: activeInfo?.address || activeInfo?.['address'] || '-',
        activeUptime: activeInfo?.uptime || '-'
      };
    });

    res.json({ success: true, data: result, total: result.length });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudieron leer los datos PPPoE del MikroTik:' + e.message });
  }
});

router.get('/app/tech/mikrotik/profiles', requireTechApiAuth, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profiles = await mikrotikService.getPppoeProfiles(routerId);
    res.json({ success: true, data: profiles || [] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/tech/mikrotik/secret/create', requireTechApiAuth, async (req, res) => {
  try {
    const { username, password, profile, comment, routerId } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'El usuario y la contraseña PPPoE son obligatorios' });

    await mikrotikService.addPppoeUser(username.trim(), password.trim(), profile || 'default', routerId ? Number(routerId) : null, { comment });
    res.json({ success: true, message: `¡Usuario PPPoE "${username}" creado en el MikroTik!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo crear el usuario PPPoE:' + e.message });
  }
});

router.post('/app/tech/mikrotik/secret/update', requireTechApiAuth, async (req, res) => {
  try {
    const { username, password, profile, disabled, routerId } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Usuario PPPoE inválido' });

    const updateData = {};
    if (password) updateData.password = password;
    if (profile) updateData.profile = profile;
    if (disabled !== undefined) updateData.disabled = disabled;

    await mikrotikService.updatePppoeUser(username.trim(), updateData, routerId ? Number(routerId) : null);
    res.json({ success: true, message: `¡Usuario PPPoE "${username}" actualizado en el MikroTik!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo actualizar el usuario PPPoE:' + e.message });
  }
});

router.post('/app/tech/mikrotik/secret/delete', requireTechApiAuth, async (req, res) => {
  try {
    const { username, routerId } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Usuario PPPoE inválido' });

    await mikrotikService.deletePppoeUser(username.trim(), routerId ? Number(routerId) : null);
    res.json({ success: true, message: `¡Usuario PPPoE "${username}" eliminado del MikroTik!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo eliminar el usuario PPPoE:' + e.message });
  }
});

router.post('/app/tech/mikrotik/secret/kick', requireTechApiAuth, async (req, res) => {
  try {
    const { username, routerId } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Usuario PPPoE inválido' });

    await mikrotikService.kickPppoeUser(username.trim(), routerId ? Number(routerId) : null);
    res.json({ success: true, message: `¡Sesión PPPoE "${username}" desconectada!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo desconectar la sesión PPPoE:' + e.message });
  }
});

// ─── TR-069 ONU MANAGEMENT FOR TECHNICIAN ────────────────────────────
router.get('/app/tech/tr069/devices', requireTechApiAuth, async (req, res) => {
  try {
    const { search, status, acs } = req.query;
    const customers = db.prepare('SELECT id, name, phone, pppoe_username, genieacs_tag FROM customers').all();
    const byPppoe = new Map();
    const byTag = new Map();
    for (const c of customers) {
      const pu = String(c.pppoe_username || '').trim().toLowerCase();
      const tg = String(c.genieacs_tag || '').trim();
      if (pu) byPppoe.set(pu, c);
      if (tg) byTag.set(tg, c);
    }

    const result = await customerDevice.listAllDevices(999999, acs);
    if (!result.ok) return res.json({ success: true, message: 'TR-069 GenieACS Offline / Timeout', data: [], total: 0 });

    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());
    let devices = result.devices.map(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive);
      const pu = String(mapped.pppoeUsername || '').trim();
      const puKey = pu && pu !== 'N/A' ? pu.toLowerCase() : '';
      let customer = puKey ? byPppoe.get(puKey) : null;
      if (!customer && Array.isArray(d._tags)) {
        for (const t of d._tags) {
          const hit = byTag.get(String(t || '').trim());
          if (hit) { customer = hit; break; }
        }
      }
      return {
        id: d._id,
        tag: d._tags?.[0] || d._id,
        serialNumber: mapped.serialNumber || '-',
        status: mapped.status.toLowerCase(),
        pppoeIP: mapped.pppoeIP || '-',
        pppoeUsername: mapped.pppoeUsername || '-',
        rxPower: mapped.rxPower || '-',
        uptime: mapped.uptime || '-',
        model: mapped.model || 'ONT Router',
        softwareVersion: mapped.softwareVersion || '-',
        ssid: mapped.ssid || '-',
        customerId: customer ? customer.id : null,
        customerName: customer ? customer.name : 'Sin cliente asignado',
        customerPhone: customer ? customer.phone : '-',
        manufacturer: d._deviceId?._Manufacturer || d._deviceId?.Manufacturer || 'ZTE/Huawei/Fiberhome'
      };
    });

    if (search) {
      const s = search.toLowerCase();
      devices = devices.filter(d =>
        d.id.toLowerCase().includes(s) ||
        d.serialNumber.toLowerCase().includes(s) ||
        d.pppoeUsername.toLowerCase().includes(s) ||
        d.customerName.toLowerCase().includes(s) ||
        d.customerPhone.toLowerCase().includes(s) ||
        d.ssid.toLowerCase().includes(s)
      );
    }

    if (status && status !== 'all') {
      devices = devices.filter(d => d.status === status);
    }

    res.json({ success: true, data: devices, total: devices.length });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudieron leer los datos TR-069:' + e.message });
  }
});

router.post('/app/tech/tr069/device/ssid', requireTechApiAuth, async (req, res) => {
  try {
    const { tag, ssid } = req.body;
    if (!tag || !ssid) return res.status(400).json({ success: false, message: 'La etiqueta del equipo y el nuevo SSID son obligatorios' });

    const ok = await customerDevice.updateSSID(tag, ssid.trim());
    if (ok) {
      // WA notification to customer
      try {
        const settings = getSettingsWithCache();
        if (settings.whatsapp_enabled) {
          const cust = customerSvc.findCustomerByAny(tag);
          if (cust && cust.phone) {
            const waNotify = require('../services/waNotifyService');
            const now = new Date().toLocaleString(regional.locale());
            const msg = `📡 *CAMBIO DE NOMBRE DEL WIFI (SSID)*\n\n` +
              `👤 *Cliente:* ${cust.name}\n` +
              `🕒 *Fecha:* ${now}\n\n` +
              `El nombre (SSID) del WiFi de su módem ahora es:\n` +
              `📶 *${ssid}*\n\n` +
              `Conecte sus dispositivos a la nueva red WiFi.`;
            await waNotify.sendText(cust.phone, msg);
          }
        }
      } catch (_) {}

      res.json({ success: true, message: `¡Nombre del WiFi cambiado a "${ssid}"!` });
    } else {
      res.status(400).json({ success: false, message: 'No se pudo cambiar el SSID. Verificá que el equipo esté conectado por TR-069.' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error update SSID: ' + e.message });
  }
});

router.post('/app/tech/tr069/device/password', requireTechApiAuth, async (req, res) => {
  try {
    const { tag, password } = req.body;
    if (!tag || !password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'La contraseña del WiFi debe tener al menos 8 caracteres' });
    }

    const ok = await customerDevice.updatePassword(tag, password.trim());
    if (ok) {
      // WA notification to customer
      try {
        const settings = getSettingsWithCache();
        if (settings.whatsapp_enabled) {
          const cust = customerSvc.findCustomerByAny(tag);
          if (cust && cust.phone) {
            const waNotify = require('../services/waNotifyService');
            const now = new Date().toLocaleString(regional.locale());
            const msg = `🔑 *CAMBIO DE CONTRASEÑA DEL WIFI*\n\n` +
              `👤 *Cliente:* ${cust.name}\n` +
              `🕒 *Fecha:* ${now}\n\n` +
              `La contraseña del WiFi de su módem ahora es:\n` +
              `🔐 *${password}*\n\n` +
              `Use la nueva contraseña para conectarse.`;
            await waNotify.sendText(cust.phone, msg);
          }
        }
      } catch (_) {}

      res.json({ success: true, message: `¡Contraseña del WiFi cambiada!` });
    } else {
      res.status(400).json({ success: false, message: 'No se pudo cambiar la contraseña del WiFi. Verificá que el equipo esté conectado por TR-069.' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error update Password WiFi: ' + e.message });
  }
});

router.post('/app/tech/tr069/device/reboot', requireTechApiAuth, async (req, res) => {
  try {
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ success: false, message: 'Etiqueta / ID de equipo inválido' });

    const ok = await customerDevice.requestReboot(tag);
    if (ok) {
      res.json({ success: true, message: '¡Orden de reinicio enviada a la ONT por TR-069!' });
    } else {
      res.status(400).json({ success: false, message: 'No se pudo enviar la orden de reinicio. Verificá que el equipo esté conectado por TR-069.' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error reboot TR-069: ' + e.message });
  }
});

// ─── TEKNISI NATIVE: PASANG BARU PELANGGAN ──────────────────────────────────
router.get('/app/tech/customers/options', requireTechApiAuth, (req, res) => {
  try {
    const pkgs = customerSvc.getAllPackages() || [];
    const routers = db.prepare('SELECT id, name, host FROM routers WHERE is_active = 1').all() || [];
    const odps = db.prepare('SELECT id, name, area, total_ports, used_ports FROM odps').all() || [];
    const areas = db.prepare('SELECT id, name FROM areas ORDER BY name ASC').all() || [];
    res.json({ success: true, data: { packages: pkgs, routers, odps, areas } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/tech/customers/create', requireTechApiAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'El nombre del cliente es obligatorio' });

    const customerData = {
      name,
      phone: String(req.body.phone || '').trim(),
      address: String(req.body.address || '').trim(),
      area: String(req.body.area || '').trim(),
      package_id: req.body.package_id ? Number(req.body.package_id) : null,
      pppoe_username: String(req.body.pppoe_username || '').trim(),
      pppoe_password: String(req.body.pppoe_password || '123456').trim(),
      router_id: req.body.router_id ? Number(req.body.router_id) : null,
      odp_id: req.body.odp_id ? Number(req.body.odp_id) : null,
      lat: String(req.body.lat || '').trim(),
      lng: String(req.body.lng || '').trim(),
      status: 'active',
      install_date: new Date().toISOString().slice(0, 10),
      notes: String(req.body.notes || 'Alta nueva desde la app del técnico').trim(),
      isolate_day: req.body.isolate_day ? Number(req.body.isolate_day) : 10
    };

    if (customerData.pppoe_username) {
      const existing = db.prepare('SELECT id, name FROM customers WHERE pppoe_username = ? LIMIT 1').get(customerData.pppoe_username);
      if (existing) return res.status(400).json({ success: false, message: `El usuario PPPoE ya lo usa ${existing.name}` });
    }

    const inserted = customerSvc.createCustomer(customerData);
    const newId = Number(inserted.lastInsertRowid);

    // If PPPoE and router, create secret in MikroTik
    if (customerData.pppoe_username && customerData.router_id) {
      try {
        const pkg = customerData.package_id ? customerSvc.getPackageById(customerData.package_id) : null;
        await mikrotikService.upsertPppoeSecret(customerData.router_id, {
          name: customerData.pppoe_username,
          password: customerData.pppoe_password,
          profile: pkg?.name || 'default',
          comment: `Cliente #${newId}: ${customerData.name}`
        });
      } catch (mErr) {
        logger.error('[Tech Create Customer] MikroTik upsert error: ' + mErr.message);
      }
    }

    // Update ODP used ports
    if (customerData.odp_id) {
      try {
        db.prepare('UPDATE odps SET used_ports = used_ports + 1 WHERE id = ?').run(customerData.odp_id);
      } catch (_) {}
    }

    res.json({
      success: true,
      message: `¡Cliente "${name}" registrado y conectado al sistema!`,
      customerId: newId
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo registrar el cliente:' + e.message });
  }
});

// ─── TEKNISI NATIVE: ABSENSI ────────────────────────────────────────────────
router.get('/app/tech/attendance/today', requireTechApiAuth, (req, res) => {
  try {
    const techId = resolveTechId(req);
    const attendanceSvc = require('../services/attendanceService');
    const { getSetting } = require('../config/settingsManager');
    const companyName = getSetting('company_header', 'OPEN-ISP');
    const today = attendanceSvc.getTodayAttendance('technician', techId);
    res.json({
      success: true,
      data: today ? { ...today, companyName } : { status: 'none', companyName }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/app/tech/attendance/checkin', requireTechApiAuth, (req, res) => {
  try {
    const techId = resolveTechId(req);
    const tech = techSvc.getTechById(techId);
    const attendanceSvc = require('../services/attendanceService');
    const today = attendanceSvc.getTodayAttendance('technician', techId);
    if (today) {
      return res.status(400).json({ success: false, message: '¡Ya registraste tu entrada hoy!' });
    }

    let { lat, lng, note, photo } = req.body || {};
    const { getSetting } = require('../config/settingsManager');
    const officeLat = getSetting('office_lat', '0');
    const officeLng = getSetting('office_lng', '0');
    if ((!lat || !lng || String(lat).trim() === '' || String(lat).trim() === '0') && officeLat && officeLng) {
      lat = officeLat;
      lng = officeLng;
    }

    const photoPath = saveAttendancePhoto(photo);

    const result = attendanceSvc.checkIn({
      employee_type: 'technician',
      employee_id: techId,
      employee_name: tech?.name || req.tech?.name || 'Técnico de campo',
      lat: String(lat || officeLat || ''),
      lng: String(lng || officeLng || ''),
      note: String(note || 'Entrada desde la app del técnico'),
      photo: photoPath
    });

    res.json({ success: true, message: '✅ ¡Entrada registrada!', id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo registrar la entrada:' + e.message });
  }
});

router.post('/app/tech/attendance/checkout', requireTechApiAuth, (req, res) => {
  try {
    const techId = resolveTechId(req);
    const attendanceSvc = require('../services/attendanceService');
    const today = attendanceSvc.getTodayAttendance('technician', techId);
    if (!today) {
      return res.status(400).json({ success: false, message: '¡Todavía no registraste tu entrada hoy!' });
    }
    if (today.status === 'checked_out') {
      return res.status(400).json({ success: false, message: '¡Ya registraste tu salida hoy!' });
    }

    let { lat, lng, note, photo } = req.body || {};
    const { getSetting } = require('../config/settingsManager');
    const officeLat = getSetting('office_lat', '0');
    const officeLng = getSetting('office_lng', '0');
    if ((!lat || !lng || String(lat).trim() === '' || String(lat).trim() === '0') && officeLat && officeLng) {
      lat = officeLat;
      lng = officeLng;
    }

    const photoPath = saveAttendancePhoto(photo);

    attendanceSvc.checkOut(today.id, {
      lat: String(lat || officeLat || ''),
      lng: String(lng || officeLng || ''),
      note: String(note || 'Salida desde la app del técnico'),
      photo: photoPath
    });

    res.json({ success: true, message: '✅ ¡Salida registrada! Gracias por tu trabajo de hoy.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'No se pudo registrar la salida:' + e.message });
  }
});

// ─── PELANGGAN NATIVE: WALLET / DOMPET ──────────────────────────────────────
router.get('/app/customer/wallet', requireCustomerApiAuth, (req, res) => {
  try {
    const customerId = req.customer.id;
    const row = db.prepare('SELECT id, name, balance FROM customers WHERE id = ?').get(customerId);
    const history = db.prepare('SELECT * FROM customer_topup_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 20').all(customerId) || [];

    res.json({
      success: true,
      data: {
        balance: Number(row?.balance || 0),
        customerName: row?.name || 'Pelanggan',
        history: history
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── PELANGGAN NATIVE: TOPUP DOMPET VIA QRIS ────────────────────────────────
router.post('/app/customer/topup/create', requireCustomerApiAuth, async (req, res) => {
  try {
    const customerId = req.customer.id;
    const amount = Number(req.body.amount || 0);
    if (!amount || amount < 10000) {
      return res.status(400).json({ success: false, message: 'La carga mínima de saldo es' + regional.formatMoney(10000) });
    }

    const customer = req.customer;

    // Generate unique code 1-999
    const uniqueCode = Math.floor(1 + Math.random() * 998);
    const totalAmount = amount + uniqueCode;

    const ins = db.prepare(`INSERT INTO customer_topup_requests (customer_id, amount, status) VALUES (?, ?, 'pending')`).run(customerId, totalAmount);
    const reqId = Number(ins.lastInsertRowid);

    // Static / Dynamic QRIS payload
    const settings = getSettingsWithCache();
    let qrisPayload = settings.qris_static_payload || settings.qris_string || '';

    // If static payload, modify with total amount if possible
    if (qrisPayload && qrisUtil && qrisUtil.createDynamicQris) {
      try {
        qrisPayload = qrisUtil.createDynamicQris(qrisPayload, totalAmount);
      } catch (_) {}
    }

    db.prepare('UPDATE customer_topup_requests SET payment_payload = ?, updated_at = (NOW_LOCAL()) WHERE id = ?')
      .run(JSON.stringify({ total_amount: totalAmount, unique_code: uniqueCode, qris_string: qrisPayload }), reqId);

    res.json({
      success: true,
      data: {
        topupId: reqId,
        amount: amount,
        uniqueCode: uniqueCode,
        totalAmount: totalAmount,
        qrisString: qrisPayload,
        status: 'pending'
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/app/customer/topup/status/:id', requireCustomerApiAuth, (req, res) => {
  try {
    const reqId = Number(req.params.id);
    const row = db.prepare('SELECT * FROM customer_topup_requests WHERE id = ? AND customer_id = ?').get(reqId, req.customer.id);
    if (!row) return res.status(404).json({ success: false, message: 'Carga de saldo no encontrada' });

    const cust = db.prepare('SELECT balance FROM customers WHERE id = ?').get(row.customer_id);
    res.json({
      success: true,
      data: {
        id: row.id,
        amount: Number(row.amount || 0),
        status: row.status || 'pending',
        paidAt: row.paid_at,
        currentBalance: Number(cust?.balance || 0)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── PELANGGAN NATIVE: KATALOG & BELI PPOB ──────────────────────────────────
router.get('/config', (req, res) => {

  const settings = getSettingsWithCache();
  const adminPhone = getResolvedAdminPhone(settings);
  res.json({
    success: true,
    data: {
      appName: settings.company_header || 'ISP Billing',
      companyHeader: settings.company_header || 'OPEN-ISP',
      companyPhone: adminPhone,
      adminPhone: adminPhone,
      companyEmail: settings.company_email || '',
      companyAddress: settings.company_address || '',
      operationalHours: settings.operational_hours || '08.00 - 22.00 WIB',
      timezone: settings.timezone || 'America/Asuncion',
      gateways: {
        tripay: Boolean(settings.tripay_enabled && settings.tripay_api_key),
        midtrans: Boolean(settings.midtrans_enabled && settings.midtrans_server_key),
        xendit: Boolean(settings.xendit_enabled && settings.xendit_api_key),
        duitku: Boolean(settings.duitku_enabled && settings.duitku_api_key),
        qrisStatic: Boolean(settings.qris_static_enabled)
      }
    }
  });
});

// ─── 2. AUTENTIKASI MULTI-ROLE (ADMIN, AGENT, KOLEKTOR, TEKNISI, PELANGGAN) ──
// Límite de intentos para los ingresos por API (app móvil)
const { loginRateLimiter: apiLoginLimiter } = require('../middleware/rateLimiter');

router.post('/auth/login', apiLoginLimiter, (req, res) => {
  const { loginId, username, password } = req.body;
  const inputUser = String(loginId || username || '').trim();
  const inputPass = String(password || '').trim();

  if (!inputUser) {
    return res.status(400).json({ success: false, message: 'El usuario / WhatsApp / ID es obligatorio.' });
  }
  if (!inputPass) {
    return res.status(400).json({ success: false, message: 'La contraseña es obligatoria.' });
  }

  // 1. Check Root Administrator
  const _adminAuth = require('../config/adminAuth');
  const adminUser = _adminAuth.username();
  const _av = _adminAuth.hasPassword() ? _adminAuth.verify(inputUser, inputPass, null) : { ok: false };
  if (_av.ok && !_av.mustChange) {
    const adminObj = { id: 1, name: 'Administrator', username: adminUser, role: 'admin' };
    const token = generateApiToken({ id: 1, adminId: 1, name: 'Administrator', username: adminUser, role: 'admin' });
    return res.json({
      success: true,
      message: 'Ingreso de administrador correcto.',
      role: 'admin',
      token,
      user: adminObj
    });
  }

  // 2. Check Cashier
  try {
    const cashier = adminSvc.authenticateCashier(inputUser, inputPass);
    if (cashier) {
      const cashierObj = { id: cashier.id, name: cashier.name, username: cashier.username, role: 'cashier' };
      const token = generateApiToken({ id: cashier.id, cashierId: cashier.id, name: cashier.name, username: cashier.username, role: 'cashier' });
      return res.json({
        success: true,
        message: 'Ingreso de cajero correcto.',
        role: 'cashier',
        token,
        user: cashierObj
      });
    }
  } catch (_) {}

// 4. Check Collector
  try {
    const collector = adminSvc.authenticateCollector(inputUser, inputPass);
    if (collector) {
      const collectorObj = { id: collector.id, name: collector.name, phone: collector.phone || '', username: collector.username, role: 'collector' };
      const token = generateApiToken({ id: collector.id, collectorId: collector.id, name: collector.name, phone: collector.phone, username: collector.username, role: 'collector' });
      return res.json({
        success: true,
        message: 'Ingreso de cobrador correcto.',
        role: 'collector',
        token,
        user: collectorObj
      });
    }
  } catch (_) {}

  // 5. Check Technician
  try {
    const tech = techSvc.authenticate(inputUser, inputPass);
    if (tech) {
      const techObj = { id: tech.id, name: tech.name, phone: tech.phone || '', username: tech.username, role: 'tech' };
      const token = generateApiToken({ id: tech.id, techId: tech.id, name: tech.name, phone: tech.phone, username: tech.username, role: 'tech' });
      return res.json({
        success: true,
        message: 'Ingreso de técnico correcto.',
        role: 'tech',
        token,
        user: techObj
      });
    }
  } catch (_) {}

  // 6. Check Customer Account
  const cleanDigits = inputUser.replace(/\D/g, '');
  const allCustomers = customerSvc.getAllCustomers();
  const customer = allCustomers.find((c) => {
    const cleanPhone = String(c.phone || '').replace(/\D/g, '');
    return (
      (cleanDigits && cleanPhone && cleanPhone.endsWith(cleanDigits.slice(-8))) ||
      c.phone === inputUser ||
      c.genieacs_tag === inputUser ||
      c.pppoe_username === inputUser ||
      String(c.id) === inputUser
    );
  });

  if (customer) {
    // Los clientes ya no ingresan con contraseña (antes aceptaba los últimos 4 dígitos
    // del teléfono o 123456). Deben usar /auth/otp/request y /auth/otp/verify.
    return res.status(401).json({
      success: false,
      otpRequired: true,
      message: 'Los clientes ingresan con un código enviado por WhatsApp.'
    });
  }
  // Not matched anywhere
  return res.status(401).json({
    success: false,
    message: 'Usuario / WhatsApp o contraseña incorrectos. Verifique sus datos.'
  });
});

// ─── Ingreso de clientes por código de WhatsApp (app móvil) ───
const customerAuth = require('../services/customerAuthService');

router.post('/auth/otp/request', apiLoginLimiter, async (req, res) => {
  const loginId = String((req.body && (req.body.loginId || req.body.phone)) || '').trim();
  if (!loginId) return res.status(400).json({ success: false, message: 'Ingrese su ID de cliente o su número de WhatsApp.' });
  const r = await customerAuth.requestOtp(loginId, { channel: 'api', ip: req.ip });
  if (!r.ok && !['not_found', 'no_phone'].includes(r.reason)) {
    return res.status(429).json({ success: false, message: customerAuth.messageFor(r) });
  }
  // Respuesta igual exista o no el cliente
  return res.json({ success: true, message: 'Si el dato corresponde a un cliente, le enviamos un código por WhatsApp.', maskedPhone: r.ok ? r.maskedPhone : null });
});

router.post('/auth/otp/verify', apiLoginLimiter, (req, res) => {
  const loginId = String((req.body && (req.body.loginId || req.body.phone)) || '').trim();
  const customer = customerAuth.findCustomer(loginId);
  const v = customerAuth.verifyOtp(customer ? customer.id : null, req.body && req.body.otp);
  if (!v.ok) return res.status(401).json({ success: false, message: customerAuth.messageFor(v) });
  const c = v.customer;
  const token = generateApiToken({ id: c.id, customerId: c.id, phone: c.phone, name: c.name, username: c.pppoe_username || c.id, role: 'customer' });
  return res.json({
    success: true,
    message: 'Ingreso de cliente correcto.',
    role: 'customer',
    token,
    customer: { id: c.id, name: c.name, phone: c.phone, pppoeUsername: c.pppoe_username || '', address: c.address || '', status: c.status || 'active', installDate: c.install_date || null }
  });
});

// ─── 3. BERANDA & PROFIL PELANGGAN (DASHBOARD) ────────────────────────────────
router.get('/dashboard', requireCustomerApiAuth, async (req, res) => {
  const customer = req.customer;
  const pkg = customer.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(customer.package_id) : null;
  const settings = getSettingsWithCache();

  const unpaidInvoices = db.prepare(`
    SELECT * FROM invoices 
    WHERE customer_id = ? AND (LOWER(COALESCE(status, 'unpaid')) NOT IN ('paid', 'lunas', 'cancelled', 'batal'))
    ORDER BY period_year DESC, period_month DESC, id DESC
  `).all(customer.id) || [];

  const totalUnpaidAmount = unpaidInvoices.length ? Number(unpaidInvoices[0].amount || 0) : 0;

  // Cari data live perangkat ONU persis seperti di web portal
  const tokenCandidates = Array.from(new Set([
    customer.pppoe_username,
    customer.genieacs_tag,
    customer.onu_sn,
    customer.phone,
    String(customer.id)
  ].map(v => String(v || '').trim()).filter(Boolean)));

  let liveDevice = null;
  for (const token of tokenCandidates) {
    try {
      liveDevice = await Promise.race([
        customerDevice.getCustomerDeviceData(token),
        new Promise(resolve => setTimeout(() => resolve(null), 2500))
      ]);
      if (liveDevice && liveDevice.status !== 'Tidak ditemukan') break;
    } catch (_) {}
  }

  const tr069Connected = Boolean(liveDevice && liveDevice.status && liveDevice.status !== 'Tidak ditemukan');
  const defaultWifiName = 'OPENISP_' + (customer.name || 'Fiber').replace(/\s+/g, '_');

  const ontInfo = tr069Connected ? {
    available: true,
    tr069Connected: true,
    online: liveDevice.status === 'Online',
    model: liveDevice.model || liveDevice.productClass || 'ONT Router',
    serialNumber: (liveDevice.serialNumber && liveDevice.serialNumber !== '-') ? liveDevice.serialNumber : (customer.onu_sn || '-'),
    softwareVersion: liveDevice.softwareVersion || '-',
    pppoeUsername: (liveDevice.pppoeUsername && liveDevice.pppoeUsername !== '-') ? liveDevice.pppoeUsername : (customer.pppoe_username || customer.name),
    ip: (liveDevice.pppoeIP && liveDevice.pppoeIP !== '-') ? liveDevice.pppoeIP : '-',
    rxPower: (liveDevice.rxPower && liveDevice.rxPower !== 'N/A' && liveDevice.rxPower !== '-') ? liveDevice.rxPower : 'Normal',
    ssid: (liveDevice.ssid && liveDevice.ssid !== '-' && liveDevice.ssid !== 'N/A') ? liveDevice.ssid : (customer.wifi_ssid || defaultWifiName),
    uptime: (liveDevice.uptime && liveDevice.uptime !== '-') ? liveDevice.uptime : '-'
  } : {
    available: false,
    tr069Connected: false,
    online: false,
    model: 'Equipo no registrado en TR-069',
    serialNumber: customer.onu_sn || '-',
    softwareVersion: '-',
    pppoeUsername: customer.pppoe_username || customer.name,
    ip: '-',
    rxPower: '-',
    ssid: '-',
    uptime: '-'
  };

  res.json({
    success: true,
    data: {
      profile: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email || '',
        address: customer.address || '',
        pppoeUsername: customer.pppoe_username || '',
        status: customer.status || 'active',
        isolateDay: customer.isolate_day || 10,
        installDate: customer.install_date || null,
        expiredAt: customer.expired_at || null,
        balance: Number(customer.balance || 0)
      },
      package: pkg ? {
        id: pkg.id,
        name: pkg.name,
        price: Number(pkg.price || 0),
        speed: pkg.speed || '',
        billingType: pkg.billing_type || 'postpaid'
      } : null,
      billing: {
        unpaidCount: unpaidInvoices.length,
        totalUnpaidAmount,
        latestUnpaidInvoice: unpaidInvoices[0] ? {
          id: unpaidInvoices[0].id,
          invoiceNo: `#INV-${unpaidInvoices[0].id}`,
          periodMonth: unpaidInvoices[0].period_month,
          periodYear: unpaidInvoices[0].period_year,
          amount: Number(unpaidInvoices[0].amount || 0),
          status: unpaidInvoices[0].status || 'unpaid',
          paidAt: unpaidInvoices[0].paid_at || null,
          paymentGateway: unpaidInvoices[0].payment_gateway || null,
          notes: unpaidInvoices[0].notes || '',
          createdAt: unpaidInvoices[0].created_at || null
        } : null
      },
      ont: ontInfo,
      isp: {
        name: settings.company_header || settings.company_name || settings.isp_name || 'ISP NETWORK',
        phone: getResolvedAdminPhone(settings),
        adminPhone: getResolvedAdminPhone(settings),
        address: settings.company_address || '',
        tagline: settings.company_tagline || settings.footer_info || ''
      }
    }
  });
});

// ─── 5. KONTROL WIFI & MODEM ONT (TR-069) ─────────────────────────────────────
router.get('/wifi', requireCustomerApiAuth, async (req, res) => {
  const customer = req.customer;
  const tokenCandidates = [customer.pppoe_username, customer.genieacs_tag, customer.phone, String(customer.id)].filter(Boolean);
  let liveDevice = null;
  for (const token of tokenCandidates) {
    try {
      liveDevice = await customerDevice.getCustomerDeviceData(token);
      if (liveDevice) break;
    } catch (_) {}
  }

  const realSsid = (liveDevice && liveDevice.ssid && liveDevice.ssid !== '-' && liveDevice.ssid !== 'N/A')
    ? liveDevice.ssid
    : (customer.wifi_ssid || ('OPENISP_' + (customer.name || 'Fiber').replace(/\s+/g, '_')));

  res.json({
    success: true,
    data: {
      online: liveDevice ? (liveDevice.status === 'Online') : true,
      model: (liveDevice && (liveDevice.model || liveDevice.productClass)) || 'ONT Router',
      ssid: realSsid,
      rxPower: (liveDevice && liveDevice.rxPower && liveDevice.rxPower !== 'N/A') ? liveDevice.rxPower : '-21.50 dBm',
      txPower: '2.30 dBm',
      temperature: '42 °C',
      connectedDevices: (liveDevice && liveDevice.connectedUsers && liveDevice.connectedUsers.length) || 0
    }
  });
});

// Ubah Nama WiFi Saja (SSID)
router.post('/wifi/change-ssid', requireCustomerApiAuth, async (req, res) => {
  const { ssid } = req.body;
  if (!ssid || ssid.trim().length < 2) {
    return res.status(400).json({ success: false, message: 'El nombre del WiFi (SSID) debe tener al menos 2 caracteres.' });
  }
  const customer = req.customer;
  const newSsid = ssid.trim();

  // Simpan ke DB customer
  try {
    db.prepare('UPDATE customers SET wifi_ssid = ? WHERE id = ?').run(newSsid, customer.id);
  } catch (_) {}

  // Kirim ke GenieACS TR-069
  const tokens = [customer.pppoe_username, customer.genieacs_tag, customer.phone, String(customer.id)].filter(Boolean);
  for (const token of tokens) {
    try {
      await customerDevice.updateSSID(token, newSsid);
    } catch (_) {}
  }

  res.json({
    success: true,
    message: `Nombre del WiFi cambiado a "${newSsid}". Vuelva a conectar sus dispositivos.`
  });
});

// Ubah Sandi WiFi Saja (Password)
router.post('/wifi/change-password', requireCustomerApiAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.trim().length < 8) {
    return res.status(400).json({ success: false, message: 'La contraseña del WiFi debe tener al menos 8 caracteres.' });
  }
  const customer = req.customer;
  const newPass = newPassword.trim();

  // Simpan ke kolom WiFi terpisah agar tidak menimpa password PPPoE
  try {
    db.prepare('UPDATE customers SET password_wifi = ? WHERE id = ?').run(newPass, customer.id);
  } catch (_) {}

  // Kirim ke GenieACS TR-069
  const tokens = [customer.pppoe_username, customer.genieacs_tag, customer.phone, String(customer.id)].filter(Boolean);
  for (const token of tokens) {
    try {
      await customerDevice.updatePassword(token, newPass);
    } catch (_) {}
  }

  res.json({
    success: true,
    message: '¡Contraseña del WiFi actualizada! Use la nueva contraseña para conectarse.'
  });
});

router.post('/wifi/reboot', requireCustomerApiAuth, async (req, res) => {
  const customer = req.customer;
  const tokens = [customer.pppoe_username, customer.genieacs_tag, customer.phone, String(customer.id)].filter(Boolean);
  for (const token of tokens) {
    try {
      await customerDevice.requestReboot(token);
    } catch (_) {}
  }
  res.json({
    success: true,
    message: 'Orden de reinicio enviada. El módem se reiniciará en 1 a 2 minutos.'
  });
});

// ─── 7. TIKET BANTUAN & LAPOR GANGGUAN ─────────────────────────────────────────
router.get('/tickets', requireCustomerApiAuth, (req, res) => {
  const customerId = req.customer.id;
  const tickets = db.prepare(`
    SELECT * FROM tickets 
    WHERE customer_id = ? 
    ORDER BY id DESC
  `).all(customerId) || [];

  res.json({
    success: true,
    data: tickets.map(t => ({
      id: t.id,
      ticketNo: `#TCK-${t.id}`,
      title: t.subject || 'Falla en el servicio',
      description: t.message || '',
      status: t.status || 'open',
      createdAt: t.created_at,
      updatedAt: t.updated_at
    }))
  });
});

router.post('/tickets/create', requireCustomerApiAuth, async (req, res) => {
  const title = String(req.body.title || req.body.subject || '').trim();
  const description = String(req.body.description || req.body.message || '').trim();
  const customer = req.customer;
  const subject = title || 'Falla en el servicio';
  const message = description || subject;

  try {
    const info = db.prepare(`
      INSERT INTO tickets (customer_id, subject, message, status, created_at, updated_at)
      VALUES (?, ?, ?, 'open', (NOW_LOCAL()), (NOW_LOCAL()))
    `).run(customer.id, subject, message);

    const ticketId = info.lastInsertRowid;

    res.json({
      success: true,
      message: 'Su reclamo fue registrado. El equipo técnico lo atenderá a la brevedad.',
      ticketId: ticketId
    });

    // --- WHATSAPP NOTIFICATION (async, tidak blokir response) ---
    try {
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const waNotify = require('../services/waNotifyService');
        const waMsg = `🎫 *NUEVO RECLAMO (app)*\n\n` +
                     `👤 *Cliente:* ${customer.name || 'Desconocido'}\n` +
                     `📞 *WhatsApp:* ${customer.phone || '-'}\n` +
                     `📝 *Subjek:* ${subject}\n` +
                     `💬 *Mensaje:* ${message}\n\n` +
                     `Revisalo en el panel de administración/técnicos para darle seguimiento.`;

        const recipients = new Set();

        // Kirim ke nomor admin
        if (Array.isArray(settings.whatsapp_admin_numbers)) {
          for (const adminPhone of settings.whatsapp_admin_numbers) {
            const digits = String(adminPhone || '').replace(/\D/g, '');
            if (digits.length >= 8) recipients.add(digits);
          }
        } else if (settings.whatsapp_number) {
          const digits = String(settings.whatsapp_number).replace(/\D/g, '');
          if (digits.length >= 8) recipients.add(digits);
        }

        // Kirim ke semua teknisi aktif
        try {
          const techSvc = require('../services/techService');
          const technicians = techSvc.getAllTechnicians ? techSvc.getAllTechnicians().filter(t => t.is_active === 1) : [];
          for (const tech of technicians) {
            const digits = String(tech.phone || '').replace(/\D/g, '');
            if (digits.length >= 8) recipients.add(digits);
          }
        } catch (_) {}

        for (const digits of recipients) {
          try { await waNotify.sendText(digits, waMsg); } catch (_) {}
        }
      }
    } catch (waErr) {
      logger.error(`[CustomerAPI] Ticket WA Notification Error: ${waErr.message}`);
    }
    // ----------------------------------------------------------

  } catch (e) {
    res.status(500).json({ success: false, message: `No se pudo crear el ticket: ${e.message}` });
  }
});

// ─── 8. API TEKNISI (Tech App) ──────────────────────────────────────────────
// Auth middleware untuk teknisi via token (juga mengizinkan admin/cashier/root untuk modul jaringan & TR-069)
function requireTechApiAuth(req, res, next) {
  try {
    const auth = extractToken(req);
    const token = String(auth || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ success: false, message: 'Falta el token' });
    const payload = verifyApiToken(token);
    if (!payload) return res.status(401).json({ success: false, message: 'Token inválido' });
    if (payload.role !== 'tech' && payload.role !== 'admin' && payload.role !== 'cashier' && payload.role !== 'root') {
      return res.status(403).json({ success: false, message: 'Acceso denegado: solo técnicos o administradores' });
    }
    req.tech = payload;
    req.admin = payload;
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Auth error: ' + e.message });
  }
}

// Login teknisi via API
router.post('/tech/login', express.json(), (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, message: 'El usuario y la contraseña son obligatorios' });
    const techSvc = require('../services/techService');
    const tech = techSvc.authenticate ? techSvc.authenticate(username, password) : null;
    if (!tech) return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
    const secret = getApiSecret();
    const payload = { techId: tech.id, name: tech.name, phone: tech.phone, role: 'tech', exp: Date.now() + 30 * 24 * 60 * 60 * 1000 };
    const body = b64urlEncode(JSON.stringify(payload));
    const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
    res.json({ success: true, token: `${body}.${sig}`, tech: { id: tech.id, name: tech.name, phone: tech.phone } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Get tiket yang di-assign ke teknisi (My Tasks)
router.get('/tech/tasks', requireTechApiAuth, (req, res) => {
  try {
    const techSvc = require('../services/techService');
    const myTickets = (techSvc.getAssignedTickets ? techSvc.getAssignedTickets(req.tech.techId) : []) || [];
    res.json({ success: true, data: myTickets });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Get pool tiket terbuka (belum diambil teknisi manapun)
router.get('/tech/pool', requireTechApiAuth, (req, res) => {
  try {
    const techSvc = require('../services/techService');
    const open = (techSvc.getOpenTickets ? techSvc.getOpenTickets() : []) || [];
    const customers = customerSvc.getAllCustomers ? customerSvc.getAllCustomers() : [];
    const customerMap = {};
    for (const c of customers) customerMap[c.id] = c;
    const enriched = open.map(t => ({
      ...t,
      customer_name: customerMap[t.customer_id]?.name || `Cliente #${t.customer_id}`,
      customer_phone: customerMap[t.customer_id]?.phone || '',
      customer_address: customerMap[t.customer_id]?.address || ''
    }));
    res.json({ success: true, data: enriched });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Ambil tiket (assign ke teknisi)
router.post('/tech/tickets/:id/take', requireTechApiAuth, (req, res) => {
  try {
    const techSvc = require('../services/techService');
    techSvc.takeTicket(req.params.id, req.tech.techId);
    res.json({ success: true, message: 'Ticket tomado.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Update status tiket oleh teknisi
router.post('/tech/tickets/:id/update', requireTechApiAuth, express.json(), (req, res) => {
  try {
    const { status, notes } = req.body || {};
    const techSvc = require('../services/techService');
    if (techSvc.updateTicket) {
      techSvc.updateTicket(req.params.id, req.tech.techId, { status: status || 'resolved', notes: notes || '' });
    } else {
      db.prepare(`UPDATE tickets SET status = ?, technician_notes = ?, updated_at = (NOW_LOCAL()) WHERE id = ?`)
        .run(status || 'resolved', notes || '', req.params.id);
    }
    res.json({ success: true, message: 'Estado del ticket actualizado.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Riwayat tiket selesai oleh teknisi
router.get('/tech/history', requireTechApiAuth, (req, res) => {
  try {
    const techSvc = require('../services/techService');
    const history = (techSvc.getResolvedTickets ? techSvc.getResolvedTickets(req.tech.techId) : []) || [];
    res.json({ success: true, data: history });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/invoices', requireCustomerApiAuth, (req, res) => {
  const customerId = req.customer.id;
  const invoices = db.prepare(`
    SELECT i.*, p.name as package_name 
    FROM invoices i
    LEFT JOIN packages p ON p.id = (SELECT package_id FROM customers WHERE id = i.customer_id)
    WHERE i.customer_id = ?
    ORDER BY i.period_year DESC, i.period_month DESC, i.id DESC
  `).all(customerId) || [];

  res.json({
    success: true,
    data: invoices.map(inv => ({
      id: inv.id,
      invoiceNo: `#INV-${inv.id}`,
      periodMonth: inv.period_month,
      periodYear: inv.period_year,
      amount: Number(inv.amount || 0),
      status: inv.status || 'unpaid',
      paidAt: inv.paid_at,
      paymentGateway: inv.payment_gateway,
      notes: inv.notes || '',
      createdAt: inv.created_at
    }))
  });
});

function ensureCustomerApiInvoiceQrisUnique(inv) {
  const invId = Number(inv?.id || 0);
  const custId = Number(inv?.customer_id || 0);
  const baseAmount = Number(inv?.amount || 0);
  if (!invId || baseAmount <= 0) {
    return { uniqueCode: 0, amountUnique: baseAmount };
  }

  const currentAmount = Number(inv?.qris_amount_unique || 0);
  const currentCode = Number(inv?.qris_unique_code || 0);
  if (currentAmount > 0 && currentCode > 0 && (currentAmount - currentCode === baseAmount)) {
    return { uniqueCode: currentCode, amountUnique: currentAmount };
  }

  const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
  let chosenCode = 0;
  let chosenAmount = 0;

  // 1. Prioritaskan ID Pelanggan sebagai kode unik utama (1 s/d 499)
  if (custId > 0) {
    const prefCode = (custId % 499 === 0) ? 499 : (custId % 499);
    const prefAmount = baseAmount + prefCode;
    if (!exists.get('unpaid', prefAmount, invId)) {
      chosenCode = prefCode;
      chosenAmount = prefAmount;
    }
  }

  // 2. Jika kode ID Pelanggan sudah terpakai, cari kode 1 s/d 499
  if (!chosenAmount) {
    for (let code = 1; code <= 499; code++) {
      const amount = baseAmount + code;
      if (!exists.get('unpaid', amount, invId)) {
        chosenCode = code;
        chosenAmount = amount;
        break;
      }
    }
  }

  // 3. Fallback 500 s/d 999
  if (!chosenAmount) {
    for (let code = 500; code <= 999; code++) {
      const amount = baseAmount + code;
      if (!exists.get('unpaid', amount, invId)) {
        chosenCode = code;
        chosenAmount = amount;
        break;
      }
    }
  }

  if (chosenAmount > 0 && String(inv?.status) === 'unpaid') {
    try {
      db.prepare(`
        UPDATE invoices
        SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=(NOW_LOCAL())
        WHERE id=?
      `).run(chosenCode, chosenAmount, invId);
    } catch (_) {}
    return { uniqueCode: chosenCode, amountUnique: chosenAmount };
  }

  return { uniqueCode: chosenCode || 0, amountUnique: chosenAmount || baseAmount };
}

// Middleware: Customer Auth or Public Invoice Token
function requireCustomerOrPublicInvoiceAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.substring(7).trim();
    const payload = verifyApiToken(token);
    if (payload && payload.role === 'customer') {
      req.customer = payload;
      return next();
    }
  }

  const pubToken = req.query.token || req.query.t || req.headers['x-invoice-token'];
  if (pubToken) {
    const settings = getSettingsWithCache();
    const tokenUtil = require('../utils/tokenUtil');
    const p = tokenUtil.verifyPublicToken(pubToken, settings.session_secret);
    if (p && Number(p.invoiceId) === Number(req.params.id)) {
      req.publicInvoiceAuth = p;
      return next();
    }
  }

  return res.status(401).json({ success: false, message: 'Se requiere autenticación o el token de la factura.' });
}

// GET /api/customer/public-check-bill?q=08...
// Pencarian tagihan cepat dari APK tanpa harus login (berdasarkan No. HP, Username PPPoE, atau ID)
router.get('/public-check-bill', (req, res) => {
  const qStr = String(req.query.q || '').trim();
  if (!qStr) {
    return res.status(400).json({ success: false, message: 'El teléfono o ID de cliente es obligatorio.' });
  }

  const cleanPhone = qStr.replace(/[^0-9]/g, '');
  const cust = db.prepare(`
    SELECT c.id, c.name, c.phone, c.pppoe_username, c.status, c.address, p.name as package_name, p.price as package_price
    FROM customers c
    LEFT JOIN packages p ON p.id = c.package_id
    WHERE c.phone = ? OR c.phone = ? OR c.pppoe_username = ? OR c.id = ?
  `).get(cleanPhone, qStr, qStr, Number(qStr) || 0);

  if (!cust) {
    return res.status(404).json({ success: false, message: 'No se encontró el cliente. Verifique el teléfono o ID ingresado.' });
  }

  const unpaidInvoices = db.prepare(`
    SELECT id, period_month, period_year, amount, status, qris_unique_code, qris_amount_unique
    FROM invoices
    WHERE customer_id = ? AND status != 'paid'
    ORDER BY id DESC
  `).all(cust.id);

  const settings = getSettingsWithCache();
  const tokenUtil = require('../utils/tokenUtil');

  const list = unpaidInvoices.map(inv => {
    const qrisInfo = ensureCustomerApiInvoiceQrisUnique(inv);
    const pubToken = tokenUtil.signPublicToken({
      invoiceId: inv.id,
      customerId: cust.id,
      lookup: qStr,
      exp: Date.now() + 60 * 60 * 1000 // 1 jam
    }, settings.session_secret);

    let rawPayload = String(settings.qris_static_payload || '').trim();
    let qrisPayload = '';
    const totalAmt = qrisInfo.amountUnique || Number(inv.amount || 0);
    if (rawPayload) {
      try {
        qrisPayload = qrisUtil.convertStaticQrisToDynamic(rawPayload, totalAmt);
      } catch (e) {
        qrisPayload = rawPayload;
      }
    }

    return {
      id: inv.id,
      invoiceNo: `#INV-${inv.id}`,
      periodMonth: inv.period_month,
      periodYear: inv.period_year,
      baseAmount: Number(inv.amount || 0),
      uniqueCode: qrisInfo.uniqueCode,
      totalAmount: totalAmt,
      qrisPayload: qrisPayload,
      qrisImageEndpoint: `/api/customer/invoices/${inv.id}/qris-image`,
      publicToken: pubToken,
      status: inv.status
    };
  });

  res.json({
    success: true,
    data: {
      customer: {
        id: cust.id,
        name: cust.name,
        phone: cust.phone,
        status: cust.status,
        packageName: cust.package_name || 'Plan de internet residencial'
      },
      unpaidCount: list.length,
      totalUnpaid: list.reduce((sum, item) => sum + item.totalAmount, 0),
      invoices: list
    }
  });
});

router.get('/invoices/:id', requireCustomerOrPublicInvoiceAuth, (req, res) => {
  const invId = Number(req.params.id);
  if (!invId) {
    return res.status(400).json({ success: false, message: 'ID de factura inválido.' });
  }

  const inv = db.prepare(`
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, p.name as package_name
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN packages p ON p.id = c.package_id
    WHERE i.id = ?
  `).get(invId);

  if (!inv) {
    return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
  }

  const settings = getSettingsWithCache();
  const baseAmt = Number(inv.amount || 0);
  const qrisInfo = ensureCustomerApiInvoiceQrisUnique(inv);
  const uniqueCode = qrisInfo.uniqueCode;
  const totalAmt = qrisInfo.amountUnique || baseAmt;

  const activeGateway = paymentSvc.resolveConfiguredGatewayForAmount(settings, baseAmt) || 'qris_static';

  let rawPayload = String(settings.qris_static_payload || '').trim();
  let qrisPayload = '';
  if (rawPayload) {
    try {
      qrisPayload = qrisUtil.convertStaticQrisToDynamic(rawPayload, totalAmt);
    } catch (e) {
      qrisPayload = rawPayload;
    }
  }

  res.json({
    success: true,
    data: {
      id: inv.id,
      invoiceNo: `#INV-${inv.id}`,
      customerName: inv.customer_name,
      customerPhone: inv.customer_phone,
      packageName: inv.package_name || 'Planes de internet',
      periodMonth: inv.period_month,
      periodYear: inv.period_year,
      baseAmount: baseAmt,
      uniqueCode: uniqueCode,
      totalAmount: totalAmt,
      qrisPayload: qrisPayload,
      qrisImageEndpoint: `/api/customer/invoices/${inv.id}/qris-image`,
      status: inv.status || 'unpaid',
      paidAt: inv.paid_at,
      activeGateway: activeGateway,
      paymentGateway: inv.payment_gateway || activeGateway,
      paymentOrderId: inv.payment_order_id,
      paymentLink: inv.payment_link,
      companyPhone: getResolvedAdminPhone(settings),
      adminPhone: getResolvedAdminPhone(settings),
      instructions: 'Transferencia o pago con QR desde la app de su banco o billetera.'
    }
  });
});

// Endpoint Gambar QRIS Dinamis Langsung (PNG Stream)
router.get('/invoices/:id/qris-image', async (req, res) => {
  try {
    const invId = Number(req.params.id);
    let inv = null;
    if (invId > 0) {
      inv = db.prepare('SELECT id, customer_id, amount, status, qris_unique_code, qris_amount_unique, payment_gateway, payment_order_id, payment_link FROM invoices WHERE id = ?').get(invId);
    }
    if (!inv) {
      inv = db.prepare("SELECT id, customer_id, amount, status, qris_unique_code, qris_amount_unique FROM invoices WHERE status != 'paid' ORDER BY id DESC LIMIT 1").get();
    }
    if (!inv) {
      inv = { id: 1, customer_id: 1, amount: 150000, status: 'unpaid' };
    }

    const settings = getSettingsWithCache();
    const qrisInfo = ensureCustomerApiInvoiceQrisUnique(inv);
    const totalAmt = qrisInfo.amountUnique || Number(inv.amount || 150000);

    let payload = settings.qris_static_payload || '00020101021126570011ID.DANA.WWW011893600915346519740402094651974040303UMI51440014ID.CO.QRIS.WWW0215ID10232708012520303UMI5204549953033605802ID5907ALIJAYA6014Kab. Indramayu6105452576304E962';
    try {
      payload = qrisUtil.convertStaticQrisToDynamic(payload, totalAmt);
    } catch (_) {}

    const buf = await QRCode.toBuffer(payload, { width: 600, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.send(buf);
  } catch (e) {
    res.status(500).send('Error generating QRIS: ' + e.message);
  }
});

// Request Pembayaran Gateway (Tripay, Midtrans, Duitku, Xendit, QRIS Dinamis)
router.post('/invoices/:id/pay', requireCustomerApiAuth, async (req, res) => {
  const invId = Number(req.params.id);
  const { gateway = 'tripay', method = 'QRIS' } = req.body;
  const settings = getSettingsWithCache();
  const customer = req.customer;

  const inv = billingSvc.getInvoiceById(invId);
  if (!inv || Number(inv.customer_id) !== Number(customer.id)) {
    return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
  }
  if (inv.status === 'paid') {
    return res.json({ success: true, message: 'Tagihan ini sudah lunas.', status: 'paid' });
  }

  const appUrl = (settings.public_base_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const returnPath = `/customer/invoice/${invId}`;
  const opts = { orderPrefix: 'INV', returnPath, callbackPath: '/customer/payment/callback' };

  try {
    let result;
    const selectedGateway = String(gateway).toLowerCase();

    if (selectedGateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(inv, customer, method === 'SNAP' ? 'snap' : method, appUrl, opts);
    } else if (selectedGateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(inv, customer, method, appUrl, opts);
    } else if (selectedGateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(inv, customer, method, appUrl, opts);
    } else {
      result = await paymentSvc.createTripayTransaction(inv, customer, method || 'QRIS', appUrl, opts);
    }

    if (!result || !result.success) {
      return res.status(400).json({ success: false, message: result?.message || 'No se pudo crear la transacción de pago.' });
    }

    res.json({
      success: true,
      data: {
        invoiceId: inv.id,
        gateway: selectedGateway,
        method: method || 'QRIS',
        orderId: result.order_id,
        paymentLink: result.link || result.payment_url || null,
        qrUrl: result.qr_url || result.qr_image || null,
        payload: result.payload || null
      }
    });
  } catch (error) {
    logger.error(`[CustomerAPI] Payment creation error: ${error.message}`);
    res.status(500).json({ success: false, message: `Error al crear el pago: ${error.message}` });
  }
});

// Cek Status Pembayaran Real-time (Support Customer Auth maupun Public Token)
router.get('/invoices/:id/check-status', requireCustomerOrPublicInvoiceAuth, (req, res) => {
  const invId = Number(req.params.id);
  const inv = db.prepare('SELECT id, customer_id, status, paid_at, payment_gateway FROM invoices WHERE id = ?').get(invId);
  if (!inv) return res.status(404).json({ success: false, message: 'Factura no encontrada.' });

  // Validasi customer_id jika customer authenticated
  if (req.customer && Number(inv.customer_id) !== Number(req.customer.id || req.customer.customerId)) {
    return res.status(403).json({ success: false, message: 'Acceso denegado.' });
  }

  res.json({
    success: true,
    data: {
      invoiceId: inv.id,
      status: inv.status || 'unpaid',
      isPaid: inv.status === 'paid',
      paidAt: inv.paid_at,
      paymentGateway: inv.payment_gateway
    }
  });
});

module.exports = router;
