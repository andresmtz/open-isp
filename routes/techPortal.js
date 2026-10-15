const express = require('express');
const router = express.Router();
const techSvc = require('../services/techService');
const customerSvc = require('../services/customerService');
const odpSvc = require('../services/odpService');
const { getSetting, getNowLocal, getCurrentDateInTimezone, getNowLocalISO, formatDateLocal, getSettings, formatTimeLocal, parseDateInTimezone } = require('../config/settingsManager');
const mikrotikService = require('../services/mikrotikService');
const db = require('../config/database');
const oltSvc = require('../services/oltService');
const attendanceSvc = require('../services/attendanceService');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadAttendance, removeAttendanceFile } = require('../middleware/attendanceUpload');
const genieacsApi = require('../config/genieacs');
const rawAxios = require('axios');
const regional = require('../config/regional');
const techPerms = require('../config/techPermissions');

const axios = {
  get: async (url, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && (url.startsWith('local/') || url === 'local')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.get(reqPath, config);
    }
    return rawAxios.get(url, config);
  },
  post: async (url, data, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && url.startsWith('local/')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.post(reqPath, data, config);
    }
    return rawAxios.post(url, data, config);
  },
  delete: async (url, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && url.startsWith('local/')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.delete(reqPath, config);
    }
    return rawAxios.delete(url, config);
  },
  put: async (url, data, config = {}) => {
    if (genieacsApi.isBuiltinAcsEnabled() && url.startsWith('local/')) {
      const reqPath = url.replace(/^local/, '');
      const instance = genieacsApi.createAxiosInstance({ id: 'builtin', url: 'local' });
      return instance.put(reqPath, data, config);
    }
    return rawAxios.put(url, data, config);
  }
};

// Configure multer for photo uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../public/uploads/tickets');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'ticket-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (JPEG, PNG, GIF, WebP)'));
    }
  }
});

const waSendDedup = new Map();
function normalizeWaDigits(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  digits = regional.normalizePhone(digits);
  if (digits.length < 8) return '';
  return digits;
}
function shouldSendWa(key, ttlMs = 15000) {
  const now = Date.now();
  const last = waSendDedup.get(key);
  if (last && (now - last) < ttlMs) return false;
  waSendDedup.set(key, now);
  if (waSendDedup.size > 5000) {
    for (const [k, t] of waSendDedup.entries()) {
      if ((now - t) > 10 * 60 * 1000) waSendDedup.delete(k);
    }
  }
  return true;
}

function requireTechSession(req, res, next) {
  if (req.session && req.session.isTechnician && req.session.techId) {
    return next();
  }
  res.redirect('/tech/login');
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function company() { return getSetting('company_header', 'ISP App'); }

router.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.settings = getSettings();
  res.locals.formatDateLocal = formatDateLocal;
  res.locals.formatTimeLocal = formatTimeLocal;
  res.locals.parseDateInTimezone = parseDateInTimezone;
  res.locals.getNowLocal = getNowLocal;
  res.locals.can = (key) => techPerms.has(req.session, key);
  next();
});

// Técnicos (muchos tercerizados): solo lo que el administrador habilitó a cada uno; cuenta desactivada → fuera
router.use(techPerms.guard);

let loginRateLimiter = (req, res, next) => next();
try {
  const rlMod = require('../middleware/rateLimiter');
  if (rlMod && typeof rlMod.loginRateLimiter === 'function') {
    loginRateLimiter = rlMod.loginRateLimiter;
  }
} catch (e) {}

// --- AUTH ---
router.get('/login', (req, res) => {
  if (req.session && req.session.isTechnician) return res.redirect('/tech');
  res.render('tech/login', { title: 'Ingreso de técnicos', company: company(), error: null });
});

router.post('/login', loginRateLimiter, express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const tech = techSvc.authenticate(username, password);
  if (tech) {
    return req.session.regenerate(() => {
      req.session.isTechnician = true;
      req.session.techId = tech.id;
      req.session.techName = tech.name;
      req.session.save(() => res.redirect('/tech'));
    });
  }
  res.render('tech/login', { title: 'Ingreso de técnicos', company: company(), error: '¡Usuario o contraseña incorrectos!' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/tech/login');
});

// --- DASHBOARD (My Tickets) ---
router.get('/', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const stats = techSvc.getTechStats(techId);
  if (!techPerms.has(req.session, 'reclamos_libres')) stats.open = null; // no ve cuántos reclamos hay sin asignar
  const myTickets = techSvc.getAssignedTickets(techId);
  // Fotos de la casa del cliente (solo en órdenes abiertas o en curso; la cédula nunca se muestra al técnico)
  try {
    const docs = require('../services/customerDocumentService');
    for (const t of myTickets) {
      t.housePhotos = (t.customer_id && ['open', 'in_progress'].includes(t.status))
        ? docs.list(t.customer_id, { kinds: ['casa'] }).map(d => `/tech/customers/${t.customer_id}/house/${d.id}`) : [];
      if (t.kind === 'install' && t.customer_id) {
        const c = db.prepare('SELECT reg_wifi_ssid, reg_wifi_status, reg_onu_mac FROM customers WHERE id=?').get(t.customer_id) || {};
        t.equipment = { ssid: c.reg_wifi_ssid || '', status: c.reg_wifi_status || '', mac: c.reg_onu_mac || '', labels: docs.list(t.customer_id, { kinds: ['etiqueta'] }).length };
      }
    }
  } catch (_) {}
  
  res.render('tech/dashboard', {
    title: 'Panel del técnico', 
    company: company(), 
    techName: req.session.techName,
    activePage: 'dashboard',
    stats,
    tickets: myTickets,
    msg: flashMsg(req)
  });
});

// Orden de instalación: el técnico carga la foto de la etiqueta de la ONU, la MAC y el WiFi que eligió el cliente
const equipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype || '')) });
router.post('/orders/:ticketId/equipment', requireTechSession, equipUpload.array('label', 3), async (req, res) => {
  const wantsJson = /json/.test(String(req.headers.accept || ''));
  try {
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(req.params.ticketId));
    if (!t || Number(t.technician_id) !== Number(req.session.techId) || t.kind !== 'install' || !['open', 'in_progress'].includes(t.status)) throw new Error('Orden no disponible.');
    const by = `técnico ${req.session.techName || ''}`.trim();
    const docs = require('../services/customerDocumentService');
    let photos = 0;
    for (const f of (req.files || [])) { await docs.add(t.customer_id, 'etiqueta', f.buffer, by); photos++; }
    const r = await require('../services/installationService').setEquipment(t.customer_id, { ssid: req.body.ssid, key: req.body.key, mac: req.body.mac }, by);
    const c = db.prepare('SELECT name FROM customers WHERE id=?').get(t.customer_id);
    try {
      await require('../services/waNotifyService').notifyAdmin(`📦 *Datos del equipo cargados* — ${c ? c.name : ''}\nPor: ${by}\n` +
        [photos ? `Foto(s) de la etiqueta: ${photos}` : '', ...r.saved].filter(Boolean).join('\n') +
        `\n\n${r.wifi && r.wifi.ok ? '✅ ' + r.wifi.message : '👉 Vinculá la ONU en Clientes → Inscriptos → "Equipo".'}`);
    } catch (_) {}
    // Lectura de la etiqueta y configuración automática de la ONU (en segundo plano: tarda 1 a 3 minutos)
    if (photos) {
      const imgs = (req.files || []).map(f => f.buffer);
      setImmediate(() => require('../services/onuAutoProvisionService').fromLabel(t.customer_id, imgs, { actor: by }).catch(e => require('../config/logger').logger.warn('[Etiqueta] ' + e.message)));
    }
    const msg = (photos ? `${photos} foto(s) guardada(s): se está leyendo la etiqueta y configurando la ONU; te llega el resultado por WhatsApp. ` : '') + (r.saved.length ? 'Datos guardados. ' : '') + (r.wifi && r.wifi.ok ? r.wifi.message : '');
    if (wantsJson) return res.json({ ok: true, message: msg });
    req.session._msg = { type: 'success', text: msg };
  } catch (e) {
    if (wantsJson) return res.status(400).json({ ok: false, message: e.message });
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('/tech');
});

// Foto de la casa: solo si el técnico tiene una orden abierta o en curso de ese cliente
router.get('/customers/:cid/house/:docId', requireTechSession, (req, res) => {
  const docs = require('../services/customerDocumentService');
  const d = docs.get(req.params.docId);
  if (!d || d.kind !== 'casa' || Number(d.customer_id) !== Number(req.params.cid) || !docs.techHasCustomer(req.session.techId, d.customer_id)) return res.status(404).send('No disponible');
  const p = docs.filePath(d);
  if (!p) return res.status(404).send('No disponible');
  res.set('Cache-Control', 'private, max-age=300');
  res.type('jpg').sendFile(p);
});

// --- OPEN TICKETS (Pool) ---
router.get('/pool', requireTechSession, (req, res) => {
  const openTickets = techSvc.getOpenTickets();
  res.render('tech/pool', {
    title: 'Reclamos sin asignar',
    company: company(), 
    activePage: 'pool',
    tickets: openTickets,
    msg: flashMsg(req)
  });
});

// --- HISTORY TICKETS ---
router.get('/history', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const historyTickets = techSvc.getResolvedTickets(techId);
  res.render('tech/history', {
    title: 'Historial de tickets', 
    company: company(), 
    activePage: 'history',
    tickets: historyTickets,
    msg: flashMsg(req)
  });
});

// --- NETWORK MAP ---
router.get('/map', requireTechSession, (req, res) => {
  // Solo lo necesario para ubicar: nunca montos, contraseñas, cédula ni correo
  const CUST_FIELDS = ['id', 'name', 'address', 'area', 'lat', 'lng', 'status', 'phone', 'customer_code', 'package_name', 'speed_down', 'speed_up', 'pppoe_username', 'odp_id', 'odp_name', 'cable_path'];
  const customers = customerSvc.getAllCustomers().map((c) => {
    const o = {};
    for (const k of CUST_FIELDS) if (c[k] !== undefined) o[k] = c[k];
    return o;
  });
  const odps = odpSvc.getAllOdps().map(({ id, name, description, lat, lng, pon_port, port_capacity, olt_id }) => ({ id, name, description, lat, lng, pon_port, port_capacity, olt_id }));
  
  res.render('tech/map', { 
    title: 'Mapa de red', 
    company: company(), 
    activePage: 'map', 
    customers, 
    odps,
    msg: flashMsg(req),
    settings: getSetting('office_lat') ? { office_lat: getSetting('office_lat'), office_lng: getSetting('office_lng') } : {}
  });
});

// --- ACTIONS ---
router.post('/tickets/:id/take', requireTechSession, (req, res) => {
  try {
    const tk = db.prepare('SELECT status, technician_id FROM tickets WHERE id = ?').get(req.params.id);
    if (!tk) throw new Error('el reclamo no existe');
    if (tk.status !== 'open' || (tk.technician_id && Number(tk.technician_id) !== Number(req.session.techId))) throw new Error('ya lo tomó otro técnico o no está abierto');
    techSvc.takeTicket(req.params.id, req.session.techId);
    req.session._msg = { type: 'success', text: 'Ticket tomado. Ya podés empezar a trabajarlo.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo tomar el ticket:' + e.message };
  }
  res.redirect('/tech');
});

router.post('/tickets/:id/update', requireTechSession, upload.array('photos', 10), async (req, res) => {
  try {
    const { status, notes } = req.body;
    const ticketId = req.params.id;
    const techId = req.session.techId;
    // Solo sus propios reclamos, y solo estos estados
    const own = db.prepare('SELECT technician_id FROM tickets WHERE id = ?').get(ticketId);
    if (!own || Number(own.technician_id) !== Number(techId)) throw new Error('este reclamo no está asignado a vos');
    if (!['in_progress', 'resolved'].includes(String(status))) throw new Error('estado inválido');
    
    // Prepare photo data
    let photoPaths = [];
    let photoMetadata = [];
    
    if (req.files && req.files.length > 0) {
      photoPaths = req.files.map(f => '/uploads/tickets/' + f.filename);
      photoMetadata = req.files.map((f, idx) => ({
        filename: f.filename,
        originalName: f.originalname,
        size: f.size,
        uploadedAt: getNowLocalISO(),
        lat: req.body.gps_lat || '',
        lng: req.body.gps_lng || ''
      }));
    }
    
    // Update ticket with photos and notes
    techSvc.updateTicketStatus(ticketId, techId, status, {
      notes: notes || '',
      photos: JSON.stringify(photoPaths),
      photoMetadata: JSON.stringify(photoMetadata)
    });
    
    req.session._msg = { type: 'success', text: 'Estado del reclamo actualizado.' };

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET ---
    if (status === 'resolved') {
      try {
        const { getSettingsWithCache } = require('../config/settingsManager');
        const settings = getSettingsWithCache();
        
        if (settings.whatsapp_enabled) {
          const waNotify = require('../services/waNotifyService');
          const ticketSvc = require('../services/ticketService');
          const ticket = ticketSvc.getTicketById(ticketId);
          
          if (ticket) {
            const photoCount = photoPaths.length;
            const photoText = photoCount > 0 ? `\n📸 *Fotos del trabajo:* ${photoCount} adjuntas` : '';
            
            const waMsg = `✅ *RECLAMO RESUELTO*\n\n` +
                         `🎫 *Ticket:* #${ticket.id}\n` +
                         `👤 *Cliente:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Técnico:* ${req.session.techName}${photoText}\n\n` +
                         `Su reclamo fue resuelto. ¡Gracias por su paciencia!`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              const digits = normalizeWaDigits(ticket.customer_phone);
              if (digits) {
                const key = `ticket:resolved:customer:${ticketId}:${digits}`;
                if (shouldSendWa(key)) await waNotify.sendText(digits, waMsg);
              }
            }

            // Kirim ke Admin dengan info foto
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const notesText = notes ? `\n💬 *Catatan:* ${notes}` : '';
              const adminMsg = `✅ *TICKET RESUELTO*\n\n` +
                               `🎫 *Ticket:* #${ticket.id}\n` +
                               `👤 *Cliente:* ${ticket.customer_name}\n` +
                               `🛠️ *Técnico:* ${req.session.techName}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Mensaje:* ${ticket.message}${notesText}${photoText}`;
              const recipients = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                const digits = normalizeWaDigits(adminPhone);
                if (digits) recipients.add(digits);
              }
              for (const digits of recipients) {
                const key = `ticket:resolved:admin:${ticketId}:${digits}`;
                if (!shouldSendWa(key)) continue;
                await waNotify.sendText(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[TechPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo actualizar el reclamo:' + e.message };
  }
  res.redirect('/tech');
});

// --- MONITORING ONU ---
router.get('/monitoring', requireTechSession, async (req, res) => {
  const acsServers = genieacsApi.getAllACSServers();
  let pppoeProfiles = [];
  try {
      // Support multi-router: get routerId from query parameter if provided
      const selectedRouterId = req.query.router_id ? Number(req.query.router_id) : null;
      pppoeProfiles = await mikrotikService.getPppoeProfiles(selectedRouterId);
  } catch (e) {
      console.error('Failed to load PPPoE profiles from MikroTik:', e.message);
  }
  res.render('tech/monitoring', {
    title: 'Monitoring ONU',
    company: company(),
    activePage: 'monitoring',
    acsServers,
    pppoeProfiles,
    msg: flashMsg(req)
  });
});

// --- CREATE CUSTOMER (Technician) ---
router.get('/customers/new', requireTechSession, (req, res) => {
  const packages = customerSvc.getAllPackages();
  const odps = odpSvc.getAllOdps();
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  res.render('tech/create_customer', {
    title: 'Agregar cliente',
    company: company(),
    activePage: 'create_customer',
    packages,
    odps,
    routers,
    olts,
    msg: flashMsg(req)
  });
});

router.post('/customers', requireTechSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw new Error('El nombre del cliente es obligatorio');

    const customerData = {
      name,
      phone: String(req.body.phone || '').trim(),
      email: String(req.body.email || '').trim(),
      nik: String(req.body.nik || '').trim(),
      address: String(req.body.address || '').trim(),
      package_id: req.body.package_id ? Number(req.body.package_id) : null,
      pppoe_username: String(req.body.pppoe_username || '').trim(),
      router_id: req.body.router_id ? Number(req.body.router_id) : null,
      olt_id: req.body.olt_id ? Number(req.body.olt_id) : null,
      odp_id: req.body.odp_id ? Number(req.body.odp_id) : null,
      pon_port: String(req.body.pon_port || '').trim(),
      lat: String(req.body.lat || '').trim(),
      lng: String(req.body.lng || '').trim(),
      isolir_profile: String(req.body.isolir_profile || 'isolir').trim() || 'isolir',
      status: String(req.body.status || 'active').trim() || 'active',
      install_date: req.body.install_date ? String(req.body.install_date).trim() : null,
      notes: String(req.body.notes || '').trim(),
      auto_isolate: req.body.auto_isolate !== undefined ? Number(req.body.auto_isolate) : 1,
      isolate_day: req.body.isolate_day !== undefined ? Number(req.body.isolate_day) : 10
    };

    // VALIDATION: If customer has PPPoE connection, router_id is REQUIRED
    if (customerData.pppoe_username && !customerData.router_id) {
      throw new Error('Hay que elegir un router si la conexión es PPPoE');
    }

    if (customerData.pppoe_username) {
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(customerData.router_id ?? null, customerData.pppoe_username);
      if (existing) throw new Error(`El usuario PPPoE ya lo usa otro cliente: ${existing.name}`);

      let conn = null;
      try {
        conn = await mikrotikService.getConnection(customerData.router_id || null);
        const results = await conn.client.menu('/ppp/secret')
          .where('service', 'pppoe')
          .where('name', customerData.pppoe_username)
          .get();
        if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
      } finally {
        if (conn && conn.api) conn.api.close();
      }
    }

    const inserted = customerSvc.createCustomer(customerData);

    if (customerData.pppoe_username) {
      let targetProfile = '';
      if (customerData.status === 'suspended') {
        targetProfile = customerData.isolir_profile || 'isolir';
      } else if (customerData.package_id) {
        const pkg = customerSvc.getPackageById(customerData.package_id);
        if (pkg) targetProfile = pkg.name;
      }
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(customerData.pppoe_username, targetProfile, customerData.router_id);
        } catch (mErr) {}
      }
    }

    const updateOdpFlag = String(req.body.update_odp || '') === '1';
    if (updateOdpFlag && customerData.odp_id) {
      const existing = odpSvc.getOdpById(customerData.odp_id);
      if (existing) {
        const newLat = String(req.body.odp_lat || '').trim();
        const newLng = String(req.body.odp_lng || '').trim();
        const newCap = req.body.odp_port_capacity !== undefined && req.body.odp_port_capacity !== null && String(req.body.odp_port_capacity).trim() !== ''
          ? Number(req.body.odp_port_capacity)
          : (existing.port_capacity || 16);
        const newPon = String(req.body.odp_pon_port || '').trim();

        odpSvc.updateOdp(existing.id, {
          name: existing.name,
          olt_id: existing.olt_id,
          pon_port: newPon || existing.pon_port || '',
          port_capacity: Number.isFinite(newCap) && newCap > 0 ? Math.floor(newCap) : (existing.port_capacity || 16),
          lat: newLat || existing.lat || '',
          lng: newLng || existing.lng || '',
          description: existing.description || ''
        });
      }
    }

    req.session._msg = { type: 'success', text: `Cliente "${name}" creado.` };
    res.redirect('/tech/customers/new');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'No se pudo crear el cliente:' + e.message };
    res.redirect('/tech/customers/new');
  }
});

// API Endpoints for Technician
const customerDevice = require('../services/customerDeviceService');

router.get('/api/mikrotik/pppoe-users', requireTechSession, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    const usedRows = db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(usedRows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/pppoe-profiles', requireTechSession, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profiles = await mikrotikService.getPppoeProfiles(routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/odps/:id/ports', requireTechSession, (req, res) => {
  try {
    const odpId = Number(req.params.id);
    if (!odpId) return res.status(400).json({ error: 'NAP inválida' });
    const usage = odpSvc.getOdpPortUsage(odpId);
    if (!usage) return res.status(404).json({ error: 'NAP no encontrada' });
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/devices', requireTechSession, async (req, res) => {
  try {
    const { search, status, acs, limit = 999999, offset = 0 } = req.query;
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
    if (!result.ok) return res.json({ error: result.message });
    
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
        tags: d._tags || [],
        serialNumber: mapped.serialNumber,
        lastInform: d._lastInform,
        status: mapped.status.toLowerCase(),
        pppoeIP: mapped.pppoeIP,
        pppoeUsername: mapped.pppoeUsername,
        rxPower: mapped.rxPower,
        uptime: mapped.uptime,
        model: mapped.model,
        softwareVersion: mapped.softwareVersion,
        userConnected: mapped.totalAssociations,
        ssid: mapped.ssid,
        customerId: customer ? customer.id : null,
        customerName: customer ? customer.name : '',
        customerPhone: customer ? customer.phone : '',
        acsServerName: d._acs_server_name || 'Default ACS',
        acsServerId: d._acs_server_id || 'legacy',
        manufacturer: d._deviceId?._Manufacturer || d._deviceId?.Manufacturer || '-'
      };
    });

    if (search) {
      const s = search.toLowerCase();
      devices = devices.filter(d => 
        d.id.toLowerCase().includes(s) ||
        d.tags.some(t => t.toLowerCase().includes(s)) || 
        d.serialNumber.toLowerCase().includes(s) || 
        (d.pppoeUsername && d.pppoeUsername !== 'N/A' && d.pppoeUsername.toLowerCase().includes(s)) ||
        (d.customerName && d.customerName.toLowerCase().includes(s)) ||
        (d.customerPhone && d.customerPhone.toLowerCase().includes(s))
      );
    }

    if (acs && acs !== 'all') {
      devices = devices.filter(d => String(d.acsServerId) === String(acs));
    }

    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    
    res.json({ devices: devices, total: devices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/device/:tag', requireTechSession, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireTechSession, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const { getSettingsWithCache } = require('../config/settingsManager');
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const tag = req.params.tag;
        const cust = customerSvc.findCustomerByAny(tag);
        if (cust && cust.phone) {
          const waNotify = require('../services/waNotifyService');
          if (true) {
            const now = getNowLocal();
            const msg = `📶 *CAMBIO DE NOMBRE DEL WIFI*\n\n` +
              `👤 *Cliente:* ${cust.name}\n` +
              `🕒 *Fecha:* ${now}\n\n` +
              `El nombre (SSID) de su WiFi ahora es:\n` +
              `\ud83d\udce1 *${ssid}*\n\n` +
              `Seleccione la nueva red en sus dispositivos para conectarse.\n` +
              `⚠️ No comparta esta información.`;
            await waNotify.sendText(cust.phone, msg);
          }
        }
      }
    } catch (e) { /* ignore WA notification errors */ }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireTechSession, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const { getSettingsWithCache } = require('../config/settingsManager');
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const tag = req.params.tag;
        const cust = customerSvc.findCustomerByAny(tag);
        if (cust && cust.phone) {
          const waNotify = require('../services/waNotifyService');
          if (true) {
            const now = getNowLocal();
            const msg = `🔑 *CAMBIO DE CONTRASEÑA DEL WIFI*\n\n` +
              `👤 *Cliente:* ${cust.name}\n` +
              `🕒 *Fecha:* ${now}\n\n` +
              `La contraseña de su WiFi ahora es:\n` +
              `\ud83d\udd10 *${password}*\n\n` +
              `Use la nueva contraseña para conectarse.\n` +
              `⚠️ No comparta esta contraseña.`;
            await waNotify.sendText(cust.phone, msg);
          }
        }
      }
    } catch (e) { /* ignore WA notification errors */ }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireTechSession, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

// ─── ATTENDANCE ROUTES ───────────────────────────────────────────────────────

// Get attendance page
router.get('/attendance', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const todayAttendance = attendanceSvc.getTodayAttendance('technician', techId);
  const history = attendanceSvc.getAttendanceHistory('technician', techId, 10);
  
  // Get monthly summary
  const now = getCurrentDateInTimezone();
  const summary = attendanceSvc.getMonthlyAttendanceSummary(
    'technician',
    techId,
    now.getFullYear(),
    now.getMonth() + 1
  );
  
  res.render('tech/attendance', {
    title: 'Asistencia',
    company: company(),
    activePage: 'attendance',
    techName: req.session.techName,
    todayAttendance,
    history,
    summary,
    msg: flashMsg(req)
  });
});

// Check-in
router.post('/attendance/checkin', requireTechSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const techId = req.session.techId;
    const techName = req.session.techName;

    if (!req.file) {
      return res.json({ success: false, message: 'La foto de entrada es obligatoria' });
    }
    
    // Check if already checked in today
    const today = attendanceSvc.getTodayAttendance('technician', techId);
    if (today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Ya registraste tu entrada hoy' });
    }
    
    // Prepare photo path
    let photoPath = '';
    if (req.file) {
      photoPath = '/uploads/attendance/' + req.file.filename;
    }
    
    const result = attendanceSvc.checkIn({
      employee_type: 'technician',
      employee_id: techId,
      employee_name: techName,
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: photoPath
    });
    
    res.json({ success: true, message: '¡Entrada registrada!', id: result.lastInsertRowid });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'No se pudo registrar la entrada:' + e.message });
  }
});

// Check-out
router.post('/attendance/checkout', requireTechSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const techId = req.session.techId;

    if (!req.file) {
      return res.json({ success: false, message: 'La foto de salida es obligatoria' });
    }
    
    // Get today's attendance
    const today = attendanceSvc.getTodayAttendance('technician', techId);
    if (!today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Todavía no registraste tu entrada hoy' });
    }
    
    if (today.status === 'checked_out') {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Ya registraste tu salida hoy' });
    }
    
    // Prepare photo path
    let photoPath = '';
    if (req.file) {
      photoPath = '/uploads/attendance/' + req.file.filename;
    }
    
    attendanceSvc.checkOut(today.id, {
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: photoPath
    });
    
    res.json({ success: true, message: '¡Salida registrada!' });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'No se pudo registrar la salida:' + e.message });
  }
});

// Get attendance history (API)
router.get('/api/attendance/history', requireTechSession, (req, res) => {
  try {
    const techId = req.session.techId;
    const limit = req.query.limit ? parseInt(req.query.limit) : 30;
    const history = attendanceSvc.getAttendanceHistory('technician', techId, limit);
    res.json({ success: true, data: history });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Helpers for GenieACS Server DB access inside Technician Portal
function getACSServers(id = null) {
    if (genieacsApi.isBuiltinAcsEnabled()) {
        const builtinServer = {
            id: 'builtin',
            name: 'Built-in ACS',
            url: 'local',
            status: 'active'
        };
        if (id && id !== 'all') {
            return id === 'builtin' ? [builtinServer] : [];
        }
        return [builtinServer];
    }

    const legacyACS = getLegacyACS();
    const legacyServer = legacyACS.acs_url ? { 
        id: 'legacy', 
        name: 'Default ACS', 
        url: legacyACS.acs_url, 
        username: legacyACS.acs_user, 
        password: legacyACS.acs_pass 
    } : null;

    if (id === 'legacy') return legacyServer ? [legacyServer] : [];

    let query = 'SELECT * FROM genieacs_servers';
    let params = [];
    if (id && id !== 'all') {
        query += ' WHERE id = ?';
        params.push(id);
        const row = db.prepare(query).get(params);
        return row ? [row] : [];
    }
    
    const rows = db.prepare(query).all(params);
    return legacyServer ? [legacyServer, ...rows] : rows;
}

function getLegacyACS() {
    return {
        acs_url: getSetting('genieacs_url', ''),
        acs_user: getSetting('genieacs_username', ''),
        acs_pass: getSetting('genieacs_password', '')
    };
}

function getAxiosConfig(server) {
    const config = {
        timeout: 15000,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    if (server.username && server.password) {
        config.auth = {
            username: server.username,
            password: server.password
        };
    }
    return config;
}

function normalizeUrl(url) {
    if (!url) return '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toBool(value) {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function normalizeSelectionArray(value) {
    const items = Array.isArray(value) ? value : (value ? [value] : []);
    return Array.from(new Set(
        items.map(v => String(v || '').trim()).filter(Boolean)
    ));
}

function buildSingleParamTasks(parameterValues) {
    return (parameterValues || [])
        .filter(pv => Array.isArray(pv) && pv.length >= 2 && pv[0])
        .map(pv => ({
            name: 'setParameterValues',
            payload: { parameterValues: [pv] }
        }));
}

function buildBuiltinAddWanWorkflow({
    mode,
    parsedVlan,
    pppoeUser,
    pppoePass,
    dhcp,
    lanPorts,
    wlanSsids,
    configureWifi,
    wifiSsid24,
    wifiPass24,
    wifiSsid5,
    wifiPass5,
    manufacturer,
    wlanConfig
}) {
    const isPppoe = mode === 'pppoe';
    const connectionType = isPppoe ? 'WANPPPConnection' : 'WANIPConnection';
    const lanPortsArray = normalizeSelectionArray(lanPorts);
    const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
    const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}.{{wanConnectionInstance}}`;
    const followup = [];

    const baseParamValues = [
        [`${baseConnPath}.Enable`, true, 'xsd:boolean'],
        [`${baseConnPath}.ConnectionType`, isPppoe ? 'IP_Routed' : 'Bridged', 'xsd:string']
    ];

    if (isPppoe) {
        baseParamValues.push(
            [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
            [`${baseConnPath}.Username`, pppoeUser, 'xsd:string'],
            [`${baseConnPath}.Password`, pppoePass, 'xsd:string']
        );
    }

    followup.push(...buildSingleParamTasks(baseParamValues));

    const vendorParamValues = [];
    if (manufacturer.includes('huawei')) {
        vendorParamValues.push(
            [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
            [`${baseConnPath}.X_HW_WANMode`, isPppoe ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else if (manufacturer.includes('zte')) {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
        if (lanPortsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
        }
        if (wlanSsidsArray.length > 0) {
            vendorParamValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
        }
    } else {
        vendorParamValues.push(
            [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
            [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
        );
    }

    followup.push(...buildSingleParamTasks(vendorParamValues));

    followup.push({
        name: 'setParameterValues',
        payload: {
            parameterValues: [[
                'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable',
                toBool(dhcp),
                'xsd:boolean'
            ]]
        }
    });

    const verifyNames = [
        `${baseConnPath}.Enable`,
        `${baseConnPath}.ConnectionType`,
        `${baseConnPath}.ExternalIPAddress`,
        `${baseConnPath}.Uptime`
    ];
    if (isPppoe) {
        verifyNames.push(`${baseConnPath}.Username`, `${baseConnPath}.NATEnabled`);
    }

    const wifiParamValues = [];
    const wlanObj = wlanConfig || {};
    if (toBool(configureWifi)) {
        if (wlanObj['1'] && wifiSsid24) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
            verifyNames.push('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
            if (wifiPass24) {
                wifiParamValues.push(
                    ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', wifiPass24, 'xsd:string'],
                    ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', wifiPass24, 'xsd:string']
                );
            }
        }

        const fiveGIndex = wlanObj['5'] ? '5' : (wlanObj['2'] ? '2' : null);
        if (fiveGIndex && wifiSsid5) {
            wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
            verifyNames.push(`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`);
            if (wifiPass5) {
                wifiParamValues.push(
                    [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                    [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                );
            }
        }
    }

    followup.push(...buildSingleParamTasks(wifiParamValues));
    followup.push({
        name: 'getParameterValues',
        payload: {
            parameterNames: Array.from(new Set(verifyNames))
        }
    });

    return {
        name: 'addObject',
        objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice',
        instanceVariable: 'wanDeviceInstance',
        followup: [{
            name: 'addObject',
            payload: {
                objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.{{wanDeviceInstance}}.${connectionType}`,
                instanceVariable: 'wanConnectionInstance',
                followup
            }
        }]
    };
}

function getNestedValue(obj, path) {
    try {
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
            if (!current) return null;
            current = current[part];
        }
        if (current && typeof current === 'object' && '_value' in current) {
            return current._value;
        }
        return current;
    } catch (e) {
        return null;
    }
}

// GET /tech/api/wifi-settings/:deviceId
router.get('/api/wifi-settings/:deviceId', requireTechSession, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).json({ success: false, message: 'ACS Server not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        
        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).json({ success: false, message: 'Device not found' });
        
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const bands = [];
        
        // Return all SSID indices (1 to 8) that exist on the ONU
        for (let i = 1; i <= 8; i++) {
            if (wlanConfig[String(i)]) {
                bands.push({
                    index: String(i),
                    ssid: getNestedValue(wlanConfig[String(i)], 'SSID') || `SSID ${i}`,
                    name: i <= 4 ? `Wi-Fi 2.4GHz (SSID ${i})` : `Wi-Fi 5GHz (SSID ${i})`
                });
            }
        }
        
        res.json({ success: true, bands });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /tech/api/add-wan/:deviceId
router.post('/api/add-wan/:deviceId', requireTechSession, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const {
            acsId,
            mode,
            vlanId,
            pppoeUser,
            pppoePass,
            pppoeProfile,
            autoCreateMikrotik,
            lanPorts,
            wlanSsids,
            configureWifi,
            wifiSsid24,
            wifiPass24,
            wifiSsid5,
            wifiPass5,
            dhcp
        } = req.body;
        
        // 1. Validasi awal
        const normalizedMode = String(mode || '').trim().toLowerCase();
        if (!['pppoe', 'bridge'].includes(normalizedMode)) {
            return res.json({ success: false, message: 'Modo WAN inválido' });
        }

        const parsedVlan = parseInt(vlanId, 10);
        if (isNaN(parsedVlan) || parsedVlan < 1 || parsedVlan > 4094) {
            return res.json({ success: false, message: 'VLAN ID inválido (debe ser 1-4094)' });
        }
        
        const trimmedPppoeUser = String(pppoeUser || '').trim();
        const trimmedPppoePass = String(pppoePass || '').trim();
        if (normalizedMode === 'pppoe' && (!trimmedPppoeUser || !trimmedPppoePass)) {
            return res.json({ success: false, message: 'El usuario y la contraseña PPPoE son obligatorios en modo PPPoE' });
        }
        
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS Server tidak ditemukan' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const config = getAxiosConfig(server);
        
        // 2. Jika Auto-create MikroTik diaktifkan
        if (normalizedMode === 'pppoe' && toBool(autoCreateMikrotik)) {
            try {
                await mikrotikService.createPppoeSecret({
                    username: trimmedPppoeUser,
                    password: trimmedPppoePass,
                    profile: pppoeProfile || 'default'
                });
            } catch (mErr) {
                console.error('[TechAddWAN] Failed to create PPPoE Secret in MikroTik:', mErr.message);
                return res.json({ success: false, message: `No se pudo crear la cuenta PPPoE en el MikroTik: ${mErr.message}` });
            }
        }
        
        // 3. Ambil data instansi WANConnectionDevice saat ini untuk menghitung nextInstance
        const getDeviceRes = await axios.get(`${baseUrl}/devices`, {
            ...config,
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_deviceId.Manufacturer,_deviceId._Manufacturer,InternetGatewayDevice.WANDevice.1.WANConnectionDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration'
            }
        });
        
        const deviceData = Array.isArray(getDeviceRes.data) && getDeviceRes.data.length > 0 ? getDeviceRes.data[0] : null;
        if (!deviceData) return res.json({ success: false, message: 'El CPE/equipo no se encontró en GenieACS' });
        
        const manufacturer = (deviceData._deviceId?._Manufacturer || deviceData._deviceId?.Manufacturer || '').toLowerCase();
        const wlanConfig = deviceData.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration || {};
        const isBuiltinServer = String(server.id || '').trim() === 'builtin' || baseUrl === 'local';

        if (isBuiltinServer) {
            const task = buildBuiltinAddWanWorkflow({
                mode: normalizedMode,
                parsedVlan,
                pppoeUser: trimmedPppoeUser,
                pppoePass: trimmedPppoePass,
                dhcp,
                lanPorts,
                wlanSsids,
                configureWifi,
                wifiSsid24,
                wifiPass24,
                wifiSsid5,
                wifiPass5,
                manufacturer,
                wlanConfig
            });

            await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, task, config);
            return res.json({ success: true, message: 'Se envió el proceso de alta WAN. Las tareas siguen la instancia original de la ONU.' });
        }

        const wanConnObj = deviceData.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice || {};
        const existingKeys = Object.keys(wanConnObj).map(Number).filter(n => !isNaN(n));
        const nextInstance = existingKeys.length > 0 ? Math.max(...existingKeys) + 1 : 2;

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.'
        }, config);

        const connectionType = normalizedMode === 'pppoe' ? 'WANPPPConnection' : 'WANIPConnection';
        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'addObject',
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${nextInstance}.${connectionType}.`
        }, config);

        const paramValues = [];
        const baseConnPath = `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${nextInstance}.${connectionType}.1`;
        paramValues.push([`${baseConnPath}.Enable`, true, 'xsd:boolean']);

        if (normalizedMode === 'pppoe') {
            paramValues.push(
                [`${baseConnPath}.ConnectionType`, 'IP_Routed', 'xsd:string'],
                [`${baseConnPath}.NATEnabled`, true, 'xsd:boolean'],
                [`${baseConnPath}.Username`, trimmedPppoeUser, 'xsd:string'],
                [`${baseConnPath}.Password`, trimmedPppoePass, 'xsd:string']
            );
        } else {
            paramValues.push([`${baseConnPath}.ConnectionType`, 'Bridged', 'xsd:string']);
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: [[`InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPServerEnable`, toBool(dhcp), 'xsd:boolean']]
        }, config).catch(() => {});

        const lanPortsArray = normalizeSelectionArray(lanPorts);
        const wlanSsidsArray = normalizeSelectionArray(wlanSsids);
        if (manufacturer.includes('huawei')) {
            paramValues.push(
                [`${baseConnPath}.X_HW_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_HW_VLANMark`, true, 'xsd:boolean'],
                [`${baseConnPath}.X_HW_WANMode`, normalizedMode === 'pppoe' ? 'WAN_PPPOE' : 'WAN_BRIDGE', 'xsd:string']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_HW_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else if (manufacturer.includes('zte')) {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.X_ZTE_VLAN`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
            if (lanPortsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_LANBind`, lanPortsArray.join(','), 'xsd:string']);
            }
            if (wlanSsidsArray.length > 0) {
                paramValues.push([`${baseConnPath}.X_ZTE_SSIDBind`, wlanSsidsArray.join(','), 'xsd:string']);
            }
        } else {
            paramValues.push(
                [`${baseConnPath}.VLANIDMark`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANID`, parsedVlan, 'xsd:unsignedInt'],
                [`${baseConnPath}.VLANMode`, 1, 'xsd:unsignedInt']
            );
        }

        await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'setParameterValues',
            parameterValues: paramValues
        }, config);

        if (toBool(configureWifi)) {
            const wifiParamValues = [];
            if (wlanConfig['1'] && wifiSsid24) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID`, wifiSsid24, 'xsd:string']);
                if (wifiPass24) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey`, wifiPass24, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase`, wifiPass24, 'xsd:string']
                    );
                }
            }

            const fiveGIndex = wlanConfig['5'] ? '5' : (wlanConfig['2'] ? '2' : null);
            if (fiveGIndex && wifiSsid5) {
                wifiParamValues.push([`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.SSID`, wifiSsid5, 'xsd:string']);
                if (wifiPass5) {
                    wifiParamValues.push(
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.PreSharedKey.1.PreSharedKey`, wifiPass5, 'xsd:string'],
                        [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${fiveGIndex}.KeyPassphrase`, wifiPass5, 'xsd:string']
                    );
                }
            }

            if (wifiParamValues.length > 0) {
                await axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
                    name: 'setParameterValues',
                    parameterValues: wifiParamValues
                }, config);
            }
        }

        axios.post(`${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`, {
            name: 'refreshObject',
            objectName: ''
        }, config).catch(() => {});
        
        res.json({ success: true, message: 'Todas las tareas de alta WAN (y WiFi) se enviaron a GenieACS.' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

module.exports = router;
