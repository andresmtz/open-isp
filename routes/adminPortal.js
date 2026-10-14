/**
 * Route Admin Dashboard — termasuk Billing System
 */
const express = require('express');
const router = express.Router();
const { getSetting, getSettings, getSettingsWithCache, saveSettings, getNowLocal, getCurrentDateInTimezone, getCurrentTimeInfo, getNowLocalISO, formatDateLocal, formatTimeLocal, parseDateInTimezone } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const customerDevice = require('../services/customerDeviceService');
const customerSvc = require('../services/customerService');
const billingSvc = require('../services/billingService');
const pdfSvc = require('../services/pdfInvoiceService');
const mikrotikService = require('../services/mikrotikService');
const adminSvc = require('../services/adminService');
const oltSvc = require('../services/oltService');
const odpSvc = require('../services/odpService');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const qrisUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Promo slides upload storage
const promoSlidesStorage = multer.diskStorage({
  destination: function(req, file, cb) {
    const uploadDir = path.resolve(__dirname, '..', 'public', 'uploads', 'promo_slides');
    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    // Generate unique filename
    const ext = path.extname(file.originalname);
    const name = 'slide-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9) + ext;
    cb(null, name);
  }
});

const promoUpload = multer({
  storage: promoSlidesStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: function(req, file, cb) {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (JPEG, PNG, GIF, WebP)'), false);
    }
  }
});
const backupSvc = require('../services/backupService');
const monitoringSvc = require('../services/monitoringService');
const inventorySvc = require('../services/inventoryService');
const auditSvc = require('../services/auditTrailService');
const whatsappService = require('../services/whatsappService');
const regional = require('../config/regional');
const { parseMikhmonOnLogin } = require('../utils/mikhmonParser');
const diagnosticsSvc = require('../services/diagnosticsService');
const attendanceSvc = require('../services/attendanceService');
const payrollSvc = require('../services/payrollService');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const areaSvc = require('../services/areaService');
const axios = require('axios');
const crypto = require('crypto');
const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;
const jsQR = require('jsqr');
const qrisUtil = require('../utils/qrisUtil');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } = require('@zxing/library');
const QRCode = require('qrcode');
const acsPortal = require('./acsPortal');
const { uploadAttendance, removeAttendanceFile } = require('../middleware/attendanceUpload');

async function extractQrTextFromImageBuffer(buffer) {
  const buf = buffer && Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return '';
  return await qrisUtil.decodeQrisPayloadFromBuffer(buf);
}

const pppoeTrafficSamples = new Map();
function prunePppoeTrafficSamples(now) {
  for (const [k, v] of pppoeTrafficSamples.entries()) {
    if (!v || !v.t || (now - v.t) > 15000) pppoeTrafficSamples.delete(k);
  }
}

function numField(obj, keys) {
  if (!obj) return 0;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
    if (obj[String(k).toLowerCase()] !== undefined && obj[String(k).toLowerCase()] !== null && obj[String(k).toLowerCase()] !== '') {
      const n = Number(obj[String(k).toLowerCase()]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function strField(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k] !== undefined ? obj[k] : obj[String(k).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

async function invokeRouterOsMenuCommand(menu, command, args) {
  if (!menu) return null;
  if (typeof menu.call === 'function') return await menu.call(command, args);
  if (typeof menu.command === 'function') return await menu.command(command, args);
  if (typeof menu.run === 'function') return await menu.run(command, args);
  return null;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  const adminKey = getSetting('admin_api_key', '');
  const providedKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey && providedKey === adminKey) return next();
  return res.status(401).json({ error: 'Unauthorized - Admin/Staff access required' });
}

function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  return res.redirect('/admin/login');
}

function resolvePaidByName(req, fallback) {
  const fb = String(fallback || '').trim();
  if (req.session?.isCashier) {
    const nm = String(req.session.cashierName || '').trim();
    const un = String(req.session.cashierUsername || '').trim();
    if (nm && un) return `Kasir ${nm} (@${un})`;
    if (nm) return `Kasir ${nm}`;
    return 'Kasir';
  }
  if (req.session?.isAdmin) return fb || 'Admin';
  return fb || 'Admin';
}

function routerContextMiddleware(req, res, next) {
  try {
    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const activeRouters = mikrotikService.getAllRouters() || [];

    if (req.query.router_id !== undefined) {
      if (req.query.router_id === 'all' || req.query.router_id === '0' || req.query.router_id === '') {
        req.session.selected_router_id = null;
      } else {
        const rid = parseInt(req.query.router_id, 10);
        req.session.selected_router_id = isNaN(rid) ? null : rid;
      }
    }

    let selectedRouterId = req.session.selected_router_id ?? null;
    if (selectedRouterId && !activeRouters.some(r => r.id === selectedRouterId)) {
      selectedRouterId = null;
      req.session.selected_router_id = null;
    }

    res.locals.multiRouterMode = multiRouterMode;
    res.locals.allActiveRouters = activeRouters;
    res.locals.selectedRouterId = selectedRouterId;
    req.selectedRouterId = selectedRouterId;
  } catch (e) {
    res.locals.multiRouterMode = false;
    res.locals.allActiveRouters = [];
    res.locals.selectedRouterId = null;
    req.selectedRouterId = null;
  }
  next();
}

// Personal de oficina: solo lo que el administrador habilitó (denegar por defecto)
const staffPerms = require('../config/staffPermissions');
router.use(staffPerms.guard);
router.use(routerContextMiddleware);

router.get('/set-active-router', requireAdminSession, (req, res) => {
  const routerId = req.query.router_id;
  if (routerId === 'all' || routerId === '0' || !routerId) {
    req.session.selected_router_id = null;
  } else {
    const parsed = parseInt(routerId, 10);
    req.session.selected_router_id = isNaN(parsed) ? null : parsed;
  }
  // Tentukan tujuan redirect yang AMAN. Saat Service Worker aktif, referer
  // bisa berupa /sw.js (skrip SW), jadi jangan pernah redirect ke referer mentah.
  const host = `${req.protocol}://${req.get('host')}`;
  let target = '/admin';
  try {
    const ref = req.get('referer') || '';
    if (ref) {
      const u = new URL(ref, host);
      if (u.origin === host && u.pathname.startsWith('/admin') && !/\/sw\.js$/i.test(u.pathname)) {
        target = u.pathname + u.search;
      }
    }
  } catch (e) {}
  return res.redirect(target);
});

async function trySendWhatsappPayment(customerPhone, message) {
  try {
    if (!require('../config/waGate').ready()) return false;
    const to = String(customerPhone || '').trim();
    if (!to) return false;
    const waNotify = require('../services/waNotifyService');
    await waNotify.sendText(to, String(message || '').trim());
    return true;
  } catch {
    return false;
  }
}

async function sendPaymentSuccessWA(customerPhone, customerName, periodText, amountText, paidBy, extraOpts = {}) {
  try {
    const defaultTemplate = whatsappService.DEFAULT_PAYMENT_SUCCESS_TEMPLATE;
    const template = db.getAppSetting('whatsapp_payment_success_message', defaultTemplate);
    const settings = getSettings();
    const appUrl = (settings.public_base_url || '').replace(/\/$/, '');
    const portalUrl = appUrl ? `${appUrl}/customer` : '';

    let periodMonth = '';
    let periodYear = '';
    if (periodText && String(periodText).includes('/')) {
      const p = String(periodText).split('/');
      periodMonth = p[0];
      periodYear = p[1];
    }

    const custId = extraOpts.customerId || extraOpts.customer_id;
    const formattedMsg = whatsappService.formatPaymentSuccessMessage({
      customerName: customerName || 'Pelanggan',
      customerId: custId || null,
      remainingUnpaidInvoices: extraOpts.remainingUnpaidInvoices || null,
      invoiceId: extraOpts.invoiceId || '',
      customerUsername: extraOpts.username || custId || '-',
      customerCode: extraOpts.customerCode || '',
      packageName: extraOpts.packageName || '-',
      periodMonth: periodMonth || periodText,
      periodYear: periodYear || '',
      amount: String(amountText || '0').replace(/[^\d]/g, ''),
      paymentMethod: extraOpts.method || 'Kasir / Admin',
      receiver: paidBy || '-',
      paidAt: extraOpts.paidAt || new Date(),
      companyName: company(),
      companyPhone: settings.company_phone || '',
      csPhone: settings.company_whatsapp || settings.company_phone || '',
      portalUrl,
      customTemplate: template
    });

    const sent = await trySendWhatsappPayment(customerPhone, formattedMsg);
    logger.info(`[Pago] Comprobante por WhatsApp a ${customerName} (${customerPhone}): ${sent ? 'enviado' : 'NO enviado (WhatsApp desactivado o sin conexión)'}`);
    return sent;
  } catch (e) {
    logger.error(`[Pago] Comprobante por WhatsApp a ${customerName}: error ${e.message}`);
    return false;
  }
}

// Middleware strictly for Admin
function restrictToAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  req.session._msg = { type: 'error', text: 'Solo el administrador puede acceder a esta página.' };
  return res.redirect('/admin');
}

function company() { return getSetting('company_header', 'ISP Admin'); }
function finCfg() {
  return {
    ppn: Number(getSetting('finance_ppn_pct', '11')) || 0,
    pph: Number(getSetting('finance_pph_pct', '22')) || 0,
    uso: Number(getSetting('finance_uso_pct', '1.75')) || 0,
    bhp: Number(getSetting('finance_bhp_pct', '0.5')) || 0,
    inclPpn: String(getSetting('finance_revenue_includes_ppn', '0')) === '1'
  };
}
function labaRugi(bruto, keluar, fin) {
  fin = fin || finCfg();
  const dpp = (fin.inclPpn && fin.ppn > 0) ? (bruto / (1 + fin.ppn / 100)) : bruto;
  const ppn = fin.inclPpn ? (bruto - dpp) : (bruto * fin.ppn / 100);
  const uso = dpp * fin.uso / 100;
  const bhp = dpp * fin.bhp / 100;
  const sebelumPph = dpp - keluar - uso - bhp;
  const pph = Math.max(0, sebelumPph) * fin.pph / 100;
  return { bruto, dpp, ppn: Math.max(0, ppn), uso, bhp, keluar, sebelumPph, pph, bersih: sebelumPph - pph };
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function safeAdminPath(rawPath, fallback = '/admin/sidebar-settings') {
  const candidate = String(rawPath || '').trim();
  if (!candidate.startsWith('/admin')) return fallback;
  if (candidate.startsWith('/admin/logout')) return fallback;
  return candidate;
}

function requireSidebarMenuAccess(menuKey) {
  return (req, res, next) => {
    const access = sidebarMenuSvc.evaluateMenuAccess(menuKey, req.session);
    if (access.allowed) return next();

    if (access.reason === 'hidden') {
      req.session._msg = { type: 'error', text: `El menú "${access.menu.labelDefault}" está oculto en la barra lateral.` };
      return res.redirect('/admin');
    }

    if (access.reason === 'locked') {
      req.session._msg = { type: 'error', text: `El menú "${access.menu.labelDefault}" está bloqueado. Contactá a ${sidebarMenuSvc.FEATURE_CONTACT_PHONE} para obtener la contraseña.` };
      return res.redirect('/admin/sidebar-settings');
    }

    req.session._msg = { type: 'error', text: 'No tenés acceso a este menú.' };
    return res.redirect('/admin');
  };
}

function popUpdateLog(req) {
  const l = req.session._updateLog;
  delete req.session._updateLog;
  return l || '';
}

function readTextFileSafe(filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (e) {
    return '';
  }
}

function runCmd(cmd, args, cwd) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: String(e?.message || e) };
  }
}

function copyDirSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyDirSync(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

function getGitDefaultBranch(repoRoot) {
  let r = runCmd('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  if (r.ok) {
    const ref = String(r.stdout || '').trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1].trim();
  }
  r = runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (r.ok) {
    const b = String(r.stdout || '').trim();
    if (b && b !== 'HEAD') return b;
  }
  r = runCmd('git', ['rev-parse', '--verify', 'origin/main'], repoRoot);
  if (r.ok) return 'main';
  r = runCmd('git', ['rev-parse', '--verify', 'origin/master'], repoRoot);
  if (r.ok) return 'master';

  return 'main';
}

function getUpdateInfo(repoRoot) {
  const localVersion = readTextFileSafe(path.join(repoRoot, 'version.txt')) || '-';
  const info = { localVersion, remoteVersion: '-', branch: '-', needsUpdate: false, error: '' };

  const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!inside.ok) {
    // Tanpa .git (Docker/container): update dilakukan via rebuild image (bukan git)
    info.container = true;
    info.containerMessage = 'Esta instalación corre en un contenedor (sin .git). Para actualizar, reconstruí la imagen desde el repositorio.';
    return info;
  }

  const branch = getGitDefaultBranch(repoRoot);
  info.branch = branch;

  const _repo = String(getSetting('update_repo', 'oxpoe/open-isp') || '').trim();
  info.repo = _repo || 'origin';
  const fetch = _repo
    ? runCmd('git', ['fetch', '--prune', 'https://github.com/' + _repo + '.git', branch], repoRoot)
    : runCmd('git', ['fetch', '--prune'], repoRoot);
  if (!fetch.ok) {
    info.error = 'Falló git fetch:' + (fetch.stderr || fetch.stdout || '').trim();
    return info;
  }

  const remote = _repo
    ? runCmd('git', ['show', 'FETCH_HEAD:version.txt'], repoRoot)
    : runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
  if (!remote.ok) {
    info.error = `No se pudo leer version.txt desde GitHub (origin/${branch}).`;
    return info;
  }

  const remoteVersion = String(remote.stdout || '').trim() || '-';
  info.remoteVersion = remoteVersion;
  info.needsUpdate = Boolean(remoteVersion && remoteVersion !== '-' && remoteVersion !== localVersion);
  return info;
}


function genCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Avoid starting with 0 if it's only numbers
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

async function createVoucherBatchAsync(batchId) {
  const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
  if (!batch) return;

  const routerId = batch.router_id ?? null;
  const vouchers = db.prepare('SELECT id, code, profile_name FROM vouchers WHERE batch_id = ? ORDER BY id ASC').all(batchId);

  const updateVoucher = db.prepare('UPDATE vouchers SET code=?, password=?, comment=?, status=?, created_at=created_at WHERE id=?');
  const markVoucherCreated = db.prepare('UPDATE vouchers SET status=? WHERE id=?');
  const incCreated = db.prepare("UPDATE voucher_batches SET qty_created = qty_created + 1, updated_at = (NOW_LOCAL()) WHERE id=?");
  const incFailed = db.prepare("UPDATE voucher_batches SET qty_failed = qty_failed + 1, updated_at = (NOW_LOCAL()) WHERE id=?");
  const setBatchStatus = db.prepare("UPDATE voucher_batches SET status=?, updated_at = (NOW_LOCAL()) WHERE id=?");

  const existsCode = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');

  const makeUniqueCode = () => {
    const prefix = String(batch.prefix || '').trim();
    const coreLen = Math.max(4, Math.min(16, (Number(batch.code_length) || 6) - prefix.length));
    const userCode = prefix + genCode(coreLen, batch.charset || 'numbers');
    
    let passCode = userCode;
    if (batch.mode === 'member') {
      passCode = genCode(coreLen, batch.charset || 'numbers');
    }
    
    return { userCode, passCode };
  };

  const poolLimit = 8;
  let idx = 0;

  const worker = async () => {
    while (idx < vouchers.length) {
      const current = vouchers[idx++];
      let generated = { userCode: current.code, passCode: current.password || current.code };
      let attempt = 0;
      while (attempt < 10) {
        attempt++;

        if (existsCode.get(routerId, generated.userCode) && generated.userCode !== current.code) {
          generated = makeUniqueCode();
          continue;
        }

        try {
          const comment = current.comment || `vc-${batch.created_by || 'admin'}`;
          const userData = {
            server: 'all',
            name: generated.userCode,
            password: generated.passCode,
            profile: batch.profile_name,
            comment
          };
          if (batch.validity) userData['limit-uptime'] = batch.validity;

          await mikrotikService.addHotspotUser(userData, routerId);

          if (generated.userCode !== current.code || generated.passCode !== current.password) {
            updateVoucher.run(generated.userCode, generated.passCode, comment, 'created', current.id);
          } else {
            markVoucherCreated.run('created', current.id);
          }
          incCreated.run(batchId);
          break;
        } catch (e) {
          const msg = String(e?.message || e || '');
          const isDup = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exist') || msg.toLowerCase().includes('duplicate');
          if (isDup) {
            generated = makeUniqueCode();
            continue;
          }
          markVoucherCreated.run('failed', current.id);
          incFailed.run(batchId);
          break;
        }
      }
      if (attempt >= 10) {
        markVoucherCreated.run('failed', current.id);
        incFailed.run(batchId);
      }
    }
  };

  setBatchStatus.run('creating', batchId);
  const workers = Array.from({ length: poolLimit }, () => worker());
  await Promise.all(workers);

  const final = db.prepare('SELECT qty_total, qty_created, qty_failed FROM voucher_batches WHERE id=?').get(batchId);
  if (final.qty_created >= final.qty_total && final.qty_failed === 0) setBatchStatus.run('ready', batchId);
  else if (final.qty_created > 0) setBatchStatus.run('partial', batchId);
  else setBatchStatus.run('failed', batchId);
}

// Global locals middleware
router.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.can = (key) => staffPerms.has(req.session, key);
  // Contraseña de fábrica / débil: obligar a cambiarla antes de usar el panel
  if (req.session && req.session.isAdmin && req.session.mustChangePassword && !/^\/(account\/password|logout)(\/|$)/.test(req.path)) {
    return res.redirect('/admin/account/password');
  }
  try { res.locals.waStatus = require('../config/waGate').status(); } catch (_) { res.locals.waStatus = null; }
  res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(req.session);
  res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(req.session);
  res.locals.settings = getSettings();
  res.locals.company = company();
  res.locals.formatDateLocal = formatDateLocal;
  res.locals.formatTimeLocal = formatTimeLocal;
  res.locals.parseDateInTimezone = parseDateInTimezone;
  res.locals.getNowLocal = getNowLocal;
  res.locals.getCurrentTimeInfo = getCurrentTimeInfo;
  next();
});

let loginRateLimiter = (req, res, next) => next();
try {
  const rlMod = require('../middleware/rateLimiter');
  if (rlMod && typeof rlMod.loginRateLimiter === 'function') {
    loginRateLimiter = rlMod.loginRateLimiter;
  }
} catch (e) {}

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────
router.get('/account/password', requireAdminSession, restrictToAdmin, (req, res) => {
  const adminAuth = require('../config/adminAuth');
  res.render('admin/account_password', { company: company(), error: null, ok: null, forced: !!req.session.mustChangePassword,
    username: adminAuth.username(), needCurrent: adminAuth.hasPassword() || !adminAuth.isDirectLan(req), minLength: adminAuth.MIN_LENGTH });
});

router.post('/account/password', requireAdminSession, restrictToAdmin, loginRateLimiter, express.urlencoded({ extended: true }), (req, res) => {
  const adminAuth = require('../config/adminAuth');
  const view = (error, ok) => res.render('admin/account_password', { company: company(), error, ok, forced: !!req.session.mustChangePassword,
    username: adminAuth.username(), needCurrent: adminAuth.hasPassword() || !adminAuth.isDirectLan(req), minLength: adminAuth.MIN_LENGTH });
  try {
    const r = adminAuth.change({ current: req.body.current, next: req.body.next, confirm: req.body.confirm, newUsername: req.body.username }, req);
    req.session.mustChangePassword = false;
    req.session.adminUser = r.username;
    // Cerrar todas las demás sesiones del panel (por si alguien entró con la contraseña anterior)
    let closed = 0;
    try { closed = db.prepare("DELETE FROM sessions WHERE sid <> ? AND (data LIKE '%\"isAdmin\":true%' OR data LIKE '%\"isCashier\":true%')").run(req.sessionID).changes; } catch (_) {}
    try { auditSvc && auditSvc.logAuditTrail && auditSvc.logAuditTrail({ action: 'UPDATE', entity_type: 'admin_password', entity_id: 'admin', actor_type: 'admin', actor_name: r.username, details: { changed: true }, ip_address: req.ip }); } catch (_) {}
    view(null, 'Contraseña actualizada.' + (closed ? ` Se cerraron ${closed} sesión(es) abiertas en otros dispositivos.` : ''));
  } catch (e) { view(e.message, null); }
});


router.get('/login', (req, res) => {
  if (req.session?.isAdmin || req.session?.isCashier) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', company: company(), error: null });
});

router.post('/login', loginRateLimiter, express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const adminAuth = require('../config/adminAuth');
  const v = adminAuth.verify(username, password, req);
  if (v.ok) {
    return req.session.regenerate(() => {
      req.session.isAdmin = true;
      req.session.adminUser = adminAuth.username();
      req.session.mustChangePassword = !!v.mustChange;
      req.session.save(() => res.redirect(v.mustChange ? '/admin/account/password' : '/admin'));
    });
  }
  if (v.reason === 'no_password_remote') {
    return res.render('admin/login', { title: 'Admin Login', company: company(), error: 'El administrador todavía no tiene contraseña propia. Ingresá una vez desde la red local para crearla.' });
  }
  
  // Check Cashier
  const cashier = adminSvc.authenticateCashier(username, password);
  if (cashier) {
    return req.session.regenerate(() => {
      req.session.isCashier = true;
      req.session.cashierId = cashier.id;
      req.session.cashierName = cashier.name;
      req.session.cashierUsername = cashier.username;
      req.session.save(() => res.redirect('/admin'));
    });
  }

  res.render('admin/login', { title: 'Admin Login', company: company(), error: 'Usuario o contraseña incorrectos' });
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// ─── VER EL PORTAL COMO EL CLIENTE (solo lectura) ───────────────────────────
router.get('/customers/:id/portal-preview', requireAdminSession, (req, res) => {
  const c = db.prepare('SELECT id, name, phone, pppoe_username, router_id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) { req.session._msg = { type: 'error', text: 'Cliente no encontrado.' }; return res.redirect('/admin/customers'); }
  req.session.portalPreview = { customerId: c.id, by: req.session.adminUser || req.session.cashierName || 'admin', since: Date.now() };
  req.session.customer_id = c.id;
  req.session.phone = c.pppoe_username || c.phone;
  req.session.pppoe_username = c.pppoe_username || null;
  if (c.router_id) req.session.router_id = c.router_id;
  try { auditSvc && auditSvc.logAuditTrail && auditSvc.logAuditTrail({ action: 'VIEW', entity_type: 'portal_preview', entity_id: String(c.id), actor_type: req.session.isAdmin ? 'admin' : 'cashier', actor_name: req.session.portalPreview.by, details: { cliente: c.name }, ip_address: req.ip }); } catch (_) {}
  req.session.save(() => res.redirect('/customer/dashboard'));
});

// ─── EQUIPO Y WIFI DEL CLIENTE (ONU VSOL vía OLT) ───────────────────────────
router.get('/customers/:id/onu', requireAdminSession, async (req, res) => {
  const onuMgr = require('../services/onuManageService');
  try {
    const wantKeys = req.query.keys === '1';
    const d = await onuMgr.readDetail(Number(req.params.id), { includeKeys: wantKeys });
    if (wantKeys && d.ok) {
      try { auditSvc && auditSvc.logAuditTrail && auditSvc.logAuditTrail({ action: 'VIEW', entity_type: 'wifi_key', entity_id: String(req.params.id), actor_type: req.session.isAdmin ? 'admin' : 'cashier', actor_name: req.session.adminUser || req.session.cashierName || '-', details: { onu: d.onu_ref }, ip_address: req.ip }); } catch (_) {}
    }
    res.json({ ...d, history: onuMgr.history(Number(req.params.id), 10) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

router.post('/customers/:id/onu/wifi', requireAdminSession, express.json(), async (req, res) => {
  const onuMgr = require('../services/onuManageService');
  const actor = req.session.isAdmin ? { type: 'admin', name: req.session.adminUser || 'admin' } : { type: 'staff', name: req.session.cashierName || 'oficina' };
  try {
    const r = await onuMgr.changeWifi(Number(req.params.id), { name: req.body && req.body.name, key: req.body && req.body.key }, actor);
    try { auditSvc && auditSvc.logAuditTrail && auditSvc.logAuditTrail({ action: 'UPDATE', entity_type: 'wifi', entity_id: String(req.params.id), actor_type: actor.type, actor_name: actor.name, details: { red: r.name, red5g: r.name5g }, ip_address: req.ip }); } catch (_) {}
    res.json({ ok: true, message: `Listo: "${r.name}" y "${r.name5g}" con la clave nueva. Verificado y guardado en la ONU.`, ...r });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.get('/customers/:id/onu/clients', requireAdminSession, async (req, res) => {
  const cl = require('../services/onuClientsService');
  try {
    if (req.query.refresh === '1') await cl.refresh(Number(req.params.id));
    res.json({ ok: true, ...cl.summary(Number(req.params.id)) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
router.post('/customers/:id/onu/clients/name', requireAdminSession, express.json(), (req, res) => {
  try { require('../services/onuClientsService').setName(Number(req.params.id), req.body && req.body.mac, req.body && req.body.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.post('/customers/:id/onu/recheck', requireAdminSession, async (req, res) => {
  const onuMgr = require('../services/onuManageService');
  try {
    const r = await onuMgr.syncInventory({ force: true });
    res.json({ ok: true, message: `Inventario actualizado: ${r.onus} ONU, ${r.compatible} compatibles.`, ...r });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

router.get('/onu-inventory', requireAdminSession, (req, res) => {
  const onuMgr = require('../services/onuManageService');
  const ro = require('../services/tr069RolloutService');
  const acsTags = db.prepare('SELECT tags, last_inform FROM acs_devices').all();
  const rows = onuMgr.inventory().map(r => {
    const d = r.pppoe ? acsTags.find(a => String(a.tags || '').includes(`"${r.pppoe}"`)) : null;
    return { ...r, tr069: d ? d.last_inform : null };
  });
  res.render('admin/onu_inventory', { title: 'Inventario de ONU', company: company(), activePage: 'onu_inventory',
    rows, changes: onuMgr.recentChanges(30), rollout: ro.status(), today: require('../config/billingCycle').nowStamp().slice(0, 10), msg: flashMsg(req) });
});

router.post('/onu-inventory/tr069/schedule', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const at = `${String(req.body.date || '').trim()} ${String(req.body.time || '').trim()}`;
    require('../services/tr069RolloutService').schedule(at);
    req.session._msg = { type: 'success', text: `Activación de TR-069 programada para ${at}. Al terminar te llega un resumen por WhatsApp.` };
  } catch (e) { req.session._msg = { type: 'error', text: e.message }; }
  res.redirect('/admin/onu-inventory');
});
router.post('/onu-inventory/tr069/cancel', requireAdminSession, restrictToAdmin, (req, res) => {
  require('../services/tr069RolloutService').cancel();
  req.session._msg = { type: 'success', text: 'Activación de TR-069 cancelada (si estaba en curso, se detiene después de la ONU actual).' };
  res.redirect('/admin/onu-inventory');
});

router.post('/onu-inventory/sync', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const r = await require('../services/onuManageService').syncInventory({ force: req.body && req.body.force === '1' });
    req.session._msg = { type: r.errors.length ? 'error' : 'success', text: `Inventario actualizado: ${r.onus} ONU, ${r.checked} comprobadas, ${r.compatible} compatibles.` + (r.errors.length ? ' Errores: ' + r.errors.join('; ') : '') };
  } catch (e) { req.session._msg = { type: 'error', text: 'No se pudo actualizar: ' + e.message }; }
  res.redirect('/admin/onu-inventory');
});

// ─── OLT MANAGEMENT ────────────────────────────────────────────────────────
router.get('/olts', requireAdminSession, async (req, res) => {
  const olts = oltSvc.getAllOlts();
  
  res.render('admin/olts', { 
    title: 'Manajemen OLT', 
    company: company(), 
    activePage: 'olts', 
    olts, 
    msg: flashMsg(req) 
  });
});

router.get('/olts/all/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getAllOltsStats(req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/olts/:id/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getOltStats(req.params.id, req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/test-connection', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const result = await oltSvc.testOltConnection(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/olts/:id/test-connection', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const olt = oltSvc.getOltById(req.params.id);
    if (!olt) return res.status(404).json({ success: false, message: 'OLT no encontrada' });
    const result = await oltSvc.testOltConnection(olt);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/olts/:id/onu/:index/reboot', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    await oltSvc.rebootOnu(req.params.id, req.params.index);
    res.json({ success: true, message: 'Orden de reinicio enviada.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/rename', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) throw new Error('El nombre no puede quedar vacío');
    await oltSvc.renameOnu(req.params.id, req.params.index, name);
    res.json({ success: true, message: 'Nombre de la ONU actualizado.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/authorize', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const output = await oltSvc.authorizeOnu(req.params.id, req.body);
    res.json({ success: true, message: 'Autorización correcta.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/configure-wan', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { method, sn } = req.body;
    let output;
    if (method === 'tr069') {
      output = await oltSvc.configureWanViaAcs(sn, req.body);
    } else {
      output = await oltSvc.configureOnuWan(req.params.id, req.body);
    }
    res.json({ success: true, message: 'Configuración WAN aplicada.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.createOlt(req.body);
    req.session._msg = { type: 'success', text: 'OLT agregada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.updateOlt(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'OLT actualizada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    oltSvc.deleteOlt(req.params.id);
    req.session._msg = { type: 'success', text: 'OLT eliminada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/olts');
});

// ─── ODP & MAP MANAGEMENT ───────────────────────────────────────────────────
router.get('/map', requireAdminSession, requireSidebarMenuAccess('map'), (req, res) => {
  // Kirim HANYA field yang dipakai peta -> payload jauh lebih kecil (hemat di mobile/PWA)
  const CUST_FIELDS = ['id', 'name', 'address', 'area', 'lat', 'lng', 'status', 'phone', 'customer_code', 'package_name', 'speed_down', 'speed_up', 'pppoe_username', 'genieacs_tag', 'odp_id', 'odp_name', 'cable_path'];
  const ODP_FIELDS = ['id', 'name', 'description', 'lat', 'lng', 'pon_port', 'port_capacity'];
  const customers = customerSvc.getAllCustomers().map(function (c) {
    const o = {};
    CUST_FIELDS.forEach(function (k) { if (c[k] !== undefined) o[k] = c[k]; });
    return o;
  });
  const odps = odpSvc.getAllOdps().map(function (o) {
    const t = {};
    ODP_FIELDS.forEach(function (k) { if (o[k] !== undefined) t[k] = o[k]; });
    t.port_usage = odpSvc.getOdpPortUsage(o.id);
    return t;
  });
  const _s = getSettings();
  res.render('admin/map', {
    title: 'Mapa de red',
    company: company(),
    activePage: 'map',
    customers: customers,
    odps: odps,
    msg: flashMsg(req),
    mapSettings: { office_lat: _s.office_lat, office_lng: _s.office_lng }
  });
});

router.get('/api/customers/live-sessions', requireAdminSession, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const activeMap = await mikrotikService.getAllActiveSessionsMap(force);
    const sessionsObj = {};
    for (const [uname, session] of activeMap.entries()) {
      sessionsObj[uname] = session;
    }
    return res.json({ ok: true, sessions: sessionsObj });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/customers/:id/pppoe-traffic', requireAdminSession, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!customerId) return res.status(400).json({ ok: false, error: 'invalid_customer' });

  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) return res.status(404).json({ ok: false, error: 'not_found' });

  const routerId = customer.router_id ? Number(customer.router_id) : null;
  const username = String(customer.pppoe_username || '').trim();

  if (!routerId || !username) {
    return res.json({ ok: true, available: false, online: false, username: username || null, rxMbps: 0, txMbps: 0 });
  }

  const now = Date.now();
  prunePppoeTrafficSamples(now);

  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', username).get();
    if (!sessions || sessions.length === 0) {
      return res.json({ ok: true, available: true, online: false, username, rxMbps: 0, txMbps: 0 });
    }

    const s = sessions[0];
    let iface = strField(s, ['interface', 'interface-name', 'interfaceName', 'ifname', 'if-name', 'pppInterface']) || null;
    const baseSessionId = strField(s, ['.id', 'id', 'sessionId', 'session-id']) || `${username}`;
    const bytesIn = numField(s, ['bytesIn', 'bytes-in', 'bytes_in']);
    const bytesOut = numField(s, ['bytesOut', 'bytes-out', 'bytes_out']);
    const uptime = strField(s, ['uptime']) || null;

    if (!iface) {
      try {
        const pppoeSrvMenu = conn.client.menu('/interface/pppoe-server');
        let pppoeRows = [];
        try {
          pppoeRows = await pppoeSrvMenu.where('user', username).get();
        } catch {
          pppoeRows = await pppoeSrvMenu.get();
        }
        const hit = (Array.isArray(pppoeRows) ? pppoeRows : []).find(r => String(r.user || r['user'] || '').trim() === username);
        const ifaceName = strField(hit, ['name']);
        if (ifaceName) iface = ifaceName;
      } catch {}
    }

    const sessionId = `${baseSessionId}${iface ? `|${iface}` : ''}`;

    const key = `${routerId || 'default'}:${username}`;
    const prev = pppoeTrafficSamples.get(key);
    let rxBytes = bytesIn;
    let txBytes = bytesOut;
    let source = 'ppp-active';

    if (iface) {
      const ifMenu = conn.client.menu('/interface');
      if (ifMenu) {
        try {
          const mtRaw = await invokeRouterOsMenuCommand(ifMenu, 'monitor-traffic', { interface: iface, once: '' });
          const mt = Array.isArray(mtRaw) ? mtRaw[0] : mtRaw;
          const rxBps = numField(mt, ['rxBitsPerSecond', 'rx-bits-per-second', 'rx-bits-per-second']);
          const txBps = numField(mt, ['txBitsPerSecond', 'tx-bits-per-second', 'tx-bits-per-second']);
          if (rxBps || txBps) {
            return res.json({
              ok: true,
              available: true,
              online: true,
              username,
              iface,
              source: 'monitor-traffic',
              uptime,
              // La interfaz PPPoE se mide desde el router: tx = lo que BAJA el cliente, rx = lo que SUBE
              rxMbps: (Number(txBps) || 0) / 1e6,
              txMbps: (Number(rxBps) || 0) / 1e6
            });
          }
        } catch {}
      }
    }

    if (iface) {
      try {
        const ifRows = await conn.client.menu('/interface').where('name', iface).get();
        if (ifRows && ifRows.length > 0) {
          const row = ifRows[0];
          const ifRx = numField(row, ['rxByte', 'rx-byte', 'rx-bytes', 'rxBytes']);
          const ifTx = numField(row, ['txByte', 'tx-byte', 'tx-bytes', 'txBytes']);
          if (ifRx || ifTx) {
            rxBytes = ifRx;
            txBytes = ifTx;
            source = 'interface';
          }
        }
      } catch {}
    }

    pppoeTrafficSamples.set(key, { t: now, sessionId, rxBytes, txBytes, source });

    if (!prev || prev.sessionId !== sessionId || !prev.t) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const dtMs = Math.max(1, now - prev.t);
    const dIn = rxBytes - numField(prev, ['rxBytes']);
    const dOut = txBytes - numField(prev, ['txBytes']);
    if (dIn < 0 || dOut < 0) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    // Bytes "in" del router = subida del cliente; "out" = bajada. rxMbps se entrega como BAJADA del cliente.
    const rxMbps = (dOut * 8) / (dtMs / 1000) / 1e6;
    const txMbps = (dIn * 8) / (dtMs / 1000) / 1e6;

    return res.json({
      ok: true,
      available: true,
      online: true,
      username,
      iface,
      source,
      uptime,
      rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      txMbps: Number.isFinite(txMbps) ? txMbps : 0
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'failed' });
  } finally {
    if (conn && conn.api) conn.api.close();
  }
});

router.post('/api/customers/:id/cable-path', requireAdminSession, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { path } = req.body;
    if (!id) throw new Error('ID de cliente inválido');
    customerSvc.updateCustomerCablePath(id, path);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Save Cable Path Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/odps/:id/ports', requireAdminSession, (req, res) => {
  try {
    const usage = odpSvc.getOdpPortUsage(Number(req.params.id));
    if (!usage) return res.status(404).json({ error: 'NAP no encontrada' });
    res.json(usage);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/odps', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.createOdp(req.body);
    req.session._msg = { type: 'success', text: 'NAP agregada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.updateOdp(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'NAP actualizada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    odpSvc.deleteOdp(req.params.id);
    req.session._msg = { type: 'success', text: 'NAP eliminada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/map');
});

// --- TECHNICIAN MANAGEMENT ---
router.get('/technicians', requireAdminSession, requireSidebarMenuAccess('technicians'), restrictToAdmin, (req, res) => {
  const techPerms = require('../config/techPermissions');
  techPerms.ensureSchema();
  const technicians = adminSvc.getAllTechnicians().map(({ password, permissions, ...t }) => {
    const perms = techPerms.current(t.id);
    return { ...t, perms, permSummary: techPerms.summary(perms) };
  });
  res.render('admin/technicians', { title: 'Gestión de técnicos', company: company(), activePage: 'technicians', technicians, msg: flashMsg(req),
    permCatalog: techPerms.CATALOG });
});

function techPermsFromBody(body) {
  const out = {};
  for (const p of require('../config/techPermissions').CATALOG) out[p.key] = body && body['perm_' + p.key];
  return out;
}

router.post('/technicians/:id/permissions', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  const row = db.prepare('SELECT id, name FROM technicians WHERE id = ?').get(req.params.id);
  if (!row) { req.session._msg = { type: 'error', text: 'Técnico no encontrado.' }; return res.redirect('/admin/technicians'); }
  const out = require('../config/techPermissions').save(row.id, techPermsFromBody(req.body));
  try { auditSvc && auditSvc.logAuditTrail && auditSvc.logAuditTrail({ action: 'UPDATE', entity_type: 'technician_permissions', entity_id: String(row.id), actor_type: 'admin', actor_name: req.session.adminUser || 'admin', details: { tecnico: row.name, permisos: out }, ip_address: req.ip }); } catch (_) {}
  req.session._msg = { type: 'success', text: `Permisos de ${row.name} guardados. Se aplican de inmediato.` };
  res.redirect('/admin/technicians');
});

router.post('/technicians', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const r = adminSvc.createTechnician(req.body);
    require('../config/techPermissions').save(r.lastInsertRowid, techPermsFromBody(req.body));
    req.session._msg = { type: 'success', text: 'Técnico agregado con los permisos marcados.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateTechnician(req.params.id, req.body);
    const closed = (String(req.body.password || '') !== '' || String(req.body.is_active) === '0') ? require('../config/techPermissions').closeSessions(req.params.id) : 0;
    req.session._msg = { type: 'success', text: 'Datos del técnico actualizados.' + (closed ? ` Se cerraron ${closed} sesión(es) abiertas.` : '') };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteTechnician(req.params.id);
  require('../config/techPermissions').closeSessions(req.params.id);
  req.session._msg = { type: 'success', text: 'Técnico eliminado.' };
  res.redirect('/admin/technicians');
});

// --- CASHIER MANAGEMENT ---
router.get('/cashiers', requireAdminSession, requireSidebarMenuAccess('cashiers'), restrictToAdmin, (req, res) => {
  staffPerms.ensureSchema();
  const cashiers = adminSvc.getAllCashiers().map(({ password, permissions, ...c }) => {
    const perms = staffPerms.current(c.id);
    return { ...c, perms, permSummary: staffPerms.summary(perms) };
  });
  res.render('admin/cashiers', { title: 'Personal de oficina', company: company(), activePage: 'cashiers', cashiers, msg: flashMsg(req),
    permCatalog: staffPerms.CATALOG, minPass: require('../config/staffPassword').MIN_LENGTH });
});

// Permisos de UNA persona (las casillas llegan como perm_<clave>)
function permsFromBody(body) {
  const out = {};
  for (const p of staffPerms.CATALOG) out[p.key] = body && body['perm_' + p.key];
  return out;
}

router.post('/cashiers/:id/permissions', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  const row = db.prepare('SELECT id, name FROM cashiers WHERE id = ?').get(req.params.id);
  if (!row) { req.session._msg = { type: 'error', text: 'Usuario no encontrado.' }; return res.redirect('/admin/cashiers'); }
  const out = staffPerms.save(row.id, permsFromBody(req.body));
  try { auditSvc && auditSvc.logAuditTrail && auditSvc.logAuditTrail({ action: 'UPDATE', entity_type: 'staff_permissions', entity_id: String(row.id), actor_type: 'admin', actor_name: req.session.adminUser || 'admin', details: { usuario: row.name, permisos: out }, ip_address: req.ip }); } catch (_) {}
  req.session._msg = { type: 'success', text: `Permisos de ${row.name} guardados. Se aplican de inmediato.` };
  res.redirect('/admin/cashiers');
});

router.post('/cashiers', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const r = adminSvc.createCashier(req.body);
    staffPerms.save(r.lastInsertRowid, permsFromBody(req.body));
    req.session._msg = { type: 'success', text: 'Usuario agregado con los permisos marcados.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCashier(req.params.id, req.body);
    // Con contraseña nueva o cuenta desactivada, se cierran sus sesiones abiertas
    const closed = (String(req.body.password || '') !== '' || String(req.body.is_active) === '0') ? require('../config/staffPassword').closeCashierSessions(req.params.id) : 0;
    req.session._msg = { type: 'success', text: 'Datos actualizados.' + (closed ? ` Se cerraron ${closed} sesión(es) abiertas.` : '') };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCashier(req.params.id);
  require('../config/staffPassword').closeCashierSessions(req.params.id);
  req.session._msg = { type: 'success', text: 'Usuario eliminado.' };
  res.redirect('/admin/cashiers');
});

// --- COLLECTOR MANAGEMENT ---
router.get('/collectors', requireAdminSession, requireSidebarMenuAccess('collectors'), restrictToAdmin, (req, res) => {
  const collectors = adminSvc.getAllCollectors();
  const masterAreas = areaSvc.getAllAreas();
  res.render('admin/collectors', { title: 'Gestión de cobradores', company: company(), activePage: 'collectors', collectors, masterAreas, msg: flashMsg(req) });
});

router.post('/collectors', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCollector(req.body);
    req.session._msg = { type: 'success', text: 'Cobrador agregado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCollector(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Datos del cobrador actualizados.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCollector(req.params.id);
  req.session._msg = { type: 'success', text: 'Cobrador eliminado.' };
  res.redirect('/admin/collectors');
});

// --- AREA MANAGEMENT ---
// ─── Migración WispHub ───────────────────────────────────────────────────────
function requireMainAdmin(req, res, next) {
  if (req.session && req.session.isAdmin && !req.session.isCashier) return next();
  if (req.accepts('json') && !req.accepts('html')) return res.status(403).json({ ok: false, message: 'Solo el administrador.' });
  return res.status(403).send('Solo el administrador puede acceder a esta página.');
}
const _bool = (v, d = false) => (v === undefined ? d : v === true || v === 'true');

router.get('/wisphub', requireAdminSession, requireMainAdmin, (req, res) => {
  const cfg = {
    has_key: !!String(getSetting('wisphub_api_key', '') || '').trim(),
    wisphub_api_url: getSetting('wisphub_api_url', 'https://api.wisphub.net'),
    migration_mode: _bool(getSetting('migration_mode', false)),
    mikrotik_readonly: _bool(getSetting('mikrotik_readonly', false)),
    isolation_method: getSetting('isolation_method', 'address_list'),
    isolation_address_list: getSetting('isolation_address_list', 'Moroso'),
    wisphub_sync_enabled: _bool(getSetting('wisphub_sync_enabled', false))
  };
  let stats = { customers: 0, unpaid: 0, paid: 0, usage: 0 };
  try {
    const wh = require('../services/wisphubSyncService');
    stats.customers = db.prepare('SELECT COUNT(*) c FROM customers WHERE wisphub_id IS NOT NULL').get().c;
    stats.unpaid = db.prepare("SELECT COUNT(*) c FROM invoices WHERE wisphub_invoice_id IS NOT NULL AND status = 'unpaid'").get().c;
    stats.paid = db.prepare("SELECT COUNT(*) c FROM invoices WHERE wisphub_invoice_id IS NOT NULL AND status = 'paid'").get().c;
    stats.usage = db.prepare('SELECT COUNT(*) c FROM customer_usage u JOIN customers c ON c.id = u.customer_id WHERE c.wisphub_id IS NOT NULL').get().c;
    var runs = wh.lastRuns(15);
  } catch (e) { var runs = []; }
  res.render('admin/wisphub', { title: 'Migración WispHub', company: company(), activePage: 'wisphub', msg: flashMsg(req), cfg, stats, runs });
});

router.post('/wisphub/settings', requireAdminSession, requireMainAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const b = req.body || {};
    const next = {
      wisphub_api_url: String(b.wisphub_api_url || 'https://api.wisphub.net').trim(),
      migration_mode: b.migration_mode === 'true',
      mikrotik_readonly: b.mikrotik_readonly === 'true',
      isolation_method: b.isolation_method === 'profile' ? 'profile' : 'address_list',
      isolation_address_list: String(b.isolation_address_list || 'Moroso').trim() || 'Moroso',
      wisphub_sync_enabled: b.wisphub_sync_enabled === 'true'
    };
    const key = String(b.wisphub_api_key || '').trim();
    if (key) next.wisphub_api_key = key; // vacío = mantener la guardada
    saveSettings(next);
    req.session._msg = { type: 'success', text: 'Configuración de migración guardada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo guardar: ' + e.message };
  }
  res.redirect('/admin/wisphub');
});

router.post('/wisphub/:action(test|simulate|sync)', requireAdminSession, requireMainAdmin, async (req, res) => {
  const wh = require('../services/wisphubSyncService');
  try {
    if (req.params.action === 'test') return res.json(await wh.testConnection());
    const report = await wh.run({ dryRun: req.params.action !== 'sync' });
    return res.json({ ok: true, ...report });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.get('/areas', requireAdminSession, requireSidebarMenuAccess('areas'), (req, res) => {
  const areas = areaSvc.getAllAreas();
  res.render('admin/areas', { title: 'Manajemen Area', company: company(), activePage: 'areas', areas, msg: flashMsg(req) });
});

router.post('/areas', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    areaSvc.createArea(req.body);
    req.session._msg = { type: 'success', text: 'Zona agregada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/areas');
});

router.post('/areas/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    areaSvc.updateArea(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Zona actualizada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/areas');
});

router.post('/areas/:id/delete', requireAdminSession, (req, res) => {
  try {
    areaSvc.deleteArea(req.params.id);
    req.session._msg = { type: 'success', text: 'Zona eliminada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/areas');
});

router.get('/collector-payments', requireAdminSession, requireSidebarMenuAccess('collector_payments'), (req, res) => {
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const rows = db.prepare(`
    SELECT r.*,
           col.name as collector_name, col.username as collector_username,
           i.period_month, i.period_year, i.amount as invoice_amount, i.status as invoice_status,
           c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.lat, c.lng
    FROM collector_payment_requests r
    JOIN collectors col ON col.id = r.collector_id
    JOIN invoices i ON i.id = r.invoice_id
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT 500
  `).all(status);

  res.render('admin/collector_payments', {
    title: 'Aprobación de cobros de cobradores',
    company: company(),
    activePage: 'collector_payments',
    status,
    rows,
    msg: flashMsg(req)
  });
});

router.post('/collector-payments/:id/approve', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID inválido');
    const decidedNote = String(req.body.decided_note || '').trim();

    const row = db.prepare(`
      SELECT r.*, col.name as collector_name, col.username as collector_username
      FROM collector_payment_requests r
      JOIN collectors col ON col.id = r.collector_id
      WHERE r.id = ?
    `).get(id);
    if (!row) throw new Error('Solicitud no encontrada');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');

    const inv = billingSvc.getInvoiceById(row.invoice_id);
    if (!inv) throw new Error('Factura no encontrada');
    if (String(inv.status) === 'paid') {
      db.prepare(`
        UPDATE collector_payment_requests
        SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
        WHERE id=?
      `).run(req.session.isCashier ? 'cashier' : 'admin', resolvePaidByName(req, 'Admin'), 'La factura ya está pagada', id);
      req.session._msg = { type: 'error', text: 'La factura ya está pagada; solicitud rechazada.' };
      return res.redirect('back');
    }

    const collectorLabel =
      (`Kolektor ${(String(row.collector_name || '').trim())}` +
        (String(row.collector_username || '').trim() ? ` (@${String(row.collector_username).trim()})` : '')).trim();

    const approver = resolvePaidByName(req, 'Admin');
    const notesParts = [
      'Via Kolektor',
      collectorLabel,
      `Approved oleh ${approver}`,
    ];
    if (row.note) notesParts.push(String(row.note));
    if (decidedNote) notesParts.push(`Approval: ${decidedNote}`);
    const notes = notesParts.join(' | ');

    billingSvc.markAsPaid(Number(row.invoice_id), collectorLabel, notes);

    db.prepare(`
      UPDATE collector_payment_requests
      SET status='approved', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (customer && customer.phone) {
      const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
      await sendPaymentSuccessWA(
        customer.phone,
        customer.name,
        `${inv.period_month}/${inv.period_year}`,
        Number(inv.amount || 0).toLocaleString(regional.locale()),
        collectorLabel,
        {
          customerId: customer.id,
          invoiceId: inv.id,
          username: customer.pppoe_username || customer.id,
          customerCode: customer.customer_code || '',
          packageName: pkg?.name || customer.package_name || '-',
          paidAt: new Date(), method: String((req.body && req.body.payment_method) || '').trim()
        }
      );
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => Number(c.id) === Number(inv.customer_id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }

    req.session._msg = { type: 'success', text: 'Solicitud aprobada y factura pagada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + (e.message || String(e)) };
  }
  res.redirect('back');
});

router.post('/collector-payments/:id/reject', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID inválido');
    const decidedNote = String(req.body.decided_note || '').trim();
    const row = db.prepare(`SELECT * FROM collector_payment_requests WHERE id=?`).get(id);
    if (!row) throw new Error('Solicitud no encontrada');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');
    const approver = resolvePaidByName(req, 'Admin');
    db.prepare(`
      UPDATE collector_payment_requests
      SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);
    req.session._msg = { type: 'success', text: 'Solicitud rechazada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + (e.message || String(e)) };
  }
  res.redirect('back');
});
// ─── CASHIER ATTENDANCE ──────────────────────────────────────────────────────
router.get('/cashiers/attendance', requireAdminSession, requireSidebarMenuAccess('cashier_attendance'), (req, res) => {
  try {
    const cashierId = req.session.cashierId || null;
    const cashierName = req.session.cashierName || req.session.username || 'Kasir';
    
    if (!cashierId) {
      req.session._msg = { type: 'error', text: 'Sesión de cajero inválida' };
      return res.redirect('/admin');
    }

    const todayAttendance = attendanceSvc.getTodayAttendance('cashier', cashierId);
    const history = attendanceSvc.getAttendanceHistory('cashier', cashierId, 10);
    
    const now = getCurrentDateInTimezone();
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      'cashier', 
      cashierId, 
      now.getFullYear(), 
      now.getMonth() + 1
    );
    
    res.render('admin/cashier_attendance', {
      title: 'Absensi Saya',
      company: company(),
      activePage: 'cashier_attendance',
      session: req.session,
      cashierName,
      todayAttendance,
      history,
      summary,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo cargar la asistencia:' + e.message };
    res.redirect('/admin');
  }
});

router.post('/cashiers/attendance/checkin', requireAdminSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    const cashierName = req.session.cashierName || req.session.username;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Sesión de cajero inválida' });
    }

    if (!req.file) {
      return res.json({ success: false, message: 'La foto de entrada es obligatoria' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Ya registraste tu entrada hoy' });
    }
    
    const result = attendanceSvc.checkIn({
      employee_type: 'cashier',
      employee_id: cashierId,
      employee_name: cashierName,
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: '¡Entrada registrada!', id: result.lastInsertRowid });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'No se pudo registrar la entrada:' + e.message });
  }
});

router.post('/cashiers/attendance/checkout', requireAdminSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Sesión de cajero inválida' });
    }

    if (!req.file) {
      return res.json({ success: false, message: 'La foto de salida es obligatoria' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (!today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Todavía no registraste tu entrada hoy' });
    }
    
    if (today.status === 'checked_out') {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Ya registraste tu salida hoy' });
    }
    
    attendanceSvc.checkOut(today.id, {
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: '¡Salida registrada!' });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'No se pudo registrar la salida:' + e.message });
  }
});


router.get('/cashiers/reports', requireAdminSession, requireSidebarMenuAccess('cashiers_reports'), (req, res) => {
  const allCashiers = adminSvc.getAllCashiers();
  const isAdmin = Boolean(req.session?.isAdmin);
  const isCashier = Boolean(req.session?.isCashier);

  const requested = req.query.cashierId != null && String(req.query.cashierId).trim() !== ''
    ? Number(req.query.cashierId)
    : null;

  const cashierId =
    isCashier && !isAdmin
      ? Number(req.session.cashierId || 0) || null
      : requested;

  const selectedCashier = cashierId
    ? (allCashiers || []).find(c => Number(c.id) === Number(cashierId)) || null
    : null;

  const paidByExact = selectedCashier
    ? (`Kasir ${(String(selectedCashier.name || '').trim())}` + (String(selectedCashier.username || '').trim() ? ` (@${String(selectedCashier.username).trim()})` : '')).trim()
    : null;

  const invWhere = [];
  const invParams = [];
  invWhere.push(`i.status='paid'`);
  invWhere.push(`i.paid_by_name LIKE 'Kasir %'`);
  if (paidByExact) {
    invWhere.push(`i.paid_by_name = ?`);
    invParams.push(paidByExact);
  }

  const invoiceRows = db.prepare(`
    SELECT i.id as ref_id,
           i.paid_at as at,
           i.paid_by_name as actor_name,
           i.amount as amount,
           i.notes as notes,
           i.period_month,
           i.period_year,
           c.name as customer_name,
           c.phone as customer_phone,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE ${invWhere.join(' AND ')}
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT 500
  `).all(...invParams).map(r => ({
    kind: 'invoice',
    at: r.at,
    actor_name: r.actor_name,
    amount: Number(r.amount || 0),
    notes: r.notes || '',
    ref_id: r.ref_id,
    customer_name: r.customer_name || '',
    customer_phone: r.customer_phone || '',
    period_month: r.period_month,
    period_year: r.period_year,
    package_name: r.package_name || ''
  }));

  const topupWhere = [];
  const topupParams = [];
  topupWhere.push(`t.type='topup'`);
  topupWhere.push(`t.note LIKE 'Kasir %:%'`);
  if (paidByExact) {
    topupWhere.push(`t.note LIKE ?`);
    topupParams.push(`${paidByExact}:%`);
  }

  const topupRows = []; /* agent dihapus */

  const rows = [...invoiceRows, ...topupRows].sort((a, b) => {
    const atA = a && a.at ? String(a.at) : '';
    const atB = b && b.at ? String(b.at) : '';
    if (atA !== atB) return atB.localeCompare(atA);
    return Number(b?.ref_id || 0) - Number(a?.ref_id || 0);
  }).slice(0, 800);

  const invSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(i.amount) as total
    FROM invoices i
    WHERE ${invWhere.join(' AND ')}
  `).get(...invParams);

  const topupSumRow = { cnt: 0, total: 0 }; /* agent dihapus */

  const safeCashiers = isAdmin
    ? allCashiers
    : selectedCashier
      ? [selectedCashier]
      : [];

  res.render('admin/cashier_reports', {
    title: 'Reporte de cajeros',
    company: company(),
    activePage: 'cashiers_reports',
    cashiers: safeCashiers,
    cashierId: cashierId || '',
    paidByExact: paidByExact || '',
    rows,
    summary: {
      count: Number(invSumRow?.cnt || 0) + Number(topupSumRow?.cnt || 0),
      total: Number(invSumRow?.total || 0) + Number(topupSumRow?.total || 0),
      invoice_count: Number(invSumRow?.cnt || 0),
      invoice_total: Number(invSumRow?.total || 0),
      topup_count: Number(topupSumRow?.cnt || 0),
      topup_total: Number(topupSumRow?.total || 0)
    },
    msg: flashMsg(req)
  });
});

router.get('/', requireAdminSession, requireSidebarMenuAccess('dashboard'), async (req, res) => {
  try {
    const billing = billingSvc.getDashboardStats();
    const custStats = customerSvc.getCustomerStats();
    const settings = getSettings(); // Get current settings
    const chartYear = getCurrentTimeInfo().year;
    const verFinanzas = staffPerms.has(req.session, 'finanzas');
    const revenueMonthly = verFinanzas ? billingSvc.getMonthlyRevenue(chartYear) : [];
    const todayRevenue = verFinanzas ? billingSvc.getTodayRevenue() : null;
    res.render('admin/dashboard', {
      title: 'Dashboard', company: company(), version: '2.0.0',
      activePage: 'dashboard', billing: verFinanzas ? billing : null, custStats, settings, revenueMonthly, todayRevenue, chartYear, verFinanzas
    });
  } catch (e) {
    logger.error('Admin dashboard error:', e);
    res.status(500).send('Error loading dashboard: ' + e.message);
  }
});

// ─── DEVICE ROUTES (existing) ───────────────────────────────────────────────
router.get('/devices', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.render('admin/dashboard', { title: 'Monitoring ONU', company: company(), version: '2.0.0', activePage: 'devices', billing: null, custStats: null, settings });
});

router.get('/bulk', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.render('admin/dashboard', { title: 'Konfigurasi Massal', company: company(), version: '2.0.0', activePage: 'bulk', billing: null, custStats: null, settings });
});

// ─── ONU MODEM STICKER PRINT ───────────────────────────────────────────────
router.get('/onu-stickers', requireAdminSession, requireSidebarMenuAccess('onu_stickers'), async (req, res) => {
  try {
    const settings = getSettings();
    const mode = req.query.mode === 'customers' ? 'customers' : 'blank';
    const count = Math.max(1, Math.min(100, Number(req.query.count || 10)));
    const searchQuery = String(req.query.q || '').trim();
    const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
    const csPhone = req.query.cs_phone || settings.company_phone || settings.company_whatsapp || '08xxxxxxxxxx';
    const serverBaseUrl = `${req.protocol}://${req.get('host')}`;

    const routers = mikrotikService.getAllRouters();
    let stickers = [];

    if (mode === 'blank') {
      const qrPayload = `${serverBaseUrl}/app/connect`;
      const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
        margin: 1,
        width: 250,
        errorCorrectionLevel: 'M'
      });

      for (let i = 0; i < count; i++) {
        stickers.push({
          name: '',
          id_display: '',
          package_name: '',
          qrCodeDataUrl
        });
      }
    } else {
      const customers = customerSvc.getAllCustomers(searchQuery, selectedRouterId, 'active');
      const targetCusts = (customers || []).slice(0, 100);

      for (const c of targetCusts) {
        const qrPayload = `${serverBaseUrl}/app/connect?cid=${encodeURIComponent(c.pppoe_username || c.id)}`;
        const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
          margin: 1,
          width: 250,
          errorCorrectionLevel: 'M'
        });

        stickers.push({
          name: c.name,
          id_display: `${c.pppoe_username || ('ID:' + c.id)}`,
          package_name: c.package_name || 'Reguler',
          qrCodeDataUrl
        });
      }
    }

    res.render('admin/onu_stickers', {
      company: company(),
      companyLogo: settings.company_logo || '',
      csPhone,
      mode,
      count,
      searchQuery,
      selectedRouterId,
      routers,
      stickers
    });
  } catch (e) {
    logger.error(`[ONU Stickers] Error: ${e.message}`);
    res.status(500).send(`No se pudieron cargar las etiquetas: ${e.message}`);
  }
});

router.get('/customers/:id/sticker-onu', requireAdminSession, async (req, res) => {
  try {
    const settings = getSettings();
    const customer = customerSvc.getCustomerById(req.params.id);
    if (!customer) return res.status(404).send('Cliente no encontrado');

    const csPhone = settings.company_phone || settings.company_whatsapp || '08xxxxxxxxxx';
    const serverBaseUrl = `${req.protocol}://${req.get('host')}`;

    const qrPayload = `${serverBaseUrl}/app/connect?cid=${encodeURIComponent(customer.pppoe_username || customer.id)}`;
    const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
      margin: 1,
      width: 250,
      errorCorrectionLevel: 'M'
    });

    const stickers = [{
      name: customer.name,
      id_display: `${customer.pppoe_username || ('ID:' + customer.id)}`,
      package_name: customer.package_name || 'Reguler',
      qrCodeDataUrl
    }];

    res.render('admin/onu_stickers', {
      company: company(),
      companyLogo: settings.company_logo || '',
      csPhone,
      mode: 'customers',
      count: 1,
      searchQuery: '',
      selectedRouterId: null,
      routers: [],
      stickers
    });
  } catch (e) {
    res.status(500).send(`No se pudieron cargar las etiquetas: ${e.message}`);
  }
});

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
router.get('/customers', requireAdminSession, requireSidebarMenuAccess('customers'), async (req, res) => {
  const { search = '', status: filterStatus = '', area: filterArea = '',
    package_id: filterPackage = '', collector_id: filterCollector = '', olt_id: filterOlt = '',
    connection_type: filterConn = '', billing: filterBilling = '', auto_isolate: filterAuto = '' } = req.query;
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const customers = customerSvc.getAllCustomers(search, selectedRouterId, filterStatus, filterArea, {
    packageId: filterPackage, collectorId: filterCollector, oltId: filterOlt,
    connectionType: filterConn, billing: filterBilling, autoIsolate: filterAuto
  });
  const stats = customerSvc.getCustomerStats();
  const packages = customerSvc.getAllPackages(selectedRouterId);
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  const odps = odpSvc.getAllOdps();
  const collectors = adminSvc.getAllCollectors();
  const areas = customerSvc.getAllCustomerAreas();
  const masterAreas = areaSvc.getAllAreas();

  let activeSessionsMap = new Map();
  try {
    activeSessionsMap = await mikrotikService.getAllActiveSessionsMap();
  } catch (e) {
    logger.warn('[Customers] Failed to fetch active sessions map:', e.message);
  }

  res.render('admin/customers', {
    title: 'Datos del cliente', company: company(), activePage: 'customers',
    customers: staffPerms.redactMoney(req.session, customers), stats, packages: staffPerms.redactMoney(req.session, packages), routers, olts, odps, collectors, areas, masterAreas, activeSessionsMap, search, filterStatus, filterArea, selectedRouterId,
    filterPackage, filterCollector, filterOlt, filterConn, filterBilling, filterAuto, msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/customers', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const defaultRouterId = multiRouterMode ? null : getSetting('default_router_id', null);

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      const password = String(req.body.pppoe_password || '').trim();
      const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
      
      req.body.pppoe_username = username;
      req.body.pppoe_password = password;
      req.body.pppoe_remote_address = remoteAddress;
      
      if (!username) throw new Error('El usuario PPPoE no puede quedar vacío');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Es OBLIGATORIO elegir un router MikroTik para conexiones PPPoE (el corte y los perfiles dependen del router)');
        } else {
          logger.warn('[Customer] Router MikroTik tidak tersedia; lanjut simpan data tanpa validasi router.');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(effectiveRouterId, username);
      if (existing) throw new Error(`El usuario PPPoE ya lo usa otro cliente: ${existing.name}`);

      // Only validate against MikroTik if password is not provided (meaning it's from MikroTik list)
      if (!password) {
        try {
          const conn = await mikrotikService.getConnection(effectiveRouterId);
          try {
            const results = await conn.client.menu('/ppp/secret')
              .where('service', 'pppoe')
              .where('name', username)
              .get();
            if (!Array.isArray(results) || results.length === 0) logger.warn('[Customer] PPPoE username belum ada di MikroTik (lanjut simpan DB).');
          } finally { if (conn && conn.api) conn.api.close(); }
        } catch (mErr) {
          logger.warn('[Customer] Validasi PPPoE ke MikroTik dilewati: ' + mErr.message);
        }
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'static') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const staticIp = String(req.body.static_ip || '').trim();
      req.body.static_ip = staticIp;
      if (!staticIp) throw new Error('La IP fija no puede quedar vacía');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Es OBLIGATORIO elegir un router MikroTik para conexiones con IP fija (gestión y corte)');
        } else {
          logger.warn('[Customer] Router MikroTik tidak tersedia; lanjut simpan data tanpa validasi router.');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND static_ip = ? LIMIT 1').get(effectiveRouterId, staticIp);
      if (existing) throw new Error(`La IP fija ya la usa otro cliente: ${existing.name}`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('El usuario hotspot no puede quedar vacío');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Es OBLIGATORIO elegir un router MikroTik para conexiones hotspot (gestión de usuarios y corte)');
        } else {
          logger.warn('[Customer] Router MikroTik tidak tersedia; lanjut simpan data tanpa validasi router.');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? LIMIT 1').get(effectiveRouterId, username);
      if (existing) throw new Error(`El usuario hotspot ya lo usa otro cliente: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('El perfil de usuario hotspot no puede quedar vacío');

      try {
        const profs = await mikrotikService.getHotspotUserProfiles(effectiveRouterId);
        const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
        if (!ok) logger.warn('[Customer] Hotspot profile ' + profile + ' belum ada di MikroTik (lanjut simpan DB).');
      } catch (mErr) {
        logger.warn('[Customer] Validasi Hotspot ke MikroTik dilewati: ' + mErr.message);
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    const radiusEnabled = getSetting('radius_enabled', '0') === '1';
    // Ketika RADIUS offline, paksa is_radius = 0 (MikroTik mode) agar secret SELALU dibuat ke MikroTik
    const isRadius = radiusEnabled ? (req.body.is_radius !== undefined ? (Number(req.body.is_radius) === 1 ? 1 : 0) : 0) : 0;
    req.body.is_radius = isRadius;

    customerSvc.createCustomer(req.body);
    
    // ========================================================================
    // SYNC KE MIKROTIK - PENTING: SECRET TIDAK PERNAH DIHAPUS!
    // ========================================================================
    // Logika:
    // - Jika RADIUS OFFLINE: SELALU create/update secret ke MikroTik
    // - Jika RADIUS AKTIF tapi is_radius=0: Hybrid mode, tetap ke MikroTik
    // - Jika RADIUS AKTIF dan is_radius=1: Full RADIUS mode, skip MikroTik
    // 
    // CATATAN: Kode ini TIDAK PERNAH menghapus secret dari MikroTik!
    //          Hanya CREATE (jika belum ada) atau UPDATE PROFILE (jika sudah ada)
    // ========================================================================
    const shouldSyncToMikrotik = !radiusEnabled || !isRadius;
    if (connectionType === 'pppoe' && req.body.pppoe_username && shouldSyncToMikrotik) {
      const password = String(req.body.pppoe_password || '').trim();
      const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
      
      // If manual input (password provided), create PPPoE secret in MikroTik
      if (password) {
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        
        if (targetProfile) {
          try {
            await mikrotikService.createPppoeSecret({
              username: req.body.pppoe_username,
              password: password,
              profile: targetProfile,
              remoteAddress: remoteAddress,
              routerId: req.body.router_id
            });
            logger.info(`[Add Customer] Created PPPoE secret "${req.body.pppoe_username}" in MikroTik (RADIUS ${radiusEnabled ? 'ON' : 'OFF'})`);
          } catch (mErr) {
            logger.error('Mikrotik create PPPoE secret error:', mErr);
          }
        }
      } else {
        // If from MikroTik list (no password input), just update profile
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        if (targetProfile) {
          try {
            await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
            logger.info(`[Add Customer] Updated PPPoE profile for "${req.body.pppoe_username}" to "${targetProfile}"`);
          } catch (mErr) {
            logger.error('Mikrotik sync error (create):', mErr);
          }
        }
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
      try {
        await mikrotikService.upsertHotspotUser({
          username: String(req.body.hotspot_username || '').trim(),
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        console.error('Mikrotik sync error (create hotspot):', mErr);
      }
    }

    req.session._msg = { type: 'success', text: `Cliente "${req.body.name}" agregado.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo agregar el cliente:' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const defaultRouterId = multiRouterMode ? null : getSetting('default_router_id', null);

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      req.body.pppoe_username = username;
      if (!username) throw new Error('El usuario PPPoE no puede quedar vacío');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Es OBLIGATORIO elegir un router MikroTik para conexiones PPPoE (el corte y los perfiles dependen del router)');
        } else {
          logger.warn('[Customer] Router MikroTik tidak tersedia; lanjut simpan data tanpa validasi router.');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? AND id != ? LIMIT 1').get(effectiveRouterId, username, customerId);
      if (existing) throw new Error(`El usuario PPPoE ya lo usa otro cliente: ${existing.name}`);

      try {
        const conn = await mikrotikService.getConnection(effectiveRouterId);
        try {
          const results = await conn.client.menu('/ppp/secret')
            .where('service', 'pppoe')
            .where('name', username)
            .get();
          if (!Array.isArray(results) || results.length === 0) logger.warn('[Customer] PPPoE username belum ada di MikroTik (lanjut simpan DB).');
        } finally { if (conn && conn.api) conn.api.close(); }
      } catch (mErr) {
        logger.warn('[Customer] Validasi PPPoE ke MikroTik dilewati: ' + mErr.message);
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'static') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const staticIp = String(req.body.static_ip || '').trim();
      req.body.static_ip = staticIp;
      if (!staticIp) throw new Error('La IP fija no puede quedar vacía');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Es OBLIGATORIO elegir un router MikroTik para conexiones con IP fija (gestión y corte)');
        } else {
          logger.warn('[Customer] Router MikroTik tidak tersedia; lanjut simpan data tanpa validasi router.');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND static_ip = ? AND id != ? LIMIT 1').get(effectiveRouterId, staticIp, customerId);
      if (existing) throw new Error(`La IP fija ya la usa otro cliente: ${existing.name}`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('El usuario hotspot no puede quedar vacío');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Es OBLIGATORIO elegir un router MikroTik para conexiones hotspot (gestión de usuarios y corte)');
        } else {
          logger.warn('[Customer] Router MikroTik tidak tersedia; lanjut simpan data tanpa validasi router.');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? AND id != ? LIMIT 1').get(effectiveRouterId, username, customerId);
      if (existing) throw new Error(`El usuario hotspot ya lo usa otro cliente: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('El perfil de usuario hotspot no puede quedar vacío');

      try {
        const profs = await mikrotikService.getHotspotUserProfiles(effectiveRouterId);
        const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
        if (!ok) logger.warn('[Customer] Hotspot profile ' + profile + ' belum ada di MikroTik (lanjut simpan DB).');
      } catch (mErr) {
        logger.warn('[Customer] Validasi Hotspot ke MikroTik dilewati: ' + mErr.message);
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    const radiusEnabled = getSetting('radius_enabled', '0') === '1';
    // Ketika RADIUS offline, paksa is_radius = 0 (MikroTik mode) agar secret SELALU ada di MikroTik
    const isRadius = radiusEnabled ? (req.body.is_radius !== undefined ? (Number(req.body.is_radius) === 1 ? 1 : 0) : 0) : 0;
    req.body.is_radius = isRadius;

    // Get old customer data to detect username changes
    const oldCustomer = customerSvc.getCustomerById(customerId);
    
    customerSvc.updateCustomer(req.params.id, req.body);
    
    // ========================================================================
    // SYNC KE MIKROTIK SAAT EDIT - PENTING: SECRET TIDAK PERNAH DIHAPUS!
    // ========================================================================
    // Logika:
    // - Jika RADIUS OFFLINE: SELALU sync ke MikroTik
    // - Jika RADIUS AKTIF tapi is_radius=0: Hybrid mode, tetap sync ke MikroTik  
    // - Jika RADIUS AKTIF dan is_radius=1: Full RADIUS mode, skip MikroTik
    //
    // Proses:
    // 1. Cek apakah secret sudah ada di MikroTik
    // 2. Jika sudah ada: UPDATE PROFILE saja (TIDAK HAPUS!)
    // 3. Jika belum ada: CREATE secret baru (jika ada password)
    // 
    // CATATAN: Kode ini TIDAK PERNAH menghapus secret dari MikroTik!
    // ========================================================================
    const shouldSyncToMikrotik = !radiusEnabled || !isRadius;
    if (connectionType === 'pppoe' && req.body.pppoe_username && shouldSyncToMikrotik) {
      try {
        const newUsername = String(req.body.pppoe_username || '').trim();
        const newPassword = String(req.body.pppoe_password || '').trim();
        const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
        
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        
        if (targetProfile) {
          try {
            // Cek apakah secret sudah ada di MikroTik
            const secrets = await mikrotikService.getPppoeSecrets(req.body.router_id);
            const existingSecret = secrets.find(s => String(s.name || '').trim() === newUsername);
            
            if (existingSecret) {
              // Secret sudah ada, hanya update profile
              await mikrotikService.setPppoeProfile(newUsername, targetProfile, req.body.router_id);
              logger.info(`[Edit Customer] Updated PPPoE profile for "${newUsername}" to "${targetProfile}"`);
            } else if (newPassword) {
              // Secret belum ada DAN ada password, create secret baru ke MikroTik
              await mikrotikService.createPppoeSecret({
                username: newUsername,
                password: newPassword,
                profile: targetProfile,
                remoteAddress: remoteAddress,
                routerId: req.body.router_id
              });
              logger.info(`[Edit Customer] Created NEW PPPoE secret for "${newUsername}" in MikroTik`);
            } else {
              logger.warn(`[Edit Customer] Cannot create PPPoE secret for "${newUsername}" - password not provided`);
            }
          } catch (mErr) {
            logger.error('Mikrotik sync error (update PPPoE):', mErr.message);
          }
        }
      } catch (syncErr) {
        logger.warn(`[Update] MikroTik API sync skipped/failed for customer ${customerId}: ${syncErr.message}`);
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      try {
        const oldUsername = oldCustomer ? String(oldCustomer.hotspot_username || '').trim() : '';
        const newUsername = String(req.body.hotspot_username || '').trim();
        const oldRouterIdForOldUser = oldCustomer ? oldCustomer.router_id : null;
        const oldEffectiveRouterId = oldCustomer ? customerSvc.getEffectiveRouterId(oldRouterIdForOldUser) : null;
        
        // If username changed, handle old one first
        if (oldUsername && oldUsername !== newUsername && oldEffectiveRouterId) {
          try {
            logger.info(`[Update] Hotspot username changed: "${oldUsername}" → "${newUsername}" for customer ${customerId}`);
            const oldUser = await mikrotikService.getHotspotUserByName(oldUsername, oldEffectiveRouterId);
            if (oldUser && (oldUser.id || oldUser['.id'])) {
              const userId = oldUser['.id'] || oldUser.id;
              await mikrotikService.deleteHotspotUser(userId, oldEffectiveRouterId);
              logger.info(`[Update] Deleted old Hotspot user: ${oldUsername} from router ${oldEffectiveRouterId}`);
            }
          } catch (err) {
            logger.warn(`[Update] Failed to delete old Hotspot user ${oldUsername}: ${err.message}`);
          }
        }
        
        // Now handle new username
        const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
        await mikrotikService.upsertHotspotUser({
          username: newUsername,
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        logger.warn(`[Update] Mikrotik sync error (update hotspot): ${mErr.message}`);
      }
    }

    req.session._msg = { type: 'success', text: 'Datos del cliente actualizados.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo actualizar:' + e.message };
  }
  res.redirect('/admin/customers');
});

async function syncCustomerToMikrotik(customerId) {
  const c = customerSvc.getCustomerById(customerId);
  if (!c) return { ok: false, message: 'Cliente no encontrado' };
  const routerId = customerSvc.getEffectiveRouterId(c.router_id);

  // ── Mode RADIUS: kredensial/paket dibaca langsung dari DB ──
  //   Perubahan dari billing dipakai saat autentikasi berikutnya. Agar langsung,
  //   kick sesi PPPoE sekarang supaya pelanggan redial (muat rate-limit/IP/paket baru).
  if (String(getSetting('radius_enabled', '0')) === '1') {
    const uname = String(c.pppoe_username || '').trim();
    if (!uname) return { ok: false, message: 'Usuario PPPoE vacío' };
    try { await mikrotikService.kickPppoeUser(uname, routerId); }
    catch (e) { return { ok: false, message: 'No se pudo desconectar la sesión RADIUS:' + e.message }; }
    try { db.prepare("UPDATE radius_accounting SET status_type=2, updated_at=NOW_LOCAL() WHERE username=? AND status_type IN (1,3)").run(uname); } catch (e) {}
    return { ok: true, message: 'Modo RADIUS: los cambios se aplican al reconectar. La sesión "' + uname + '" se desconectó para recargar velocidad/IP/plan.' };
  }

  if (!routerId || routerId <= 0) return { ok: false, message: 'No hay un router MikroTik disponible para este cliente' };
  const connType = String(c.connection_type || 'pppoe').toLowerCase();
  const pkg = c.package_id ? customerSvc.getPackageById(c.package_id) : null;
  const isSuspended = String(c.status || '').toLowerCase() !== 'active';
  if (connType === 'pppoe') {
    const username = String(c.pppoe_username || '').trim();
    if (!username) return { ok: false, message: 'Usuario PPPoE vacío' };
    const targetProfile = isSuspended ? ((pkg && pkg.isolir_profile) || c.isolir_profile || getSetting('mikrotik_isolir_profile', 'isolir') || 'isolir') : (pkg ? pkg.name : 'default');
    const secrets = await mikrotikService.getPppoeSecrets(routerId);
    const exists = Array.isArray(secrets) && secrets.some(function (s) { return String(s.name || '').trim() === username; });
    if (exists) {
      await mikrotikService.setPppoeProfile(username, targetProfile, routerId);
      return { ok: true, message: 'Profil PPPoE "' + username + '" disinkronkan ke "' + targetProfile + '".' };
    }
    const pass = String(c.pppoe_password || '').trim();
    if (!pass) return { ok: false, message: 'Secret "' + username + '" no existe en el MikroTik y la contraseña está vacía (no se puede crear).' };
    await mikrotikService.createPppoeSecret({ username: username, password: pass, profile: targetProfile, remoteAddress: String(c.pppoe_remote_address || '').trim(), routerId: routerId });
    return { ok: true, message: 'Secret PPPoE "' + username + '" creado en el MikroTik (perfil "' + targetProfile + '").' };
  }
  if (connType === 'hotspot') {
    const username = String(c.hotspot_username || '').trim();
    if (!username) return { ok: false, message: 'Usuario hotspot vacío' };
    const profile = String(c.hotspot_profile || '').trim() || (pkg ? String(pkg.name || '') : '');
    await mikrotikService.upsertHotspotUser({ username: username, password: String(c.hotspot_password || '').trim(), profile: profile, macAddress: String(c.mac_address || '').trim(), disabled: isSuspended }, routerId);
    return { ok: true, message: 'Hotspot user "' + username + '" disinkronkan (' + (isSuspended ? 'disabled' : 'enabled') + ').' };
  }
  if (connType === 'static') {
    const ip = String(c.static_ip || '').trim();
    if (!ip) return { ok: false, message: 'IP fija vacía' };
    let limit = '5M/5M';
    if (pkg) {
      const up = Number(pkg.speed_up || 0) || 0;
      const down = Number(pkg.speed_down || 0) || 0;
      const upM = up > 0 ? Math.max(1, Math.round(up / 1000)) : 5;
      const dnM = down > 0 ? Math.max(1, Math.round(down / 1000)) : 5;
      limit = upM + 'M/' + dnM + 'M';
    }
    await mikrotikService.manageStaticIp({ ip: ip, name: c.name, limit: limit, isolate: isSuspended }, routerId);
    return { ok: true, message: 'Static IP ' + ip + ' disinkronkan (' + (isSuspended ? 'isolir' : 'normal') + ').' };
  }
  return { ok: false, message: 'Tipo de conexión desconocido' };
}

router.post('/customers/sync-all-mikrotik', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const list = db.prepare("SELECT id FROM customers WHERE status IN ('active','suspended') ORDER BY id").all();
    res.json({ ok: true, message: 'Sinkronisasi ' + list.length + ' clientes se procesan en segundo plano. Revisá el registro para ver el resultado.' });
    (async function () {
      let ok = 0, fail = 0;
      for (const row of list) {
        try { const r = await syncCustomerToMikrotik(row.id); if (r.ok) ok++; else fail++; } catch (e) { fail++; }
        await new Promise(function (r) { setTimeout(r, 150); });
      }
      logger.info('[SyncMikroTik] Selesai: ok=' + ok + ' fail=' + fail + ' dari ' + list.length + '.');
    })().catch(function () {});
  } catch (e) { return res.status(200).json({ ok: false, message: e.message }); }
});

router.post('/customers/:id/sync-mikrotik', requireAdminSession, async (req, res) => {
  try { const r = await syncCustomerToMikrotik(req.params.id); return res.json(r); }
  catch (e) { return res.json({ ok: false, message: 'Falló la sincronización:' + e.message }); }
});

router.post('/customers/:id/generate-pppoe', requireAdminSession, async (req, res) => {
  try {
    const g = customerSvc.generatePppoeAccount(req.params.id);
    const cust = customerSvc.getCustomerById(req.params.id);
    try {
      const waNotify = require('../services/waNotifyService');
      const pkgC = cust && cust.package_id ? customerSvc.getPackageById(cust.package_id) : null;
      const credMsg = '🔑 *CREDENCIALES PPPoE DEL CLIENTE*\n\n' +
        '👤 *Nombre:*' + ((cust && cust.name) || '-') + '\n' +
        '🆔 *ID:* ' + ((cust && cust.customer_code) || '-') + '\n' +
        '📦 *Plan:*' + (pkgC ? pkgC.name : ((cust && cust.package_name) || '-')) + '\n' +
        '📡 *PPPoE User:* *' + g.username + '*\n' +
        '🔒 *PPPoE Pass:* *' + g.password + '*\n' +
        '📍 *Dirección:*' + ((cust && cust.address) || '-') + '\n\n' +
        'Configurá el equipo del cliente con estos datos.';
      await waNotify.notifyAdmin(credMsg);
      await waNotify.notifyInstallers(credMsg);
    } catch (e) {}
    req.session._msg = { type: 'success', text: 'Cuenta PPPoE creada:' + g.username + ' / ' + g.password + ' (credenciales enviadas al administrador y a los técnicos con permiso de instalaciones).' };
  } catch (e) { req.session._msg = { type: 'error', text: 'No se pudo generar la cuenta PPPoE:' + e.message }; }
  res.redirect(req.get('Referrer') || '/admin/customers');
});

router.post('/customers/delete-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { customer_ids } = req.body;
    const ids = Array.isArray(customer_ids) ? customer_ids : [customer_ids];
    const clean = ids
      .map(x => Number(x))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!clean || clean.length === 0) throw new Error('Tidak ada pelanggan yang dipilih.');

    const deleted = await customerSvc.bulkDeleteCustomers(clean);
    req.session._msg = { type: 'success', text: `${deleted} clientes eliminados (las cuentas PPPoE del MikroTik no se tocan).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Falló la eliminación masiva:' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', requireAdminSession, async (req, res) => {


  try {
    const cust = customerSvc.getCustomerById(req.params.id);
    await customerSvc.deleteCustomer(req.params.id);
    try {
      require('../services/auditTrailService').logAuditTrail({
        action: 'DELETE_CUSTOMER',
        entity_type: 'customer',
        entity_id: String(req.params.id),
        actor_type: 'admin',
        actor_id: req.session.adminUser || null,
        actor_name: req.session.adminUser || 'Admin',
        details: cust ? { name: cust.name, customer_code: cust.customer_code, phone: cust.phone, status: cust.status } : {},
        ip_address: req.ip,
        user_agent: req.headers['user-agent']
      });
    } catch (e) {}
    logger.info(`[Customer] Dihapus oleh ${req.session.adminUser || 'Admin'}: id=${req.params.id} ${cust ? cust.name : ''}`);
    req.session._msg = { type: 'success', text: 'Cliente eliminado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/disconnect', requireAdminSession, async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const customer = customerSvc.getCustomerById(custId);
    if (!customer) throw new Error('Cliente no encontrado');

    const pppoeUser = String(customer.pppoe_username || '').trim();
    const hotspotUser = String(customer.hotspot_username || '').trim();
    const username = pppoeUser || hotspotUser || String(customer.name || '').trim();

    let kicked = false;
    if (pppoeUser) {
      kicked = await mikrotikService.kickPppoeUser(pppoeUser, customer.router_id);
    } else if (hotspotUser) {
      kicked = await mikrotikService.kickHotspotUser(hotspotUser, customer.router_id);
    } else if (username) {
      kicked = await mikrotikService.kickPppoeUser(username, customer.router_id) || await mikrotikService.kickHotspotUser(username, customer.router_id);
    }

    if (kicked) {
      req.session._msg = { type: 'success', text: `Se desconectó del MikroTik la sesión activa de "${customer.name}".` };
    } else {
      req.session._msg = { type: 'error', text: `No se encontró la sesión activa de "${customer.name}" en el MikroTik o no se pudo desconectar.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo desconectar:' + (e.message || String(e)) };
  }
  res.redirect('/admin/customers');
});

// ─── EXPORT/IMPORT CUSTOMERS ──────────────────────────────────────
router.get('/customers/export', requireAdminSession, (req, res) => {
  try {
    const customers = customerSvc.getAllCustomers();
    const data = customers.map(c => ({
      'ID': c.id,
      'NIK': c.nik || '',
      'Nama': c.name,
      'Telepon': c.phone,
      'Email': c.email || '',
      'Alamat': c.address,
      'Area': c.area || '',
      'Paket': c.package_name || '-',
      'Router': c.router_name || '-',
      'Tipo de conexión': c.connection_type || 'pppoe',
      'Tag ONU': c.genieacs_tag,
      'PPPoE Username': c.pppoe_username,
      'Hotspot Username': c.hotspot_username || '',
      'Static IP': c.static_ip || '',
      'Perfil de corte': c.isolir_profile,
      'Status': c.status,
      'Fecha de instalación': c.install_date,
      'Auto Isolir': c.auto_isolate === 1 ? 'YA' : 'TIDAK',
      'Día de corte': c.isolate_day,
      'ODP': c.odp_name || '-',
      'Latitude': c.lat || '',
      'Longitude': c.lng || '',
      'Catatan': c.notes
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pelanggan');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=daftar_pelanggan.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    logger.error('Export error:', e);
    res.status(500).send('No se pudieron exportar los datos.');
  }
});

// ─── Cancelar servicio (manual) ───
// Cobro de monto libre (pagos parciales / saldo a favor)
router.get('/customers/:id/payment-info', requireAdminSession, (req, res) => {
  try {
    const pay = require('../services/paymentReversalService');
    const c = customerSvc.getCustomerById(Number(req.params.id));
    if (!c) throw new Error('Cliente no encontrado');
    res.json({ ok: true, customer: { id: c.id, name: c.name, status: c.status }, debt: pay.debtOf(c.id), receipts: pay.receipts(c.id).slice(0, 10), isCashier: !!req.session.isCashier });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.post('/customers/:id/receive', requireAdminSession, express.json(), async (req, res) => {
  try {
    const pay = require('../services/paymentReversalService');
    const b = req.body || {};
    const paidBy = resolvePaidByName(req, b.paid_by_name);
    // activate=true: "Cobrar y activar" — el saldo que falte pasa a la próxima factura y se habilita el servicio
    const r = pay.receive(Number(req.params.id), { amount: b.amount, method: b.method, note: b.note, paidBy, useCredit: !!b.use_credit, invoiceIds: b.invoice_ids, carryRemaining: !!b.activate });
    // Sin deuda pendiente: si estaba cortado se habilita; si tenía promesa, queda cumplida
    const debt = pay.debtOf(r.customer.id);
    let enabled = false;
    if (!debt.count) {
      if (r.customer.status === 'suspended') { await customerSvc.activateCustomer(r.customer.id, 'active'); enabled = true; }
      else if (r.customer.status === 'ditangguhkan') { db.prepare("UPDATE customers SET status='active' WHERE id=?").run(r.customer.id); require('../services/promiseService').close(r.customer.id, 'kept'); }
    }
    const parts = r.applied.map(a => `${a.period}: ${regional.formatMoney(a.amount)}${a.full ? ' (pagada)' : ' (parcial, falta ' + regional.formatMoney(a.remaining) + ')'}`);
    let msg = `Cobro #${r.receiptId} registrado.` + (parts.length ? ' Aplicado a ' + parts.join('; ') + '.' : '');
    if (r.creditUsed) msg += ` Se usó ${regional.formatMoney(r.creditUsed)} de saldo a favor.`;
    if (r.creditAdded) msg += ` Saldo a favor: +${regional.formatMoney(r.creditAdded)}.`;
    if (r.carried) msg += ` Saldo de ${regional.formatMoney(r.carried)} trasladado a la próxima factura.`;
    msg += debt.count ? ` Deuda restante: ${regional.formatMoney(debt.total)}.` : (r.carried ? '' : ' El cliente no tiene deuda.');
    if (enabled) msg += ' Servicio habilitado.';
    res.json({ ok: true, ...r, debt, enabled, message: msg });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.post('/customers/:id/credit-adjust', requireAdminSession, express.json(), (req, res) => {
  if (req.session.isCashier) return res.status(403).json({ ok: false, message: 'Solo el administrador puede ajustar el saldo a favor.' });
  try {
    const r = require('../services/paymentReversalService').adjustCredit(Number(req.params.id), req.body && req.body.delta, req.body && req.body.reason, req.session.adminUser || 'admin');
    res.json({ ok: true, ...r, message: 'Saldo a favor actualizado: ' + regional.formatMoney(r.balance) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.get('/customers/:id/promise-preview', requireAdminSession, (req, res) => {
  try {
    res.json({ ok: true, ...require('../services/promiseService').preview(Number(req.params.id)) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.post('/customers/:id/promise', requireAdminSession, express.json(), async (req, res) => {
  try {
    const actor = { type: 'admin', name: req.session.adminUser || req.session.cashierName || 'admin', ip: req.ip };
    const r = await require('../services/promiseService').grant(Number(req.params.id), { days: req.body && req.body.days, until: req.body && req.body.until, note: req.body && req.body.note, actor });
    const ro = require('../services/mikrotikService').isMikrotikReadOnly && require('../services/mikrotikService').isMikrotikReadOnly();
    res.json({ ok: true, ...r, message: `Promesa de pago registrada hasta ${r.until}.` + (r.wasSuspended ? (ro ? ' MikroTik en solo lectura: habilitalo en WispHub/MikroTik.' : ' Servicio habilitado.') : '') });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.get('/customers/:id/cancel-preview', requireAdminSession, (req, res) => {
  if (req.session.isCashier) return res.status(403).json({ ok: false, message: 'Solo el administrador puede cancelar clientes.' });
  try { return res.json({ ok: true, ...customerSvc.cancellationPreview(Number(req.params.id)) }); }
  catch (e) { return res.status(400).json({ ok: false, message: e.message }); }
});

router.post('/customers/:id/cancel', requireAdminSession, express.json(), async (req, res) => {
  if (req.session.isCashier) return res.status(403).json({ ok: false, message: 'Solo el administrador puede cancelar clientes.' });
  try {
    const r = await customerSvc.cancelCustomer(Number(req.params.id), {
      reason: req.body && req.body.reason,
      actor: { type: 'admin', name: req.session.adminUser || 'admin', ip: req.ip }
    });
    const net = r.network.readOnly
      ? ' MikroTik en SOLO LECTURA: el router no se modificó (borrá el usuario PPPoE en WispHub/MikroTik).'
      : ` Router: usuario PPPoE borrado (${r.network.secretRemoved}), IP liberada (${r.network.ipReleased}).`;
    return res.json({ ok: true, message: `Servicio cancelado. Facturas anuladas: ${r.voidedInvoices}.` + net, ...r });
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message });
  }
});

router.post('/customers/import', requireAdminSession, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Archivo no encontrado');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    logger.info(`[Import] Found ${rows.length} rows in Excel file.`);
    
    const packages = customerSvc.getAllPackages();
    const odps = odpSvc.getAllOdps();
    const routers = mikrotikService.getAllRouters();
    let count = 0;

    for (let row of rows) {
      // Normalize row keys (trim whitespace)
      const cleanRow = {};
      Object.keys(row).forEach(key => {
        cleanRow[key.trim()] = row[key];
      });

      const name = cleanRow['Nama'] || cleanRow['name'] || cleanRow['Name'];
      if (!name) {
        logger.debug('[Import] Skipping row - Name is empty.');
        continue; 
      }

      const pkgName = cleanRow['Paket'] || cleanRow['package'] || cleanRow['Package'];
      const pkg = packages.find(p => p.name === pkgName);

      const odpName = cleanRow['ODP'] || cleanRow['odp'] || cleanRow['ODP Name'];
      const odp = odps.find(o => o.name === odpName);
      
      // ✅ Handle Router field
      const routerName = cleanRow['Router'] || cleanRow['router'] || cleanRow['Router Name'];
      const router = routers.find(r => r.name === routerName);
      
      // ✅ NEW: Handle Connection Type
      const connType = String(cleanRow['Tipo de conexión'] || cleanRow['connection_type'] || cleanRow['Connection Type'] || 'pppoe').trim().toLowerCase() || 'pppoe';
      
      const data = {
        nik: cleanRow['NIK'] || cleanRow['nik'] || cleanRow['No KTP'] || cleanRow['No. KTP'] || '',
        name: name,
        phone: cleanRow['Telepon'] || cleanRow['phone'] || cleanRow['Phone'],
        email: cleanRow['Email'] || cleanRow['email'] || cleanRow['email_address'],
        address: cleanRow['Alamat'] || cleanRow['address'] || cleanRow['Address'],
        area: cleanRow['Area'] || cleanRow['area'] || cleanRow['Wilayah'] || '',
        package_id: pkg ? pkg.id : null,
        router_id: router ? router.id : null,
        odp_id: odp ? odp.id : null,
        lat: cleanRow['Latitude'] || cleanRow['latitude'] || cleanRow['Lat'] || '',
        lng: cleanRow['Longitude'] || cleanRow['longitude'] || cleanRow['Lng'] || '',
        genieacs_tag: cleanRow['Tag ONU'] || cleanRow['genieacs_tag'],
        pppoe_username: connType === 'pppoe' ? (cleanRow['PPPoE Username'] || cleanRow['pppoe_username'] || '') : '',
        hotspot_username: connType === 'hotspot' ? (cleanRow['Hotspot Username'] || cleanRow['hotspot_username'] || '') : '',
        static_ip: connType === 'static' ? (cleanRow['Static IP'] || cleanRow['static_ip'] || '') : '',
        connection_type: connType,
        isolir_profile: cleanRow['Perfil de corte'] || cleanRow['isolir_profile'] || 'isolir',
        status: (cleanRow['Status'] || cleanRow['status'] || 'active').toLowerCase(),
        install_date: cleanRow['Fecha de instalación'] || cleanRow['install_date'],
        auto_isolate: (cleanRow['Auto Isolir'] === 'TIDAK' || cleanRow['auto_isolate'] === 0) ? 0 : 1,
        isolate_day: parseInt(cleanRow['Día de corte'] || cleanRow['isolate_day']) || 10,
        notes: cleanRow['Catatan'] || cleanRow['notes']
      };
      
      const id = cleanRow['ID'] || cleanRow['id'];
      if (id && !isNaN(id) && id !== '') {
        logger.info(`[Import] Updating customer ID: ${id}`);
        customerSvc.updateCustomer(id, data);
      } else {
        logger.info(`[Import] Creating new customer: ${name}`);
        customerSvc.createCustomer(data);
      }
      count++;
    }
    
    logger.info(`[Import] Finished. Total processed: ${count}`);
    req.session._msg = { type: 'success', text: `Se importaron ${count} clientes.` };
  } catch (e) {
    logger.error('Import error:', e);
    req.session._msg = { type: 'error', text: 'Falló la importación:' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/isolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.suspendCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Se cortó manualmente el servicio de "${customer.name}".` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo cortar:' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/unisolate', requireAdminSession, async (req, res) => {
  try {
    const customer = customerSvc.getCustomerById(req.params.id);
    if (!customer) throw new Error('Cliente no encontrado');
    const unpaid = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status='unpaid'").get(req.params.id)?.cnt || 0;
    if (unpaid > 0) {
      // Con deuda: se habilita como promesa de pago con los días por defecto (luego se corta si no paga)
      const r = await require('../services/promiseService').grant(Number(req.params.id), { note: 'Habilitación manual con deuda', actor: { type: 'admin', name: req.session.adminUser || 'admin', ip: req.ip } });
      req.session._msg = { type: 'success', text: `Se habilitó a "${customer.name}" con deuda: promesa de pago hasta ${r.until}.` };
    } else {
      await customerSvc.activateCustomer(req.params.id, 'active');
      req.session._msg = { type: 'success', text: `Se rehabilitó el servicio de "${customer.name}" (ACTIVO).` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo rehabilitar:' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const result = billingSvc.generateInvoiceForCustomer(req.params.id, parseInt(month), parseInt(year));
    if (result.created) {
      req.session._msg = { type: 'success', text: `Factura creada para "${result.customerName}", período ${month}/${year}.` };
    } else {
      req.session._msg = { type: 'success', text: `Ya existe una factura para "${result.customerName}", período ${month}/${year}.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo generar la factura:' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/reset-promo-cycles', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const r = customerSvc.resetPromoCyclesUsed(req.params.id);
    if (!r.changes) {
      req.session._msg = { type: 'error', text: 'Cliente no encontrado.' };
    } else {
      const c = customerSvc.getCustomerById(req.params.id);
      req.session._msg = { type: 'success', text: `Se reinició el contador de promoción de "${c ? c.name : req.params.id}" (el ciclo vuelve a empezar).` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/install-prorata', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const out = billingSvc.createInstallProrataCatchUpInvoice(req.params.id);
    req.session._msg = {
      type: 'success',
      text: `Factura complementaria prorrateada para "${out.customerName}", período ${String(out.periodMonth).padStart(2, '0')}/${out.periodYear}, por ${regional.currencySymbol()} ${Number(out.amount).toLocaleString(regional.locale())} (${out.billableDays}/${out.daysInMonth} días).`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { month, months, year, paid_by_name, notes } = req.body;
    const y = parseInt(year);
    const paidBy = resolvePaidByName(req, paid_by_name);
    const customer = customerSvc.getCustomerById(req.params.id);

    if (months != null) {
      const sum = billingSvc.payInvoicesForCustomerMonths(req.params.id, y, months, paidBy, notes);
      const done = sum.paidMonths.length;
      const already = sum.alreadyPaidMonths.length;
      const created = sum.createdMonths.length;
      const total = Number(sum.totalAmount) || 0;
      req.session._msg = { type: 'success', text: `Pago registrado para "${sum.customerName}", año ${sum.year}. Total: ${regional.currencySymbol()} ${total.toLocaleString(regional.locale())} (${sum.totalMonths || 0} meses). Pagados: ${done}, creados: ${created}, ya pagados: ${already}.` };

      if (customer && customer.phone && done > 0) {
        const monthsText = (sum.paidMonths || []).join(', ');
        const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
        await sendPaymentSuccessWA(
          customer.phone,
          customer.name,
          `${monthsText} / ${sum.year}`,
          Number(total || 0).toLocaleString(regional.locale()),
          paidBy,
          {
            customerId: customer.id,
            invoiceId: '',
            username: customer.pppoe_username || customer.id,
          customerCode: customer.customer_code || '',
            packageName: pkg?.name || customer.package_name || '-',
            paidAt: new Date(), method: String((req.body && req.body.payment_method) || '').trim()
          }
        );
      }
    } else {
      const m = parseInt(month);
      const result = billingSvc.payInvoiceForCustomerPeriod(req.params.id, m, y, paidBy, notes);
      if (result.alreadyPaid) {
        req.session._msg = { type: 'success', text: `La factura del período ${m}/${y} de "${result.customerName}" ya estaba pagada.` };
      } else {
        const verb = result.created ? 'creada y pagada' : 'dilunasi';
        req.session._msg = { type: 'success', text: `Factura del período ${m}/${y} de "${result.customerName}": ${verb}.` };

        if (customer && customer.phone) {
          const invs = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
          const inv = (Array.isArray(invs) ? invs : []).find(i => Number(i?.period_month) === Number(m) && Number(i?.period_year) === Number(y)) || null;
          const amount = inv ? Number(inv.amount || 0) : 0;
          const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
          await sendPaymentSuccessWA(
            customer.phone,
            customer.name,
            `${m}/${y}`,
            amount.toLocaleString(regional.locale()),
            paidBy,
            {
              customerId: customer.id,
              invoiceId: inv ? inv.id : '',
              username: customer.pppoe_username || customer.id,
          customerCode: customer.customer_code || '',
              packageName: pkg?.name || customer.package_name || '-',
              paidAt: new Date(), method: String((req.body && req.body.payment_method) || '').trim()
            }
          );
        }
      }
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => String(c.id) === String(req.params.id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(req.params.id);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo registrar el pago:' + e.message };
  }
  res.redirect('back');
});

// ─── PACKAGES ──────────────────────────────────────────────────────────────
router.get('/packages', requireAdminSession, requireSidebarMenuAccess('packages'), async (req, res) => {
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const routers = mikrotikService.getAllRouters();
  const packages = customerSvc.getAllPackages(selectedRouterId);
  try { const _pl = require('../services/packageProfileService'); packages.forEach(function (p) { p.rate_limit = _pl.rateLimitStr(p) || ''; }); } catch (e) {}
  // Info profil isolir (READ-ONLY, mode-aware)
  const _pkgMode = require('../services/packageProfileService').currentProfileMode();
  const isolirSource = (_pkgMode === 'radius-attributes') ? 'radius' : 'mikrotik';
  const isolirProfileName = String(getSetting('mikrotik_isolir_profile', 'isolir') || 'isolir');
  let isolirExists = false, isolirLiveRl = '', isolirLiveLocal = '', isolirLiveRemote = '';
  if (isolirSource === 'mikrotik') {
    try {
      const _pr = await mikrotikService.getPppoeProfiles(selectedRouterId || null);
      const _ip = (_pr || []).find((x) => String(x.name || '').trim().toLowerCase() === isolirProfileName.toLowerCase());
      if (_ip) { isolirExists = true; isolirLiveRl = _ip.rateLimit || ''; isolirLiveLocal = _ip.localAddress || ''; isolirLiveRemote = _ip.remoteAddress || ''; }
    } catch (e) {}
  }
  const radiusIsolir = {
    action: String(getSetting('radius_isolir_action', 'pool') || 'pool'),
    pool: String(getSetting('radius_isolir_pool', 'isolir') || 'isolir'),
    rateLimit: String(getSetting('radius_isolir_rate_limit', '512k/512k') || '512k/512k'),
    ipPoolEnabled: String(getSetting('radius_isolir_ip_pool_enabled', '1')) === '1',
    ipPoolStart: String(getSetting('radius_isolir_ip_pool_start', '10.10.99.2') || ''),
    ipPoolEnd: String(getSetting('radius_isolir_ip_pool_end', '10.10.99.254') || '')
  };
  res.render('admin/packages', {
    title: 'Planes de internet', company: company(), activePage: 'packages',
    packages, routers, selectedRouterId, msg: flashMsg(req),
    profileMode: _pkgMode, isolirSource, isolirProfileName, isolirExists, isolirLiveRl, isolirLiveLocal, isolirLiveRemote, radiusIsolir
  });
});

router.post('/packages', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const ins = customerSvc.createPackage(req.body);
    let extra = '';
    const pkg = ins && ins.lastInsertRowid ? customerSvc.getPackageById(Number(ins.lastInsertRowid)) : null;
    if (pkg) {
      const r = await require('../services/packageProfileService').ensurePppProfileForPackage(pkg).catch(function () { return null; });
      if (r && r.message) extra = ' ' + r.message;
    }
    req.session._msg = { type: 'success', text: `Plan "${req.body.name}" agregado.` + extra };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const _before = customerSvc.getPackageById(req.params.id);
    customerSvc.updatePackage(req.params.id, req.body);
    let extra = '';
    let _cleanup = '';
    if (_before && String(_before.name || '') !== String(req.body.name || '').trim() && String(_before.name || '').trim()) {
      let _oldPoolUsed = false;
      if (_before.pool_name) {
        const _oc = db.prepare("SELECT COUNT(*) c FROM packages WHERE id != ? AND TRIM(COALESCE(pool_name,'')) = ?").get(req.params.id, String(_before.pool_name).trim()).c;
        _oldPoolUsed = _oc > 0;
      }
      const _cr = await require('../services/packageProfileService').removePppProfileForPackage(_before, { removePool: !_oldPoolUsed }).catch(function () { return null; });
      if (_cr && _cr.message) _cleanup = ' [lama] ' + _cr.message;
    }
    const pkg = customerSvc.getPackageById(req.params.id);
    if (pkg) {
      const r = await require('../services/packageProfileService').ensurePppProfileForPackage(pkg).catch(function () { return null; });
      if (r && r.message) extra = ' ' + r.message;
    }
    req.session._msg = { type: 'success', text: 'Plan actualizado.' + extra + _cleanup };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/delete', requireAdminSession, async (req, res) => {
  try {
    const _cnt = db.prepare('SELECT COUNT(*) c FROM customers WHERE package_id=?').get(req.params.id).c;
    const pkg = customerSvc.getPackageById(req.params.id);
    let poolUsed = false;
    if (pkg && pkg.pool_name) {
      const other = db.prepare("SELECT COUNT(*) c FROM packages WHERE id != ? AND TRIM(COALESCE(pool_name,'')) = ?").get(req.params.id, String(pkg.pool_name).trim()).c;
      poolUsed = other > 0;
    }
    customerSvc.deletePackage(req.params.id);
    let extra = '';
    if (pkg) {
      const r = await require('../services/packageProfileService').removePppProfileForPackage(pkg, { removePool: !poolUsed }).catch(function () { return null; });
      if (r && r.message) extra = ' ' + r.message;
    }
    req.session._msg = { type: 'success', text: 'Plan eliminado.' + extra + (_cnt ? (' ' + _cnt + ' clientes quedaron sin plan — asignales uno.') : '') };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/packages');
});

// ─── VOUCHER PACKAGES (ON-DEMAND REAL-TIME CONFIGURATION) ────────────────────
router.get('/vouchers/packages', requireAdminSession, requireSidebarMenuAccess('voucher_packages'), (req, res) => {
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const routers = db.prepare('SELECT id, name FROM routers WHERE is_active = 1').all();
  res.render('admin/vouchers_packages', {
    title: 'Planes de fichas hotspot', company: company(), activePage: 'voucher_packages',
    routers, selectedRouterId, msg: flashMsg(req)
  });
});

router.get('/api/vouchers/packages', requireAdminSession, (req, res) => {
  try {
    const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
    let rows;
    if (selectedRouterId && selectedRouterId > 0) {
      rows = db.prepare(`
        SELECT vp.*, r.name AS router_name
        FROM voucher_packages vp
        LEFT JOIN routers r ON r.id = vp.router_id
        WHERE vp.router_id = ?
        ORDER BY vp.price ASC
      `).all(selectedRouterId);
    } else {
      rows = db.prepare(`
        SELECT vp.*, r.name AS router_name
        FROM voucher_packages vp
        LEFT JOIN routers r ON r.id = vp.router_id
        ORDER BY vp.price ASC
      `).all();
    }
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/vouchers/packages', requireAdminSession, express.json(), (req, res) => {
  try {
    const { router_id, profile_name, price, validity, prefix, code_length, charset, is_active } = req.body;
    
    // VALIDATION: router_id is REQUIRED for voucher packages
    if (!router_id || Number(router_id) <= 0) return res.status(400).json({ ok: false, error: 'Hay que elegir un router' });
    
    // Verify router exists
    const router = db.prepare('SELECT id FROM routers WHERE id = ? LIMIT 1').get(Number(router_id));
    if (!router) return res.status(400).json({ ok: false, error: 'Router no encontrado en la base de datos' });
    
    if (!profile_name) return res.status(400).json({ ok: false, error: 'El nombre del perfil es obligatorio' });
    if (!price || Number(price) <= 0) return res.status(400).json({ ok: false, error: 'El precio debe ser mayor a 0' });
    if (!validity) return res.status(400).json({ ok: false, error: 'La duración/vigencia es obligatoria' });

    const rId = router_id ? Number(router_id) : null;
    const prc = Math.floor(Number(price));
    const len = Math.max(4, Math.min(16, Number(code_length) || 6));
    const act = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;

    const stmt = db.prepare(`
      INSERT INTO voucher_packages (router_id, profile_name, price, validity, prefix, code_length, charset, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (NOW_LOCAL()))
      ON CONFLICT(router_id, profile_name) DO UPDATE SET
        price=excluded.price,
        validity=excluded.validity,
        prefix=excluded.prefix,
        code_length=excluded.code_length,
        charset=excluded.charset,
        is_active=excluded.is_active,
        updated_at=(NOW_LOCAL())
    `);
    
    stmt.run(rId, profile_name, prc, String(validity).trim(), String(prefix || '').trim(), len, charset || 'mixed', act);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/vouchers/packages/:id/delete', requireAdminSession, (req, res) => {
  try {
    db.prepare('DELETE FROM voucher_packages WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── BILLING ───────────────────────────────────────────────────────────────
function adminActorFromReq(req) {
  return { type: 'admin', id: req.session.adminUser || null, name: req.session.adminUser || 'Admin', ip: req.ip, userAgent: req.headers['user-agent'] };
}

router.get('/discounts', requireAdminSession, requireSidebarMenuAccess('discounts'), (req, res) => {
  const timeInfo = getCurrentTimeInfo();
  const { status: fStatus = 'active', search = '' } = req.query;
  const discSvc = require('../services/discountService');
  let allCustomers = [];
  try { allCustomers = customerSvc.getAllCustomers() || []; } catch (e) { allCustomers = []; }
  const customers = allCustomers.filter(c => {
    if (fStatus && fStatus !== 'all' && String(c.status) !== fStatus) return false;
    if (String(c.status) === 'suspended' && fStatus === 'active') return false;
    if (search) {
      const s = String(search).toLowerCase();
      const hay = `${c.name || ''} ${c.phone || ''} ${c.customer_code || ''} ${c.pppoe_username || ''}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });
  const areas = [...new Set(allCustomers.map(c => c.area).filter(Boolean))].sort();
  res.render('admin/discounts', {
    title: 'Descuentos en facturas', company: company(), activePage: 'discounts',
    customers, logs: discSvc.getDiscountLogs(100), fStatus, search, areas, timeInfo, msg: flashMsg(req)
  });
});

router.post('/discounts/apply', requireAdminSession, requireSidebarMenuAccess('discounts'), express.urlencoded({ extended: true }), (req, res) => {
  try {
    const discSvc = require('../services/discountService');
    const timeInfo = getCurrentTimeInfo();
    const applyMode = String(req.body.apply_mode || 'selected');
    const pMonth = parseInt(req.body.period_month, 10) || timeInfo.month;
    const pYear = parseInt(req.body.period_year, 10) || timeInfo.year;
    let customerIds = [];
    let all = false;
    if (applyMode === 'all') all = true;
    else if (applyMode === 'single') { const cid = parseInt(req.body.customer_id, 10); if (cid) customerIds = [cid]; }
    else { const arr = Array.isArray(req.body.customer_ids) ? req.body.customer_ids : (req.body.customer_ids ? [req.body.customer_ids] : []); customerIds = arr.map(x => parseInt(x, 10)).filter(Boolean); }
    const result = discSvc.applyDiscountBatch({ customerIds, all, periodMonth: pMonth, periodYear: pYear, type: req.body.discount_type, value: req.body.discount_value, note: req.body.note, actor: adminActorFromReq(req) });
    req.session._msg = { type: 'success', text: `Descuento aplicado a ${result.applied.length} facturas (total descontado ${regional.currencySymbol()} ${Number(result.totalDiscount || 0).toLocaleString(regional.locale())}). ${result.skipped.length} clientes omitidos (sin facturas pendientes en ese período).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo aplicar el descuento:' + e.message };
  }
  res.redirect('/admin/discounts');
});

router.post('/billing/:id/discount', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const discSvc = require('../services/discountService');
    const r = discSvc.applyDiscountToInvoice(req.params.id, { type: req.body.discount_type, value: req.body.discount_value, note: req.body.note }, adminActorFromReq(req));
    req.session._msg = { type: 'success', text: `Diskon diterapkan: ${regional.currencySymbol()} ${Number(r.amountBefore).toLocaleString(regional.locale())} -> ${regional.currencySymbol()} ${Number(r.amountAfter).toLocaleString(regional.locale())} (potongan ${regional.currencySymbol()} ${Number(r.discountAmount).toLocaleString(regional.locale())}).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Falló el descuento:' + e.message };
  }
  res.redirect(req.get('Referrer') || '/admin/billing');
});

router.get('/billing', requireAdminSession, requireSidebarMenuAccess('billing'), (req, res) => {
  const timeInfo = getCurrentTimeInfo();
  const { month: filterMonth, year: filterYear = timeInfo.year, status: filterStatus = 'all', search = '',
    package_id: filterPackage = '', area: filterArea = '', router_id: filterRouter = '', collector_id: filterCollector = '' } = req.query;
  const summary = billingSvc.getInvoiceSummary(filterMonth || timeInfo.month, filterYear);
  const invoices = billingSvc.getAllInvoices({ month: filterMonth, year: filterYear, status: filterStatus, search,
    packageId: filterPackage, area: filterArea, routerId: filterRouter, collectorId: filterCollector });
  res.render('admin/billing', {
    title: 'Tagihan', company: company(), activePage: 'billing',
    invoices, summary, filterMonth, filterYear: parseInt(filterYear), filterStatus, search,
    filterPackage, filterArea, filterRouter, filterCollector,
    packages: customerSvc.getAllPackages(), areas: customerSvc.getAllCustomerAreas(),
    routers: mikrotikService.getAllRouters(), collectors: adminSvc.getAllCollectors(),
    msg: flashMsg(req)
  });
});

router.get('/billing/:id/print', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Factura no encontrada');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Cliente no encontrado');

  const settings = getSettings();
  res.render('admin/print_invoice', {
    invoice: inv,
    customer,
    company: settings.company_header || 'OPEN-ISP',
    settings
  });
});

router.get('/billing/:id/print-thermal', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Factura no encontrada');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Cliente no encontrado');

  const settings = getSettings();
  res.render('collector/print_thermal', {
    invoice: inv,
    customer,
    company: settings.company_header || 'OPEN-ISP',
    settings,
    collectorName: req.session.adminUsername || 'Admin',
    formatDateLocal,
    formatTimeLocal,
    getNowLocal
  });
});

router.get('/billing/:id/pdf', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) return res.status(404).send('Factura no encontrada');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) return res.status(404).send('Cliente no encontrado');

    const settings = getSettings();
    const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(inv, customer, settings);
    
    const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Invoice_INV-${String(inv.id).padStart(4, '0')}_${safeName}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    return res.send(pdfBuffer);
  } catch (err) {
    logger.error(`[PDF Download] Error: ${err.message}`);
    return res.status(500).send('No se pudo generar el PDF de la factura:' + err.message);
  }
});

router.post('/billing/:id/send-pdf-wa', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) return res.json({ success: false, message: 'Factura no encontrada' });
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) return res.json({ success: false, message: 'Cliente no encontrado' });
    if (!customer.phone) return res.json({ success: false, message: 'El cliente no tiene número de WhatsApp' });

    const settings = getSettings();
    const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(inv, customer, settings);

    const mns = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const periodStr = `${mns[(inv.period_month || 1) - 1]} ${inv.period_year}`;
    const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Invoice_${inv.id}_${safeName}.pdf`;
    const statusText = inv.status === 'paid' ? 'LUNAS' : 'BELUM BAYAR';
    
    const caption = `📄 *FACTURA DE INTERNET*\n\nEstimado/a *${customer.name}*,\nLe enviamos adjunta su factura de internet del período *${periodStr}*.\n\n💰 *Monto:* ${regional.currencySymbol()} ${Number(inv.amount || 0).toLocaleString(regional.locale())}\n📌 *Estado:* *${statusText}*\n\n¡Gracias por elegir *${settings.company_header || 'OPEN-ISP'}*!`;

    const waNotify = require('../services/waNotifyService');
    if (false) {
      return res.json({ success: false, message: 'Bot WhatsApp belum terhubung' });
    }

    const sent = await waNotify.sendDocument(customer.phone, pdfBuffer, filename, caption);
    if (sent) {
      return res.json({ success: true, message: `Factura PDF enviada por WhatsApp a ${customer.name} (${customer.phone})` });
    } else {
      return res.json({ success: false, message: 'No se pudo enviar el PDF por WhatsApp' });
    }
  } catch (err) {
    logger.error(`[Send PDF WA] Error: ${err.message}`);
    return res.json({ success: false, message: 'No se pudo enviar el PDF:' + err.message });
  }
});

router.post('/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const count = billingSvc.generateMonthlyInvoices(parseInt(month), parseInt(year));
    req.session._msg = { type: 'success', text: `Se generaron ${count} facturas nuevas para el período ${month}/${year}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo generar:' + e.message };
  }
  res.redirect('/admin/billing');
});

router.get('/api/billing/unpaid/:customerId', requireAdmin, (req, res) => {
  try {
    const invoices = billingSvc.getUnpaidInvoicesByCustomerId(req.params.customerId);
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/paid-months', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || getCurrentTimeInfo().year);
    const months = billingSvc.getPaidMonthsForCustomerYear(req.params.id, year);
    res.json({ year, months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/billing-year', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || getCurrentTimeInfo().year);
    const summary = billingSvc.getCustomerBillingYearSummary(req.params.id, year);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/billing/pay-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { invoice_ids, paid_by_name, notes } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const paidBy = resolvePaidByName(req, paid_by_name);
    
    if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    const paidByCustomer = new Map();
    const touchedCustomerIds = new Set();
    let processed = 0;
    for (const id of ids) {
      const inv = billingSvc.getInvoiceById(id);
      if (inv) {
        processed++;
        const customerId = Number(inv.customer_id || 0);
        if (Number.isFinite(customerId) && customerId > 0) touchedCustomerIds.add(customerId);
        const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
        billingSvc.markAsPaid(id, paidBy, notes);
        if (!wasPaid) {
          if (!paidByCustomer.has(customerId)) paidByCustomer.set(customerId, []);
          paidByCustomer.get(customerId).push({
            id: inv.id,
            amount: Number(inv.amount || 0),
            period_month: inv.period_month,
            period_year: inv.period_year
          });
        }
      }
    }

    const customersSnapshot = customerSvc.getAllCustomers();
    for (const customerId of touchedCustomerIds) {
      const freshCustomer = customersSnapshot.find(c => Number(c.id) === Number(customerId));
      if (freshCustomer && freshCustomer.status === 'suspended' && Number(freshCustomer.unpaid_count || 0) === 0) {
        await customerSvc.activateCustomer(customerId);
      }
    }

    for (const [customerId, paidInvoices] of paidByCustomer.entries()) {
      if (!paidInvoices || paidInvoices.length === 0) continue;
      const customer = customerSvc.getCustomerById(customerId);
      if (customer && customer.phone) {
        const total = paidInvoices.reduce((a, b) => a + Number(b.amount || 0), 0);
        const periods = paidInvoices
          .map(x => whatsappService.formatIndonesianPeriod(x.period_month, x.period_year))
          .slice(0, 10)
          .join(', ') + (paidInvoices.length > 10 ? `, +${paidInvoices.length - 10} lainnya` : '');
        const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
        await sendPaymentSuccessWA(
          customer.phone,
          customer.name,
          periods,
          Number(total || 0).toLocaleString(regional.locale()),
          paidBy,
          {
            customerId: customer.id,
            invoiceId: paidInvoices.map(x => x.id).join(', '),
            username: customer.pppoe_username || customer.id,
          customerCode: customer.customer_code || '',
            packageName: pkg?.name || customer.package_name || '-',
            paidAt: new Date(), method: String((req.body && req.body.payment_method) || '').trim()
          }
        );
      }
    }

    req.session._msg = { type: 'success', text: `Se procesaron ${processed} facturas.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Falló el cobro masivo:' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/delete-bulk', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { invoice_ids } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const clean = ids
      .map(x => Number(x))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!clean || clean.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    let deleted = 0;
    for (const id of clean) {
      try {
        billingSvc.deleteInvoice(id);
        deleted++;
      } catch {}
    }

    req.session._msg = { type: 'success', text: `Se eliminaron ${deleted} facturas.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Falló la eliminación masiva:' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Factura no encontrada');

    const paidBy = resolvePaidByName(req, req.body.paid_by_name);
    const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
    if (!wasPaid) {
      billingSvc.markAsPaid(req.params.id, paidBy, req.body.notes);
    }
    
    // Check if customer is currently suspended and has no more unpaid invoices
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!wasPaid && customer && customer.phone) {
      const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
      await sendPaymentSuccessWA(
        customer.phone,
        customer.name,
        `${inv.period_month}/${inv.period_year}`,
        Number(inv.amount || 0).toLocaleString(regional.locale()),
        paidBy,
        {
          customerId: customer.id,
          invoiceId: inv.id,
          username: customer.pppoe_username || customer.id,
          customerCode: customer.customer_code || '',
          packageName: pkg?.name || customer.package_name || '-',
          paidAt: new Date(), method: String((req.body && req.body.payment_method) || '').trim()
        }
      );
    }
    if (customer && customer.status === 'suspended') {
      const unpaidCount = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status='unpaid'").get(inv.customer_id)?.cnt || 0;
      if (unpaidCount === 0) {
        await customerSvc.activateCustomer(inv.customer_id);
      }
    }

    req.session._msg = { type: 'success', text: wasPaid ? 'Esta factura ya estaba pagada.' : 'Factura marcada como pagada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('back');
});

// Anular pago: vista previa (estado al que vuelve el cliente + advertencias) y anulación con reversión completa
router.get('/billing/:id/annul-preview', requireAdminSession, (req, res) => {
  if (req.session.isCashier) return res.status(403).json({ ok: false, message: 'Solo el administrador puede anular pagos.' });
  try { res.json({ ok: true, ...require('../services/paymentReversalService').preview(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.post('/billing/:id/annul', requireAdminSession, express.json(), async (req, res) => {
  if (req.session.isCashier) return res.status(403).json({ ok: false, message: 'Solo el administrador puede anular pagos.' });
  try {
    const r = await require('../services/paymentReversalService').annul(Number(req.params.id), {
      reason: req.body && req.body.reason,
      actor: { type: 'admin', name: req.session.adminUser || 'admin', ip: req.ip }
    });
    res.json({ ...r, message: `Pago anulado. La factura volvió a pendiente y el cliente quedó: ${r.restoredLabel} (${r.network}).` });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

router.post('/billing/:id/unpay', requireAdminSession, (req, res) => {
  // Reemplazado por /billing/:id/annul (con motivo y reversión del estado del cliente)
  req.session._msg = { type: 'error', text: 'Usá "Anular pago" para revertir un cobro.' };
  res.redirect('back');
});

router.post('/billing/:id/qris-assign', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('ID de factura inválido');

    const force = String(req.query.force || '') === '1';
    const inv = db.prepare('SELECT id, status, amount, qris_amount_unique FROM invoices WHERE id=?').get(invId);
    if (!inv) throw new Error('Factura no encontrada');
    if (String(inv.status) !== 'unpaid') throw new Error('Hanya tagihan BELUM BAYAR yang bisa dibuat kode QRIS.');

    if (!force && inv.qris_amount_unique) {
      req.session._msg = { type: 'success', text: 'Esta factura ya tiene código QR.' };
      return res.redirect('back');
    }

    const baseAmount = Number(inv.amount || 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error('Monto de la factura inválido');

    const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
    const update = db.prepare(`
      UPDATE invoices
      SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=(NOW_LOCAL())
      WHERE id=?
    `);

    let chosenCode = 0;
    let chosenAmount = 0;

    for (let i = 0; i < 50; i++) {
      const code = 1 + Math.floor(Math.random() * 999);
      const amount = baseAmount + code;
      if (!exists.get('unpaid', amount, invId)) {
        chosenCode = code;
        chosenAmount = amount;
        break;
      }
    }

    if (!chosenAmount) {
      for (let code = 1; code <= 999; code++) {
        const amount = baseAmount + code;
        if (!exists.get('unpaid', amount, invId)) {
          chosenCode = code;
          chosenAmount = amount;
          break;
        }
      }
    }

    if (!chosenAmount) throw new Error('No se pudo crear el monto único (los códigos 1-999 están ocupados).');

    update.run(chosenCode, chosenAmount, invId);
    req.session._msg = { type: 'success', text: `Código QR creado: ${regional.currencySymbol()} ${Number(chosenAmount).toLocaleString(regional.locale())} (código ${chosenCode}).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo crear el código QR:' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/qris-clear', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('ID de factura inválido');
    db.prepare(`
      UPDATE invoices
      SET qris_unique_code=NULL, qris_amount_unique=NULL, qris_assigned_at=NULL
      WHERE id=?
    `).run(invId);
    req.session._msg = { type: 'success', text: 'Código QR eliminado de la factura.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo eliminar el código QR:' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
  try {
    const waEnabled = require('../config/waGate').ready();
    const billingEnabled = getSetting('whatsapp_billing_to_customer_enabled', true);
    if (!waEnabled) throw new Error('Las notificaciones de WhatsApp están desactivadas en Configuración.');
    if (!billingEnabled) throw new Error('El envío de facturas por WhatsApp a los clientes está desactivado.');

    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Factura no encontrada');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('No se encontró el número de WhatsApp del cliente');

    const waNotify = require('../services/waNotifyService');
    
    if (false) {
      throw new Error('WhatsApp no está conectado. Revisá el estado de WhatsApp en el panel.');
    }

    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const summary = whatsappService.formatUnpaidInvoicesSummary(
      (unpaidInvoices && unpaidInvoices.length > 0) ? unpaidInvoices : [inv]
    );
    const totalTagihan = summary.totalAmount > 0 ? summary.totalAmount : Number(inv.amount || 0);
    const rincianBulan = summary.periodText;
    const rincianDetail = summary.isMultiple ? `📋 *Detalle de la deuda:*\n${summary.breakdownText}\n` : '';

    let qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
    let qrisCode = Number(inv.qris_unique_code || 0) || 0;
    const qrisQrUrl = String(getSetting('qris_static_qr_url', '') || '').trim();
    const qrisPayloadSetting = String(getSetting('qris_static_payload', '') || '');
    const qrisEnabledRaw = getSetting('qris_static_enabled', true);
    const qrisEnabled = !(qrisEnabledRaw === false || qrisEnabledRaw === 'false' || qrisEnabledRaw === 0 || qrisEnabledRaw === '0');
    const hasStaticQris = qrisEnabled && (!!qrisQrUrl || !!String(qrisPayloadSetting || '').trim());

    const baseAmount = totalTagihan > 0 ? totalTagihan : Number(inv.amount || 0);

    if (hasStaticQris && String(inv.status) === 'unpaid' && (!qrisAmountUnique || !qrisCode || (qrisAmountUnique - qrisCode !== baseAmount))) {
      const invId = Number(inv.id);
      if (Number.isFinite(invId) && invId > 0 && Number.isFinite(baseAmount) && baseAmount > 0) {
        const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
        const update = db.prepare(`
          UPDATE invoices
          SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=(NOW_LOCAL())
          WHERE id=?
        `);

        let chosenCode = qrisCode > 0 ? qrisCode : 0;
        let chosenAmount = 0;

        if (chosenCode > 0) {
          const pAmt = baseAmount + chosenCode;
          if (!exists.get('unpaid', pAmt, invId)) {
            chosenAmount = pAmt;
          }
        }

        if (!chosenAmount) {
          for (let i = 0; i < 50; i++) {
            const code = 1 + Math.floor(Math.random() * 999);
            const amount = baseAmount + code;
            if (!exists.get('unpaid', amount, invId)) {
              chosenCode = code;
              chosenAmount = amount;
              break;
            }
          }
        }
        if (!chosenAmount) {
          for (let code = 1; code <= 999; code++) {
            const amount = baseAmount + code;
            if (!exists.get('unpaid', amount, invId)) {
              chosenCode = code;
              chosenAmount = amount;
              break;
            }
          }
        }
        if (chosenAmount) {
          update.run(chosenCode, chosenAmount, invId);
          qrisAmountUnique = chosenAmount;
          qrisCode = chosenCode;
        }
      }
    }

    const normalizeQrisPayload = (raw) => {
      let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
      const idx = s.indexOf('000201');
      if (idx > 0) s = s.slice(idx);
      const lastCrc = s.lastIndexOf('6304');
      if (lastCrc >= 0 && s.length >= lastCrc + 8) {
        s = s.slice(0, lastCrc + 8);
      }
      return s;
    };
    const crc16CcittFalse = (input) => {
      const s = String(input || '');
      let crc = 0xffff;
      for (let i = 0; i < s.length; i++) {
        crc ^= (s.charCodeAt(i) & 0xff) << 8;
        for (let b = 0; b < 8; b++) {
          if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
          else crc = (crc << 1) & 0xffff;
        }
      }
      return crc & 0xffff;
    };
    const parseEmvTlvString = (input) => {
      const raw = String(input || '').replace(/[\r\n\t]+/g, '').trim();
      if (!raw) throw new Error('El payload QRIS está vacío');
      if (raw.length < 8) throw new Error('QRIS payload terlalu pendek');
      const items = [];
      let i = 0;
      while (i < raw.length) {
        if (i + 4 > raw.length) throw new Error('El payload QRIS (TLV) no es válido');
        const tag = raw.slice(i, i + 2);
        const lenStr = raw.slice(i + 2, i + 4);
        if (!/^\d{2}$/.test(lenStr)) throw new Error('QRIS payload TLV length tidak valid');
        const len = Number(lenStr);
        const start = i + 4;
        const end = start + len;
        if (end > raw.length) throw new Error('QRIS payload TLV length melebihi data');
        const value = raw.slice(start, end);
        items.push({ tag, value });
        i = end;
      }
      return items;
    };
    const buildEmvTlvString = (items) => {
      const list = Array.isArray(items) ? items : [];
      let out = '';
      for (const it of list) {
        const tag = String(it?.tag || '');
        const value = String(it?.value ?? '');
        const len = value.length;
        if (!/^\d{2}$/.test(tag)) throw new Error('Tag TLV tidak valid');
        if (len > 99) throw new Error('No se admite una longitud TLV > 99');
        out += tag + String(len).padStart(2, '0') + value;
      }
      return out;
    };
    const convertStaticQrisToDynamic = (staticPayload, amount) => {
      const amt = Math.max(0, Math.floor(Number(amount || 0) || 0));
      if (!amt) throw new Error('El monto del QRIS dinámico no es válido');
      const source = parseEmvTlvString(staticPayload)
        .filter(x => x && x.tag)
        .map(x => ({ tag: String(x.tag), value: String(x.value ?? '') }));
      const managed = new Set(['54', '55', '56', '57', '63']);
      const result = [];
      let amountInserted = false;
      for (const el of source) {
        if (managed.has(el.tag)) continue;
        if (el.tag === '01') {
          result.push({ tag: '01', value: '12' });
          continue;
        }
        if (el.tag === '58' && !amountInserted) {
          result.push({ tag: '54', value: String(amt) });
          amountInserted = true;
        }
        result.push(el);
      }
      if (!amountInserted) result.push({ tag: '54', value: String(amt) });
      const body = buildEmvTlvString(result);
      const partial = body + '6304';
      const crc = crc16CcittFalse(partial).toString(16).toUpperCase().padStart(4, '0');
      return partial + crc;
    };

    let _decodedCache = global.__adminQrisDecodedCache || { file: '', mtimeMs: 0, payload: '' };
    const decodeQrisPayloadFromUploadedQr = async () => {
      const m = String(qrisQrUrl || '').match(/^\/uploads\/qris\/([^/?#]+)$/i);
      if (!m || !m[1]) return '';
      const safeName = path.basename(String(m[1]));
      const filePath = path.join(__dirname, '../public/uploads/qris', safeName);
      let st = null;
      try {
        st = await fs.promises.stat(filePath);
      } catch {
        return '';
      }
      if (_decodedCache.file === safeName && _decodedCache.mtimeMs === st.mtimeMs && _decodedCache.payload) {
        return _decodedCache.payload;
      }
      try {
        const buf = await fs.promises.readFile(filePath);
        const img = await Jimp.read(buf);
        const rgba = new Uint8ClampedArray(img.bitmap.data.buffer, img.bitmap.data.byteOffset, img.bitmap.data.byteLength);
        const source = new RGBLuminanceSource(rgba, img.bitmap.width, img.bitmap.height);
        const bitmap = new BinaryBitmap(new HybridBinarizer(source));
        const reader = new MultiFormatReader();
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        reader.setHints(hints);
        const decoded = reader.decode(bitmap);
        const text = typeof decoded?.getText === 'function' ? decoded.getText() : String(decoded?.text || '');
        const payload = normalizeQrisPayload(text);
        if (!payload) return '';
        _decodedCache = { file: safeName, mtimeMs: st.mtimeMs, payload };
        global.__adminQrisDecodedCache = _decodedCache;
        return payload;
      } catch {
        return '';
      }
    };

    const resolveQrisStaticPayload = async () => {
      const fromSetting = normalizeQrisPayload(qrisPayloadSetting);
      if (fromSetting) return fromSetting;
      return await decodeQrisPayloadFromUploadedQr();
    };

    // Generate Link Login
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    let baseUrl = String(getSetting('app_url', '') || `${protocol}://${host}`).replace(/\/+$/, '');
    try {
      const parsed = new URL(baseUrl);
      baseUrl = parsed.origin;
    } catch {}
    const loginLink = `${baseUrl}/customer/login`;

    const comp = company();
    const defaultAutoBilling = "{Hola|Buenas}, *{{nama}}* 👋\n\nLe enviamos el detalle de su factura de internet:\n\n• ID de cliente: *{{id_pelanggan}}*\n• Plan: {{paket}}\n• Monto: *{{moneda}} {{tagihan}}*\n• Período: {{rincian}}\n\nPuede consultar su factura aquí:\n{{link}}\n\n¡Gracias!\n— {{company}}";
    
    const defaultQris = `{Hola|Buenas}, *{{nama}}* 👋\n\nLe enviamos el detalle de su factura:\n\n📦 *Plan:* {{paket}}\n📅 *Período:* {{periode}}\n💰 *Monto:* {{moneda}} {{qris_nominal}}\n\n{{qris_qr}}\n\n¡Gracias!`;

    const templateQris = db.getAppSetting('whatsapp_billing_qris_message', defaultQris);
    const template = db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBilling);

    const isQrisCase = (qrisAmountUnique > 0 && qrisCode > 0);
    const finalNominal = qrisAmountUnique > 0 ? qrisAmountUnique : totalTagihan;
    const finalNominalStr = Number(finalNominal).toLocaleString(regional.locale());
    const displayPeriode = summary.isMultiple
      ? `${rincianBulan}\n\n${rincianDetail}`.trim()
      : rincianBulan;

    const qrisJpgLink = `${baseUrl}/customer/qris/static.jpg?amount=${encodeURIComponent(String(finalNominal))}`;
    const qrisJpgCaption = isQrisCase
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{id_pelanggan}}/gi, customer.customer_code || '-')
          .replace(/{{username}}/gi, customer.pppoe_username || '-')
          .replace(/{{pppoe}}/gi, customer.pppoe_username || '-')
          .replace(/{{company}}/gi, company())
          .replace(/{{company_phone}}/gi, getSetting('company_phone', '') || '-')
          .replace(/{{link}}/gi, loginLink)
          .replace(/{{rincian_detail}}/gi, rincianDetail)
          .replace(/{{periode}}/gi, displayPeriode)
          .replace(/{{rincian}}/gi, displayPeriode)
          .replace(/{{paket}}/gi, inv.package_name || customer.package_name || '-')
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, `QR adjunto (imagen).\n🌐 Portal del cliente: ${loginLink}`)
      : '';

    const formattedMsg = isQrisCase
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{id_pelanggan}}/gi, customer.customer_code || '-')
          .replace(/{{username}}/gi, customer.pppoe_username || '-')
          .replace(/{{pppoe}}/gi, customer.pppoe_username || '-')
          .replace(/{{company}}/gi, company())
          .replace(/{{company_phone}}/gi, getSetting('company_phone', '') || '-')
          .replace(/{{link}}/gi, loginLink)
          .replace(/{{rincian_detail}}/gi, rincianDetail)
          .replace(/{{periode}}/gi, displayPeriode)
          .replace(/{{rincian}}/gi, displayPeriode)
          .replace(/{{paket}}/gi, inv.package_name || customer.package_name || '-')
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, `🔗 QR (imagen JPG): ${qrisJpgLink}\n🌐 Portal del cliente: ${loginLink}`)
      : template
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{id_pelanggan}}/gi, customer.customer_code || '-')
          .replace(/{{username}}/gi, customer.pppoe_username || '-')
          .replace(/{{pppoe}}/gi, customer.pppoe_username || '-')
          .replace(/{{company}}/gi, company())
          .replace(/{{company_phone}}/gi, getSetting('company_phone', '') || '-')
          .replace(/{{link}}/gi, loginLink)
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{rincian_detail}}/gi, rincianDetail)
          .replace(/{{periode}}/gi, displayPeriode)
          .replace(/{{rincian}}/gi, displayPeriode)
          .replace(/{{paket}}/gi, inv.package_name || customer.package_name || '-')
          .replace(/{{link}}/gi, loginLink);

    let sent = false;
    if (isQrisCase) {
      try {
        const payloadNorm = await resolveQrisStaticPayload();
        if (payloadNorm) {
          const jpg = await qrisUtil.buildDynamicQrisJpgBuffer(payloadNorm, qrisAmountUnique);
          sent = await waNotify.sendImage(customer.phone, jpg, qrisJpgCaption);
        }
      } catch (e) {
        sent = false;
      }
    }
    if (!sent) {
      sent = await waNotify.sendText(customer.phone, formattedMsg);
    }
    if (!sent) throw new Error('No se pudo enviar el mensaje por WhatsApp.');

    req.session._msg = { type: 'success', text: `Factura enviada por WhatsApp a ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo enviar el WhatsApp:' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/delete', requireAdminSession, (req, res) => {
  try {
    billingSvc.deleteInvoice(req.params.id);
    req.session._msg = { type: 'success', text: 'Factura eliminada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('back');
});

// ─── TICKETS ───────────────────────────────────────────────────────────────
const ticketSvc = require('../services/ticketService');

router.get('/tickets', requireAdminSession, requireSidebarMenuAccess('tickets'), (req, res) => {
  const { status = 'all', search = '', tech_id: filterTech = '' } = req.query;
  const tickets = ticketSvc.getAllTickets(status, { search, technicianId: filterTech });
  const stats = ticketSvc.getTicketStats();
  const customers = customerSvc.getAllCustomers();
  const techSvc = require('../services/techService');
  const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1);
  
  res.render('admin/tickets', {
    title: 'Reclamos y tareas de técnicos', company: company(), activePage: 'tickets',
    tickets, stats, customers, technicians, filterStatus: status, filterSearch: search, filterTech: filterTech, msg: flashMsg(req)
  });
});

router.post('/tickets/create', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { customer_id, subject, message, technician_id, status } = req.body;
    if (!subject || !message) {
      req.session._msg = { type: 'error', text: 'El asunto y el detalle son obligatorios.' };
      return res.redirect('/admin/tickets');
    }

    const custId = customer_id ? parseInt(customer_id, 10) : 0;
    const techId = technician_id ? parseInt(technician_id, 10) : null;
    const ticketStatus = status || (techId ? 'in_progress' : 'open');

    const result = ticketSvc.createTicket(custId, subject, message, {
      technicianId: techId,
      status: ticketStatus
    });

    const ticketId = result.lastInsertRowid;
    req.session._msg = { type: 'success', text: '¡Ticket/tarea creado!' };

    // --- WHATSAPP NOTIFICATION FOR NEW ADMIN CREATED TICKET ---
    try {
      const settings = getSettings();
      if (settings.whatsapp_enabled) {
        const waNotify = require('../services/waNotifyService');
        const cust = custId ? customerSvc.getCustomerById(custId) : null;
        const techSvc = require('../services/techService');
        const tech = techId ? techSvc.getTechById(techId) : null;

        const custName = cust ? cust.name : 'Tugas Umum / Maintenance Admin';
        const custPhone = cust ? cust.phone : '-';
        const custAddr = cust ? cust.address : '-';

        const _waDigits = regional.normalizePhone(custPhone || '');
        const _mapQ = (cust && cust.lat && cust.lng) ? (cust.lat + ',' + cust.lng) : String(custAddr || '');
        const _base = (getSetting('public_base_url', '') || getSetting('app_url', '') || ('http://' + (req.get('host') || ''))).replace(/\/+$/, '');
        const _links = `\n🔗 *Tautan Cepat:*\n` +
          (_waDigits ? `• 💬 Chat con el cliente: https://wa.me/${_waDigits}\n` : '') +
          (_mapQ ? `• 📍 Ubicación: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(_mapQ)}` : '');
        const waMsg = `📌 *NUEVA TAREA PARA TÉCNICOS*\n\n` +
                     `🎫 *Ticket:* #${ticketId}\n` +
                     `👤 *Cliente/objeto:* ${custName}\n` +
                     `📞 *Kontak:* ${custPhone}\n` +
                     `📍 *Dirección:* ${custAddr}\n` +
                     `📝 *Kendala/Tugas:* ${subject}\n` +
                     `💬 *Detalle:* ${message}\n\n` +
                     `Revisalo en el portal de técnicos/administración para darle seguimiento.` + _links;

        // Send to assigned technician or broadcast to all active technicians if not assigned
        if (tech && tech.phone) {
          let digits = String(tech.phone).replace(/\D/g, '');
          digits = regional.normalizePhone(digits);
          await waNotify.sendText(digits, waMsg);
        } else if (!techId) {
          const technicians = require('../config/techPermissions').broadcastRecipients(); // solo técnicos con 'reclamos sin asignar'
          for (const t of technicians) {
            let digits = String(t.phone).replace(/\D/g, '');
            digits = regional.normalizePhone(digits);
            await waNotify.sendText(digits, waMsg);
          }
        }
      }
    } catch (waErr) {
      console.error(`[AdminPortal] WA Ticket Create Notification Error: ${waErr.message}`);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo crear el ticket:' + e.message };
  }
  res.redirect('/admin/tickets');
});

router.post('/tickets/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { status, technician_id } = req.body;
    const ticketId = req.params.id;
    const oldTicket = ticketSvc.getTicketById(ticketId);
    
    const techId = (technician_id && parseInt(technician_id, 10) > 0) ? parseInt(technician_id, 10) : null;
    ticketSvc.updateTicketStatus(ticketId, status, techId);
    req.session._msg = { type: 'success', text: 'Estado y asignación del reclamo actualizados.' };

    // --- WHATSAPP NOTIFICATION IF TECHNICIAN IS ASSIGNED / CHANGED ---
    if (techId && (!oldTicket || Number(oldTicket.technician_id) !== techId)) {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const waNotify = require('../services/waNotifyService');
          const techSvc = require('../services/techService');
          const newTech = techSvc.getTechById(techId);
          const updatedTicket = ticketSvc.getTicketById(ticketId);

          if (newTech && newTech.phone && updatedTicket) {
            let digits = String(newTech.phone).replace(/\D/g, '');
            digits = regional.normalizePhone(digits);
            
            const waMsg = `📌 *TICKET ASIGNADO POR LA ADMINISTRACIÓN*\n\n` +
                         `🎫 *Ticket:* #${updatedTicket.id}\n` +
                         `👤 *Cliente/objeto:* ${updatedTicket.customer_name}\n` +
                         `📞 *Kontak:* ${updatedTicket.customer_phone || '-'}\n` +
                         `📍 *Dirección:* ${updatedTicket.customer_address || '-'}\n` +
                         `📝 *Kendala/Tugas:* ${updatedTicket.subject}\n` +
                         `💬 *Detalle:* ${updatedTicket.message}\n` +
                         `📊 *Status:* ${status}\n\n` +
                         `Revisá el portal de técnicos para atender esta tarea.`;
            await waNotify.sendText(digits, waMsg);
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Assign Notification Error: ${waErr.message}`);
      }
    }

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET (BY ADMIN) ---
    if (status === 'resolved') {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const waNotify = require('../services/waNotifyService');
          const ticket = ticketSvc.getTicketById(ticketId);
          
          if (ticket) {
            const waMsg = `✅ *RECLAMO RESUELTO*\n\n` +
                         `🎫 *Ticket:* #${ticket.id}\n` +
                         `👤 *Cliente:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Petugas:* Admin\n\n` +
                         `Su reclamo fue resuelto. ¡Gracias por su paciencia!`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              await waNotify.sendText(ticket.customer_phone, waMsg);
            }

            // Kirim ke Admin Numbers
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const adminMsg = `✅ *TICKET RESUELTO (POR LA ADMINISTRACIÓN)*\n\n` +
                               `🎫 *Ticket:* #${ticket.id}\n` +
                               `👤 *Cliente:* ${ticket.customer_name}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Mensaje:* ${ticket.message}`;
              const seen = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                let digits = String(adminPhone || '').replace(/\D/g, '');
                if (!digits) continue;
                digits = regional.normalizePhone(digits);
                if (seen.has(digits)) continue;
                seen.add(digits);
                await waNotify.sendText(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo actualizar el reclamo:' + e.message };
  }
  res.redirect('back');
});

router.post('/tickets/:id/delete', requireAdminSession, (req, res) => {
  try {
    ticketSvc.deleteTicket(req.params.id);
    req.session._msg = { type: 'success', text: 'Reclamo eliminado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo eliminar el reclamo:' + e.message };
  }
  res.redirect('back');
});

// ─── REPORTS ───────────────────────────────────────────────────────────────
router.get('/reports', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const now = new Date();
  const monthlyData = billingSvc.getMonthlyRevenue(filterYear);
  const recentPayments = billingSvc.getRecentPayments(10);
  const topUnpaid = billingSvc.getTopUnpaid(5);
  const activeCustomers = customerSvc.getCustomerStats().active;

  const yStr = String(filterYear);
  const revenueYearAllRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ?"
  ).get(yStr);
  const revenueYearAll = Number(revenueYearAllRow?.t || 0);

  const revenueYearDirectRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')"
  ).get(yStr);
  const revenueYearDirect = Number(revenueYearDirectRow?.t || 0);
  const revenueYearAgent = Math.max(0, revenueYearAll - revenueYearDirect);

  const agentDepositYearRow = ({ t: 0 });
  const agentDepositYear = Number(agentDepositYearRow?.t || 0);

  const nowYearStr = String(now.getFullYear());
  const nowMonthStr = String(now.getMonth() + 1).padStart(2, '0');
  const revenueThisMonthAllRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ?"
  ).get(nowYearStr, nowMonthStr);
  const revenueThisMonthAll = Number(revenueThisMonthAllRow?.t || 0);

  const revenueThisMonthDirectRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')"
  ).get(nowYearStr, nowMonthStr);
  const revenueThisMonthDirect = Number(revenueThisMonthDirectRow?.t || 0);
  const revenueThisMonthAgent = Math.max(0, revenueThisMonthAll - revenueThisMonthDirect);

  const agentDepositMonthRow = ({ t: 0 });
  const agentDepositThisMonth = Number(agentDepositMonthRow?.t || 0);

  const customCashInYearRow = db.prepare("SELECT SUM(amount) as t FROM cash_in WHERE strftime('%Y', date) = ?").get(yStr);
  const customCashInYear = Number(customCashInYearRow?.t || 0);

  const customCashInMonthRow = db.prepare("SELECT SUM(amount) as t FROM cash_in WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?").get(nowYearStr, nowMonthStr);
  const customCashInMonth = Number(customCashInMonthRow?.t || 0);

  const cashInYear = revenueYearDirect + agentDepositYear + customCashInYear;
  const cashInThisMonth = revenueThisMonthDirect + agentDepositThisMonth + customCashInMonth;
  const pendingAmountRow = db.prepare("SELECT SUM(amount - COALESCE(amount_paid,0)) as t FROM invoices WHERE status='unpaid'").get();
  const pendingAmount = Number(pendingAmountRow?.t || 0);

  const voidedYearRow = db.prepare("SELECT COUNT(*) as c, SUM(amount) as t FROM invoices WHERE status='void' AND period_year = ?").get(yStr);
  const voidedYearCount = Number(voidedYearRow?.c || 0);
  const voidedYearAmount = Number(voidedYearRow?.t || 0);

  const expensesYearRow = db.prepare("SELECT SUM(amount) as t FROM expenses WHERE strftime('%Y', date) = ?").get(yStr);
  const expensesRegularYear = Number(expensesYearRow?.t || 0);
  const expensesYear = expensesRegularYear;

  const expensesMonthRow = db.prepare("SELECT SUM(amount) as t FROM expenses WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?").get(nowYearStr, nowMonthStr);
  const expensesRegularMonth = Number(expensesMonthRow?.t || 0);
  const expensesMonth = expensesRegularMonth;

  const voidedMonthRow = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='void' AND strftime('%Y', voided_at) = ? AND strftime('%m', voided_at) = ?").get(nowYearStr, nowMonthStr);
  const voidedMonthAmount = Number(voidedMonthRow?.t || 0);

  const netProfitYear = cashInYear - expensesYear - voidedYearAmount;
  const netProfitMonth = cashInThisMonth - expensesMonth - voidedMonthAmount;

  const expensesByCategory = db.prepare("SELECT category, SUM(amount) as total FROM expenses WHERE strftime('%Y', date) = ? GROUP BY category").all(yStr);
  expensesByCategory.sort((a, b) => b.total - a.total);

  // ── Pajak & Retribusi (lazy finance) ──
  const fin = {
    ppn: Number(getSetting('finance_ppn_pct', '11')) || 0,
    pph: Number(getSetting('finance_pph_pct', '22')) || 0,
    uso: Number(getSetting('finance_uso_pct', '1.75')) || 0,
    bhp: Number(getSetting('finance_bhp_pct', '0.5')) || 0,
    inclPpn: String(getSetting('finance_revenue_includes_ppn', '0')) === '1'
  };
  const lab = (bruto, keluar) => {
    const dpp = (fin.inclPpn && fin.ppn > 0) ? (bruto / (1 + fin.ppn / 100)) : bruto;
    const ppn = fin.inclPpn ? (bruto - dpp) : (bruto * fin.ppn / 100);
    const uso = dpp * fin.uso / 100;
    const bhp = dpp * fin.bhp / 100;
    const sebelumPph = dpp - keluar - uso - bhp;
    const pph = Math.max(0, sebelumPph) * fin.pph / 100;
    const bersih = sebelumPph - pph;
    return { bruto, dpp, ppn: Math.max(0, ppn), uso, bhp, keluar, sebelumPph, pph, bersih };
  };
  const ply = lab(cashInYear, expensesYear);
  const pm = lab(cashInThisMonth, expensesMonth);
  const _revM = db.prepare("SELECT CAST(strftime('%m', paid_at) AS INTEGER) m, COALESCE(SUM(amount),0) t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at)=? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %') GROUP BY m").all(yStr);
  const _expM = db.prepare("SELECT CAST(strftime('%m', date) AS INTEGER) m, COALESCE(SUM(amount),0) t FROM expenses WHERE strftime('%Y', date)=? GROUP BY m").all(yStr);
  const _revMap = {}; _revM.forEach(r => { _revMap[r.m] = Number(r.t); });
  const _expMap = {}; _expM.forEach(r => { _expMap[r.m] = Number(r.t); });
  const monthlyFinance = [];
  for (let _m = 1; _m <= 12; _m++) { monthlyFinance.push(Object.assign({ month: _m }, lab(_revMap[_m] || 0, _expMap[_m] || 0))); }

  res.render('admin/reports', {
    title: 'Estado de resultados', company: company(), activePage: 'reports',
    filterYear, monthlyData, chartData: monthlyData, recentPayments, topUnpaid,
    totalRevenue: revenueYearAll,
    thisMonth: revenueThisMonthAll,
    pendingAmount,
    voidedYearCount,
    voidedYearAmount,
    voidedMonthAmount,
    activeCustomers,
    revenueYearAgent,
    revenueThisMonthAgent,
    agentDepositYear,
    agentDepositThisMonth,
    customCashInYear,
    customCashInMonth,
    cashInYear,
    cashInThisMonth,
    expensesYear,
    expensesMonth,
    netProfitYear,
    netProfitMonth,
    expensesByCategory,
    finance: fin, ply, pm, monthlyFinance
  });
});

router.post('/reports/finance', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const keep = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? String(n) : String(d); };
    const cur = getSettings();
    const next = {
      ...cur,
      finance_ppn_pct: keep(req.body.finance_ppn_pct, 11),
      finance_pph_pct: keep(req.body.finance_pph_pct, 22),
      finance_uso_pct: keep(req.body.finance_uso_pct, 1.75),
      finance_bhp_pct: keep(req.body.finance_bhp_pct, 0.5),
      finance_revenue_includes_ppn: String(req.body.finance_revenue_includes_ppn) === '1' ? '1' : '0'
    };
    saveSettings(next);
    req.session._msg = { type: 'success', text: 'Pengaturan pajak & retribusi disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo guardar:' + e.message };
  }
  res.redirect('/admin/reports');
});

router.get('/reports/print', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const filterMonth = parseInt(req.query.month) || 0;
  const yStr = String(filterYear);
  const monthlyData = billingSvc.getMonthlyRevenue(filterYear);
  const settings = getSettingsWithCache();
  const activeCustomers = customerSvc.getCustomerStats().active;

  // Kalkulasi sama seperti laporan utama
  const revenueYearDirect = Number(db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')").get(yStr)?.t || 0);
  const agentDepositYear = Number(({ t: 0 })?.t || 0);
  const customCashInYear = Number(db.prepare("SELECT SUM(amount) as t FROM cash_in WHERE strftime('%Y', date) = ?").get(yStr)?.t || 0);
  const cashInYear = revenueYearDirect + agentDepositYear + customCashInYear;

  const expensesRegularYear = Number(db.prepare("SELECT SUM(amount) as t FROM expenses WHERE strftime('%Y', date) = ?").get(yStr)?.t || 0);
  const expensesYear = expensesRegularYear;
  
  const netProfitYear = cashInYear - expensesYear;

  const pendingAmountRow = db.prepare("SELECT SUM(amount - COALESCE(amount_paid,0)) as t FROM invoices WHERE status='unpaid' AND period_year = ?").get(filterYear);
  const pendingAmount = Number(pendingAmountRow?.t || 0);

  const expensesByCategory = db.prepare("SELECT category, SUM(amount) as total FROM expenses WHERE strftime('%Y', date) = ? GROUP BY category").all(yStr);
  expensesByCategory.sort((a, b) => b.total - a.total);

  // voided (dibutuhkan view print; sebelumnya belum dihitung di route ini)
  const _now = new Date();
  const _nowYearStr = String(_now.getFullYear());
  const _nowMonthStr = String(_now.getMonth() + 1).padStart(2, '0');
  const voidedYearRow = db.prepare("SELECT COUNT(*) as c, SUM(amount) as t FROM invoices WHERE status='void' AND period_year = ?").get(filterYear);
  const voidedYearCount = Number(voidedYearRow?.c || 0);
  const voidedYearAmount = Number(voidedYearRow?.t || 0);
  const voidedMonthRow = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='void' AND strftime('%Y', voided_at) = ? AND strftime('%m', voided_at) = ?").get(_nowYearStr, _nowMonthStr);
  const voidedMonthAmount = Number(voidedMonthRow?.t || 0);

  const _mPad = String(filterMonth).padStart(2, '0');
  const _brutoP = filterMonth
    ? (Number(db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at)=? AND strftime('%m', paid_at)=?").get(yStr, _mPad)?.t || 0)
       + Number(db.prepare("SELECT SUM(amount) as t FROM cash_in WHERE strftime('%Y', date)=? AND strftime('%m', date)=?").get(yStr, _mPad)?.t || 0))
    : cashInYear;
  const _keluarP = filterMonth
    ? Number(db.prepare("SELECT SUM(amount) as t FROM expenses WHERE strftime('%Y', date)=? AND strftime('%m', date)=?").get(yStr, _mPad)?.t || 0)
    : expensesYear;
  const finP = finCfg();
  const LR = labaRugi(_brutoP, _keluarP, finP);

  res.render('admin/reports_print', {
    company: company(),
    settings,
    filterYear,
    filterMonth,
    fin: finP,
    LR,
    cashInYear,
    expensesYear,
    netProfitYear,
    pendingAmount,
    voidedYearCount,
    voidedYearAmount,
    voidedMonthAmount,
    activeCustomers,
    monthlyData,
    expensesByCategory,
    formatDateLocal,
    getNowLocal
  });
});

router.get('/reports/pdf', requireAdminSession, requireSidebarMenuAccess('reports'), async (req, res) => {
  try {
    const filterYear = parseInt(req.query.year) || new Date().getFullYear();
    const filterMonth = parseInt(req.query.month) || 0;
    const mode = String(req.query.mode || 'after') === 'before' ? 'before' : 'after';
    const yStr = String(filterYear);
    const _mPad = String(filterMonth).padStart(2, '0');
    const fin = finCfg();
    const q = (s, ...a) => Number((db.prepare(s).get(...a) || {}).t || 0);
    const brutoP = filterMonth
      ? (q("SELECT COALESCE(SUM(amount),0) t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at)=? AND strftime('%m', paid_at)=? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')", yStr, _mPad)
        + q("SELECT COALESCE(SUM(amount),0) t FROM cash_in WHERE strftime('%Y', date)=? AND strftime('%m', date)=?", yStr, _mPad))
      : (q("SELECT COALESCE(SUM(amount),0) t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at)=? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')", yStr)
        + q("SELECT COALESCE(SUM(amount),0) t FROM cash_in WHERE strftime('%Y', date)=?", yStr));
    const keluarP = filterMonth
      ? q("SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE strftime('%Y', date)=? AND strftime('%m', date)=?", yStr, _mPad)
      : q("SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE strftime('%Y', date)=?", yStr);
    const ply = labaRugi(brutoP, keluarP, fin);
    const _revM = db.prepare("SELECT CAST(strftime('%m', paid_at) AS INTEGER) m, COALESCE(SUM(amount),0) t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at)=? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %') GROUP BY m").all(yStr);
    const _expM = db.prepare("SELECT CAST(strftime('%m', date) AS INTEGER) m, COALESCE(SUM(amount),0) t FROM expenses WHERE strftime('%Y', date)=? GROUP BY m").all(yStr);
    const _rM = {}; _revM.forEach(r => { _rM[r.m] = Number(r.t); });
    const _eM = {}; _expM.forEach(r => { _eM[r.m] = Number(r.t); });
    const monthlyFinance = [];
    for (let m = 1; m <= 12; m++) monthlyFinance.push(Object.assign({ month: m }, labaRugi(_rM[m] || 0, _eM[m] || 0, fin)));
    const pdf = await require('../services/financeReportPdfService').generateFinanceReportPdfBuffer({
      company: company(), settings: getSettings(), filterYear, filterMonth, finance: fin, ply, pm: ply, monthlyFinance, mode
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Laporan_Keuangan_' + filterYear + (filterMonth ? ('-' + _mPad) : '') + '_' + mode + '.pdf"');
    res.send(pdf);
  } catch (e) {
    res.status(500).send('No se pudo crear el PDF:' + e.message);
  }
});

router.get('/reports/export-csv', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const filterMonth = parseInt(req.query.month) || 0;
  const yStr = String(filterYear);
  const fin = finCfg();
  const q = (s, ...a) => Number((db.prepare(s).get(...a) || {}).t || 0);
  const num = (v) => Math.round(Number(v) || 0);

  let csvContent = '';
  let fname = '';
  if (filterMonth) {
    const mStr = String(filterMonth).padStart(2, '0');
    const bruto = q("SELECT COALESCE(SUM(amount),0) t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at)=? AND strftime('%m', paid_at)=? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')", yStr, mStr)
      + q("SELECT COALESCE(SUM(amount),0) t FROM cash_in WHERE strftime('%Y', date)=? AND strftime('%m', date)=?", yStr, mStr);
    const keluar = q("SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE strftime('%Y', date)=? AND strftime('%m', date)=?", yStr, mStr);
    const L = labaRugi(bruto, keluar, fin);
    csvContent += `Estado de resultados ${company()} - Mes ${mStr}/${filterYear}\n\n`;
    csvContent += `Keterangan,Nilai (${regional.currencySymbol()})\n`;
    csvContent += `Ingresos (brutos),${num(L.bruto)}\nBase imponible,${num(L.dpp)}\nIVA (${fin.ppn}%),${num(L.ppn)}\nGastos,${num(L.keluar)}\nOtro impuesto 1 (${fin.uso}%),${num(L.uso)}\nOtro impuesto 2 (${fin.bhp}%),${num(L.bhp)}\nGanancia antes de impuesto a la renta,${num(L.sebelumPph)}\nImpuesto a la renta (${fin.pph}%),${num(L.pph)}\nGanancia neta,${num(L.bersih)}\n\n`;
    const invs = db.prepare("SELECT i.paid_at, c.name, i.amount FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.status='paid' AND strftime('%Y', i.paid_at)=? AND strftime('%m', i.paid_at)=? ORDER BY i.paid_at").all(yStr, mStr);
    csvContent += "=== Pemasukan (Invoice Lunas) ===\nTanggal,Pelanggan,Nominal\n";
    invs.forEach(r => { csvContent += `${r.paid_at},"${(r.name || '').replace(/"/g, '""')}",${r.amount}\n`; });
    const exps = db.prepare("SELECT date, category, amount, description FROM expenses WHERE strftime('%Y', date)=? AND strftime('%m', date)=? ORDER BY date").all(yStr, mStr);
    csvContent += "\n=== Pengeluaran ===\nTanggal,Kategori,Nominal,Deskripsi\n";
    exps.forEach(e => { csvContent += `${e.date},"${(e.category || '').replace(/"/g, '""')}",${e.amount},"${(e.description || '').replace(/"/g, '""')}"\n`; });
    fname = `Laporan_Keuangan_${filterYear}-${mStr}.csv`;
  } else {
    const expenses = db.prepare("SELECT date, category, amount, description FROM expenses WHERE strftime('%Y', date) = ? ORDER BY date ASC").all(yStr);
    const cashIn = db.prepare("SELECT date, category, amount, description FROM cash_in WHERE strftime('%Y', date) = ? ORDER BY date ASC").all(yStr);
    const bruto = q("SELECT COALESCE(SUM(amount),0) t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at)=?", yStr)
      + q("SELECT COALESCE(SUM(amount),0) t FROM cash_in WHERE strftime('%Y', date)=?", yStr);
    const keluar = q("SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE strftime('%Y', date)=?", yStr);
    const L = labaRugi(bruto, keluar, fin);
    csvContent += `Reporte financiero ${company()} - Año ${filterYear}\n\n`;
    csvContent += `=== RINGKASAN LABA/RUGI ===\nKeterangan,Nilai (${regional.currencySymbol()})\n`;
    csvContent += `Ingresos (brutos),${num(L.bruto)}\nBase imponible,${num(L.dpp)}\nIVA (${fin.ppn}%),${num(L.ppn)}\nGastos,${num(L.keluar)}\nOtro impuesto 1 (${fin.uso}%),${num(L.uso)}\nOtro impuesto 2 (${fin.bhp}%),${num(L.bhp)}\nGanancia antes de impuesto a la renta,${num(L.sebelumPph)}\nImpuesto a la renta (${fin.pph}%),${num(L.pph)}\nGanancia neta,${num(L.bersih)}\n\n`;
    csvContent += "=== DATA PENGELUARAN ===\nTanggal,Kategori,Nominal,Deskripsi\n";
    expenses.forEach(e => { csvContent += `${e.date},"${e.category}",${e.amount},"${(e.description || '').replace(/"/g, '""')}"\n`; });
    csvContent += "\n=== DATA KAS MASUK TAMBAHAN ===\nTanggal,Sumber/Kategori,Nominal,Deskripsi\n";
    cashIn.forEach(c => { csvContent += `${c.date},"${c.category}",${c.amount},"${(c.description || '').replace(/"/g, '""')}"\n`; });
    fname = `Laporan_Keuangan_${filterYear}.csv`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csvContent);
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/sidebar-settings', requireAdminSession, (req, res) => {
  res.render('admin/sidebar_settings', {
    title: 'Pengaturan Sidebar',
    company: company(),
    activePage: 'sidebar_settings',
    msg: flashMsg(req),
    canManageSidebar: Boolean(req.session?.isAdmin),
    menuConfigs: sidebarMenuSvc.getConfigMenus(),
    featureContactPhone: sidebarMenuSvc.getFeatureContactPhone()
  });
});

router.post('/sidebar-settings', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const menuStates = sidebarMenuSvc.sanitizeMenuStates(req.body.menu_state || {});
    const success = sidebarMenuSvc.saveMenuStates(menuStates);
    if (!success) throw new Error('No se pudo guardar la configuración del menú lateral');

    if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
      auditSvc.logAuditTrail({
        action: 'UPDATE',
        entity_type: 'sidebar_settings',
        entity_id: 'global',
        actor_type: req.session?.isAdmin ? 'admin' : 'cashier',
        actor_id: String(req.session?.adminUser || req.session?.cashierUsername || ''),
        actor_name: req.session?.adminUser || req.session?.cashierName || 'Admin',
        details: { menuStates, password_verified: true },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    }

    req.session._msg = { type: 'success', text: 'Menú lateral guardado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo guardar la configuración del menú lateral:' + e.message };
  }
  res.redirect('/admin/sidebar-settings');
});

router.get('/service-notice', requireAdminSession, requireSidebarMenuAccess('service_notice'), (req, res) => {
  res.render('admin/service_notice', {
    title: 'Estado del servicio y avisos', company: company(), activePage: 'service_notice',
    settings: getSettings(), msg: flashMsg(req)
  });
});

router.post('/service-notice', requireAdminSession, requireSidebarMenuAccess('service_notice'), express.urlencoded({ extended: true }), (req, res) => {
  try {
    const allowed = ['NORMAL', 'GANGGUAN_MASAL', 'PERBAIKAN'];
    let mode = String(req.body.notice_mode || 'NORMAL').trim().toUpperCase();
    if (allowed.indexOf(mode) === -1) mode = 'NORMAL';
    let interval = parseInt(req.body.notice_interval_hours, 10);
    if (!interval || interval < 1) interval = 5;
    if (interval > 168) interval = 168;
    saveSettings({
      notice_mode: mode,
      notice_start: String(req.body.notice_start || '').trim(),
      notice_interval_hours: interval,
      notice_note: String(req.body.notice_note || '').trim()
    });
    const noticeSvc = require('../services/serviceNoticeService');
    const n = noticeSvc.computeNotice();
    const detail = n.active ? (n.label + (n.estimateText ? ' — estimasi ' + n.estimateText : '')) : 'Normal (tanpa pengumuman)';
    req.session._msg = { type: 'success', text: 'Estado del servicio actualizado:' + detail };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo guardar el estado del servicio:' + e.message };
  }
  res.redirect('/admin/service-notice');
});

router.post('/customers/auto-deactivate-now', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const months = parseInt(getSetting('auto_deactivate_months', 3), 10) || 3;
    const r = await customerSvc.autoDeactivateOverdueCustomers(months);
    return res.json({ success: true, processed: r.processed, candidates: r.candidates, message: `Desactivación automática: ${r.processed} clientes desactivados de ${r.candidates} candidatos (>= ${months} meses).` });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/registrations/:id/approve', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cust = customerSvc.getCustomerById(id);
    if (!cust) throw new Error('Inscripto no encontrado');
    let total = parseInt(req.body.final_total, 10);
    if (!Number.isFinite(total) || total < 0) total = Number(cust.reg_total || 0);

    // Periode tagihan pertama = bulan jatuh tempo (acuan tgl 5)
    const due = String(cust.reg_due_date || '');
    let pMonth, pYear;
    if (/^\d{4}-\d{2}-\d{2}$/.test(due)) { pYear = Number(due.slice(0, 4)); pMonth = Number(due.slice(5, 7)); }
    else { const ti = getCurrentTimeInfo(); pMonth = ti.month || (new Date().getMonth() + 1); pYear = ti.year || new Date().getFullYear(); }

    // Auto-generate akun PPPoE bila belum ada (bisa dimatikan di Pengaturan RADIUS/PPPoE)
    const _autoGenPppoe = getSetting('pppoe_auto_generate', '1') === '1';
    let pppoeUser = cust.pppoe_username || '';
    let pppoePass = cust.pppoe_password || '';
    if (!pppoeUser && _autoGenPppoe) { try { const g = customerSvc.generatePppoeAccount(id); pppoeUser = g.username; pppoePass = g.password; } catch (e) {} }

    // Provisioning: RADIUS baca DB langsung; mode MikroTik perlu push secret ke router
    try {
      const _radiusEnabled = getSetting('radius_enabled', '0') === '1';
      const _isRadius = _radiusEnabled ? (Number(cust.is_radius) === 1 ? 1 : 0) : 0;
      db.prepare('UPDATE customers SET is_radius=? WHERE id=?').run(_isRadius, id);
      const _shouldSyncToMikrotik = !_radiusEnabled || !_isRadius;
      if (_shouldSyncToMikrotik && pppoeUser) {
        const _pkg = cust.package_id ? customerSvc.getPackageById(cust.package_id) : null;
        await mikrotikService.createPppoeSecret({
          username: pppoeUser,
          password: pppoePass,
          profile: _pkg ? _pkg.name : '',
          remoteAddress: cust.pppoe_remote_address || '',
          routerId: cust.router_id || null
        });
        logger.info('[RegApprove] PPPoE secret dipush ke MikroTik: ' + pppoeUser + ' (profile ' + (_pkg ? _pkg.name : '-') + ')');
      } else if (pppoeUser) {
        logger.info('[RegApprove] Mode RADIUS - kredensial dibaca dari DB (tanpa push MikroTik): ' + pppoeUser);
      }
    } catch (e) { try { logger.error('[RegApprove] Provisioning PPPoE gagal: ' + e.message); } catch (_) {} }

    const existingInv = db.prepare('SELECT id FROM invoices WHERE customer_id=? AND period_month=? AND period_year=?').get(id, pMonth, pYear);
    if (!existingInv) {
      db.prepare('INSERT INTO invoices (customer_id, period_month, period_year, amount, status, notes) VALUES (?,?,?,?,?,?)')
        .run(id, pMonth, pYear, total, 'unpaid', 'Factura inicial de alta (instalación + prorrateo)');
    }

    const installDate = cust.install_date || String(cust.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const inFee = parseInt(req.body.reg_install_fee, 10);
    const inPro = parseInt(req.body.reg_prorata, 10);
    const inDisc = parseInt(req.body.reg_discount, 10);
    db.prepare('UPDATE customers SET status=?, reg_status=?, reg_total=?, reg_install_fee=COALESCE(?,reg_install_fee), reg_prorata=COALESCE(?,reg_prorata), reg_discount=COALESCE(?,reg_discount), install_date=? WHERE id=?')
      .run('active', 'approved', total, Number.isFinite(inFee) ? inFee : null, Number.isFinite(inPro) ? inPro : null, Number.isFinite(inDisc) ? inDisc : null, installDate, id);

    // Notifikasi WA ke pelanggan: tagihan pertama + QRIS dinamis
    try {
      const waNotify = require('../services/waNotifyService');
      const invoiceQris = require('../services/invoiceQrisService');
      const invRow = db.prepare('SELECT * FROM invoices WHERE customer_id=? AND period_month=? AND period_year=?').get(id, pMonth, pYear);
      if (cust.phone && invRow) {
        const q = invoiceQris.ensureInvoiceQris(invRow);
        const mns = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const periodStr = (mns[pMonth - 1] || pMonth) + ' ' + pYear;
        const pkg = cust.package_id ? customerSvc.getPackageById(cust.package_id) : null;
        const comp = getSetting('company_header', 'OPEN-ISP');
        const caption = 'Hola *' + cust.name + '*,\n\n' +
          '🎉 ¡Bienvenido/a! Le enviamos su primera factura de internet:\n\n' +
          '📋 *RESUMEN DE LA FACTURA*\n' +
          '• ID de cliente : *' + (cust.customer_code || '-') + '*\n' +
          '• Plan          :' + (pkg ? pkg.name : (cust.package_name || '-')) + '\n' +
          '• Monto         : *' + regional.currencySymbol() + ' ' + Number(invRow.amount || 0).toLocaleString(regional.locale()) + '*\n' +
          '• Período       :' + periodStr + '\n\n' +
          'Escanee el QR de arriba para pagar.\n\n' +
          'Gracias.\n—' + comp;
        if (q.payload) {
          const QRCode = require('qrcode');
          const png = await QRCode.toBuffer(q.payload, { width: 512, margin: 1 });
          await waNotify.sendImage(cust.phone, png, caption);
        } else {
          await waNotify.sendText(cust.phone, caption);
        }
      }
    } catch (e) { try { logger.error('[RegApprove] WA error: ' + e.message); } catch (_) {} }

    // Kirim kredensial PPPoE ke admin & teknisi
    try {
      if (pppoeUser) {
        const waNotify = require('../services/waNotifyService');
        const pkgC = cust.package_id ? customerSvc.getPackageById(cust.package_id) : null;
        const credMsg = '🔑 *CREDENCIALES PPPoE DEL CLIENTE NUEVO*\n\n' +
          '👤 *Nombre:*' + cust.name + '\n' +
          '🆔 *ID:* ' + (cust.customer_code || '-') + '\n' +
          '📦 *Plan:*' + (pkgC ? pkgC.name : (cust.package_name || '-')) + '\n' +
          '📡 *PPPoE User:* *' + pppoeUser + '*\n' +
          '🔒 *PPPoE Pass:* *' + (pppoePass || '-') + '*\n' +
          '📍 *Dirección:*' + (cust.address || '-') + '\n\n' +
          'Configurá el equipo del cliente con estos datos.';
        await waNotify.notifyAdmin(credMsg);
        await waNotify.notifyInstallers(credMsg);
      }
    } catch (e) { try { logger.error('[RegApprove] staff cred error: ' + e.message); } catch (_) {} }

    req.session._msg = { type: 'success', text: 'Pendaftar ' + cust.name + ' aprobado (activo) + primera factura creada (' + regional.currencySymbol() + ' ' + total.toLocaleString(regional.locale()) + ', período' + pMonth + '/' + pYear + ').' };
  } catch (e) { req.session._msg = { type: 'error', text: 'No se pudo aprobar:' + e.message }; }
  res.redirect(req.get('Referrer') || '/admin/customers?status=inactive');
});

router.post('/registrations/:id/reject', requireAdminSession, (req, res) => {
  try {
    const id = Number(req.params.id);
    const cust = customerSvc.getCustomerById(id);
    if (!cust) throw new Error('Inscripto no encontrado');
    db.prepare("UPDATE customers SET reg_status='rejected' WHERE id=?").run(id);
    req.session._msg = { type: 'success', text: 'Pendaftar ' + cust.name + ' rechazado.' };
  } catch (e) { req.session._msg = { type: 'error', text: 'No se pudo rechazar:' + e.message }; }
  res.redirect(req.get('Referrer') || '/admin/customers?status=inactive');
});

router.get('/vouchers-discounts', requireAdminSession, requireSidebarMenuAccess('vouchers_discounts'), (req, res) => {
  const voucherSvc = require('../services/voucherService');
  const editId = parseInt(req.query.edit, 10) || 0;
  res.render('admin/vouchers_discounts', {
    title: 'Voucher Diskon', company: company(), activePage: 'vouchers_discounts',
    vouchers: voucherSvc.list(),
    editVoucher: editId ? voucherSvc.getById(editId) : null,
    installFee: parseInt(getSetting('registration_install_fee', 0), 10) || 0,
    pppoeDomain: String(getSetting('pppoe_domain', 'sky.id') || 'sky.id'),
    pppoeDefaultPassword: String(getSetting('pppoe_default_password', 'openisp') || 'openisp'),
    msg: flashMsg(req)
  });
});

router.post('/vouchers-discounts/save', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const voucherSvc = require('../services/voucherService');
    if (req.body.id) voucherSvc.update(req.body.id, req.body);
    else voucherSvc.create(req.body);
    req.session._msg = { type: 'success', text: 'Cupón guardado.' };
  } catch (e) { req.session._msg = { type: 'error', text: 'No se pudo guardar el cupón:' + e.message }; }
  res.redirect('/admin/vouchers-discounts');
});

router.post('/vouchers-discounts/:id/toggle', requireAdminSession, (req, res) => {
  try {
    const voucherSvc = require('../services/voucherService');
    const v = voucherSvc.getById(req.params.id);
    if (v) voucherSvc.update(v.id, { active: v.active ? 0 : 1 });
    req.session._msg = { type: 'success', text: 'Estado del cupón cambiado.' };
  } catch (e) { req.session._msg = { type: 'error', text: 'Error:' + e.message }; }
  res.redirect('/admin/vouchers-discounts');
});

router.post('/vouchers-discounts/:id/delete', requireAdminSession, (req, res) => {
  try { require('../services/voucherService').remove(req.params.id); req.session._msg = { type: 'success', text: 'Cupón eliminado.' }; }
  catch (e) { req.session._msg = { type: 'error', text: 'Error:' + e.message }; }
  res.redirect('/admin/vouchers-discounts');
});

router.post('/vouchers-discounts/settings', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const fee = parseInt(req.body.registration_install_fee, 10) || 0;
    if (fee <= 0) throw new Error('El costo de instalación no puede ser 0. Para hacerla gratis, usá un código de cupón.');
    saveSettings({
      registration_install_fee: fee,
      pppoe_domain: String(req.body.pppoe_domain || 'sky.id').replace(/^@/, '').trim() || 'sky.id',
      pppoe_default_password: String(req.body.pppoe_default_password || 'openisp').trim() || 'openisp'
    });
    req.session._msg = { type: 'success', text: 'Costo de instalación guardado:' + regional.currencySymbol() + ' ' + fee.toLocaleString(regional.locale()) + '.' };
  } catch (e) { req.session._msg = { type: 'error', text: 'Error:' + e.message }; }
  res.redirect('/admin/vouchers-discounts');
});

function waTemplateDefaults(comp) {
  // Plantillas predeterminadas en español (config/waTemplates.js)
  return Object.assign({}, require('../config/waTemplates').TEMPLATES);
}

router.get('/automation/template', requireAdminSession, (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    const _bsvc = require('../services/billingSendService');
    const defaults = waTemplateDefaults(company());
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      return res.status(400).json({ ok: false, error: 'clave desconocida' });
    }
    const text = db.getAppSetting(key, defaults[key] || '');
    res.json({ ok: true, key: key, label: _bsvc.TEMPLATE_LABELS[key] || key, text: text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.get('/automation', requireAdminSession, requireSidebarMenuAccess('automation'), (req, res) => {
  const comp = company();
  const defaultAutoBillingMsg =
    'Estimado/a {{nama}},\n\n' +
    'Le recordamos que su factura de internet está por vencer.\n\n' +
    '📦 *Plan:* {{paket}}\n' +
    '💰 *Monto:* {{moneda}} {{tagihan}}\n' +
    '📅 *Período:* {{rincian}}\n\n' +
    'Por favor, realice su pago antes de la fecha de corte. Detalle: {{link}}\n\n' +
    '¡Gracias!\n' +
    'Saludos,\n' + comp;
  const _bsvc = require('../services/billingSendService');
  const defaults = waTemplateDefaults(comp);
  const selectedTplKey = String(getSetting('auto_billing_template_key', 'whatsapp_auto_billing_message') || 'whatsapp_auto_billing_message');
  const autoBillingMsg = db.getAppSetting(selectedTplKey, defaults[selectedTplKey] || '');
  let runs = [];
  try { runs = db.prepare('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 30').all(); } catch (e) {}
  let isolateDays = [];
  try { isolateDays = db.prepare("SELECT DISTINCT COALESCE(isolate_day,0) d FROM customers WHERE package_id IS NOT NULL AND COALESCE(isolate_day,0)>0 ORDER BY d").all().map(function (x) { return x.d; }); } catch (e) {}
  res.render('admin/automation', {
    title: 'Automation', company: comp, activePage: 'automation', msg: flashMsg(req),
    getSetting, autoBillingMsg, selectedTplKey, billingTemplates: _bsvc.TEMPLATE_LABELS, runs: runs, isolateDays: isolateDays,
    cycle: require('../config/billingCycle').get(), cyclePreview: require('../config/billingCycle').preview(),
    netQueue: require('../services/networkQueueService').list({ includeDone: false }),
    cutPreviewId: (db.prepare("SELECT id FROM customers WHERE status='suspended' ORDER BY id LIMIT 1").get() || {}).id || null,
    cutNotice: require('../services/cutDebtNoticeService').config(),
    cutNoticeDue: (function () { try { return require('../services/cutDebtNoticeService').due().length; } catch (e) { return 0; } })(),
    cutDebtMessage: db.getAppSetting('whatsapp_cut_debt_message', require('../config/waTemplates').getDefault('whatsapp_cut_debt_message')),
    netQueueRecent: require('../services/networkQueueService').list({ includeDone: true, limit: 20 })
  });
});

router.post('/network-queue/:id/retry', requireAdminSession, async (req, res) => {
  try {
    const r = await require('../services/networkQueueService').retryNow(Number(req.params.id));
    req.session._msg = { type: r === 'done' ? 'success' : 'error', text: r === 'done' ? 'Acción aplicada en el MikroTik.' : (r === 'skipped' ? 'El cliente ya no requiere acción de red.' : 'El MikroTik volvió a fallar; se sigue reintentando.') };
  } catch (e) { req.session._msg = { type: 'error', text: e.message }; }
  res.redirect('/admin/automation#red');
});

router.post('/automation/billing-cycle', requireAdminSession, requireMainAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const next = require('../config/billingCycle').sanitize(req.body);
    if (req.body && typeof req.body.corte_payment_info === 'string') next.corte_payment_info = req.body.corte_payment_info.replace(/\r/g, '').trim().slice(0, 1500);
    if (req.body && req.body.cut_debt_notice_enabled !== undefined) {
      next.cut_debt_notice_enabled = req.body.cut_debt_notice_enabled === 'true';
      next.cut_debt_notice_days = Math.min(60, Math.max(1, parseInt(req.body.cut_debt_notice_days, 10) || 7));
      next.cut_debt_notice_hour = Math.min(23, Math.max(0, parseInt(req.body.cut_debt_notice_hour, 10) || 10));
    }
    if (req.body && typeof req.body.cut_debt_message === 'string' && req.body.cut_debt_message.trim()) {
      db.saveAppSetting('whatsapp_cut_debt_message', req.body.cut_debt_message.replace(/\r/g, '').trim().slice(0, 2000));
    }
    saveSettings(next);
    req.session._msg = { type: 'success', text: 'Ciclo de facturación guardado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo guardar el ciclo: ' + e.message };
  }
  res.redirect('/admin/automation#ciclo');
});

router.post('/automation', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const b = req.body || {};
    const truthy = (v) => (v === true || v === 'true' || v === '1' || v === 'on' || v === 1);
    const next = {
      whatsapp_auto_billing_enabled: !!b.enabled,
      whatsapp_billing_to_customer_enabled: !!b.billing_enabled,
      auto_deactivate_enabled: truthy(b.auto_deactivate_enabled),
      auto_delete_overdue_enabled: truthy(b.auto_delete_overdue_enabled),
      arrears_notice_enabled: truthy(b.arrears_notice_enabled),
      autolunas_notify_enabled: truthy(b.autolunas_notify_enabled),
      autolunas_recap_enabled: truthy(b.autolunas_recap_enabled),
    };
    if (b.auto_deactivate_months !== undefined && b.auto_deactivate_months !== '') {
      next.auto_deactivate_months = parseInt(b.auto_deactivate_months) || 3;
    }
    const delay = b.delay ? parseInt(b.delay) : null;
    if (delay != null && Number.isFinite(delay) && delay >= 1 && delay <= 60) next.whatsapp_broadcast_delay = delay;
    if (b.reminder_days_before != null) {
      const rDays = String(b.reminder_days_before).replace(/[^\d,]/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '');
      if (rDays) next.reminder_days_before = rDays;
    }
    if (b.auto_billing_template_key) next.auto_billing_template_key = String(b.auto_billing_template_key).trim();
    const tplKey = String(b.auto_billing_template_key || 'whatsapp_auto_billing_message').trim();
    const allowedKeys = Object.keys(waTemplateDefaults(company()));
    const msgText = typeof b.message === 'string' ? b.message.trim() : '';
    if (msgText && allowedKeys.includes(tplKey)) db.saveAppSetting(tplKey, msgText);
    saveSettings(next);
    req.session._msg = { type: 'success', text: 'Configuración de automatización guardada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo guardar la automatización:' + e.message };
  }
  res.redirect('/admin/automation');
});

router.post('/automation/send-now', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const svc = require('../services/billingSendService');
    const r = await svc.start({
      isolateDay: req.body.isolate_day,
      templateKey: req.body.template_key,
      intervalMode: req.body.interval_mode,
      intervalValue: req.body.interval_value,
      intervalMin: req.body.interval_min,
      intervalMax: req.body.interval_max,
    });
    res.json({ ok: !!r.started, total: r.total || 0, label: r.label || '', message: r.started ? ('Pengiriman dimulai: ' + r.total + ' clientes (' + r.label + ').') : (r.message || 'No hay destinatarios.') });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

router.get('/settings', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  res.render('admin/settings', {
    title: 'Configuración del sistema', company: company(), activePage: 'settings',
    settings, msg: flashMsg(req),
    paymentWebhookUrl
  });
});

router.get('/ewallet-logs', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  const _now = new Date();
  const alMonth = parseInt(req.query.month) || (_now.getMonth() + 1);
  const alYear = parseInt(req.query.year) || _now.getFullYear();
  const alRows = db.prepare(`
    SELECT i.amount, i.period_month, i.period_year, i.paid_at, c.name AS customer_name, c.customer_code
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.paid_by_name = 'Sistema (automático)' AND i.period_month = ? AND i.period_year = ?
    ORDER BY c.name ASC
  `).all(alMonth, alYear);
  const alTotal = alRows.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
  res.render('admin/settings', {
    title: 'Log Notifikasi E-Wallet (Webhook)', company: company(), activePage: 'ewallet_logs',
    settings, msg: flashMsg(req),
    paymentWebhookUrl,
    viewMode: 'ewallet_logs',
    alRows, alTotal, alMonth, alYear
  });
});

router.post('/settings/qris-upload', requireAdminSession, qrisUpload.single('qris_file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer || !f.originalname) throw new Error('Archivo QR no encontrado');

    const ext = String(path.extname(f.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedExt.has(ext) || !allowedMime.has(String(f.mimetype || '').toLowerCase())) {
      throw new Error('Formato no admitido. Usá PNG/JPG/WebP');
    }

    const dir = path.join(__dirname, '../public/uploads/qris');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const name = `qris-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const fullPath = path.join(dir, name);
    fs.writeFileSync(fullPath, f.buffer);

    const url = `/uploads/qris/${name}`;
    let payload = '';
    const payloadFromClient = String(req.body?.qris_payload || '').trim();
    try {
      if (payloadFromClient) {
        payload = payloadFromClient.replace(/[\r\n\t]+/g, '').trim();
      } else {
        payload = await extractQrTextFromImageBuffer(f.buffer);
      }
      if (!payload.startsWith('000201')) payload = '';
    } catch (e) {
      payload = '';
    }

    const ok = saveSettings({ qris_static_qr_url: url, qris_static_enabled: true, ...(payload ? { qris_static_payload: payload } : {}) });
    if (!ok) throw new Error('No se pudo guardar la configuración del QR');

    if (payload) {
      req.session._msg = { type: 'success', text: 'QR subido. El payload se leyó automáticamente.' };
    } else {
      req.session._msg = { type: 'success', text: 'QR subido, pero el payload no se pudo leer automáticamente. Completá el payload a mano.' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo subir el QR:' + (e?.message || e) };
  }
  res.redirect('/admin/settings');
});

router.post('/settings/logo-upload', requireAdminSession, qrisUpload.single('logo_file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer || !f.originalname) throw new Error('Archivo de logo no encontrado');

    const ext = String(path.extname(f.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedExt.has(ext) || !allowedMime.has(String(f.mimetype || '').toLowerCase())) {
      throw new Error('Formato no admitido. Usá PNG/JPG/WebP');
    }

    const dir = path.join(__dirname, '../public/img');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fullPath = path.join(dir, 'logo.png');
    fs.writeFileSync(fullPath, f.buffer);
    let _iconMsg = '';
    try { await require('../services/iconService').generatePwaIcons(f.buffer); _iconMsg = ' Los íconos de la app (192/512/maskable/apple) también se actualizaron.'; }
    catch (e) { try { logger.warn('[Logo] Gagal generate ikon PWA: ' + e.message); } catch (_) {} _iconMsg = ' (Ikon PWA gagal dibuat.)'; }
    try { saveSettings({ logo_version: String(Date.now()) }); } catch (e) {}

    req.session._msg = { type: 'success', text: '¡Logo actualizado!' + _iconMsg };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo subir el logo:' + (e?.message || e) };
  }
  res.redirect('/admin/settings');
});

router.post('/settings/branding/logo/:type', requireAdminSession, qrisUpload.single('logo_file'), async (req, res) => {
  try {
    const type = String(req.params.type || '').toLowerCase();
    const map = {
      portal:  { file: 'logo-portal.png',  key: 'logo_portal',  url: '/img/logo-portal.png' },
      invoice: { file: 'logo-invoice.png', key: 'logo_invoice', url: '/img/logo-invoice.png' },
      pwa:     { file: 'logo-pwa.png',     key: 'logo_pwa',     url: '/img/logo-pwa.png' }
    };
    // Khusus foto hero landing: konversi ke WebP + JPEG (fallback)
    if (type === 'hero') {
      const f0 = req.file;
      if (!f0 || !f0.buffer) throw new Error('Archivo de foto no encontrado');
      const dirH = path.join(__dirname, '../public/img/landing');
      if (!fs.existsSync(dirH)) fs.mkdirSync(dirH, { recursive: true });
      const r = await require('../services/imageOptimize').writeWebpAndJpg(f0.buffer, path.join(dirH, 'server-1600'), { maxWidth: 1600, quality: 82 });
      try { saveSettings({ landing_hero_version: String(Date.now()) }); } catch (e) {}
      req.session._msg = { type: 'success', text: 'Imagen principal actualizada (WebP' + Math.round(r.webp / 1024) + ' KB + JPEG ' + Math.round(r.jpg / 1024) + ' KB).' };
      return res.redirect('/admin/settings');
    }
    const cfg = map[type];
    if (!cfg) throw new Error('Tipo de logo desconocido');
    const f = req.file;
    if (!f || !f.buffer) throw new Error('Archivo de logo no encontrado');
    const ext = String(path.extname(f.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedExt.has(ext) || !allowedMime.has(String(f.mimetype || '').toLowerCase())) throw new Error('Formato no admitido (PNG/JPG/WebP)');

    const dir = path.join(__dirname, '../public/img');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, cfg.file), f.buffer);

    const upd = {}; upd[cfg.key] = cfg.url; upd.logo_version = String(Date.now());
    try { saveSettings(upd); } catch (e) {}

    let extra = '';
    if (type === 'pwa') {
      try { await require('../services/iconService').generatePwaIcons(f.buffer); extra = ' Los íconos de la app (192/512/maskable/apple) se regeneraron.'; }
      catch (e) { extra = ' (No se pudieron crear los íconos de la app.)'; }
    }
    req.session._msg = { type: 'success', text: 'Logo ' + type + ' actualizado.' + extra };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo subir el logo:' + (e && e.message ? e.message : e) };
  }
  res.redirect('/admin/settings');
});

router.post('/settings/regenerate-icons', requireAdminSession, async (req, res) => {
  try {
    const p = path.join(__dirname, '../public/img/logo.png');
    if (!fs.existsSync(p)) return res.json({ ok: false, message: 'Todavía no hay logo. Subí un logo primero.' });
    await require('../services/iconService').generatePwaIcons(fs.readFileSync(p));
    try { saveSettings({ logo_version: String(Date.now()) }); } catch (e) {}
    return res.json({ ok: true, message: 'Íconos de la app creados a partir del logo actual.' });
  } catch (e) { return res.json({ ok: false, message: 'No se pudieron generar los íconos:' + e.message }); }
});

router.get('/update', requireAdminSession, requireSidebarMenuAccess('update'), restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  const info = getUpdateInfo(repoRoot);
  res.render('admin/update', {
    title: 'Update Aplikasi',
    company: company(),
    activePage: 'update',
    msg: flashMsg(req),
    info,
    log: popUpdateLog(req)
  });
});

router.post('/update/run', requireAdminSession, restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  if (!runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot).ok) {
    req.session._msg = { type: 'error', text: 'Instalación en contenedor (sin .git): la actualización se hace reconstruyendo la imagen, no con git.' };
    return res.redirect('/admin/update');
  }
  const log = [];
  const pushCmd = (label, r) => {
    log.push(`$ ${label}`.trim());
    if (r.stdout) log.push(String(r.stdout).trimEnd());
    if (r.stderr) log.push(String(r.stderr).trimEnd());
  };

  const versionPath = path.join(repoRoot, 'version.txt');
  const localBefore = readTextFileSafe(versionPath) || '-';
  const branch = getGitDefaultBranch(repoRoot);
  const backupRoot = path.join(os.tmpdir(), `billing-update-backup-${Date.now()}`);
  const authFolder = String(getSetting('whatsapp_auth_folder', 'auth_info_baileys') || 'auth_info_baileys').trim() || 'auth_info_baileys';
  const preservedEntries = [
    { label: 'settings.json', relativePath: 'settings.json', cleanExclude: 'settings.json' },
    { label: '.env', relativePath: '.env', cleanExclude: '.env' },
    { label: 'database', relativePath: 'database', cleanExclude: 'database' },
    { label: 'public/uploads', relativePath: 'public/uploads', cleanExclude: 'public/uploads' },
    { label: 'public/img', relativePath: 'public/img', cleanExclude: 'public/img' },
    { label: authFolder, relativePath: authFolder, cleanExclude: authFolder.replace(/\\/g, '/') },
    { label: 'data', relativePath: 'data', cleanExclude: 'data' }
  ];
  let repoChanged = false;

  const backupPreservedEntries = () => {
    const backedUp = [];
    for (const entry of preservedEntries) {
      const sourcePath = path.resolve(repoRoot, entry.relativePath);
      const backupPath = path.resolve(backupRoot, entry.relativePath);
      if (!fs.existsSync(sourcePath)) continue;
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        fs.mkdirSync(backupPath, { recursive: true });
        copyDirSync(sourcePath, backupPath);
      } else {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(sourcePath, backupPath);
      }
      backedUp.push(entry.label);
    }
    if (backedUp.length > 0) {
      log.push(`$ backup preserved files: ${backedUp.join(', ')}`);
    }
  };

  const restorePreservedFiles = (stageLabel) => {
    const restored = [];
    for (const entry of preservedEntries) {
      const targetPath = path.resolve(repoRoot, entry.relativePath);
      const backupPath = path.resolve(backupRoot, entry.relativePath);
      if (!fs.existsSync(backupPath)) continue;
      const stat = fs.statSync(backupPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.mkdirSync(targetPath, { recursive: true });
        copyDirSync(backupPath, targetPath);
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(backupPath, targetPath);
      }
      restored.push(entry.label);
    }
    if (restored.length > 0) {
      log.push(`$ restore preserved files (${stageLabel}): ${restored.join(', ')}`);
    }
  };

  try {
    const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
    pushCmd('git rev-parse --is-inside-work-tree', inside);
    if (!inside.ok) throw new Error('Esta carpeta no es un repositorio git.');

    const _repo = String(getSetting('update_repo', 'oxpoe/open-isp') || '').trim();
  info.repo = _repo || 'origin';
  const fetch = _repo
    ? runCmd('git', ['fetch', '--prune', 'https://github.com/' + _repo + '.git', branch], repoRoot)
    : runCmd('git', ['fetch', '--prune'], repoRoot);
    pushCmd('git fetch --prune', fetch);
    if (!fetch.ok) throw new Error('Falló git fetch.');

    const remote = _repo
    ? runCmd('git', ['show', 'FETCH_HEAD:version.txt'], repoRoot)
    : runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
    pushCmd(`git show origin/${branch}:version.txt`, remote);
    if (!remote.ok) throw new Error('No se pudo leer version.txt desde GitHub.');
    const remoteVersion = String(remote.stdout || '').trim() || '-';

    if (remoteVersion !== '-' && remoteVersion === localBefore) {
      req.session._msg = { type: 'success', text: 'Ya tenés la última versión:' + localBefore };
      req.session._updateLog = log.join('\n');
      return res.redirect('/admin/update');
    }

    fs.mkdirSync(backupRoot, { recursive: true });
    backupPreservedEntries();

    const resetSettings = runCmd('git', ['checkout', '--', 'settings.json'], repoRoot);
    pushCmd('git checkout -- settings.json', resetSettings);
    const resetDb = runCmd('git', ['checkout', '--', 'database'], repoRoot);
    pushCmd('git checkout -- database', resetDb);

    const resetHard = runCmd('git', ['reset', '--hard', _repo ? 'FETCH_HEAD' : `origin/${branch}`], repoRoot);
    pushCmd(`git reset --hard origin/${branch}`, resetHard);
    if (!resetHard.ok) throw new Error('No se pudo restablecer a origin/' + branch);
    repoChanged = true;

    if (remoteVersion && remoteVersion !== '-') {
      try {
        fs.writeFileSync(versionPath, remoteVersion + os.EOL, 'utf8');
        log.push(`$ write version.txt = ${remoteVersion}`);
      } catch (e) {
        log.push(`$ write version.txt failed: ${String(e?.message || e)}`);
      }
    }

    const cleanExcludes = ['node_modules', 'package-lock.json', ...preservedEntries.map((entry) => entry.cleanExclude)];
    const cleanArgs = ['clean', '-fd'];
    for (const exclude of cleanExcludes) {
      cleanArgs.push('-e', exclude);
    }
    const clean = runCmd(
      'git',
      cleanArgs,
      repoRoot
    );
    pushCmd(`git ${cleanArgs.join(' ')}`, clean);

    restorePreservedFiles('post-update');

    // Cek apakah package.json berubah sebelum install
    const pkgDiff = runCmd('git', ['diff', 'HEAD@{1}', 'HEAD', '--', 'package.json'], repoRoot);
    const pkgChanged = pkgDiff.ok && String(pkgDiff.stdout || '').trim().length > 0;

    if (pkgChanged) {
      log.push('$ package.json berubah, menjalankan npm install (Low-CPU Mode)...');
      const npm = runCmd('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], repoRoot);
      pushCmd('npm install --omit=dev --no-audit --no-fund --prefer-offline', npm);
      if (!npm.ok) throw new Error('Update berhasil, tetapi npm install gagal.');
    } else {
      log.push('$ package.json no cambió, se omite npm install (ahorra CPU y tiempo).');
    }

    const localAfter = readTextFileSafe(versionPath) || '-';
    req.session._msg = { type: 'success', text: `Update selesai. Versi: ${localBefore} → ${localAfter}. Silakan restart aplikasi.` };
    req.session._updateLog = log.join('\n');
  } catch (e) {
    if (repoChanged) {
      try {
        restorePreservedFiles('error-recovery');
      } catch (restoreErr) {
        log.push(`$ restore preserved files failed: ${String(restoreErr?.message || restoreErr)}`);
      }
    }
    req.session._msg = { type: 'error', text: 'No se pudo actualizar:' + (e?.message || e) };
    req.session._updateLog = log.join('\n');
  } finally {
    try {
      if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
    } catch (e) {}
  }

  return res.redirect('/admin/update');
});

router.post('/api/telegram/sync', requireAdminSession, async (req, res) => {
  try {
    const { initTelegram } = require('../services/telegramBot');
    initTelegram();
    res.json({ success: true, message: 'Bot de Telegram sincronizado.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const newSettings = { ...req.body };
    // Las credenciales del administrador solo se cambian en /admin/account/password
    delete newSettings.admin_password; delete newSettings.admin_password_hash; delete newSettings.admin_username;
    if (newSettings.whatsapp_enabled === 'true') newSettings.whatsapp_enabled = true;
    else if (newSettings.whatsapp_enabled === 'false') newSettings.whatsapp_enabled = false;
    if (newSettings.voucher_enabled === 'true') newSettings.voucher_enabled = true;
    else if (newSettings.voucher_enabled === 'false') newSettings.voucher_enabled = false;

    if (newSettings.qris_static_enabled === 'true') newSettings.qris_static_enabled = true;
    else if (newSettings.qris_static_enabled === 'false') newSettings.qris_static_enabled = false;

    if (newSettings.payment_bank_enabled === 'true') newSettings.payment_bank_enabled = true;
    else if (newSettings.payment_bank_enabled === 'false') newSettings.payment_bank_enabled = false;
    if (newSettings.payment_ewallet_enabled === 'true') newSettings.payment_ewallet_enabled = true;
    else if (newSettings.payment_ewallet_enabled === 'false') newSettings.payment_ewallet_enabled = false;

    if (newSettings.auto_delete_overdue_enabled === 'true') newSettings.auto_delete_overdue_enabled = true;
    else if (newSettings.auto_delete_overdue_enabled === 'false') newSettings.auto_delete_overdue_enabled = false;
    if (newSettings.arrears_notice_enabled === 'true') newSettings.arrears_notice_enabled = true;
    else if (newSettings.arrears_notice_enabled === 'false') newSettings.arrears_notice_enabled = false;

    if (newSettings.webhook_unmatched_notify_enabled === 'true') newSettings.webhook_unmatched_notify_enabled = true;
    else if (newSettings.webhook_unmatched_notify_enabled === 'false') newSettings.webhook_unmatched_notify_enabled = false;
    if (newSettings.autolunas_notify_enabled === 'true') newSettings.autolunas_notify_enabled = true;
    else if (newSettings.autolunas_notify_enabled === 'false') newSettings.autolunas_notify_enabled = false;
    if (newSettings.autolunas_recap_enabled === 'true') newSettings.autolunas_recap_enabled = true;
    else if (newSettings.autolunas_recap_enabled === 'false') newSettings.autolunas_recap_enabled = false;
    
    if (newSettings.tripay_enabled === 'true') newSettings.tripay_enabled = true;
    else if (newSettings.tripay_enabled === 'false') newSettings.tripay_enabled = false;
    
    if (newSettings.midtrans_enabled === 'true') newSettings.midtrans_enabled = true;
    else if (newSettings.midtrans_enabled === 'false') newSettings.midtrans_enabled = false;

    if (newSettings.xendit_enabled === 'true') newSettings.xendit_enabled = true;
    else if (newSettings.xendit_enabled === 'false') newSettings.xendit_enabled = false;

    if (newSettings.duitku_enabled === 'true') newSettings.duitku_enabled = true;
    else if (newSettings.duitku_enabled === 'false') newSettings.duitku_enabled = false;

    if (newSettings.default_gateway) newSettings.default_gateway = newSettings.default_gateway.toLowerCase();

    if (typeof newSettings.whatsapp_admin_numbers === 'string') {
      newSettings.whatsapp_admin_numbers = newSettings.whatsapp_admin_numbers.split(',').map(n => n.trim()).filter(Boolean);
    }
    // whatsapp_tech_numbers removed - now automatically fetched from technicians table
    if (newSettings.server_port) newSettings.server_port = parseInt(newSettings.server_port);
    if (newSettings.mikrotik_port) newSettings.mikrotik_port = parseInt(newSettings.mikrotik_port);
    if (newSettings.whatsapp_broadcast_delay) newSettings.whatsapp_broadcast_delay = parseInt(newSettings.whatsapp_broadcast_delay);
    
    newSettings.login_otp_enabled = (newSettings.login_otp_enabled === 'true');
    newSettings.telegram_enabled = (newSettings.telegram_enabled === 'true');
    newSettings.auto_backup_enabled = (newSettings.auto_backup_enabled === 'true');
    if (newSettings.auto_deactivate_enabled !== undefined) newSettings.auto_deactivate_enabled = (newSettings.auto_deactivate_enabled === 'true');
    if (newSettings.auto_deactivate_months !== undefined) newSettings.auto_deactivate_months = parseInt(newSettings.auto_deactivate_months) || 3;
    newSettings.use_builtin_acs = (newSettings.use_builtin_acs === 'true' || newSettings.use_builtin_acs === true);

    // Multi-Router Mode settings
    if (!newSettings.multi_router_mode) newSettings.multi_router_mode = 'disabled';
    if (newSettings.default_router_id) newSettings.default_router_id = parseInt(newSettings.default_router_id) || null;

    // ✅ NEW: Jika switching dari disabled ke active, auto-assign default router ke pelanggan NULL
    const oldMode = getSetting('multi_router_mode', 'disabled');
    if (oldMode === 'disabled' && newSettings.multi_router_mode === 'active') {
      const defaultRouterId = newSettings.default_router_id;
      if (defaultRouterId && defaultRouterId > 0) {
        // Auto-assign default router to customers with NULL router_id
        const result = db.prepare(
          "UPDATE customers SET router_id = ? WHERE router_id IS NULL AND (pppoe_username != '' OR hotspot_username != '' OR static_ip != '')"
        ).run(defaultRouterId);
        logger.info(`[Settings] Auto-assigned router ${defaultRouterId} to ${result.changes} customers with NULL router_id`);
      } else {
        // Jika tidak ada default router, cari router pertama yang aktif
        const router = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
        if (router) {
          const result = db.prepare(
            "UPDATE customers SET router_id = ? WHERE router_id IS NULL AND (pppoe_username != '' OR hotspot_username != '' OR static_ip != '')"
          ).run(router.id);
          logger.info(`[Settings] Auto-assigned router ${router.id} to ${result.changes} customers with NULL router_id`);
        }
      }
    }

    const success = saveSettings(newSettings);
    if (success) {
      // Re-init services if needed
      if (newSettings.telegram_enabled) {
        require('../services/telegramBot').initTelegram();
      } else {
        require('../services/telegramBot').initTelegram(); // This will stop it if it was running
      }
      req.session._msg = { type: 'success', text: 'Configuración guardada.' };
    } else {
      req.session._msg = { type: 'error', text: 'No se pudo guardar la configuración' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/settings');
});

// ─── BACKUP & RECOVERY ──────────────────────────────────────────────────────
router.get('/payment-unmatched', requireAdminSession, (req, res) => {
  res.redirect('/admin/ewallet-logs');
});

router.post('/payment-unmatched/:id/match', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const notifId = parseInt(req.params.id);
    const invId = parseInt(req.body.invoice_id || req.body.manual_invoice_id);
    if (!invId) throw new Error('Elegí una factura candidata o ingresá el ID de la factura');
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invId);
    if (!inv) throw new Error('Invoice #' + invId + ' no encontrada');
    if (String(inv.status) === 'paid') throw new Error('Invoice #' + invId + ' sudah lunas');
    const note = 'Conciliado A MANO desde la notificación webhook #' + notifId;
    billingSvc.markAsPaid(invId, 'Manual (Webhook)', note, req.session.admin || null);
    try { db.prepare('UPDATE webhook_payment_notifs SET matched_invoice_id = ? WHERE id = ?').run(invId, notifId); } catch (e) {}
    // Aktifkan kembali bila pelanggan isolir & tak ada unpaid
    try {
      const cust = customerSvc.getCustomerById(inv.customer_id);
      if (cust && String(cust.status) === 'suspended') {
        const unpaid = db.prepare("SELECT COUNT(*) c FROM invoices WHERE customer_id = ? AND status='unpaid'").get(inv.customer_id).c;
        if (!unpaid) await customerSvc.activateCustomer(inv.customer_id);
      }
    } catch (e) {}
    req.session._msg = { type: 'success', text: 'Invoice #' + invId + ' marcada como PAGADA y notificación conciliada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo conciliar:' + e.message };
  }
  res.redirect('/admin/payment-unmatched');
});

router.post('/payment-unmatched/:id/dismiss', requireAdminSession, (req, res) => {
  try {
    db.prepare('UPDATE webhook_payment_notifs SET dismissed = 1 WHERE id = ?').run(parseInt(req.params.id));
    req.session._msg = { type: 'success', text: 'Notifikasi diabaikan.' };
  } catch (e) { req.session._msg = { type: 'error', text: e.message }; }
  res.redirect('/admin/payment-unmatched');
});

router.get('/autolunas', requireAdminSession, requireSidebarMenuAccess('payment_unmatched'), (req, res) => {
  res.redirect('/admin/payment-unmatched?tab=autolunas');
});

router.get('/autolunas/export', requireAdminSession, requireSidebarMenuAccess('payment_unmatched'), (req, res) => {
  const now = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year = parseInt(req.query.year) || now.getFullYear();
  const rows = db.prepare(`
    SELECT i.amount, i.period_month, i.period_year, i.paid_at, i.notes, c.name AS customer_name, c.customer_code
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.paid_by_name = 'Sistema (automático)' AND i.period_month = ? AND i.period_year = ?
    ORDER BY c.name ASC
  `).all(month, year);
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['No','Pelanggan','ID de cliente','Periode','Nominal','Fecha de pago','Catatan'].map(esc).join(',')];
  rows.forEach((r, i) => lines.push([i + 1, r.customer_name, r.customer_code || '', r.period_month + '/' + r.period_year, Number(r.amount) || 0, r.paid_at || '', String(r.notes || '').replace('AUTO-LUNAS:', '').trim()].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="rekap-autolunas-' + month + '-' + year + '.csv"');
  res.send('\uFEFF' + lines.join('\n'));
});

router.get('/backup', requireAdminSession, requireSidebarMenuAccess('backup'), (req, res) => {
  const result = backupSvc.listBackups();
  res.render('admin/backup', {
    title: 'Backup & Recovery',
    company: company(),
    activePage: 'backup',
    msg: flashMsg(req),
    backups: result.backups || [],
    total: result.total || 0,
    getSetting
  });
});

router.get('/backup/download/:fileName', requireAdminSession, (req, res) => {
  try {
    const rawFileName = req.params.fileName;
    const fileName = path.basename(rawFileName);
    const backupDir = path.join(__dirname, '../backups');
    const filePath = path.join(backupDir, fileName);

    if (!fs.existsSync(filePath)) {
      req.session._msg = { type: 'error', text: 'Archivo de respaldo no encontrado.' };
      return res.redirect('/admin/backup');
    }

    res.download(filePath, fileName, (err) => {
      if (err && !res.headersSent) {
        logger.error(`[Backup] Error downloading file ${fileName}:`, err);
        req.session._msg = { type: 'error', text: 'No se pudo descargar el respaldo.' };
        res.redirect('/admin/backup');
      }
    });
  } catch (e) {
    logger.error('[Backup] Download error:', e);
    req.session._msg = { type: 'error', text: 'No se pudo descargar el respaldo:' + e.message };
    res.redirect('/admin/backup');
  }
});

router.post('/backup/create', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { type } = req.body;
    let result;

    if (type === 'all') {
      result = backupSvc.backupAll();
    } else if (type === 'database') {
      result = backupSvc.backupDatabase();
    } else if (type === 'settings') {
      result = backupSvc.backupSettings();
    } else {
      req.session._msg = { type: 'error', text: 'Tipo de respaldo inválido' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Respaldo creado: ${result.fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Falló el respaldo: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Error: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/restore', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  let restartNeeded = false;
  try {
    const { fileName, type } = req.body;
    let result;

    if (type === 'database') {
      result = backupSvc.restoreDatabase(fileName);
    } else if (type === 'settings') {
      result = backupSvc.restoreSettings(fileName);
    } else {
      req.session._msg = { type: 'error', text: 'Tipo de restauración inválido' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      if (type === 'database') {
        restartNeeded = true;
        req.session._msg = { type: 'success', text: `Base de datos restaurada: ${fileName}. La aplicación se reinicia automáticamente para aplicarla...` };
      } else {
        req.session._msg = { type: 'success', text: `Restauración completada: ${fileName}` };
      }
    } else {
      req.session._msg = { type: 'error', text: `Falló la restauración: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Error: ${e.message}` };
  }
  res.redirect('/admin/backup');
  // DB di-swap: koneksi lama masih memakai file lama -> muat ulang proses (PM2/Docker restart otomatis)
  if (restartNeeded) setTimeout(() => process.exit(0), 2000);
});

router.post('/backup/upload-restore', requireAdminSession, upload.single('backupFile'), (req, res) => {
  let restartNeeded = false;
  try {
    const file = req.file;
    if (!file || !file.buffer || !file.originalname) {
      throw new Error('Archivo de respaldo no encontrado.');
    }

    const originalName = path.basename(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    const timestamp = Date.now();
    const backupDir = path.join(__dirname, '../backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    let result;
    let savedFileName = '';

    if (ext === '.db' || ext === '.sqlite' || originalName.includes('billing_db')) {
      savedFileName = `uploaded_db_${timestamp}_${originalName}`;
      const savePath = path.join(backupDir, savedFileName);
      fs.writeFileSync(savePath, file.buffer);
      result = backupSvc.restoreDatabase(savedFileName);
      restartNeeded = true;
    } else if (ext === '.json' || originalName.includes('settings')) {
      savedFileName = `uploaded_settings_${timestamp}_${originalName}`;
      const savePath = path.join(backupDir, savedFileName);
      fs.writeFileSync(savePath, file.buffer);

      // Verify JSON validity before restoring settings
      try {
        JSON.parse(file.buffer.toString('utf8'));
      } catch (jsonErr) {
        fs.unlinkSync(savePath);
        throw new Error('El JSON del archivo de configuración no es válido:' + jsonErr.message);
      }

      result = backupSvc.restoreSettings(savedFileName);
    } else {
      throw new Error('Formato no admitido. Subí un archivo .db (base de datos) o .json (configuración).');
    }

    if (result && result.success) {
      req.session._msg = { 
        type: 'success', 
        text: `¡Respaldo "${originalName}" subido y restaurado! Antes se creó un respaldo automático (${result.preRestoreBackup || '-'}).` 
      };
    } else {
      req.session._msg = { type: 'error', text: `Falló la restauración: ${result ? result.error : 'error desconocido'}` };
    }
  } catch (e) {
    logger.error('[Backup] Upload & restore error:', e);
    req.session._msg = { type: 'error', text: 'Falló la subida y restauración:' + e.message };
  }
  res.redirect('/admin/backup');
  if (restartNeeded && result && result.success) setTimeout(() => process.exit(0), 2000);
});

router.post('/backup/delete', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName } = req.body;
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../backups');
    const backupFilePath = path.join(backupDir, fileName);

    if (!fs.existsSync(backupFilePath)) {
      req.session._msg = { type: 'error', text: 'Archivo de respaldo no encontrado' };
      return res.redirect('/admin/backup');
    }

    fs.unlinkSync(backupFilePath);
    logger.info(`[Backup] Backup deleted: ${fileName}`);
    req.session._msg = { type: 'success', text: `Respaldo eliminado: ${fileName}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: `No se pudo eliminar: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/cleanup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { retentionDays } = req.body;
    const result = backupSvc.cleanupOldBackups(parseInt(retentionDays) || 30);

    if (result.success) {
      req.session._msg = { type: 'success', text: `Limpieza terminada: se eliminaron ${result.deletedCount} respaldos antiguos` };
    } else {
      req.session._msg = { type: 'error', text: `Falló la limpieza: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Error: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

// ─── INVENTORY / WAREHOUSE ──────────────────────────────────────────────────
router.get('/inventory', requireAdminSession, requireSidebarMenuAccess('inventory'), (req, res) => {
  const items = inventorySvc.getAllItems(req.query.q);
  const categories = inventorySvc.getAllCategories();
  const logs = inventorySvc.getInventoryLogs(100);

  res.render('admin/inventory', {
    title: 'Manajemen Inventaris',
    company: company(),
    activePage: 'inventory',
    msg: flashMsg(req),
    items,
    categories,
    logs
  });
});

router.post('/inventory/category/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createCategory(req.body);
    req.session._msg = { type: 'success', text: 'Categoría agregada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/category/delete/:id', requireAdminSession, (req, res) => {
  try {
    inventorySvc.deleteCategory(req.params.id);
    req.session._msg = { type: 'success', text: 'Categoría eliminada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createItem(req.body);
    req.session._msg = { type: 'success', text: 'Artículo agregado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/edit/:id', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.updateItem(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Artículo actualizado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/stock/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.addStock(req.body, req.session.adminUser || 'Admin');
    req.session._msg = { type: 'success', text: 'Stock agregado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.get('/audit-logs', requireAdminSession, requireSidebarMenuAccess('audit_logs'), restrictToAdmin, (req, res) => {
  const filters = {
    action: req.query.action || null,
    entity_type: req.query.entity_type || null,
    limit: 100
  };
  const logs = auditSvc.getAuditTrail(filters);
  const stats = auditSvc.getAuditStats();

  res.render('admin/audit_logs', {
    title: 'Audit Trail / Log Aktivitas',
    company: company(),
    activePage: 'audit_logs',
    logs,
    stats,
    filters
  });
});

// ─── MONITORING ──────────────────────────────────────────────────────────────
router.get('/monitoring', requireAdminSession, requireSidebarMenuAccess('monitoring'), restrictToAdmin, async (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  const performanceSummary = monitoringSvc.getPerformanceSummary();
  const dependencies = await diagnosticsSvc.checkDependencies();
  const recentErrors = diagnosticsSvc.getRecentErrors(10);
  const settings = getSettings(); // Get current settings

  res.render('admin/monitoring', {
      title: 'Monitoreo del sistema',
      company: company(),
      activePage: 'monitoring',
      healthStatus,
      performanceSummary,
      dependencies,
      recentErrors,
      settings // Pass settings to view
    });
});

router.get('/api/health', requireAdmin, (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  res.json(healthStatus);
});

router.get('/api/metrics', requireAdmin, (req, res) => {
  const metrics = monitoringSvc.getAllMetrics();
  res.json(metrics);
});

router.get('/api/metrics/history', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const history = monitoringSvc.getMetricsHistory(limit);
  res.json(history);
});

// ─── GENIEACS SETTINGS API ──────────────────────────────────────────────────
router.post('/api/genieacs/settings', requireAdmin, async (req, res) => {
  try {
    const { genieacs_timeout, genieacs_rxpower_threshold, genieacs_monitoring_interval, genieacs_monitoring_enabled } = req.body;
    
    // Validate input
    if (genieacs_timeout < 5000 || genieacs_timeout > 120000) {
      return res.json({ success: false, message: 'El tiempo de espera debe estar entre 5000 y 120000 ms' });
    }
    if (genieacs_rxpower_threshold < -40 || genieacs_rxpower_threshold > -15) {
      return res.json({ success: false, message: 'El umbral de potencia RX debe estar entre -40 y -15 dBm' });
    }
    if (genieacs_monitoring_interval < 1 || genieacs_monitoring_interval > 24) {
      return res.json({ success: false, message: 'El intervalo de monitoreo debe estar entre 1 y 24 horas' });
    }

    // Update settings
    const currentSettings = getSettings();
    currentSettings.genieacs_timeout = parseInt(genieacs_timeout);
    currentSettings.genieacs_rxpower_threshold = parseFloat(genieacs_rxpower_threshold);
    currentSettings.genieacs_monitoring_interval = parseInt(genieacs_monitoring_interval);
    currentSettings.genieacs_monitoring_enabled = Boolean(genieacs_monitoring_enabled);

    // Save to file
    const fs = require('fs');
    const path = require('path');
    const settingsPath = require('../config/paths').settingsPath;
    fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');

    // Log audit
    try {
      if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
        auditSvc.logAuditTrail({
          action: 'UPDATE',
          entity_type: 'genieacs_settings',
          entity_id: 'settings.json',
          actor_type: req.session.isAdmin ? 'admin' : 'cashier',
          actor_id: req.session.adminUser || req.session.cashierUsername || 'admin',
          actor_name: req.session.adminUser || req.session.cashierName || 'Admin',
          details: {
            timeout: genieacs_timeout,
            rxpower_threshold: genieacs_rxpower_threshold,
            monitoring_interval: genieacs_monitoring_interval,
            monitoring_enabled: genieacs_monitoring_enabled
          },
          ip_address: req.ip || req.connection.remoteAddress,
          user_agent: req.headers['user-agent']
        });
      } else {
        logger.warn('[API] auditSvc.logAuditTrail is not available');
      }
    } catch (auditError) {
      logger.error('[API] Error logging audit trail:', auditError);
    }

    res.json({ 
      success: true, 
      message: 'Configuración de GenieACS guardada. Reiniciá la aplicación para aplicar el nuevo tiempo de espera.' 
    });
  } catch (error) {
    logger.error('[API] Error saving GenieACS settings:', error);
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

router.get('/api/genieacs/test', requireAdmin, async (req, res) => {
  try {
    const genieacs = require('../config/genieacs');
    const devices = await genieacs.getDevices();
    
    res.json({ 
      success: true, 
      message: '¡Conexión con GenieACS correcta!',
      deviceCount: devices.length
    });
  } catch (error) {
    logger.error('[API] Error testing GenieACS connection:', error);
    res.json({ 
      success: false, 
      message: 'Falló la conexión:' + error.message 
    });
  }
});

// ─── API ROUTES (existing) ──────────────────────────────────────────────────
// ONUs leídas de la(s) OLT, con el mismo formato que los equipos de GenieACS.
// Se usan cuando GenieACS no está configurado o no devuelve equipos.
async function oltOnuDevices() {
  const oltSvc = require('../services/oltService');
  const olts = (oltSvc.getActiveOlts ? oltSvc.getActiveOlts() : []) || [];
  const custs = db.prepare('SELECT id, name, pppoe_username, pppoe_remote_address FROM customers').all();
  const byId = new Map(custs.map(c => [c.id, c]));
  const out = [];
  let weak = 0;
  for (const o of olts) {
    const s = await oltSvc.getOltStats(o.id, true);
    if (!s || s.error || !Array.isArray(s.onus)) continue;
    weak += Number(s.onus_weak || 0);
    for (const u of s.onus) {
      const c = u.customer_id ? byId.get(u.customer_id) : null;
      const isOn = String(u.status).toLowerCase() === 'online';
      const m = /\((\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\)/.exec(u.offline_reason || '');
      out.push({
        id: String(u.id), tags: [c ? c.name : u.name], serialNumber: String(u.sn || '-'),
        lastInform: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null, lastInformLabel: '-', lastInformAgo: '-',
        lastSync: null, lastSyncLabel: 'OLT', lastSyncAgo: '-', syncInProgress: false, syncPendingCount: 0,
        syncStatusLabel: (o.name || 'OLT') + ' · ' + u.id,
        status: isOn ? 'online' : 'offline',
        pppoeIP: c && c.pppoe_remote_address ? c.pppoe_remote_address : '-',
        pppoeUsername: c && c.pppoe_username ? c.pppoe_username : u.name,
        rxPower: String(u.rx || '-'), uptime: String(u.uptime || '-'), model: String(u.firmware || '-'),
        softwareVersion: u.distance && u.distance !== '-' ? 'Distancia ' + u.distance : '-',
        userConnected: '-', ssid: '-', note: isOn ? '' : (u.offline_reason || ''),
        acs_server_id: 'olt', acs_server_name: o.name || 'OLT', source: 'olt',
      });
    }
  }
  return { devices: out, weak };
}

router.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const result = await customerDevice.listAllDevices(999999);
    if (!result.ok || !result.devices || !result.devices.length) {
      const od = await oltOnuDevices();
      if (od.devices.length || !result.ok) {
        const online = od.devices.filter(d => d.status === 'online').length;
        return res.json({ total: od.devices.length, online, offline: od.devices.length - online, warning: od.weak, source: 'olt', lastUpdate: getNowLocalISO() });
      }
    }
    const mikrotikService = require('../services/mikrotikService');
    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());

    const devices = result.devices;
    const total = devices.length;
    let online = 0, offline = 0;

    devices.forEach(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive) || {};
      const status = String(mapped.status || 'offline').toLowerCase();
      if (status === 'online') online++;
      else offline++;
    });

    res.json({ total, online, offline, warning: 0, lastUpdate: getNowLocalISO() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get stats', detail: e.message });
  }
});

router.get('/api/devices', requireAdmin, async (req, res) => {
  try {
    const { search, status, limit = 999999, offset = 0 } = req.query;
    const result = await customerDevice.listAllDevices(999999);
    if (!result.ok || !result.devices || !result.devices.length) {
      const od = await oltOnuDevices();
      if (od.devices.length || !result.ok) {
        let devs = od.devices;
        if (search) { const s = String(search).toLowerCase(); devs = devs.filter(d => [d.id, d.serialNumber, d.pppoeUsername, d.pppoeIP, ...(d.tags || [])].some(v => String(v || '').toLowerCase().includes(s))); }
        if (status && status !== 'all') devs = devs.filter(d => d.status === String(status).toLowerCase());
        return res.json({ devices: devs, total: od.devices.length, source: 'olt' });
      }
    }
    const mikrotikService = require('../services/mikrotikService');
    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());

    let devices = result.devices.map(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive) || {};
      const tagsArr = Array.isArray(d._tags) ? d._tags.filter(Boolean).map(String) : [];
      return {
        id: String(d._id || ''),
        tags: tagsArr,
        serialNumber: String(mapped.serialNumber || '-'),
        lastInform: d._lastInform,
        lastInformLabel: String(mapped.lastInform || '-'),
        lastInformAgo: String(mapped.lastInformAgo || '-'),
        lastSync: d._updatedAt || mapped.lastSyncRaw || d._lastInform || '',
        lastSyncLabel: String(mapped.lastSync || '-'),
        lastSyncAgo: String(mapped.lastSyncAgo || '-'),
        syncInProgress: !!mapped.syncInProgress,
        syncPendingCount: Number(mapped.syncPendingCount || 0),
        syncStatusLabel: String(mapped.syncStatusLabel || 'Idle'),
        status: String(mapped.status || 'unknown').toLowerCase(),
        pppoeIP: String(mapped.pppoeIP || '-'),
        pppoeUsername: String(mapped.pppoeUsername || '-'),
        rxPower: String(mapped.rxPower || '-'),
        uptime: String(mapped.uptime || '-'),
        model: String(mapped.model || '-'),
        softwareVersion: String(mapped.softwareVersion || '-'),
        userConnected: mapped.totalAssociations ?? '-',
        ssid: String(mapped.ssid || '-'),
        acs_server_id: d._acs_server_id || 'legacy',
        acs_server_name: d._acs_server_name || 'Default ACS'
      };
    });
    if (search) { 
      const s = search.toLowerCase();
      const billingCustomers = customerSvc.getAllCustomers(s);
      const matchingTags = new Set(billingCustomers.map(c => c.genieacs_tag?.toLowerCase()).filter(Boolean));
      const matchingPppoes = new Set(billingCustomers.map(c => c.pppoe_username?.toLowerCase()).filter(Boolean));

      devices = devices.filter(d => 
        String(d.id || '').toLowerCase().includes(s) ||
        (Array.isArray(d.tags) && d.tags.some(t => String(t || '').toLowerCase().includes(s) || matchingTags.has(String(t || '').toLowerCase()))) || 
        String(d.serialNumber || '').toLowerCase().includes(s) || 
        String(d.pppoeIP || '').toLowerCase().includes(s) ||
        (String(d.pppoeUsername || '') !== 'N/A' && String(d.pppoeUsername || '').toLowerCase().includes(s)) ||
        matchingPppoes.has(String(d.pppoeUsername || '').toLowerCase())
      ); 
    }
    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    const total = devices.length;
    const paginated = devices.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    res.json({ devices: paginated, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get devices', detail: e.message });
  }
});

router.get('/api/device/:tag', requireAdmin, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireAdmin, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = getNowLocal();
        const msg = `📶 *CAMBIO DE NOMBRE DEL WIFI*\n\n` +
          `👤 *Cliente:* ${cust.name}\n` +
          `🕒 *Fecha:* ${now}\n\n` +
          `El nombre (SSID) de su WiFi ahora es:\n` +
          `📡 *${ssid}*\n\n` +
          `Seleccione la nueva red en sus dispositivos para conectarse.\n` +
          `⚠️ No comparta esta información.`;
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif SSID via WA: ' + (e.message || e)); }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireAdmin, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = getNowLocal();
        const msg = `🔑 *CAMBIO DE CONTRASEÑA DEL WIFI*\n\n` +
          `👤 *Cliente:* ${cust.name}\n` +
          `🕒 *Fecha:* ${now}\n\n` +
          `La contraseña de su WiFi ahora es:\n` +
          `🔐 *${password}*\n\n` +
          `Use la nueva contraseña para conectarse.\n` +
          `⚠️ No comparta esta contraseña.`;
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif Password via WA: ' + (e.message || e)); }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireAdmin, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

router.post('/api/bulk/ssid', requireAdmin, express.json(), async (req, res) => {
  const { tags, ssid } = req.body;
  if (!Array.isArray(tags) || !ssid) return res.status(400).json({ error: 'Tags and SSID required' });
  const results = [];
  for (const tag of tags) {
    try {
      const success = await customerDevice.updateSSID(tag, ssid);
      results.push({ tag, success });
      // Kirim notifikasi WhatsApp ke pelanggan
      if (success) {
        try {
          const cust = customerSvc.findCustomerByAny(tag);
          if (cust && cust.phone) {
            const now = getNowLocal();
            const msg = `📶 *CAMBIO DE NOMBRE DEL WIFI*\n\n` +
              `👤 *Cliente:* ${cust.name}\n` +
              `🕒 *Fecha:* ${now}\n\n` +
              `El nombre (SSID) de su WiFi ahora es:\n` +
              `📡 *${ssid}*\n\n` +
              `Seleccione la nueva red en sus dispositivos para conectarse.\n` +
              `⚠️ No comparta esta información.`;
            await trySendWhatsappPayment(cust.phone, msg);
          }
        } catch (e) { /* ignore per-customer WA notification errors */ }
      }
    }
    catch (e) { results.push({ tag, success: false, error: e.message }); }
  }
  res.json({ results, total: tags.length, success: results.filter(r => r.success).length });
});

router.get('/api/mikrotik/queue-types', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getQueueTypes(req.query.routerId || null)); } catch (e) { res.json([]); }
});
router.get('/api/mikrotik/queue-parents', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getQueueParents(req.query.routerId || null)); } catch (e) { res.json([]); }
});
router.get('/api/mikrotik/profiles', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.query.routerId);
    res.json(profiles);
  } catch (e) {
        if (/not configured|belum dikonfigurasi|settings not/i.test(String(e.message || ''))) return res.json([]);
        if (/not configured|belum dikonfigurasi|settings not/i.test(String(e.message || ''))) return res.json([]);
        if (/not configured|belum dikonfigurasi|settings not/i.test(String(e.message || ''))) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
        if (/not configured|belum dikonfigurasi|settings not/i.test(String(e.message || ''))) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ─── MIKROTIK MONITORING ───────────────────────────────────────────────────
router.get('/mikrotik', requireAdminSession, requireSidebarMenuAccess('mikrotik'), (req, res) => {
  const dbRouters = mikrotikService.getAllRouters();
  const settings = getSettings();
  const settingsRouter = {
    id: '',
    name: settings.mikrotik_host ? `MikroTik (settings.json - ${settings.mikrotik_host})` : 'MikroTik (settings.json)',
    host: settings.mikrotik_host || '',
    user: settings.mikrotik_user || '',
    port: settings.mikrotik_port || 8728,
    is_active: true
  };
  
  const routers = dbRouters.length > 0 ? dbRouters : [settingsRouter];
  const activeRouterId = req.selectedRouterId || (routers[0] ? routers[0].id : '');

  res.render('admin/mikrotik', {
    title: 'Monitoring MikroTik', company: company(), activePage: 'mikrotik',
    routers, activeRouterId, selectedRouterId: req.selectedRouterId, msg: flashMsg(req)
  });
});

router.get('/mikrotik/display', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  const settings = getSettings();
  const defaultRouter = {
    id: 'settings_json',
    name: 'MikroTik (settings.json)',
    host: settings.mikrotik_host || '',
    user: settings.mikrotik_user || '',
    port: settings.mikrotik_port || 8728,
    is_active: true
  };
  
  const allRouters = (Array.isArray(routers) && routers.length) ? [...routers, defaultRouter] : [defaultRouter];

  res.render('admin/mikrotik_display', {
    title: 'MikroTik NOC Display',
    company: company(),
    routers: allRouters,
    msg: flashMsg(req),
    settings
  });
});

router.get('/vouchers', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  res.render('admin/vouchers', {
    title: 'Manajemen Voucher', company: company(), activePage: 'mikrotik',
    routers, selectedRouterId, msg: flashMsg(req), settings: getSettings()
  });
});

router.get('/api/vouchers/template', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.json({
    use_template: !!settings.voucher_print_use_template,
    default_style: String(settings.voucher_print_default_style || ''),
    header: String(settings.voucher_print_template_header || ''),
    row: String(settings.voucher_print_template_row || ''),
    footer: String(settings.voucher_print_template_footer || '')
  });
});

router.post('/api/vouchers/template', requireAdminSession, restrictToAdmin, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const useTemplate = !!req.body.use_template;
    const defaultStyle = String(req.body.default_style || '').trim().toLowerCase();
    const header = String(req.body.header || '');
    const row = String(req.body.row || '');
    const footer = String(req.body.footer || '');
    saveSettings({
      voucher_print_use_template: useTemplate,
      voucher_print_default_style: defaultStyle,
      voucher_print_template_header: header,
      voucher_print_template_row: row,
      voucher_print_template_footer: footer
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/webhook/payment-notif/logs', requireAdminSession, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const service = String(req.query.service || '').trim();
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];
    if (service) {
      where.push('service = ?');
      params.push(service);
    }
    if (q) {
      where.push('(content LIKE ? OR service LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT id, created_at, service, content, parsed_amount, parsed_ok, matched_invoice_id, matched_voucher_order_id, matched_donation_order_id, ip
      FROM webhook_payment_notifs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit);

    // Convert created_at to local timezone
    const rowsWithLocalTime = rows.map(row => ({
      ...row,
      created_at: row.created_at ? formatDateLocal(row.created_at, 'YYYY-MM-DD HH:mm:ss') : null
    }));

    res.json({ ok: true, rows: rowsWithLocalTime });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhook/payment-notif/clear', requireAdminSession, restrictToAdmin, express.json(), (req, res) => {
  try {
    db.prepare('DELETE FROM webhook_payment_notifs').run();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/vouchers/batches/:id/print', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Lote no encontrado');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const settings = getSettings();
  const requestedStyle = String(req.query.style || '').trim().toLowerCase();
  const style = requestedStyle || String(settings.voucher_print_default_style || '').trim().toLowerCase() || (settings.voucher_print_use_template ? 'template' : 'cards');

  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const stripUnsafe = (html) => {
    let out = String(html || '');
    out = out.replace(/<\?(?:php)?[\s\S]*?\?>/gi, '');
    out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    out = out.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
    return out;
  };

  const applyVars = (tpl, vars) => {
    let out = String(tpl || '');
    out = out.replace(/%([a-zA-Z0-9_#]+)%/g, (m, k) => (vars[k] != null ? vars[k] : m));
    out = out.replace(/\{\{\s*([a-zA-Z0-9_#]+)\s*\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return out;
  };

  const formatValidity = (v) => {
    if (!v) return '-';
    const s = String(v).trim();
    const mDay = s.match(/^(\d+)\s*d$/i);
    if (mDay) return `${Number(mDay[1])} días`;
    return s;
  };

  let renderedHtml = '';
  let templateError = '';
  const builtinTemplate = (name) => {
    const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
      ? ('+' + String(settings.whatsapp_admin_numbers[0]))
      : String(settings.company_phone || '');
    const companyName = settings.company_header || company();
    const timeStamp = new Date().toISOString();
    const priceNumber = Number(batch.price || 0);
    const priceText = priceNumber.toLocaleString(regional.locale());
    const validityText = formatValidity(batch.validity);

    const rows = (vouchers || []).map((v, i) => {
      const credential = (String(v.code) === String(v.password))
        ? escapeHtml(String(v.code))
        : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
      return {
        idx: i + 1,
        username: escapeHtml(v.code),
        password: escapeHtml(v.password),
        credential,
        profile: escapeHtml(batch.profile_name || v.profile_name || ''),
        company: escapeHtml(companyName),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: regional.currencySymbol(),
        price: escapeHtml(String(priceNumber)),
        priceText: escapeHtml(priceText),
        validity: escapeHtml(batch.validity || ''),
        validityText: escapeHtml(validityText),
      };
    });

    if (name === 'mks') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.v-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.vc{border:1px solid #0f172a;border-radius:10px;min-height:110px;padding:8px;position:relative;break-inside:avoid;overflow:hidden}
.vc:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,rgba(59,130,246,.03),rgba(16,185,129,.025))}
.vc>*{position:relative}
.vh{font-weight:900;font-size:11px;letter-spacing:.2px}
.vp{position:absolute;top:8px;right:8px;font-size:10.5px;font-weight:800;background:rgba(16,185,129,.16);border:1px solid rgba(16,185,129,.35);padding:2px 7px;border-radius:999px}
.vm{font-size:10px;color:#334155;margin-top:6px}
.vu{font-weight:950;font-size:18px;letter-spacing:1px;margin-top:8px;font-family:Consolas,monospace;line-height:1.15}
.vf{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="vc">
  <div class="vh">${r.company}</div>
  <div class="vp">${r.currency} ${r.priceText}</div>
  <div class="vm">${r.profile} • ${r.validityText}</div>
  <div class="vu">${r.credential}</div>
  <div class="vf">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="v-grid">\n${html}\n</div>`;
    }

    if (name === 'simple') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.card{border:1.5px solid #334155;border-radius:10px;padding:8px 8px 22px;min-height:110px;position:relative;break-inside:avoid}
.hd{font-weight:800;font-size:11px}
.code{font-weight:900;font-size:22px;letter-spacing:2px;margin-top:6px;font-family:Consolas,monospace}
.meta{font-size:10px;color:#334155;margin-top:4px}
.wa{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="card">
  <div class="hd">${r.company}</div>
  <div class="meta">${r.profile} • ${r.validityText} • ${r.currency} ${r.priceText}</div>
  <div class="code">${r.username}</div>
  <div class="meta">${r.password}</div>
  <div class="wa">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="grid">\n${html}\n</div>`;
    }

    if (name === 'minimal') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.c{border:1px dashed #334155;border-radius:8px;padding:6px 6px 18px;min-height:84px;position:relative;break-inside:avoid}
.t{font-weight:900;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m{font-size:9.5px;color:#334155;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{font-weight:950;font-size:18px;letter-spacing:2px;margin-top:8px;font-family:Consolas,monospace}
.w{position:absolute;left:6px;right:6px;bottom:5px;font-size:9px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>`;
      const html = rows.map(r => `<div class="c">
  <div class="t">${r.company}</div>
  <div class="m">${r.profile}</div>
  <div class="k">${r.username}</div>
  <div class="w">${r.validityText} • ${r.currency} ${r.priceText} • ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="g">\n${html}\n</div>`;
    }

    return '';
  };

  if (style === 'mks' || style === 'simple' || style === 'minimal') {
    renderedHtml = builtinTemplate(style);
  } else if (style === 'template') {
    const headerTpl = String(settings.voucher_print_template_header || '');
    const rowTpl = String(settings.voucher_print_template_row || '');
    const footerTpl = String(settings.voucher_print_template_footer || '');

    if (rowTpl.trim()) {
      const looksLikePhpOnly = (tpl) => {
        const s = String(tpl || '');
        const hasHtml = /<\s*[a-zA-Z][^>]*>/.test(s);
        const phpSignals = /(\$[a-zA-Z_])|(\bif\s*\()|(\bsubstr\s*\()|(\bstrlen\s*\()|(\belse(if)?\b)|(\bforeach\b)/.test(s);
        const manyPhp = (s.match(/\$/g) || []).length >= 3;
        return !hasHtml && (phpSignals || manyPhp);
      };
      const combined = `${headerTpl}\n${rowTpl}\n${footerTpl}`;
      if (/<\?(?:php)?/i.test(combined) || looksLikePhpOnly(combined)) {
        templateError = 'La plantilla pegada todavía está en formato PHP (Mikhmon). Aquí solo se admiten plantillas HTML con marcadores (%username%, etc.).';
      }

      const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
        ? ('+' + String(settings.whatsapp_admin_numbers[0]))
        : String(settings.company_phone || '');
      const timeStamp = new Date().toISOString();
      const priceNumber = Number(batch.price || 0);
      const priceText = priceNumber.toLocaleString(regional.locale());
      const validityText = formatValidity(batch.validity);

      const parts = [];
      parts.push(stripUnsafe(applyVars(headerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: regional.currencySymbol(),
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      vouchers.forEach((v, i) => {
        const credential = (String(v.code) === String(v.password))
          ? escapeHtml(String(v.code))
          : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
        const vars = {
          username: escapeHtml(v.code),
          password: escapeHtml(v.password),
          profile: escapeHtml(batch.profile_name || v.profile_name || ''),
          validity: escapeHtml(batch.validity || ''),
          validityText: escapeHtml(validityText),
          price: escapeHtml(String(priceNumber)),
          priceText: escapeHtml(priceText),
          currency: regional.currencySymbol(),
          company: escapeHtml(settings.company_header || company()),
          phone: escapeHtml(phone),
          timeStamp: escapeHtml(timeStamp),
          '#': escapeHtml(String(i + 1)),
          credential
        };
        parts.push(stripUnsafe(applyVars(rowTpl, vars)));
      });

      parts.push(stripUnsafe(applyVars(footerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: regional.currencySymbol(),
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      renderedHtml = parts.join('\n');
    }
  }

  let finalStyle = style;
  if (finalStyle === 'template') {
    const s = String(renderedHtml || '').trim();
    if (!s || !/<\s*[a-zA-Z][^>]*>/.test(s) || templateError) {
      renderedHtml = '';
      finalStyle = 'cards';
    }
  }

  res.render('admin/print_vouchers', {
    title: 'Imprimir fichas',
    company: company(),
    settings,
    batch,
    vouchers,
    style: finalStyle,
    renderedHtml,
    templateError
  });
});

router.get('/vouchers/batches/:id/pdf', requireAdminSession, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare(`SELECT b.*, r.name AS router_name FROM voucher_batches b LEFT JOIN routers r ON r.id = b.router_id WHERE b.id = ?`).get(batchId);
    if (!batch) return res.status(404).send('Lote no encontrado');
    const vouchers = db.prepare('SELECT code, password, profile_name, used_at FROM vouchers WHERE batch_id = ? ORDER BY code ASC').all(batchId);
    const pdf = await require('../services/voucherPdfService').generateVoucherBatchPdfBuffer(batch, vouchers, getSettings());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Voucher_Batch_' + batchId + '.pdf"');
    res.send(pdf);
  } catch (e) { res.status(500).send('No se pudo crear el PDF:' + e.message); }
});

router.get('/vouchers/batches/:id/export.csv', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Lote no encontrado');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const lines = [];
  lines.push(['code', 'password', 'profile', 'validity', 'price', 'router', 'batch_id', 'created_at', 'used_at'].join(','));
  const createdAt = batch.created_at || '';
  const validity = batch.validity || '';
  const price = Number(batch.price || 0);
  const routerName = batch.router_name || '';
  for (const v of vouchers) {
    const row = [
      v.code,
      v.password,
      v.profile_name,
      validity,
      price,
      routerName,
      batchId,
      createdAt,
      v.used_at || ''
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=vouchers_batch_${batchId}.csv`);
  res.send(lines.join('\n'));
});

router.get('/api/vouchers/batches', requireAdmin, (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const rows = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE (? IS NULL OR b.router_id = ?)
    ORDER BY b.id DESC
    LIMIT 200
  `).all(routerId, routerId);
  res.json(rows);
});

router.get('/api/vouchers/batches/:id', requireAdmin, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).json({ error: 'Lote no encontrado' });

  const vouchers = db.prepare(`
    SELECT id, code, password, profile_name, status, used_at, last_seen_comment, last_seen_uptime, last_seen_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
    LIMIT 2000
  `).all(batchId);
  res.json({ batch, vouchers });
});

router.post('/api/vouchers/batches', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profileName = String(req.body.profile || '').trim();
    const qty = Math.max(1, Math.min(5000, Number(req.body.qty) || 0));
    const prefix = String(req.body.prefix || '').trim();
    const codeLength = Math.max(4, Math.min(16, Number(req.body.codeLength) || 6));
    const mode = String(req.body.mode || 'voucher');
    const charset = String(req.body.charset || 'numbers');
    const priceInput = req.body.price;
    
    if (!profileName) return res.status(400).json({ error: 'El perfil es obligatorio' });
    if (!qty) return res.status(400).json({ error: 'La cantidad de fichas es obligatoria' });
    if (prefix.length >= codeLength) return res.status(400).json({ error: 'Prefix terlalu panjang' });

    const profiles = await mikrotikService.getHotspotUserProfiles(routerId);
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) return res.status(400).json({ error: 'No se encontró el perfil hotspot en el MikroTik' });

    const meta = parseMikhmonOnLogin(profile.onLogin || profile['on-login']);
    if (!meta || !meta.validity) return res.status(400).json({ error: 'El perfil no tiene datos de precio/duración (formato Mikhmon)' });

    const createdBy = req.session?.isAdmin ? (req.session.adminUser || 'admin') : (req.session.cashierName || 'kasir');
    let price = Number(meta.price || 0);
    if (priceInput !== undefined && priceInput !== null && String(priceInput).trim() !== '') {
      const p = Number(priceInput);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Precio inválido' });
      price = Math.floor(p);
    }

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const defaultComment = `vc-${createdBy}-${dd}.${mm}.${yy}`;
    const comment = String(req.body.comment || defaultComment).trim();

    const insertBatch = db.prepare(`
      INSERT INTO voucher_batches (router_id, profile_name, qty_total, qty_created, qty_failed, price, validity, prefix, code_length, status, created_by, mode, charset)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 'creating', ?, ?, ?)
    `);
    const batchRes = insertBatch.run(routerId, profileName, qty, price, meta.validity || '', prefix, codeLength, createdBy, mode, charset);
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);

    const exists = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');
    const codes = new Set();
    const makeCode = () => {
      const coreLen = Math.max(4, Math.min(16, codeLength - prefix.length));
      const userCode = prefix + genCode(coreLen, charset);
      let passCode = userCode;
      if (mode === 'member') {
        passCode = genCode(coreLen, charset);
      }
      return { userCode, passCode };
    };

    const initialVouchers = [];
    while (initialVouchers.length < qty) {
      const generated = makeCode();
      if (codes.has(generated.userCode)) continue;
      if (exists.get(routerId, generated.userCode)) continue;
      codes.add(generated.userCode);
      initialVouchers.push(generated);
    }

    const tx = db.transaction((items) => {
      for (const c of items) {
        insertVoucher.run(batchId, routerId, c.userCode, c.passCode, profileName, comment);
      }
    });
    tx(initialVouchers);

    setImmediate(() => {
      createVoucherBatchAsync(batchId).catch(e => logger.error('[VoucherBatch] Error: ' + (e?.message || e)));
    });

    res.json({ success: true, batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/sync', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Lote no encontrado' });

    const routerId = batch.router_id ?? null;
    const users = await mikrotikService.getHotspotUsers(routerId);
    const byName = new Map();
    for (const u of users) {
      if (u?.name) byName.set(String(u.name), u);
    }

    const list = db.prepare('SELECT id, code, used_at FROM vouchers WHERE batch_id = ?').all(batchId);
    const updSeen = db.prepare("UPDATE vouchers SET last_seen_comment=?, last_seen_uptime=?, last_seen_at=(NOW_LOCAL()) WHERE id=?");
    const markUsed = db.prepare("UPDATE vouchers SET used_at=(NOW_LOCAL()), status='used', last_seen_comment=?, last_seen_uptime=?, last_seen_at=(NOW_LOCAL()) WHERE id=?");
    const markMissing = db.prepare("UPDATE vouchers SET status='missing', last_seen_at=(NOW_LOCAL()) WHERE id=?");

    let usedNew = 0;
    let missing = 0;

    const tx = db.transaction(() => {
      for (const v of list) {
        const u = byName.get(String(v.code));
        if (!u) {
          markMissing.run(v.id);
          missing++;
          continue;
        }
        const comment = String(u.comment || '');
        const uptime = String(u.uptime || '');
        const isUsedByComment = comment && !comment.toLowerCase().startsWith('vc') && !comment.toLowerCase().startsWith('up');
        const isUsedByUptime = uptime && uptime !== '0s' && uptime !== '0' && uptime !== '00:00:00';
        const usedNow = isUsedByComment || isUsedByUptime;
        if (usedNow && !v.used_at) {
          markUsed.run(comment, uptime, v.id);
          usedNew++;
        } else {
          updSeen.run(comment, uptime, v.id);
        }
      }
    });
    tx();

    res.json({ success: true, usedNew, missing, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/delete', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    if (!batchId) return res.status(400).json({ error: 'ID de lote inválido' });

    const batch = db.prepare('SELECT id, status FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Lote no encontrado' });
    if (String(batch.status) === 'creating') {
      return res.status(400).json({ error: 'El lote se está procesando. Esperá a que termine.' });
    }

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ?) AS total,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ? AND v.used_at IS NOT NULL) AS used
    `).get(batchId, batchId);

    const del = db.prepare('DELETE FROM voucher_batches WHERE id = ?');
    del.run(batchId);

    res.json({ success: true, deletedBatchId: batchId, deletedVouchers: stats?.total || 0, usedCount: stats?.used || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/secrets', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeSecrets(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeSecret(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeSecret(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeSecret(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-users', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotUsers(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUser(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUser(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUser(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/monitoring-display-data', requireAdmin, async (req, res) => {
  const routerId = req.query.routerId ? (req.query.routerId === 'null' || req.query.routerId === 'settings' || req.query.routerId === 'settings_json' ? 'settings_json' : Number(req.query.routerId)) : 'settings_json';
  try {
    const conn = await mikrotikService.getConnection(routerId);
    if (!conn) {
      return res.status(500).json({ error: 'No se pudo conectar con el router MikroTik.' });
    }

    // Parallel execution for performance
    const [
      resource,
      interfaces,
      activePppoe,
      secrets,
      activeHotspot,
      hotspotUsers
    ] = await Promise.all([
      // 1. Resources
      mikrotikService.getSystemResource(routerId).catch(err => {
        logger.error('[NOC Display] Error resource:', err.message);
        return null;
      }),
      // 2. Interfaces
      conn.client.menu('/interface').get().catch(err => {
        logger.error('[NOC Display] Error interfaces:', err.message);
        return [];
      }),
      // 3. Active PPPoE
      mikrotikService.getPppoeActive(routerId).catch(err => {
        logger.error('[NOC Display] Error active PPPoE:', err.message);
        return [];
      }),
      // 4. PPPoE Secrets
      mikrotikService.getPppoeSecrets(routerId).catch(err => {
        logger.error('[NOC Display] Error secrets:', err.message);
        return [];
      }),
      // 5. Active Hotspot
      mikrotikService.getHotspotActive(routerId).catch(err => {
        logger.error('[NOC Display] Error active Hotspot:', err.message);
        return [];
      }),
      // 6. Hotspot Users
      mikrotikService.getHotspotUsers(routerId).catch(err => {
        logger.error('[NOC Display] Error hotspot users:', err.message);
        return [];
      })
    ]);

    // Calculate PPPoE Offline
    const activePppoeNames = new Set((activePppoe || []).map(s => String(s.name).trim()));
    const offlinePppoe = (secrets || []).filter(s => {
      const isOnline = activePppoeNames.has(String(s.name).trim());
      const isDisabled = s.disabled === true || s.disabled === 'true';
      return !isOnline && !isDisabled;
    });

    // Format resources
    const resData = {
      cpu: resource ? String(resource['cpu-load'] || resource.cpuLoad || resource['cpu'] || '0') : '0',
      freeMemory: resource ? Number(resource['free-memory'] || resource.freeMemory) || 0 : 0,
      totalMemory: resource ? Number(resource['total-memory'] || resource.totalMemory) || 0 : 0,
      uptime: resource ? String(resource['uptime'] || '00:00:00') : '00:00:00',
      boardName: resource ? String(resource['board-name'] || resource.boardName || 'MikroTik') : 'MikroTik',
      version: resource ? String(resource['version'] || 'N/A') : 'N/A'
    };

    // Format interfaces (only return fields needed)
    const formattedInterfaces = (interfaces || []).map(i => {
      return {
        name: i.name,
        type: i.type,
        running: i.running === true || i.running === 'true' || i.running === 'yes',
        disabled: i.disabled === true || i.disabled === 'true' || i.disabled === 'yes',
        bytesIn: Number(i['rx-byte'] || i['rx-bytes'] || i['bytes-in']) || 0,
        bytesOut: Number(i['tx-byte'] || i['tx-bytes'] || i['bytes-out']) || 0
      };
    });

    res.json({
      ok: true,
      resources: resData,
      interfaces: formattedInterfaces,
      pppoe: {
        active: activePppoe ? activePppoe.length : 0,
        offline: offlinePppoe ? offlinePppoe.length : 0,
        total: secrets ? secrets.length : 0
      },
      hotspot: {
        active: activeHotspot ? activeHotspot.length : 0,
        total: hotspotUsers ? hotspotUsers.length : 0
      },
      timestamp: Date.now()
    });
  } catch (e) {
    logger.error('[NOC Display API] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/hotspot-profiles', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotProfiles(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-pppoe', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-hotspot', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/ip-pools', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getIpPools(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// PPPoE Profiles CRUD
router.post('/api/mikrotik/pppoe-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotspot User Profiles CRUD
router.get('/api/mikrotik/hotspot-user-profiles', requireAdmin, async (req, res) => {
  try {
    const rows = await mikrotikService.getHotspotUserProfiles(req.query.routerId);
    res.json((Array.isArray(rows) ? rows : []).map((r) => ({ ...r, id: r.id || r['.id'] })));
  } catch (e) {
        if (/not configured|belum dikonfigurasi|settings not/i.test(String(e.message || ''))) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});
router.get('/api/mikrotik/hotspot-user-profiles/:id', requireAdmin, async (req, res) => {
  try {
    const row = await mikrotikService.getHotspotUserProfileById(req.params.id, req.query.routerId);
    if (!row) return res.status(404).json({ error: 'Perfil no encontrado' });
    return res.json({ ok: true, row });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
router.post('/api/mikrotik/hotspot-user-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUserProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUserProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUserProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await mikrotikService.getBackup(req.query.routerId);
    res.setHeader('Content-disposition', 'attachment; filename=mikrotik_backup_' + new Date().toISOString().slice(0,10) + '.rsc');
    res.setHeader('Content-type', 'text/plain');
    res.send(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
// Global Broadcast Tracker
global.broadcastStatus = {
  active: false,
  total: 0,
  sent: 0,
  failed: 0,
  startTime: null,
  paused: false,
  stopped: false,
  currentBatch: 0,
  messagesPerHour: 0,
  hourlyLimit: 100
};

// Helper: Random delay generator untuk smart rate limiting
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Message variation untuk menghindari spam detection
function addMessageVariation(message, index) {
  const variations = [
    '',
    '\n\n_',
    '\n\n•',
    '\n\n▪',
    '\n\n▫'
  ];
  const suffix = variations[index % variations.length];
  return message + suffix;
}

// Helper: Cek apakah waktu aman untuk broadcast (hindari jam sibuk)
function isSafeTimeToBroadcast() {
  const now = new Date();
  const hour = now.getHours();
  // Hindari jam 00:00 - 06:00 (jam malam) dan jam 18:00 - 21:00 (jam sibuk)
  return hour >= 8 && hour <= 17;
}

// Helper: Hitung delay berdasarkan jam (lebih lama di jam sibuk)
function getTimeBasedDelay(baseDelayMs) {
  const now = new Date();
  const hour = now.getHours();
  
  // Jam sibuk (18:00 - 21:00): delay 2x lebih lama
  if (hour >= 18 && hour <= 21) {
    return baseDelayMs * 2;
  }
  
  // Jam malam (00:00 - 06:00): delay 3x lebih lama
  if (hour >= 0 && hour <= 6) {
    return baseDelayMs * 3;
  }
  
  // Jam normal: delay normal
  return baseDelayMs;
}

// Helper: Cek duplicate message untuk menghindari spam
function isDuplicateMessage(phone, message, messageHistory) {
  const key = `${phone}_${message.substring(0, 50)}`;
  const lastSent = messageHistory.get(key);
  if (!lastSent) return false;
  
  const timeDiff = Date.now() - lastSent;
  return timeDiff < 3600000; // 1 jam
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Helper: Cek apakah error adalah temporary (bisa retry)
function isTemporaryError(errorMessage) {
  const temporaryErrorPatterns = [
    /timeout/i,
    /network/i,
    /connection/i,
    /rate.*limit/i,
    /too.*many/i,
    /429/i,
    /500/i,
    /502/i,
    /503/i,
    /504/i
  ];
  
  return temporaryErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Global message history untuk duplicate detection
global.broadcastMessageHistory = new Map();

const waSvc = require('../services/whatsappService');

router.get('/whatsapp/gowa/qr', requireAdminSession, async (req, res) => {
  try {
    const gowa = require('../services/gowaWhatsappService');
    const dev = await gowa.ensureDevice();
    if (dev && dev !== getSetting('gowa_device_id', '')) saveSettings({ gowa_device_id: dev });
    const r = await gowa.getLoginQr(dev);
    if (!r.ok) return res.json({ ok: false, message: 'No se pudo crear el QR (' + (r.code || 'pastikan GOWA berjalan') + ').' });
    return res.json({ ok: true, image: '/admin/whatsapp/gowa/qr.png?v=' + Date.now(), device_id: r.device_id, duration: r.duration });
  } catch (e) { return res.json({ ok: false, message: e.message }); }
});

router.get('/whatsapp/gowa/qr.png', requireAdminSession, async (req, res) => {
  try {
    const img = await require('../services/gowaWhatsappService').getLastQrImage();
    if (!img) return res.status(404).end();
    res.set('Content-Type', img.contentType);
    res.set('Cache-Control', 'no-store');
    return res.send(img.buffer);
  } catch (e) { return res.status(500).end(); }
});

router.get('/whatsapp', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const waGatewayType = getSetting('wa_gateway_type', 'gowa');
  const metaSettings = {
    meta_phone_number_id: getSetting('meta_phone_number_id', ''),
    meta_waba_id: getSetting('meta_waba_id', ''),
    meta_access_token: getSetting('meta_access_token', ''),
    meta_verify_token: getSetting('meta_verify_token', 'antigravity_meta_wa_secret'),
    meta_business_phone: getSetting('meta_business_phone', '')
  };
  const fonnteSettings = {
    fonnte_token: getSetting('fonnte_token', ''),
    fonnte_api_url: getSetting('fonnte_api_url', 'https://api.fonnte.com/send'),
    fonnte_country_code: getSetting('fonnte_country_code', regional.phoneCountryCode())
  };
  const gowaSettings = {
    gowa_base_url: getSetting('gowa_base_url', 'http://127.0.0.1:3000'),
    gowa_username: getSetting('gowa_username', ''),
    gowa_password: getSetting('gowa_password', ''),
    gowa_device_id: getSetting('gowa_device_id', ''),
    gowa_webhook_secret: getSetting('gowa_webhook_secret', 'secret')
  };
  const gowaWebhookUrl = String(getSetting('app_url', '') || ((req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'))).replace(/\/+$/, '') + '/api/webhook/gowa';
  const gowaUiHost = String(req.get('host') || '').split(':')[0];
  const gowaUiUrl = String(getSetting('gowa_base_url', '') || getSetting('gowa_ui_url', '') || (gowaUiHost ? ('https://gowa.' + gowaUiHost) : 'http://127.0.0.1:3000')).replace(/\/+$/, '');

  res.render('admin/whatsapp', {
    title: 'Status WhatsApp',
    company: company(),
    activePage: 'whatsapp',
    msg: flashMsg(req),
    waGatewayType,
    metaSettings,
    fonnteSettings,
    gowaSettings,
    gowaWebhookUrl,
    gowaUiUrl,
    host: req.get('host') || 'localhost:3001'
  });
});

router.post('/whatsapp/gateway-settings', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const {
      wa_gateway_type,
      meta_phone_number_id,
      meta_waba_id,
      meta_access_token,
      meta_verify_token,
      meta_business_phone,
      fonnte_token,
      fonnte_api_url,
      fonnte_country_code,
      gowa_base_url,
      gowa_username,
      gowa_password,
      gowa_device_id,
      gowa_webhook_secret
    } = req.body;

    saveSettings({
      wa_gateway_type: wa_gateway_type || 'baileys',
      meta_phone_number_id: String(meta_phone_number_id || '').trim(),
      meta_waba_id: String(meta_waba_id || '').trim(),
      meta_access_token: String(meta_access_token || '').trim(),
      meta_verify_token: String(meta_verify_token || '').trim() || 'antigravity_meta_wa_secret',
      meta_business_phone: String(meta_business_phone || '').trim(),
      fonnte_token: String(fonnte_token || '').trim(),
      fonnte_api_url: String(fonnte_api_url || 'https://api.fonnte.com/send').trim(),
      fonnte_country_code: String(fonnte_country_code || regional.phoneCountryCode()).trim(),
      gowa_base_url: String(gowa_base_url || 'http://127.0.0.1:3000').trim(),
      gowa_username: String(gowa_username || '').trim(),
      gowa_password: String(gowa_password || '').trim(),
      gowa_device_id: String(gowa_device_id || '').trim(),
      gowa_webhook_secret: String(gowa_webhook_secret || 'secret').trim()
    });

    if ((wa_gateway_type || 'baileys') === 'baileys') {
      import('../services/whatsappBot.mjs').then(m => m.startWhatsAppBot()).catch(e => {
        logger.error('Failed to start Baileys bot on gateway change: ' + e.message);
      });
    }

    req.session._msg = { type: 'success', text: 'Configuración del gateway de WhatsApp (Baileys / Fonnte / Meta) guardada.' };
  } catch (e) {
    req.session._msg = { type: 'danger', text: 'No se pudo guardar la configuración:' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/test-gowa', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'El número de destino es obligatorio.' });
    const gowaSvc = require('../services/gowaWhatsappService');
    const result = await gowaSvc.testGowaConnection(phone, message);
    res.json({ success: true, message: '¡Mensaje enviado vía GOWA!', data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/whatsapp/test-fonnte', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'El número de destino es obligatorio.' });

    const fonnteSvc = require('../services/fonnteWhatsappService');
    const result = await fonnteSvc.testFonnteConnection(phone, message);
    res.json({ success: true, message: '¡Mensaje enviado vía Fonnte!', data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// LIVE CHAT ROUTES
router.get('/whatsapp/live-chat', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const waGatewayType = getSetting('wa_gateway_type', 'gowa');
  const customers = customerSvc.getAllCustomers();
  res.render('admin/whatsapp_live_chat', {
    title: 'Live Chat WhatsApp',
    company: company(),
    activePage: 'whatsapp',
    msg: flashMsg(req),
    gatewayType: waGatewayType,
    customers: customers || []
  });
});

router.get('/api/whatsapp/conversations', requireAdminSession, (req, res) => {
  try {
    const list = waSvc.getRecentConversations(50);
    res.json({ ok: true, conversations: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/whatsapp/messages', requireAdminSession, (req, res) => {
  try {
    const phone = req.query.phone || '';
    const list = waSvc.getChatHistory(phone, 100);
    res.json({ ok: true, messages: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/whatsapp/send-direct', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, error: 'El número y el mensaje no pueden quedar vacíos' });

    await waSvc.sendWhatsAppMessage(phone, message);
    res.json({ success: true, message: 'Mensaje de WhatsApp enviado' });
  } catch (e) {
    const errorText = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
    res.status(500).json({ success: false, error: errorText });
  }
});

router.get('/whatsapp/templates', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const comp = company();
  const defaultAutoBilling = `Estimado/a {{nama}},\n\nLe recordamos que su factura de internet está por vencer.\n\n📦 *Plan:* {{paket}}\n💰 *Monto:* {{moneda}} {{tagihan}}\n📅 *Período:* {{rincian}}\n\nPor favor, realice su pago antes de la fecha de corte. Detalle: {{link}}\n\n¡Gracias!\nSaludos,\n${comp}`;
  
  const defaultQris = `{Hola|Buenas}, *{{nama}}* 👋\n\nLe enviamos el detalle de su factura:\n\n📦 *Plan:* {{paket}}\n📅 *Período:* {{periode}}\n💰 *Monto:* {{moneda}} {{qris_nominal}}\n\n{{qris_qr}}\n\n¡Gracias!`;

  const defaultSuccess = whatsappService.DEFAULT_PAYMENT_SUCCESS_TEMPLATE;

  const defaultIsolir = "{Hola|Buenas}, *{{nama}}*\n\nLe informamos que su servicio de internet fue *suspendido* porque tiene facturas pendientes:\n\n• ID de cliente: *{{id_pelanggan}}*\n• Plan: {{paket}}\n• Total adeudado: *{{moneda}} {{tagihan}}*\n\nAl registrar su pago, el servicio se rehabilita automáticamente.\nDetalle de su deuda: {{link}}\n\nSi ya pagó o necesita ayuda, responda a este mensaje.\n— {{company}}";

  const defaultAutolunas = '✅ *Factura saldada*\n\nEstimado/a *{{nama}}* (ID: {{id_pelanggan}}),\n\nSu factura del período {{rincian}} quedó registrada como *PAGADA*.\n\n💵 Monto: *{{moneda}} {{tagihan}}*\n\n¡Gracias!\n— {{company}}';
  const defaultDeactivated = '⚠️ *Servicio dado de baja*\n\nEstimado/a *{{nama}}* (ID: {{id_pelanggan}}),\n\nSu servicio de internet fue *dado de baja* por registrar *{{bulan_nunggak}} meses* sin pagar.\n\n💵 Total adeudado: *{{moneda}} {{tagihan}}*\n\nPara regularizar su situación, comuníquese con nosotros.\nDetalle de su deuda: {{link}}\n— {{company}}';
  const defaultDeleted = 'Estimado/a *{{nama}}*,\n\nSu cuenta de internet fue *eliminada* por registrar *{{bulan_nunggak}} meses* sin pagar.\n\nSi desea volver a contratar el servicio, deberá solicitar una nueva instalación.\n— {{company}}';
  const defaultArrears = "*Aviso de deuda*\n\nEstimado/a *{{nama}}* (ID: {{id_pelanggan}}),\n\nLe informamos que su servicio de internet registra *{{bulan_nunggak}} mes(es)* sin pagar.\n\n📦 Plan: {{paket}}\n💰 Total adeudado: {{moneda}} {{tagihan}}\n📅 Período: {{rincian}}\n\nSi la deuda llega a {{batas}} meses, el servicio será dado de baja y para volver a conectarse deberá solicitar una nueva instalación.\n\nDetalle de su deuda: {{link}}\nAnte cualquier consulta, estamos a su disposición.\n— {{company}}";

  const templates = {
    whatsapp_auto_billing_message: db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBilling),
    whatsapp_billing_qris_message: db.getAppSetting('whatsapp_billing_qris_message', defaultQris),
    whatsapp_payment_success_message: db.getAppSetting('whatsapp_payment_success_message', defaultSuccess),
    whatsapp_isolir_message: db.getAppSetting('whatsapp_isolir_message', defaultIsolir),
    whatsapp_arrears_warning_message: db.getAppSetting('whatsapp_arrears_warning_message', defaultArrears),
    whatsapp_autolunas_message: db.getAppSetting('whatsapp_autolunas_message', defaultAutolunas),
    whatsapp_deactivated_message: db.getAppSetting('whatsapp_deactivated_message', defaultDeactivated),
    whatsapp_deleted_message: db.getAppSetting('whatsapp_deleted_message', defaultDeleted)
  };

  res.render('admin/whatsapp_templates', {
    title: 'Plantillas de WhatsApp',
    company: comp,
    activePage: 'whatsapp',
    msg: flashMsg(req),
    templates
  });
});

router.post('/whatsapp/templates', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const {
      whatsapp_auto_billing_message,
      whatsapp_billing_qris_message,
      whatsapp_payment_success_message,
      whatsapp_isolir_message,
      whatsapp_arrears_warning_message,
      whatsapp_autolunas_message,
      whatsapp_deactivated_message,
      whatsapp_deleted_message
    } = req.body;

    db.saveAppSetting('whatsapp_auto_billing_message', whatsapp_auto_billing_message || '');
    db.saveAppSetting('whatsapp_billing_qris_message', whatsapp_billing_qris_message || '');
    db.saveAppSetting('whatsapp_payment_success_message', whatsapp_payment_success_message || '');
    db.saveAppSetting('whatsapp_isolir_message', whatsapp_isolir_message || '');
    db.saveAppSetting('whatsapp_arrears_warning_message', whatsapp_arrears_warning_message || '');
    db.saveAppSetting('whatsapp_autolunas_message', whatsapp_autolunas_message || '');
    db.saveAppSetting('whatsapp_deactivated_message', whatsapp_deactivated_message || '');
    db.saveAppSetting('whatsapp_deleted_message', whatsapp_deleted_message || '');

    req.session._msg = { type: 'success', text: 'Plantillas de WhatsApp guardadas.' };
  } catch (e) {
    req.session._msg = { type: 'danger', text: 'No se pudo guardar la plantilla:' + e.message };
  }
  res.redirect('/admin/whatsapp/templates');
});

function buildWaPreviewMessages() {
  const comp = company();
  const base = (getSetting('app_url', '') || getSetting('public_base_url', '') || 'http://localhost:3001').replace(/\/+$/, '');
  const nowTxt = new Date().toLocaleString(regional.locale(), { timeZone: getSetting('timezone', 'America/Asuncion') });
  const sample = { nama: 'Juan Pérez', id: 'ISP-12345', paket: 'PLAN180MB', tagihan: '250.000', periode: '10/2026', link: base + '/customer', otp: '482913', ssid: 'WiFi-JuanPerez', password: 'clave-wifi-2026', waktu: nowTxt, bulan: '3', batas: '3' };
  const rv = (t) => regional.applyPlaceholders(String(t || ''))
    .replace(/{{nama}}/gi, sample.nama).replace(/{{id_pelanggan}}/gi, sample.id).replace(/{{paket}}/gi, sample.paket)
    .replace(/{{tagihan}}/gi, sample.tagihan).replace(/{{total}}/gi, sample.tagihan).replace(/{{qris_nominal}}/gi, sample.tagihan)
    .replace(/{{rincian}}/gi, sample.periode).replace(/{{periode}}/gi, sample.periode).replace(/{{bulan_nunggak}}/gi, sample.bulan).replace(/{{batas}}/gi, sample.batas)
    .replace(/{{link}}/gi, sample.link).replace(/{{link_portal}}/gi, sample.link).replace(/{{link_pdf}}/gi, sample.link + '/invoice/1001/pdf')
    .replace(/{{company}}/gi, comp).replace(/{{company_phone}}/gi, '-').replace(/{{no_invoice}}/gi, '1001')
    .replace(/{{waktu}}/gi, sample.waktu).replace(/{{tanggal}}/gi, sample.waktu).replace(/{{metode}}/gi, 'QRIS')
    .replace(/{{username}}/gi, 'budi_pppoe').replace(/{{pppoe}}/gi, 'budi_pppoe').replace(/{{otp}}/gi, sample.otp);
  const g = (k, def) => db.getAppSetting(k, def) || def;
  const messages = [
    { title: 'Recordatorio de pago (automático, X días antes)', key: 'whatsapp_auto_billing_message', text: rv(g('whatsapp_auto_billing_message', 'Estimado/a {{nama}}, factura de {{moneda}} {{tagihan}} del período {{rincian}}. Detalle: {{link}}')) },
    { title: 'Factura con QR (con imagen)', key: 'whatsapp_billing_qris_message', text: rv(g('whatsapp_billing_qris_message', 'Estimado/a {{nama}}, factura de {{moneda}} {{tagihan}} del período {{rincian}}. QR adjunto.')) + '\n\n[imagen QR dinámica]' },
    { title: 'Comprobante de pago', key: 'whatsapp_payment_success_message', text: rv(g('whatsapp_payment_success_message', 'PAGO RECIBIDO\n\nEstimado/a {{nama}}, recibimos el pago de la factura del período {{periode}} por {{moneda}} {{total}}.\n\nFactura N.º: {{no_invoice}}\nForma de pago: {{metode}}\nFecha: {{waktu}}\n\nFactura PDF: {{link_pdf}}\nGracias.')) },
    { title: 'Aviso de corte', key: 'whatsapp_isolir_message', text: rv(g('whatsapp_isolir_message', 'Su servicio de internet fue suspendido porque la factura de {{moneda}} {{tagihan}} no está pagada.')) },
    { title: 'Aviso de deuda', key: 'whatsapp_arrears_warning_message', text: rv(g('whatsapp_arrears_warning_message', 'Factura de {{moneda}} {{tagihan}} con {{bulan_nunggak}} meses de atraso.')) },
    { title: 'Pago automático (monto 0 / sin corte automático)', key: 'whatsapp_autolunas_message', text: rv(g('whatsapp_autolunas_message', 'Factura saldada automáticamente.')) },
    { title: 'Baja automática (N meses de deuda)', key: 'whatsapp_deactivated_message', text: rv(g('whatsapp_deactivated_message', 'Servicio dado de baja.')) },
    { title: 'Eliminación automática (mes N)', key: 'whatsapp_deleted_message', text: rv(g('whatsapp_deleted_message', 'Cuenta eliminada.')) },
    { title: 'Código de ingreso (OTP)', key: '(mensaje del sistema)', text: 'Su código de ingreso es: *' + sample.otp + '*\n\nVálido por 10 minutos. No comparta este código con nadie.', note: 'Mensaje del sistema (código) — se envía al ingresar.' },
    { title: 'Cambio de nombre del WiFi (SSID)', key: '(mensaje del sistema)', text: 'CAMBIO DE NOMBRE DEL WIFI\n\nCliente:' + sample.nama + '\nFecha: ' + sample.waktu + '\n\nEl nombre (SSID) de su WiFi ahora es:\n*' + sample.ssid + '*\n\nSeleccione la nueva red en sus dispositivos para conectarse.', note: 'Mensaje del sistema — cuando el cliente cambia el nombre del WiFi.' },
    { title: 'Cambio de contraseña del WiFi', key: '(mensaje del sistema)', text: 'CAMBIO DE CONTRASEÑA DEL WIFI\n\nCliente:' + sample.nama + '\nFecha: ' + sample.waktu + '\n\nLa contraseña de su WiFi ahora es:\n*' + sample.password + '*\n\nUse la nueva contraseña para conectarse.', note: 'Mensaje del sistema — cuando el cliente cambia la contraseña del WiFi.' }
  ];
  return { messages, sample };
}

router.get('/whatsapp/preview', requireAdminSession, requireSidebarMenuAccess('whatsapp'), (req, res) => {
  const { messages, sample } = buildWaPreviewMessages();
  res.render('admin/whatsapp_preview', { title: 'Vista previa de mensajes de WhatsApp', company: company(), activePage: 'whatsapp', msg: flashMsg(req), messages, sample });
});

router.post('/whatsapp/preview/send', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const idx = parseInt(req.body.index, 10);
    const { messages } = buildWaPreviewMessages();
    const m = messages[idx];
    if (!m) throw new Error('Mensaje no encontrado');
    const waNotify = require('../services/waNotifyService');
    const txt = '[CONTOH] ' + m.title + '\n\n' + m.text;
    const r = await waNotify.notifyAdmin(txt);
    return res.json({ ok: true, message: 'Contoh "' + m.title + '" enviado al WhatsApp del administrador (enviados=' + ((r && r.sent) || 0) + ').' });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.get('/whatsapp/broadcast', requireAdminSession, requireSidebarMenuAccess('whatsapp'), (req, res) => {
  const comp = company();
  const defaultAutoBillingMsg =
    `Estimado/a {{nama}},\n\n` +
    `Le recordamos que su factura de internet está por vencer.\n\n` +
    `📦 *Plan:* {{paket}}\n` +
    `💰 *Monto:* {{moneda}} {{tagihan}}\n` +
    `📅 *Período:* {{rincian}}\n\n` +
    `Por favor, realice su pago antes de la fecha de corte. Detalle: {{link}}\n\n` +
    `¡Gracias!\n` +
    `Saludos,\n${comp}`;
  const autoBillingMsg = db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBillingMsg);

  const _bsvc = require('../services/billingSendService');
  res.render('admin/broadcast', {
    title: 'Broadcast WhatsApp', company: comp, activePage: 'whatsapp', msg: flashMsg(req),
    broadcastStatus: global.broadcastStatus, getSetting, autoBillingMsg,
    isolateDays: db.prepare("SELECT DISTINCT COALESCE(isolate_day,0) d FROM customers WHERE package_id IS NOT NULL AND COALESCE(isolate_day,0)>0 ORDER BY d").all().map(function (x) { return x.d; }),
    billingSendStatus: _bsvc.getStatus(),
    billingTemplates: _bsvc.TEMPLATE_LABELS
  });
});

router.post('/whatsapp/send-billing-now', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const svc = require('../services/billingSendService');
    const r = await svc.start({
      isolateDay: req.body.isolate_day,
      templateKey: req.body.template_key,
      intervalMode: req.body.interval_mode,
      intervalValue: req.body.interval_value,
      intervalMin: req.body.interval_min,
      intervalMax: req.body.interval_max,
    });
    req.session._msg = r.started
      ? { type: 'success', text: 'Envío de facturas iniciado:' + r.total + ' clientes (' + r.label + '). Seguí el progreso en esta página.' }
      : { type: 'error', text: r.message || 'No hay destinatarios.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.get('/api/whatsapp/billing-send-status', requireAdminSession, (req, res) => {
  res.json(require('../services/billingSendService').getStatus());
});

router.post('/api/whatsapp/billing-send-stop', requireAdminSession, (req, res) => {
  res.json({ ok: true, status: require('../services/billingSendService').stop() });
});

router.get('/api/whatsapp/broadcast-status', requireAdminSession, (req, res) => {
  res.json(global.broadcastStatus);
});

// API: Pause Broadcast
router.post('/api/whatsapp/broadcast-pause', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'No hay ninguna difusión en curso.' });
  }
  global.broadcastStatus.paused = true;
  logger.info('[Broadcast] Broadcast dipause oleh admin.');
  res.json({ ok: true, message: 'Difusión pausada.' });
});

// API: Resume Broadcast
router.post('/api/whatsapp/broadcast-resume', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'No hay ninguna difusión en curso.' });
  }
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dilanjutkan oleh admin.');
  res.json({ ok: true, message: 'Difusión reanudada.' });
});

// API: Stop Broadcast
router.post('/api/whatsapp/broadcast-stop', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'No hay ninguna difusión en curso.' });
  }
  global.broadcastStatus.stopped = true;
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
  res.json({ ok: true, message: 'Difusión detenida.' });
});

router.post('/whatsapp/broadcast', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { target, message, delay: customDelay, batchSize: customBatchSize, hourlyLimit: customHourlyLimit } = req.body;
    if (!message) throw new Error('El mensaje no puede quedar vacío');
    
    // Smart Rate Limit Settings
    const baseDelayMs = (parseInt(customDelay) || getSetting('whatsapp_broadcast_delay', 5)) * 1000; // Default 5 detik
    const batchSize = parseInt(customBatchSize) || 15; // Default 15 pesan per batch (lebih aman)
    const batchPauseMs = 120000; // Pause 2 menit setelah setiap batch (lebih aman)
    const hourlyLimit = parseInt(customHourlyLimit) || 80; // Default 80 pesan per jam (lebih aman)
    
    if (customDelay) {
      const v = parseInt(customDelay);
      if (Number.isFinite(v) && v >= 1 && v <= 60) {
        saveSettings({ whatsapp_broadcast_delay: v });
      }
    }

    if (global.broadcastStatus.active) {
      throw new Error('Ya hay una difusión en curso. Esperá a que termine.');
    }

    let customers = [];
    const allCust = customerSvc.getAllCustomers();
    
    if (target === 'all') {
      customers = allCust;
    } else if (target === 'active') {
      customers = allCust.filter(c => c.status === 'active');
    } else if (target === 'suspended') {
      customers = allCust.filter(c => c.status === 'suspended');
    } else if (target === 'unpaid') {
      customers = allCust.filter(c => c.unpaid_count > 0);
    }

    // Ambil pelanggan unik berdasarkan nomor HP
    const uniqueCustomers = [];
    const seenPhones = new Set();
    for (const c of customers) {
      if (c.phone && c.phone.length > 8 && !seenPhones.has(c.phone)) {
        uniqueCustomers.push(c);
        seenPhones.add(c.phone);
      }
    }

    if (uniqueCustomers.length === 0) {
      throw new Error('No hay números de clientes válidos para ese grupo.');
    }
    
    // Initialize Tracker dengan Smart Rate Limit
    global.broadcastStatus = {
      active: true,
      total: uniqueCustomers.length,
      sent: 0,
      failed: 0,
      startTime: new Date(),
      paused: false,
      stopped: false,
      currentBatch: 0,
      messagesPerHour: 0,
      hourlyLimit: hourlyLimit
    };

    const sendMessageAsync = async () => {
      let batchCount = 0;
      let windowStartTime = Date.now();
      let messagesInCurrentHour = 0;

      for (let i = 0; i < uniqueCustomers.length; i++) {
        if (global.broadcastStatus.stopped) {
          logger.info('[Broadcast] Dihentikan oleh admin.');
          break;
        }

        while (global.broadcastStatus.paused) {
          await new Promise(r => setTimeout(r, 1000));
          if (global.broadcastStatus.stopped) break;
        }
        if (global.broadcastStatus.stopped) break;

        // Rate Limiting: Cek batas per jam
        const now = Date.now();
        if (now - windowStartTime >= 3600000) {
          windowStartTime = now;
          messagesInCurrentHour = 0;
          global.broadcastStatus.messagesPerHour = 0;
        }

        if (messagesInCurrentHour >= hourlyLimit) {
          const waitTimeMs = 3600000 - (now - windowStartTime);
          logger.info(`[Broadcast] Batas per jam tercapai (${hourlyLimit} pesan). Menunggu ${Math.ceil(waitTimeMs / 60000)} menit...`);
          await new Promise(r => setTimeout(r, waitTimeMs));
          windowStartTime = Date.now();
          messagesInCurrentHour = 0;
          global.broadcastStatus.messagesPerHour = 0;
        }

        const cust = uniqueCustomers[i];
        let attemptCount = 0;
        const maxAttempts = 3;

        while (attemptCount < maxAttempts) {
          try {
            // Smart Random Delay
            const randomDelay = getRandomDelay(baseDelayMs, 2000);
            await new Promise(r => setTimeout(r, randomDelay));

            // Format Pesan dengan Spintax
            let formattedMsg = message.replace(/{{nama}}/gi, cust.name || 'Pelanggan');
            formattedMsg = formattedMsg.replace(/{{id_pelanggan}}/gi, cust.customer_code || '-');
            formattedMsg = formattedMsg.replace(/{{username}}/gi, cust.pppoe_username || '-');
            formattedMsg = formattedMsg.replace(/{{pppoe}}/gi, cust.pppoe_username || '-');
            formattedMsg = formattedMsg.replace(/{{company}}/gi, company());
            formattedMsg = formattedMsg.replace(/{{company_phone}}/gi, getSetting('company_phone', '') || '-');

            const { parseSpintax } = await import('../services/whatsappBot.mjs');
            formattedMsg = parseSpintax(formattedMsg);
            formattedMsg = addMessageVariation(formattedMsg, i);

            // Jeda mengetik manusiawi sebelum kirim
            await waSvc.humanTypingDelay(formattedMsg);

            await waSvc.sendWhatsAppMessage(cust.phone, formattedMsg);
            global.broadcastStatus.sent++;
            messagesInCurrentHour++;
            global.broadcastStatus.messagesPerHour = messagesInCurrentHour;
            batchCount++;
            
            // Batch Processing: Pause setelah N pesan
            if (batchCount >= batchSize && i < uniqueCustomers.length - 1) {
              logger.info(`[Broadcast] Selesai batch ${global.broadcastStatus.currentBatch + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
              global.broadcastStatus.currentBatch++;
              await new Promise(r => setTimeout(r, batchPauseMs));
              batchCount = 0;
            }
            
            break; // Sukses, keluar dari retry loop
          } catch (e) {
            attemptCount++;
            const errorMsg = e.message || e.toString();
            
            // Cek apakah error permanent (tidak perlu retry)
            if (isPermanentError(errorMsg)) {
              logger.warn(`[Broadcast] SKIP: Error permanent untuk ${cust.phone} - ${errorMsg}`);
              global.broadcastStatus.failed++;
              break; // Skip retry langsung ke pelanggan berikutnya
            }
            
            // Error temporary, bisa retry
            logger.error(`[Broadcast] Gagal kirim ke ${cust.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);
            
            if (attemptCount >= maxAttempts) {
              logger.warn(`[Broadcast] Max attempts tercapai untuk ${cust.phone}`);
              global.broadcastStatus.failed++;
            } else {
              // Exponential backoff untuk retry
              const backoffDelay = getBackoffDelay(attemptCount);
              logger.info(`[Broadcast] Retry ke ${cust.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
              await new Promise(r => setTimeout(r, backoffDelay));
            }
          }
        }
      }
      
      global.broadcastStatus.active = false;
      logger.info(`[Broadcast] Selesai. Terkirim: ${global.broadcastStatus.sent}, Gagal: ${global.broadcastStatus.failed}`);
    };
    
    sendMessageAsync(); 

    req.session._msg = { type: 'success', text: `Difusión en proceso para ${uniqueCustomers.length} clientes con control de velocidad.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Falló la difusión:' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/auto-billing', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? true : false;
    const billingEnabled = req.body && req.body.billing_enabled ? true : false;
    const delay = req.body && req.body.delay ? parseInt(req.body.delay) : null;
    const next = { whatsapp_auto_billing_enabled: enabled, whatsapp_billing_to_customer_enabled: billingEnabled };
    if (delay != null && Number.isFinite(delay) && delay >= 1 && delay <= 60) {
      next.whatsapp_broadcast_delay = delay;
    }
    if (req.body && req.body.reminder_days_before != null) {
      const rd = String(req.body.reminder_days_before).replace(/[^\d,]/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '');
      if (rd) next.reminder_days_before = rd;
    }
    if (req.body && req.body.auto_billing_template_key) {
      next.auto_billing_template_key = String(req.body.auto_billing_template_key).trim();
    }
    const msg = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (msg) {
      db.saveAppSetting('whatsapp_auto_billing_message', msg);
    }
    saveSettings(next);
    req.session._msg = { type: 'success', text: `Recordatorio automático de pago ${enabled ? 'activado' : 'desactivado'}. Envío de facturas a clientes ${billingEnabled ? 'activado' : 'desactivado'}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo guardar la configuración:' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

// Jalankan pengingat tagihan otomatis sekarang (manual, tanpa nunggu CRON)
router.post('/whatsapp/run-reminder-now', requireAdminSession, async (req, res) => {
  try {
    const r = await require('../services/cronService').runAutoBillingReminder();
    const msg = (r && r.skipped)
      ? ('Pengingat dilewati (' + r.skipped + '). Verificá que el envío automático y WhatsApp estén activos.')
      : ('Pengingat dijalankan: target ' + ((r && r.target) || 0) + ', enviados' + ((r && r.sent) || 0) + ', fallidos' + ((r && r.failed) || 0) + '.');
    return res.json({ ok: true, message: msg, data: r || null });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.get('/api/whatsapp/status', requireAdmin, async (req, res) => {
    try {
      const gatewayType = getSetting('wa_gateway_type', 'gowa');
      if (gatewayType === 'fonnte') {
        const token = getSetting('fonnte_token', '');
        res.json({
          connection: token ? 'open' : 'close',
          gateway: 'fonnte',
          user: { id: 'fonnte_gateway', name: 'Fonnte Gateway' },
          lastUpdate: new Date().toISOString()
        });
      } else if (gatewayType === 'meta') {
        const phoneId = getSetting('meta_phone_number_id', '');
        const token = getSetting('meta_access_token', '');
        res.json({ connection: (phoneId && token) ? 'open' : 'connecting', gateway: 'meta' });
      } else if (gatewayType === 'gowa') {
        let st = null;
        try { st = await require('../services/gowaWhatsappService').gowaStatus(); } catch (e) { st = { ok: false, error: e.message }; }
        const rr = (st && st.data && st.data.results) || {};
        const loggedIn = !!(rr.is_logged_in || rr.isConnected || rr.connected);
        const isConn = !!(rr.is_connected || rr.connected);
        const conn = isConn ? 'open' : (loggedIn ? 'connecting' : 'close');
        res.json({ connection: conn, gateway: 'gowa', loggedIn: loggedIn, user: { id: 'gowa_gateway', name: loggedIn ? 'GOWA (WhatsApp)' : 'GOWA Gateway' }, lastUpdate: new Date().toISOString() });
      } else if (gatewayType === 'baileys') {
        const { whatsappStatus, startWhatsAppBot, isBotRunning } = await import('../services/whatsappBot.mjs');
        if (getSetting('whatsapp_enabled', true) && !isBotRunning() && whatsappStatus.connection !== 'open' && whatsappStatus.connection !== 'qr') {
          startWhatsAppBot().catch(err => logger.error('Auto start Baileys error: ' + err.message));
        }
        res.json(whatsappStatus);
      } else {
        res.json({ connection: 'close', gateway: gatewayType || 'unknown' });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
  try {
    const waSvc = require('../services/whatsappService');
    const adminNumbers = getSetting('whatsapp_admin_numbers', []);
    const legacyNumbers = getSetting('admins', []);
    let adminPhone = getSetting('company_phone', '');
    if (Array.isArray(adminNumbers) && adminNumbers.length > 0) {
      adminPhone = adminNumbers[0];
    } else if (Array.isArray(legacyNumbers) && legacyNumbers.length > 0) {
      adminPhone = legacyNumbers[0];
    }
    if (!adminPhone) {
      throw new Error('El número de WhatsApp del administrador no está configurado en Configuración de WhatsApp / Empresa.');
    }

    logger.info(`[WA Test] Mengirim test notifikasi ke nomor admin: ${adminPhone}`);
    const msg =
      `🧪 *TEST NOTIFIKASI WHATSAPP*\n\n` +
      `✅ Si recibís este mensaje, las notificaciones de WhatsApp del sistema funcionan correctamente.\n` +
      `📅 Fecha: ${getNowLocal()}`;
    const ok = await waSvc.sendWhatsAppMessage(adminPhone, msg);
    if (!ok) throw new Error('No se pudo enviar el mensaje de prueba.');
    logger.info(`[WA Test] Test notifikasi sukses terkirim ke ${adminPhone}`);
    req.session._msg = { type: 'success', text: 'Prueba de WhatsApp enviada a' + adminPhone };
  } catch (e) {
    logger.error(`[WA Test] Gagal mengirim test notifikasi: ${e.message}`);
    req.session._msg = { type: 'error', text: 'No se pudo enviar la prueba de WhatsApp:' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
  try {
    const authFolder = getSetting('whatsapp_auth_folder', 'auth_info_baileys');
    const folderPath = path.resolve(__dirname, '..', authFolder);
    
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      logger.info(`[WA] Session reset by admin. Folder ${authFolder} deleted.`);
      
      // Trigger restart bot secara asinkron
      import('../services/whatsappBot.mjs').then(m => m.restartWhatsAppBot()).catch(e => {
        logger.error('Failed to trigger WA restart:', e.message);
      });

      req.session._msg = { text: 'Sesión de WhatsApp eliminada. El bot se está reiniciando; esperá a que aparezca el código QR.', type: 'success' };
    } else {
      req.session._msg = { text: 'La carpeta de la sesión no existe o ya fue eliminada.', type: 'warning' };
    }
    res.redirect('/admin/whatsapp');
  } catch (e) {
    logger.error('Failed to reset WA session:', e.message);
    req.session._msg = { text: 'No se pudo eliminar la sesión:' + e.message, type: 'danger' };
    res.redirect('/admin/whatsapp');
  }
});

router.post('/whatsapp/repair-keys', requireAdminSession, async (req, res) => {
  try {
    const { cleanStaleSessionKeys, restartWhatsAppBot } = await import('../services/whatsappBot.mjs');
    const cleaned = cleanStaleSessionKeys();
    await restartWhatsAppBot();
    req.session._msg = {
      text: `Se limpiaron ${cleaned} claves de sesión obsoletas. Baileys se actualizó sin volver a escanear el QR.`,
      type: 'success'
    };
    res.redirect('/admin/whatsapp');
  } catch (e) {
    logger.error('Failed to repair WA session keys:', e.message);
    req.session._msg = { text: 'No se pudieron reparar las claves de sesión:' + e.message, type: 'danger' };
    res.redirect('/admin/whatsapp');
  }
});

// ─── ROUTERS (MULTI-ROUTER) ──────────────────────────────────────────────────
router.get('/routers', requireAdminSession, requireSidebarMenuAccess('mikrotik'), (req, res) => {
  res.render('admin/routers', {
    title: 'Manajemen Router', company: company(), activePage: 'mikrotik',
    routers: mikrotikService.getAllRouters(), msg: flashMsg(req)
  });
});

// ─── PROMO SLIDES ─────────────────────────────────────────────────────────────
router.get('/promo-slides', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  try {
    const slides = db.prepare(`
      SELECT * FROM promo_slides 
      ORDER BY sort_order ASC, id ASC
    `).all();
    
    res.render('admin/promo_slides', {
      title: 'Manajemen Promo Slides',
      company: company(),
      activePage: 'promo_slides',
      slides: slides || [],
      msg: flashMsg(req)
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
    res.redirect('/admin/settings');
  }
});

router.get('/api/promo-slides/:id', requireAdminSession, (req, res) => {
  try {
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(Number(req.params.id));
    if (!slide) return res.status(404).json({ error: 'Diapositiva no encontrada' });
    res.json(slide);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/promo-slides', requireAdminSession, requireSidebarMenuAccess('settings'), promoUpload.single('image'), async (req, res) => {
  try {
    const { title, description, url, open_in_new_tab, sort_order, start_date, end_date, is_active } = req.body;
    
    if (!req.file) throw new Error('Hay que subir una imagen');
    
    let imagePath = `/uploads/promo_slides/${req.file.filename}`;
    // Konversi otomatis PNG/JPEG -> WebP (lebih ringan)
    try {
      const _opt = await require('../services/imageOptimize').convertUploadToWebp(req.file.path, '/uploads/promo_slides', { maxWidth: 1600, quality: 82 });
      if (_opt && _opt.urlPath) imagePath = _opt.urlPath;
    } catch (e) { try { logger.warn('[Promo] Konversi WebP gagal: ' + e.message); } catch (_) {} }
    
    db.prepare(`
      INSERT INTO promo_slides (title, description, image_path, url, open_in_new_tab, sort_order, start_date, end_date, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(title || '').trim(),
      String(description || '').trim(),
      imagePath,
      String(url || '').trim(),
      open_in_new_tab === 'on' ? 1 : 0,
      Number(sort_order) || 0,
      start_date || null,
      end_date || null,
      is_active === 'on' ? 1 : 0
    );
    
    req.session._msg = { type: 'success', text: 'Diapositiva agregada' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/promo-slides/:id/update', requireAdminSession, requireSidebarMenuAccess('settings'), promoUpload.single('image'), async (req, res) => {
  try {
    const { title, description, url, open_in_new_tab, sort_order, start_date, end_date, is_active } = req.body;
    const slideId = Number(req.params.id);
    
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(slideId);
    if (!slide) throw new Error('Diapositiva no encontrada');
    
    let imagePath = slide.image_path;
    let oldImagePath = null;
    
    if (req.file) {
      oldImagePath = slide.image_path;
      imagePath = `/uploads/promo_slides/${req.file.filename}`;
      try {
        const _opt2 = await require('../services/imageOptimize').convertUploadToWebp(req.file.path, '/uploads/promo_slides', { maxWidth: 1600, quality: 82 });
        if (_opt2 && _opt2.urlPath) imagePath = _opt2.urlPath;
      } catch (e) { try { logger.warn('[Promo] Konversi WebP gagal: ' + e.message); } catch (_) {} }
    }
    
    db.prepare(`
      UPDATE promo_slides SET 
        title = ?, description = ?, image_path = ?, url = ?, 
        open_in_new_tab = ?, sort_order = ?, start_date = ?, end_date = ?, is_active = ?,
        updated_at = NOW_LOCAL()
      WHERE id = ?
    `).run(
      String(title || '').trim(),
      String(description || '').trim(),
      imagePath,
      String(url || '').trim(),
      open_in_new_tab === 'on' ? 1 : 0,
      Number(sort_order) || 0,
      start_date || null,
      end_date || null,
      is_active === 'on' ? 1 : 0,
      slideId
    );
    
    // Cleanup old image file if new one was uploaded
    if (oldImagePath && oldImagePath !== imagePath) {
      const oldFilePath = path.resolve(__dirname, '..', 'public', oldImagePath);
      try {
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
          logger.info(`[PromoSlides] Deleted old image: ${oldFilePath}`);
        }
      } catch (err) {
        logger.warn(`[PromoSlides] Failed to delete old image: ${err.message}`);
        // Don't fail the request, just log warning
      }
    }
    
    req.session._msg = { type: 'success', text: 'Diapositiva actualizada' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/promo-slides/:id/delete', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  try {
    const slideId = Number(req.params.id);
    
    // Get slide data to retrieve image path for cleanup
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(slideId);
    
    // Delete from database
    db.prepare('DELETE FROM promo_slides WHERE id = ?').run(slideId);
    
    // Cleanup image file
    if (slide && slide.image_path) {
      const filePath = path.resolve(__dirname, '..', 'public', slide.image_path);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.info(`[PromoSlides] Deleted image: ${filePath}`);
        }
      } catch (err) {
        logger.warn(`[PromoSlides] Failed to delete image: ${err.message}`);
        // Don't fail the request, just log warning
      }
    }
    
    req.session._msg = { type: 'success', text: 'Diapositiva eliminada' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/routers', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.createRouter(req.body);
    req.session._msg = { type: 'success', text: `Router "${req.body.name}" agregado.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.updateRouter(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Router actualizado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/delete', requireAdminSession, (req, res) => {
  try {
    mikrotikService.deleteRouter(req.params.id);
    req.session._msg = { type: 'success', text: 'Router eliminado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/routers');
});

router.get('/api/routers/:id/test', requireAdmin, async (req, res) => {
  try {
    const conn = await mikrotikService.getConnection(req.params.id);
    if (conn && conn.api) {
      conn.api.close();
      return res.json({ success: true, message: '¡Conexión con el router correcta!' });
    }
    throw new Error('No se pudo conectar con el router');
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/routers/:id/details', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.id;
    const routerConfig = mikrotikService.getRouterById(routerId);
    if (!routerConfig) return res.status(404).json({ success: false, error: 'Router no encontrado' });

    let liveData = {
      connected: false,
      identity: routerConfig.name || 'MikroTik',
      version: '-',
      boardName: '-',
      cpuLoad: 0,
      freeMemory: 0,
      totalMemory: 0,
      freeHdd: 0,
      totalHdd: 0,
      uptime: '-',
      architecture: '-',
      cpuCount: 1,
      cpuFrequency: 0,
      activePppoe: 0,
      activeHotspot: 0,
      customersCount: 0,
      error: null
    };

    try {
      const allRouters = mikrotikService.getAllRouters();
      const firstRouter = allRouters && allRouters.length > 0 ? allRouters[0] : null;
      let countRes;
      if (firstRouter && Number(firstRouter.id) === Number(routerId)) {
        countRes = db.prepare('SELECT COUNT(*) as total FROM customers WHERE router_id = ? OR router_id IS NULL OR router_id = 0').get(routerId);
      } else {
        countRes = db.prepare('SELECT COUNT(*) as total FROM customers WHERE router_id = ?').get(routerId);
      }
      liveData.customersCount = countRes ? countRes.total : 0;
    } catch (e) {
      liveData.customersCount = 0;
    }

    try {
      const resource = await mikrotikService.getSystemResource(routerId);
      if (resource) {
        liveData.connected = true;
        liveData.cpuLoad = parseInt(resource['cpu-load'] || resource.cpuLoad || 0);
        liveData.freeMemory = parseInt(resource['free-memory'] || resource.freeMemory || 0);
        liveData.totalMemory = parseInt(resource['total-memory'] || resource.totalMemory || 0);
        liveData.freeHdd = parseInt(resource['free-hdd-space'] || resource.freeHddSpace || 0);
        liveData.totalHdd = parseInt(resource['total-hdd-space'] || resource.totalHddSpace || 0);
        liveData.version = resource.version || '-';
        liveData.boardName = resource['board-name'] || resource.boardName || '-';
        liveData.uptime = resource.uptime || '-';
        liveData.architecture = resource['architecture-name'] || resource.architectureName || '-';
        liveData.cpuCount = resource['cpu-count'] || resource.cpuCount || 1;
        liveData.cpuFrequency = resource['cpu-frequency'] || resource.cpuFrequency || 0;
      }

      try {
        const identity = await mikrotikService.getSystemIdentity(routerId);
        if (identity) liveData.identity = identity;
      } catch (e) {}

      try {
        const activePpp = await mikrotikService.getPppoeActive(routerId);
        liveData.activePppoe = activePpp ? activePpp.length : 0;
        liveData.activePppoeList = Array.isArray(activePpp) ? activePpp.slice(0, 50).map(s => ({
          name: s.name || s['name'] || '-',
          address: s.address || s['address'] || '-',
          uptime: s.uptime || s['uptime'] || '-',
          callerId: s['caller-id'] || s.callerId || '-'
        })) : [];
      } catch (e) {
        liveData.activePppoeList = [];
      }

      try {
        const activeHs = await mikrotikService.getHotspotActive(routerId);
        liveData.activeHotspot = activeHs ? activeHs.length : 0;
        liveData.activeHotspotList = Array.isArray(activeHs) ? activeHs.slice(0, 50).map(h => ({
          user: h.user || h['user'] || '-',
          address: h.address || h['address'] || '-',
          mac: h['mac-address'] || h.mac || '-',
          uptime: h.uptime || h['uptime'] || '-'
        })) : [];
      } catch (e) {
        liveData.activeHotspotList = [];
      }

    } catch (e) {
      liveData.connected = false;
      liveData.error = e.message;
    }

    res.json({ success: true, router: routerConfig, live: liveData });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/routers/:id/setup-firewall', requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.setupIsolirFirewall(req.params.id);
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/isolir-portal-script', requireAdmin, async (req, res) => {
  try {
    const data = await mikrotikService.generateIsolirPortalScript();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/system/update', requireAdmin, async (req, res) => {
  const { exec } = require('child_process');
  const path = require('path');
  const projectDir = path.join(__dirname, '..');
  const isWindows = process.platform === 'win32';

  const cmd = isWindows 
    ? 'git pull origin main || git pull' 
    : 'nice -n 19 bash update.sh';

  logger.info(`[System Update] Admin initiated 1-Click System Update.`);

  exec(cmd, { cwd: projectDir, timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      logger.error(`[System Update Error]: ${error.message}`);
      return res.json({ success: false, message: 'No se pudo actualizar:' + error.message, output: stderr || stdout });
    }
    logger.info(`[System Update Complete]: ${stdout}`);
    return res.json({ 
      success: true, 
      message: '¡Actualización aplicada (modo bajo consumo)!', 
      output: stdout || 'Git pull y recarga completados.' 
    });
  });
});

router.get('/api/mikrotik/profiles/:routerId', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.params.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users/:routerId', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.routerId ? Number(req.params.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ─── ATTENDANCE MANAGEMENT ───────────────────────────────────────────────────

// Attendance dashboard
router.get('/attendance', requireAdminSession, requireSidebarMenuAccess('attendance'), (req, res) => {
  try {
    const date = req.query.date || getNowLocal().split(' ')[0];
    const attendances = attendanceSvc.getAttendanceByDate(date);
    const stats = attendanceSvc.getAttendanceStats(date);
    const lateCheckIns = attendanceSvc.getLateCheckIns(date);
    const notCheckedOut = attendanceSvc.getNotCheckedOut(date);
    
    res.render('admin/attendance', {
      title: 'Manajemen Absensi',
      company: company(),
      activePage: 'attendance',
      session: req.session,
      attendances,
      stats,
      lateCheckIns,
      notCheckedOut,
      selectedDate: date,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo cargar la asistencia:' + e.message };
    res.redirect('/admin');
  }
});

// Get attendance by date range (API)
router.get('/api/attendance/range', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.json({ success: false, message: 'La fecha de inicio y de fin son obligatorias' });
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    res.json({ success: true, data: attendances });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get employee attendance history
router.get('/api/attendance/employee/:type/:id', requireAdminSession, (req, res) => {
  try {
    const { type, id } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit) : 30;
    const history = attendanceSvc.getAttendanceHistory(type, parseInt(id), limit);
    res.json({ success: true, data: history });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get monthly summary
router.get('/api/attendance/summary/:type/:id/:year/:month', requireAdminSession, (req, res) => {
  try {
    const { type, id, year, month } = req.params;
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      type, 
      parseInt(id), 
      parseInt(year), 
      parseInt(month)
    );
    res.json({ success: true, data: summary });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Update attendance (admin correction)
router.post('/attendance/:id/update', requireAdminSession, express.json(), (req, res) => {
  try {
    const { id } = req.params;
    const { check_in_time, check_in_note, check_out_time, check_out_note } = req.body;
    
    // Calculate duration if both times provided
    let duration = 0;
    if (check_in_time && check_out_time) {
      const checkIn = parseDateInTimezone(check_in_time);
      const checkOut = parseDateInTimezone(check_out_time);
      if (checkIn && checkOut) {
        duration = Math.floor((checkOut - checkIn) / 1000 / 60);
      }
    }
    
    attendanceSvc.updateAttendance(parseInt(id), {
      check_in_time,
      check_in_note: check_in_note || '',
      check_out_time: check_out_time || null,
      check_out_note: check_out_note || '',
      work_duration_minutes: duration
    });
    
    auditSvc.log('admin', req.session.username || 'admin', 'update_attendance', `Updated attendance #${id}`);
    res.json({ success: true, message: 'Asistencia actualizada' });
  } catch (e) {
    res.json({ success: false, message: 'No se pudo actualizar la asistencia:' + e.message });
  }
});

// Delete attendance
router.post('/attendance/:id/delete', requireAdminSession, (req, res) => {
  try {
    const { id } = req.params;
    attendanceSvc.deleteAttendance(parseInt(id));
    auditSvc.log('admin', req.session.username || 'admin', 'delete_attendance', `Deleted attendance #${id}`);
    req.session._msg = { type: 'success', text: 'Asistencia eliminada' };
    res.redirect('/admin/attendance');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo eliminar la asistencia:' + e.message };
    res.redirect('/admin/attendance');
  }
});

// Export attendance to Excel
router.get('/attendance/export', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      req.session._msg = { type: 'error', text: 'La fecha de inicio y de fin son obligatorias' };
      return res.redirect('/admin/attendance');
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    
    // Prepare data for Excel
    const data = attendances.map(a => ({
      'ID': a.id,
      'Tipe Karyawan': a.employee_type,
      'Nama': a.employee_name,
      'Check In': a.check_in_time,
      'Ubicación de entrada': a.check_in_lat && a.check_in_lng ? `${a.check_in_lat}, ${a.check_in_lng}` : '-',
      'Catatan Check In': a.check_in_note || '-',
      'Foto de entrada': a.check_in_photo || '-',
      'Check Out': a.check_out_time || '-',
      'Ubicación de salida': a.check_out_lat && a.check_out_lng ? `${a.check_out_lat}, ${a.check_out_lng}` : '-',
      'Catatan Check Out': a.check_out_note || '-',
      'Foto de salida': a.check_out_photo || '-',
      'Durasi (menit)': a.work_duration_minutes || 0,
      'Status': a.status
    }));
    
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Absensi');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename=absensi_${startDate}_${endDate}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo exportar:' + e.message };
    res.redirect('/admin/attendance');
  }
});


// ─── PAYROLL / GAJI KARYAWAN ───────────────────────────────────────────────

router.get('/payroll', requireAdmin, requireSidebarMenuAccess('payroll'), (req, res) => {
  const now = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year = parseInt(req.query.year) || now.getFullYear();

  const employees = payrollSvc.getAllEmployees();
  const slips = payrollSvc.getSlipsByPeriod(month, year);
  const summary = payrollSvc.getPayrollSummary(month, year);

  res.render('admin/payroll', {
    title: 'Sueldos del personal',
    company: company(),
    employees,
    slips,
    summary,
    selectedMonth: month,
    selectedYear: year,
    msg: req.session._msg || null
  });
  req.session._msg = null;
});

router.post('/payroll/settings', requireAdmin, (req, res) => {
  try {
    payrollSvc.upsertPayrollSetting(req.body);
    req.session._msg = { type: 'success', text: 'Configuración de sueldos guardada.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Error:' + e.message };
  }
  res.redirect('/admin/payroll');
});

router.post('/payroll/generate', requireAdmin, (req, res) => {
  const month = parseInt(req.body.month);
  const year = parseInt(req.body.year);
  if (!month || !year) {
    req.session._msg = { type: 'error', text: 'Se requieren mes y año' };
    return res.redirect('/admin/payroll');
  }

  const result = payrollSvc.generateAllSlips(month, year);
  req.session._msg = { 
    type: 'success', 
    text: `Generación terminada: ${result.generated} creados, ${result.skipped} omitidos, ${result.errors.length} errores.` 
  };
  res.redirect(`/admin/payroll?month=${month}&year=${year}`);
});

router.post('/payroll/slip/:id/deduction', requireAdmin, express.json(), (req, res) => {
  try {
    const { other_deduction, other_deduction_note } = req.body;
    payrollSvc.updateSlipDeductions(req.params.id, other_deduction, other_deduction_note);
    res.json({ success: true, message: 'Descuento actualizado' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.post('/payroll/slip/:id/approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.approveSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Recibo aprobado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.markSlipPaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Recibo marcado como pagado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/delete', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Recibo eliminado.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkApprove(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Todos los borradores fueron aprobados.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkMarkPaid(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Todos los recibos aprobados se marcaron como pagados.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/delete-drafts', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlipsByPeriod(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Todos los borradores fueron eliminados.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.get('/payroll/slip/:id/print', requireAdmin, (req, res) => {
  const slip = payrollSvc.getSlipById(req.params.id);
  if (!slip) return res.status(404).send('Recibo no encontrado');
  
  res.render('admin/print_payslip', {
    company: company(),
    slip
  });
});

router.get('/payroll/slip/:id/pdf', requireAdmin, async (req, res) => {
  try {
    const slip = payrollSvc.getSlipById(req.params.id);
    if (!slip) return res.status(404).send('Recibo no encontrado');
    const pdf = await require('../services/payslipPdfService').generatePayslipPdfBuffer(slip, getSettings());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Slip_Gaji_' + (slip.employee_name || slip.id) + '_' + (slip.period_month || '') + '-' + (slip.period_year || '') + '.pdf"');
    res.send(pdf);
  } catch (e) { res.status(500).send('No se pudo crear el PDF:' + e.message); }
});

router.post('/payroll/slip/:id/send-wa', requireAdmin, async (req, res) => {
  try {
    const slip = payrollSvc.getSlipById(req.params.id);
    if (!slip) throw new Error('Recibo no encontrado');
    
    const phone = payrollSvc.getEmployeePhone(slip.employee_type, slip.employee_id);
    if (!phone) throw new Error('El empleado no tiene número de teléfono');

    const { getSettingsWithCache } = require('../config/settingsManager');
    const settings = getSettingsWithCache();
    if (!settings.whatsapp_enabled) throw new Error('WhatsApp no está activo');

    const waNotify = require('../services/waNotifyService');
    if (false) {
      throw new Error('WhatsApp no está conectado');
    }

    const monthNames = ['','Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    
    const msg = `🧾 *RECIBO DE SUELDO*\n\n` +
      `👤 *Nombre:* ${slip.employee_name}\n` +
      `📅 *Período:* ${monthNames[slip.period_month]} ${slip.period_year}\n` +
      `🏢 *Status:* ${slip.status.toUpperCase()}\n\n` +
      `*PENDAPATAN:*\n` +
      `- Sueldo base: ${regional.currencySymbol()} ${slip.base_salary.toLocaleString(regional.locale())}\n` +
      (slip.transport_allowance ? `- Tunj. Transport: ${regional.currencySymbol()} ${slip.transport_allowance.toLocaleString(regional.locale())}\n` : '') +
      (slip.meal_allowance ? `- Tunj. Makan: ${regional.currencySymbol()} ${slip.meal_allowance.toLocaleString(regional.locale())}\n` : '') +
      (slip.phone_allowance ? `- Tunj. Pulsa: ${regional.currencySymbol()} ${slip.phone_allowance.toLocaleString(regional.locale())}\n` : '') +
      (slip.other_allowance ? `- Tunj. Lain: ${regional.currencySymbol()} ${slip.other_allowance.toLocaleString(regional.locale())}\n` : '') +
      (slip.ticket_bonus ? `- Bono por tickets: +${regional.currencySymbol()} ${slip.ticket_bonus.toLocaleString(regional.locale())}\n` : '') +
      (slip.collection_commission ? `- Comisión por cobranza: +${regional.currencySymbol()} ${slip.collection_commission.toLocaleString(regional.locale())}\n` : '') +
      (slip.overtime_bonus ? `- Lembur: +${regional.currencySymbol()} ${slip.overtime_bonus.toLocaleString(regional.locale())}\n` : '') +
      `*Total Pendapatan: ${regional.currencySymbol()} ${slip.gross_salary.toLocaleString(regional.locale())}*\n\n` +
      `*POTONGAN:*\n` +
      (slip.absence_deduction ? `- Descuento por ausencias: -${regional.currencySymbol()} ${slip.absence_deduction.toLocaleString(regional.locale())}\n` : '') +
      (slip.late_deduction ? `- Potongan Terlambat: -${regional.currencySymbol()} ${slip.late_deduction.toLocaleString(regional.locale())}\n` : '') +
      (slip.other_deduction ? `- Potongan Lain: -${regional.currencySymbol()} ${slip.other_deduction.toLocaleString(regional.locale())}\n` : '') +
      `*Total Potongan: ${regional.currencySymbol()} ${slip.total_deductions.toLocaleString(regional.locale())}*\n\n` +
      `💰 *SUELDO NETO: ${regional.currencySymbol()} ${slip.net_salary.toLocaleString(regional.locale())}*\n\n` +
      `¡Gracias por tu trabajo! 🙏`;

    await waNotify.sendText(phone, msg);
    res.json({ success: true, message: 'Terkirim' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.use('/acs', acsPortal);

// Mount Finance Portal
router.use('/finance', require('./financePortal'));
// ─── ONU PROVISION ─────────────────────────────────────────────────────────
const onuProvisionSvc = require('../services/onuProvisionService');

router.get('/onu-provision', requireAdminSession, restrictToAdmin, (req, res) => {
  const oltConfig = {
    vendor: getSetting('olt_vendor', ''),
    host: getSetting('olt_host', ''),
    port: getSetting('olt_port', 22),
    username: getSetting('olt_username', ''),
    password: getSetting('olt_password', '')
  };
  
  res.render('admin/onu_provision', {
    title: 'ONU Provision',
    company: company(),
    activePage: 'onu_provision',
    msg: flashMsg(req),
    oltConfig,
    lang: req.session?.lang || 'id'
  });
});

router.post('/onu-provision/configure-olt', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { vendor, host, port, username, password, action } = req.body;
    
    if (action === 'test') {
      // Test connection
      const oltConfig = { vendor, host, port: parseInt(port), username, password };
      
      try {
        const conn = await onuProvisionSvc.connectSSH(oltConfig);
        conn.end();
        req.session._msg = { type: 'success', text: `¡Conexión con la OLT ${vendor} correcta!` };
      } catch (error) {
        req.session._msg = { type: 'error', text: `Falló la conexión: ${error.message}` };
      }
    } else if (action === 'save') {
      // Save configuration
      const currentSettings = getSettings();
      const success = saveSettings({
        ...currentSettings,
        olt_vendor: vendor,
        olt_host: host,
        olt_port: parseInt(port),
        olt_username: username,
        olt_password: password
      });
      
      if (success) {
        req.session._msg = { type: 'success', text: 'Configuración de la OLT guardada.' };
      } else {
        req.session._msg = { type: 'error', text: 'No se pudo guardar la configuración de la OLT.' };
      }
    }
  } catch (error) {
    req.session._msg = { type: 'error', text: 'Error: ' + error.message };
  }
  
  res.redirect('/admin/onu-provision');
});

router.post('/onu-provision/scan-unconfigured', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const oltConfig = {
      vendor: getSetting('olt_vendor', ''),
      host: getSetting('olt_host', ''),
      port: getSetting('olt_port', 22),
      username: getSetting('olt_username', ''),
      password: getSetting('olt_password', '')
    };
    
    if (!oltConfig.host) {
      return res.json({ success: false, error: 'La OLT no está configurada' });
    }
    
    let onus = [];
    
    if (oltConfig.vendor === 'ZTE') {
      const { pon } = req.body;
      if (!pon) {
        return res.json({ success: false, error: 'La interfaz PON es obligatoria' });
      }
      onus = await onuProvisionSvc.zteGetUnconfiguredONUs(oltConfig, pon);
    } else if (oltConfig.vendor === 'Huawei') {
      const { frame, slot, pon } = req.body;
      onus = await onuProvisionSvc.huaweiGetUnconfiguredONUs(oltConfig, frame, slot, pon);
    } else if (oltConfig.vendor === 'HSGQ' || oltConfig.vendor === 'Hioso') {
      const { pon } = req.body;
      if (!pon) {
        return res.json({ success: false, error: 'La interfaz PON es obligatoria' });
      }
      onus = await onuProvisionSvc.hsgqGetUnconfiguredONUs(oltConfig, pon);
    } else {
      return res.json({ success: false, error: 'Esta marca de OLT no admite el escaneo automático' });
    }
    
    res.json({ success: true, onus });
  } catch (error) {
    logger.error('Scan unconfigured ONUs error:', error);
    res.json({ success: false, error: error.message });
  }
});

router.post('/onu-provision/scan-configured', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const host = getSetting('olt_host', '');
    if (!host) {
      return res.json({ success: false, error: 'La OLT no está configurada en la configuración general' });
    }
    
    const olt = db.prepare('SELECT * FROM olts WHERE host = ? LIMIT 1').get(host);
    if (!olt) {
      return res.json({ 
        success: false, 
        error: 'La OLT con IP' + host + ' todavía no está registrada en "Gestión de OLT". Registrala ahí primero para que el sistema pueda leer el monitoreo SNMP.' 
      });
    }
    
    const oltSvc = require('../services/oltService');
    const stats = await oltSvc.getOltStats(olt.id, true);
    
    res.json({ success: true, onus: stats.onus || [], oltId: olt.id });
  } catch (error) {
    logger.error('Scan configured ONUs error:', error);
    res.json({ success: false, error: error.message });
  }
});

router.post('/onu-provision/provision', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const oltConfig = {
      vendor: getSetting('olt_vendor', ''),
      host: getSetting('olt_host', ''),
      port: getSetting('olt_port', 22),
      username: getSetting('olt_username', ''),
      password: getSetting('olt_password', '')
    };
    
    if (!oltConfig.host) {
      throw new Error('La OLT no está configurada');
    }
    
    const { vendor, createMikrotikPPPoE, mikrotikPppoeUsername, mikrotikPppoePassword, mikrotikProfile } = req.body;
    let result;
    let messages = [];
    
    // Check if need to create MikroTik PPPoE
    if (createMikrotikPPPoE === 'on' && mikrotikPppoeUsername && mikrotikPppoePassword) {
      // Validate PPPoE username not already in use
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const existingCustomer = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(routerId, mikrotikPppoeUsername);
      
      if (existingCustomer) {
        throw new Error(`El usuario PPPoE "${mikrotikPppoeUsername}" ya lo usa el cliente: ${existingCustomer.name}`);
      }
      
      // Use full provision with MikroTik integration
      const mikrotikConfig = {
        host: getSetting('mikrotik_host', ''),
        user: getSetting('mikrotik_user', ''),
        password: getSetting('mikrotik_password', ''),
        port: getSetting('mikrotik_port', 8728)
      };
      
      if (mikrotikConfig.host) {
        // Prepare params for full provision
        const provisionParams = {
          ...req.body,
          pppoeUsername: mikrotikPppoeUsername,
          pppoePassword: mikrotikPppoePassword,
          bandwidth: mikrotikProfile || req.body.bandwidth
        };
        
        result = await onuProvisionSvc.fullProvision(oltConfig, mikrotikConfig, provisionParams);
        
        if (result.results.onu) {
          messages.push(`✅ ONU ${req.body.name} dada de alta`);
        }
        if (result.results.pppoe) {
          messages.push(`✅ PPPoE ${mikrotikPppoeUsername} creado en el MikroTik`);
        }
        if (result.results.errors && result.results.errors.length > 0) {
          messages.push(`⚠️ ${result.results.errors.join(', ')}`);
        }
      } else {
        throw new Error('El MikroTik no está configurado');
      }
    } else {
      // Standard provision (ONU only)
      if (vendor === 'ZTE') {
        result = await onuProvisionSvc.zteProvisionONU(oltConfig, req.body);
      } else if (vendor === 'Huawei') {
        result = await onuProvisionSvc.huaweiProvisionONU(oltConfig, req.body);
      } else if (vendor === 'Fiberhome') {
        result = await onuProvisionSvc.fiberhomeProvisionONU(oltConfig, req.body);
      } else if (vendor === 'VSOL') {
        result = await onuProvisionSvc.vsolProvisionONU(oltConfig, req.body);
      } else if (vendor === 'CData') {
        result = await onuProvisionSvc.cdataProvisionONU(oltConfig, req.body);
      } else if (vendor === 'HSGQ') {
        result = await onuProvisionSvc.hsgqProvisionONU(oltConfig, req.body);
      } else if (vendor === 'Hioso') {
        result = await onuProvisionSvc.hiosoProvisionONU(oltConfig, req.body);
      } else {
        throw new Error('Marca no admitida');
      }
      
      messages.push(`✅ ONU ${req.body.name} dada de alta`);
    }
    
    if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
      auditSvc.logAuditTrail({
        action: 'CREATE',
        entity_type: 'onu_provision',
        entity_id: req.body.sn,
        actor_type: 'admin',
        actor_id: String(req.session?.adminUser || ''),
        actor_name: req.session?.adminUser || 'Admin',
        details: {
          vendor,
          params: req.body,
          mikrotikIntegration: createMikrotikPPPoE === 'on'
        },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    }
    
    req.session._msg = { type: 'success', text: messages.join(' | ') };
  } catch (error) {
    logger.error('Provision ONU error:', error);
    req.session._msg = { type: 'error', text: 'No se pudo dar de alta la ONU:' + error.message };
  }
  
  res.redirect('/admin/onu-provision');
});

router.post('/onu-provision/delete', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const oltConfig = {
      vendor: getSetting('olt_vendor', ''),
      host: getSetting('olt_host', ''),
      port: getSetting('olt_port', 22),
      username: getSetting('olt_username', ''),
      password: getSetting('olt_password', '')
    };
    
    const { vendor, params } = req.body;
    const result = await onuProvisionSvc.deleteONU(oltConfig, vendor, params);
    
    if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
      auditSvc.logAuditTrail({
        action: 'DELETE',
        entity_type: 'onu_provision',
        entity_id: params.sn || 'unknown',
        actor_type: 'admin',
        actor_id: String(req.session?.adminUser || ''),
        actor_name: req.session?.adminUser || 'Admin',
        details: { vendor, params },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    }
    
    res.json({ success: true, message: result.message });
  } catch (error) {
    logger.error('Delete ONU error:', error);
    res.json({ success: false, error: error.message });
  }
});

// --- RADIUS SERVER MANAGEMENT ---
const radiusSvc = require('../services/radiusServerService');

router.get('/radius-settings', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const radiusStatus = radiusSvc.getStatus();
    const onlineSessions = radiusSvc.getOnlineSessions();
    const acctLogs = radiusSvc.getAccountingLogs(100);
    const nasList = db.prepare(`SELECT * FROM radius_nas ORDER BY id DESC`).all() || [];

    const todayStats = db.prepare(`
      SELECT 
        COUNT(1) as total_events,
        COALESCE(SUM(input_octets + output_octets), 0) as total_bytes
      FROM radius_accounting
      WHERE DATE(created_at) = DATE('now')
    `).get() || { total_events: 0, total_bytes: 0 };

    const todayTrafficMB = (todayStats.total_bytes / (1024 * 1024)).toFixed(1);
    const todayEvents = todayStats.total_events;

    const msg = req.session._msg || null;
    req.session._msg = null;

    let detectedServerIp = '192.168.8.88';
    try {
      const ifaces = os.networkInterfaces();
      for (const ifaceName in ifaces) {
        for (const alias of ifaces[ifaceName]) {
          if (alias.family === 'IPv4' && !alias.internal && alias.address !== '127.0.0.1') {
            detectedServerIp = alias.address;
            break;
          }
        }
        if (detectedServerIp !== '192.168.8.88') break;
      }
    } catch (e) {}

    res.render('admin/radius-settings', {
      title: 'Pengaturan RADIUS',
      company: company(),
      activePage: 'radius_settings',
      session: req.session,
      radiusStatus,
      onlineSessions,
      acctLogs,
      nasList,
      todayTrafficMB,
      todayEvents,
      serverIp: detectedServerIp,
      msg
    });
  } catch (error) {
    logger.error('Error rendering RADIUS settings page:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

router.post('/radius-settings', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const {
      radius_enabled,
      radius_secret,
      radius_auth_port,
      radius_acct_port,
      radius_isolir_action,
      radius_isolir_pool,
      radius_isolir_rate_limit,
      radius_isolir_ip_pool_enabled,
      radius_isolir_ip_pool_start,
      radius_isolir_ip_pool_end,
      radius_limit_simultaneous,
      radius_default_rate_limit,
      radius_ip_pool_enabled,
      radius_ip_pool_start,
      radius_ip_pool_end,
      radius_framed_pool,
      pppoe_auto_generate,
      pppoe_username_pattern,
      pppoe_domain,
      pppoe_default_password,
      radius_use_profile
    } = req.body;

    saveSettings({
      radius_enabled: radius_enabled === '1' ? '1' : '0',
      radius_secret: String(radius_secret || 'secret123').trim(),
      radius_auth_port: String(radius_auth_port || '1812').trim(),
      radius_acct_port: String(radius_acct_port || '1813').trim(),
      radius_isolir_action: String(radius_isolir_action || 'pool').trim(),
      radius_isolir_pool: String(radius_isolir_pool || 'isolir').trim(),
      radius_isolir_rate_limit: String(radius_isolir_rate_limit || '512k/512k').trim(),
      radius_isolir_ip_pool_enabled: radius_isolir_ip_pool_enabled === '1' ? '1' : '0',
      radius_isolir_ip_pool_start: String(radius_isolir_ip_pool_start || '10.10.99.2').trim(),
      radius_isolir_ip_pool_end: String(radius_isolir_ip_pool_end || '10.10.99.254').trim(),
      radius_limit_simultaneous: radius_limit_simultaneous === '1' ? '1' : '0',
      radius_default_rate_limit: String(radius_default_rate_limit || '5M/10M').trim(),
      radius_ip_pool_enabled: radius_ip_pool_enabled === '1' ? '1' : '0',
      radius_ip_pool_start: String(radius_ip_pool_start || '10.10.10.2').trim(),
      radius_ip_pool_end: String(radius_ip_pool_end || '10.10.10.254').trim(),
      radius_framed_pool: String(radius_framed_pool || 'pool-pppoe').trim(),
      pppoe_auto_generate: pppoe_auto_generate === '0' ? '0' : '1',
      pppoe_username_pattern: String(pppoe_username_pattern || 'name').trim() === 'customer_code' ? 'customer_code' : 'name',
      pppoe_domain: String(pppoe_domain || 'sky.id').replace(/^@/, '').trim() || 'sky.id',
      pppoe_default_password: String(pppoe_default_password || 'openisp').trim() || 'openisp',
      radius_use_profile: radius_use_profile === '1' ? '1' : '0'
    });

    // Kontrol background service UDP RADIUS
    radiusSvc.stop();
    if (radius_enabled === '1') {
      radiusSvc.start();
    }

    req.session._msg = { type: 'success', text: 'Configuración del servidor RADIUS actualizada.' };
  } catch (error) {
    logger.error('Error saving RADIUS settings:', error);
    req.session._msg = { type: 'danger', text: 'No se pudo guardar la configuración:' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/disconnect', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { username, session_id, nas_ip } = req.body;
    if (!username) throw new Error('El usuario no puede quedar vacío');

    await radiusSvc.disconnectSession(username, session_id, nas_ip);
    req.session._msg = { type: 'success', text: `Se desconectó la sesión RADIUS del usuario "${username}".` };
  } catch (e) {
    logger.error('Error disconnecting RADIUS session:', e);
    req.session._msg = { type: 'danger', text: 'No se pudo desconectar la sesión RADIUS:' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/clear-stale', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE radius_accounting
      SET status_type = 2, terminate_cause = 10, updated_at = NOW_LOCAL()
      WHERE status_type IN (1, 3) AND updated_at < datetime('now', '-2 hours')
    `).run();
    req.session._msg = { type: 'success', text: `Se limpiaron ${result.changes} sesiones vencidas / fantasma.` };
  } catch (e) {
    logger.error('Error clearing stale RADIUS sessions:', e);
    req.session._msg = { type: 'danger', text: 'No se pudieron limpiar las sesiones:' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/restart', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    radiusSvc.stop();
    await new Promise(r => setTimeout(r, 500));
    radiusSvc.start();
    req.session._msg = { type: 'success', text: 'Servicio RADIUS (UDP 1812/1813) reiniciado.' };
  } catch (e) {
    logger.error('Error restarting RADIUS service:', e);
    req.session._msg = { type: 'danger', text: 'No se pudo reiniciar el servicio RADIUS:' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/add', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { nasname, shortname, secret, description } = req.body;
    if (!nasname || !secret) {
      throw new Error('La IP del NAS y el secreto compartido son obligatorios.');
    }

    db.prepare(`
      INSERT INTO radius_nas (nasname, shortname, secret, description, is_active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(nasname) DO UPDATE SET
        shortname = excluded.shortname,
        secret = excluded.secret,
        description = excluded.description,
        is_active = 1
    `).run(
      String(nasname).trim(),
      String(shortname || '').trim(),
      String(secret).trim(),
      String(description || '').trim()
    );

    req.session._msg = { type: 'success', text: `NAS ${nasname} agregado.` };
  } catch (error) {
    logger.error('Error adding NAS:', error);
    req.session._msg = { type: 'danger', text: 'No se pudo agregar el NAS:' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/edit', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id, nasname, shortname, secret, description, is_active } = req.body;
    if (!id || !nasname || !secret) {
      throw new Error('El ID, la IP del NAS y el secreto compartido son obligatorios.');
    }

    db.prepare(`
      UPDATE radius_nas
      SET nasname = ?, shortname = ?, secret = ?, description = ?, is_active = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(
      String(nasname).trim(),
      String(shortname || '').trim(),
      String(secret).trim(),
      String(description || '').trim(),
      is_active === '1' || is_active === 1 ? 1 : 0,
      id
    );

    req.session._msg = { type: 'success', text: `Datos del NAS ${nasname} actualizados.` };
  } catch (error) {
    logger.error('Error updating NAS:', error);
    req.session._msg = { type: 'danger', text: 'No se pudo actualizar el NAS:' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/toggle', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    const nas = db.prepare(`SELECT id, nasname, is_active FROM radius_nas WHERE id = ?`).get(id);
    if (nas) {
      const newStatus = nas.is_active ? 0 : 1;
      db.prepare(`UPDATE radius_nas SET is_active = ?, updated_at = (NOW_LOCAL()) WHERE id = ?`).run(newStatus, id);
      req.session._msg = { type: 'success', text: `Estado del NAS ${nas.nasname} cambiado a ${newStatus ? 'Activo' : 'Inactivo'}.` };
    }
  } catch (error) {
    logger.error('Error toggling NAS status:', error);
    req.session._msg = { type: 'danger', text: 'No se pudo cambiar el estado del NAS:' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/delete', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    db.prepare(`DELETE FROM radius_nas WHERE id = ?`).run(id);
    req.session._msg = { type: 'success', text: 'NAS eliminado.' };
  } catch (error) {
    logger.error('Error deleting NAS:', error);
    req.session._msg = { type: 'danger', text: 'No se pudo eliminar el NAS:' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

module.exports = router;
