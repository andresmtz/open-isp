/**
 * Permisos de técnicos (portal /tech), por persona. Pensado para técnicos tercerizados.
 *
 * Regla general: todo lo no habilitado queda prohibido (denegar por defecto).
 * Siempre puede: ver y trabajar SUS reclamos y órdenes de instalación asignados y su historial.
 * Nunca puede dar de alta clientes: eso lo hace la oficina o el administrador (Clientes → Nueva solicitud).
 * Nunca ve montos (precios, deudas, pagos) ni contraseñas de clientes.
 * Se guarda en technicians.permissions (JSON { clave: true|false }); el admin lo edita en Usuarios → Técnicos.
 */
const db = require('./database');

const ID = '\\d+';

const BASE = [
  ['GET', '^/$'],
  ['GET', '^/history$'],
  ['GET|POST', '^/logout$'],
  ['POST', `^/tickets/${ID}/update$`],        // solo sus reclamos (se valida en la ruta)
  ['GET', `^/customers/${ID}/house/${ID}$`],    // foto de la casa del cliente de una orden suya (nunca la cédula)
  ['POST', `^/orders/${ID}/equipment$`],         // etiqueta de la ONU, MAC y WiFi del cliente (solo sus órdenes de instalación)
];

const CATALOG = [
  { key: 'reclamos_libres', label: 'Ver y tomar reclamos sin asignar', help: 'Ve la bolsa de reclamos abiertos y puede tomarlos. También recibe por WhatsApp los reclamos nuevos sin asignar. Sin esto solo ve lo que vos le asignás.', rules: [
    ['GET', '^/pool$'],
    ['POST', `^/tickets/${ID}/take$`],
  ] },
  { key: 'mapa', label: 'Ver mapa de red', help: 'Clientes y cajas NAP en el mapa (nombre, dirección y estado; sin montos ni contraseñas).', rules: [
    ['GET', '^/map$'],
  ] },
  { key: 'asistencia', label: 'Marcar asistencia', help: 'Registrar entrada y salida (solo para personal propio; los tercerizados no lo necesitan).', rules: [
    ['GET', '^/attendance$'],
    ['POST', '^/attendance/(checkin|checkout)$'],
    ['GET', '^/api/attendance/history$'],
  ] },
  { key: 'equipos', label: 'Gestionar equipos del cliente', help: 'Monitoreo de ONU, cambiar nombre y clave del WiFi, reiniciar equipos (requiere GenieACS).', rules: [
    ['GET', '^/monitoring$'],
    ['GET', '^/api/devices$'],
    ['GET', '^/api/device/[^/]+$'],
    ['POST', '^/api/device/[^/]+/(ssid|password|reboot)$'],
    ['GET', '^/api/wifi-settings/[^/]+$'],
    ['GET', '^/api/add-wan-status/[^/]+$'],
    ['POST', '^/api/add-wan/[^/]+$'],
  ] },
];

const compile = (rules) => rules.map(([m, re]) => ({ methods: m.split('|'), re: new RegExp(re) }));
const BASE_C = compile(BASE);
const CATALOG_C = CATALOG.map(p => ({ key: p.key, rules: compile(p.rules) }));

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  const cols = db.prepare('PRAGMA table_info(technicians)').all().map(c => c.name);
  if (!cols.includes('permissions')) db.exec('ALTER TABLE technicians ADD COLUMN permissions TEXT');
  _schemaOk = true;
}

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
function normalize(input) {
  const out = {};
  for (const p of CATALOG) out[p.key] = !!(input && truthy(input[p.key]));
  return out;
}

const _cache = new Map();
function current(techId) {
  const id = Number(techId) || 0;
  const hit = _cache.get(id);
  if (hit && Date.now() - hit.at < 3000) return hit.perms;
  ensureSchema();
  let obj = null;
  try { const r = db.prepare('SELECT permissions FROM technicians WHERE id = ?').get(id); obj = r && r.permissions ? JSON.parse(r.permissions) : null; } catch (_) {}
  const perms = normalize(obj);
  _cache.set(id, { at: Date.now(), perms });
  return perms;
}

function save(techId, input) {
  ensureSchema();
  const out = normalize(input);
  db.prepare('UPDATE technicians SET permissions = ? WHERE id = ?').run(JSON.stringify(out), Number(techId));
  _cache.delete(Number(techId));
  return out;
}

const summary = (perms) => CATALOG.filter(p => perms[p.key]).map(p => p.label);
const has = (session, key) => !!(session && session.techId && current(session.techId)[key]);

function allows(session, method, path) {
  if (!session || !session.techId) return false;
  const m = method === 'HEAD' ? 'GET' : method;
  const p = String(path || '/').replace(/\/+$/, '') || '/';
  const hit = (rules) => rules.some(r => r.methods.includes(m) && r.re.test(p));
  if (hit(BASE_C)) return true;
  const perms = current(session.techId);
  return CATALOG_C.some(c => perms[c.key] && hit(c.rules));
}

/** Middleware del portal /tech (después del login). */
function guard(req, res, next) {
  const s = req.session;
  if (!s || !s.isTechnician || !s.techId) return next(); // requireTechSession se encarga
  try {
    const row = db.prepare('SELECT is_active FROM technicians WHERE id = ?').get(s.techId);
    if (!row || !row.is_active) return req.session.destroy(() => res.redirect('/tech/login'));
  } catch (_) {}
  if (/^\/login$/.test(req.path) || allows(s, req.method, req.path)) return next();
  const msg = 'No tenés permiso para esta sección. Consultá con la administración.';
  if (req.xhr || req.path.startsWith('/api/') || /json/i.test(req.get('accept') || '')) return res.status(403).json({ ok: false, success: false, error: msg, message: msg });
  req.session._msg = { type: 'error', text: msg };
  return res.redirect('/tech');
}

/** Técnicos activos con teléfono que pueden recibir avisos de reclamos/solicitudes sin asignar. */
function broadcastRecipients() {
  ensureSchema();
  return db.prepare("SELECT id, name, phone, permissions FROM technicians WHERE is_active = 1 AND COALESCE(phone,'') <> ''").all()
    .filter(t => { try { return normalize(t.permissions ? JSON.parse(t.permissions) : null).reclamos_libres; } catch (_) { return false; } })
    .map(({ permissions, ...t }) => t);
}

/** Cierra las sesiones abiertas de un técnico. */
function closeSessions(techId) {
  try {
    const id = Number(techId);
    return db.prepare(`DELETE FROM sessions WHERE data LIKE '%"isTechnician":true%' AND (data LIKE ? OR data LIKE ?)`).run(`%"techId":${id},%`, `%"techId":${id}}%`).changes;
  } catch (_) { return 0; }
}

module.exports = { CATALOG, BASE, ensureSchema, normalize, current, save, summary, has, allows, guard, broadcastRecipients, closeSessions };
