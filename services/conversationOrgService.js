'use strict';
/**
 * Organización de Conversaciones (CRM v1, sin IA): bandejas, motivo, embudo de ventas con requisitos,
 * respuestas rápidas, vincular a un cliente y crear la solicitud de instalación desde el chat.
 *
 * Bandejas (cada conversación cae en una sola, en este orden):
 *   internas      números del personal, técnicos, administradores o marcadas a mano
 *   archivo       cerradas o sin movimiento hace más de crm_archive_days (30) días
 *   avisos        solo salieron mensajes nuestros (el contacto nunca escribió)
 *   por_atender   Meta AI derivó o el último mensaje es del contacto
 *   ventas        no es cliente (o es inscripto / cancelado): embudo de instalación
 *   cobranza      cliente respondiendo a un recordatorio, aviso final o suspensión
 *   clientes      el resto de los clientes
 *
 * Parámetros: crm_archive_days, crm_quick_replies (JSON [{title,text}]).
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const conv = require('./conversationService');

const INBOXES = {
  por_atender: 'Por atender', ventas: 'Ventas', clientes: 'Clientes', cobranza: 'Cobranza',
  internas: 'Internas', avisos: 'Avisos enviados', archivo: 'Archivo',
};
const MOTIVES = {
  instalacion: 'Instalación nueva', soporte: 'Soporte técnico', pago: 'Pago / comprobante', cobranza: 'Cobranza',
  baja: 'Baja / retiro', adicionales: 'Servicios adicionales', otro: 'Otro',
};
const STAGES = {
  nuevo: 'Nuevo', informado: 'Informado', requisitos: 'Requisitos pedidos', parciales: 'Datos parciales',
  listo: 'Listo para solicitud', solicitud: 'Solicitud creada', instalado: 'Instalado', perdido: 'Perdido',
};
const LOST = { sin_cobertura: 'Sin cobertura', precio: 'Precio', no_responde: 'No responde', otro_proveedor: 'Eligió otro proveedor', otro: 'Otro motivo' };

const KW = [
  ['baja', /\b(retir(o|ar|en)|dar de baja|darme de baja|cancelar el servicio|ya no (quiero|voy|necesito))\b/i],
  ['pago', /(comprobante|transfer|transf\b|pagu[eé]|ya pag|pago|giro|dep[oó]sit|alias|nro de cuenta|n[uú]mero de cuenta|cu[aá]nto debo|deuda)/i],
  ['soporte', /(sin internet|no (anda|funciona|tengo internet|hay internet|me anda|carga|conecta)|luz roja|\blos\b|lent[oa]|se (corta|cae)|cort[oó]|wifi|wi-fi|contraseñ|clave|router|m[oó]dem|se[ñn]al|desconect)/i],
  ['adicionales', /(c[aá]mara|seguridad|\btv\b|televis|notebook|computador|\bpc\b|impresora|celular|reparaci[oó]n|equipo inform)/i],
  ['instalacion', /(instal|precio|planes?\b|cobertura|llega (hasta|a)|contratar|cu[aá]nto (sale|cuesta|es)|megas|servicio nuevo|quiero (internet|el servicio|conectar)|fibra)/i],
];
const NOTICE = [
  ['Aviso final', /aviso final/i], ['Suspensión', /suspendid|suspensi[oó]n/i], ['Aviso de deuda', /aviso importante|aviso de deuda|registra.*sin pagar/i],
  ['Recordatorio de pago', /recordatorio|le recordamos|te recordamos|est[aá] por vencer/i], ['Confirmación de pago', /pago recibido|comprobante de pago|factura saldada/i],
];
const COBRANZA_NOTICES = new Set(['Aviso final', 'Suspensión', 'Aviso de deuda', 'Recordatorio de pago']);

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  conv.ensureSchema();
  const cols = db.prepare('PRAGMA table_info(wa_conversations)').all().map(c => c.name);
  const add = (n, t) => { if (!cols.includes(n)) db.exec(`ALTER TABLE wa_conversations ADD COLUMN ${n} ${t}`); };
  add('motive', "TEXT DEFAULT ''");
  add('lead_stage', "TEXT DEFAULT ''");
  add('lost_reason', "TEXT DEFAULT ''");
  add('internal', 'INTEGER');
  add('cedula_msg', 'INTEGER');
  add('fachada_msg', 'INTEGER');
  add('lead_name', "TEXT DEFAULT ''");
  _schema = true;
}

// ── contexto ────────────────────────────────────────────────────────────────
const intl = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  try { return require('../config/regional').normalizePhone(d); } catch (_) { return d; }
};
let _staff = { at: 0, set: new Set() };
function staffPhones() {
  if (Date.now() - _staff.at < 60000) return _staff.set;
  const set = new Set();
  const addAll = (arr) => arr.forEach(p => { const n = intl(p); if (n) set.add(n); });
  try { addAll(db.prepare("SELECT phone FROM cashiers WHERE COALESCE(phone,'')!=''").all().map(r => r.phone)); } catch (_) {}
  try { addAll(db.prepare("SELECT phone FROM technicians WHERE COALESCE(phone,'')!=''").all().map(r => r.phone)); } catch (_) {}
  const admins = getSetting('whatsapp_admin_numbers', []);
  addAll(Array.isArray(admins) ? admins : String(admins || '').split(','));
  _staff = { at: Date.now(), set };
  return set;
}

// ── análisis de una conversación ────────────────────────────────────────────
const _cache = new Map();
function analyze(c) {
  ensureSchema();
  const hour = Math.floor(Date.now() / 3600000);
  const key = [c.last_message_at, c.state, c.customer_id, c.customer_status, c.motive, c.lead_stage, c.lost_reason, c.internal, c.cedula_msg, c.fachada_msg, c.lead_name, hour].join('|');
  const hit = _cache.get(c.id);
  if (hit && hit.key === key) return hit.data;

  const msgs = db.prepare('SELECT id, ts, sender, body, media_type, lat, lng FROM wa_messages WHERE conv_id=? ORDER BY ts DESC, id DESC LIMIT 150').all(c.id);
  const clientCount = db.prepare("SELECT COUNT(*) n FROM wa_messages WHERE conv_id=? AND sender='cliente'").get(c.id).n;
  const fromClient = msgs.filter(m => m.sender === 'cliente');
  const ours = msgs.filter(m => m.sender !== 'cliente');

  // último aviso de cobranza o pago enviado por el sistema
  let notice = null;
  for (const m of msgs) {
    if (m.sender !== 'sistema' && m.sender !== 'persona') continue;
    const k = NOTICE.find(([, re]) => re.test(m.body || ''));
    if (k) { notice = { type: k[0], ts: m.ts }; break; }
  }

  // motivo
  let motiveAuto = 'otro';
  for (const m of fromClient.slice(0, 15)) {
    const hitKw = KW.find(([, re]) => re.test(m.body || ''));
    if (hitKw) { motiveAuto = hitKw[0]; break; }
  }
  const isCustomer = !!c.customer_id && !['inactive', 'cancelled'].includes(c.customer_status);
  if (isCustomer && notice && COBRANZA_NOTICES.has(notice.type) && fromClient[0] && fromClient[0].ts > notice.ts &&
      new Date(fromClient[0].ts) - new Date(notice.ts) < 10 * 86400000 && ['otro', 'pago'].includes(motiveAuto)) {
    motiveAuto = motiveAuto === 'pago' ? 'pago' : 'cobranza';
  }
  if (!isCustomer && motiveAuto === 'otro' && clientCount) motiveAuto = 'instalacion';
  const motive = c.motive || motiveAuto;

  // embudo de ventas
  const loc = fromClient.find(m => m.lat != null);
  const images = fromClient.filter(m => m.media_type === 'image').map(m => m.id);
  const askedReq = ours.find(m => /requisitos|foto (del frente )?de (su |tu |la )?c[eé]dula|fachada|ubicaci[oó]n (actual|gps)/i.test(m.body || ''));
  const informed = ours.find(m => /(\d{2,3}\.000|megas|\bplan(es)?\b|precio)/i.test(m.body || ''));
  const imgsAfterReq = askedReq ? fromClient.filter(m => m.media_type === 'image' && m.ts >= askedReq.ts).length : images.length;
  const name = String(c.lead_name || c.customer_name || '').trim();
  const check = {
    nombre: { ok: !!name, value: name || c.name || '' },
    cedula: { ok: !!c.cedula_msg, probable: !c.cedula_msg && imgsAfterReq >= 1 },
    fachada: { ok: !!c.fachada_msg, probable: !c.fachada_msg && imgsAfterReq >= 2 },
    ubicacion: { ok: !!loc, lat: loc ? loc.lat : null, lng: loc ? loc.lng : null },
  };
  const missing = Object.keys(check).filter(k => !check[k].ok);
  const missingProbable = Object.keys(check).filter(k => !check[k].ok && !check[k].probable);

  let stageAuto = 'nuevo';
  if (c.customer_id && c.customer_status === 'inactive') stageAuto = 'solicitud';
  else if (isCustomer) stageAuto = 'instalado';
  else if (!missing.length) stageAuto = 'listo';
  else if (c.cedula_msg || c.fachada_msg || loc || imgsAfterReq > 0) stageAuto = 'parciales';
  else if (askedReq) stageAuto = 'requisitos';
  else if (informed) stageAuto = 'informado';
  const stage = c.lost_reason ? 'perdido' : (c.lead_stage || stageAuto);
  const nearClose = ['parciales', 'listo'].includes(stage) && missingProbable.length <= 1;

  // bandeja
  const archiveDays = Math.max(1, Number(getSetting('crm_archive_days', 30)) || 30);
  const internal = c.internal === 1 || (c.internal !== 0 && staffPhones().has(intl(c.phone)));
  const old = !c.last_message_at || (Date.now() - new Date(c.last_message_at)) > archiveDays * 86400000;
  let inbox;
  if (internal) inbox = 'internas';
  else if (c.state === 'closed' || (old && c.state !== 'waiting_human')) inbox = 'archivo';
  else if (!clientCount) inbox = 'avisos';
  else if (c.state === 'waiting_human' || c.last_sender === 'cliente') inbox = 'por_atender';
  else if (!isCustomer) inbox = 'ventas';
  else if (motive === 'cobranza') inbox = 'cobranza';
  else inbox = 'clientes';

  const data = {
    inbox, motive, motiveAuto, stage, stageAuto, check, missing, nearClose, notice, internal,
    images, lead: !isCustomer, waitingSince: c.state === 'waiting_human' ? c.handoff_at : (c.last_sender === 'cliente' ? c.last_inbound_at : null),
  };
  _cache.set(c.id, { key, data });
  return data;
}

function allConvs() {
  ensureSchema();
  return db.prepare(`SELECT c.*, cu.name AS customer_name, cu.status AS customer_status, cu.customer_code
    FROM wa_conversations c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE c.last_message_at IS NOT NULL`).all();
}

const STAGE_ORDER = { listo: 0, parciales: 1, requisitos: 2, informado: 3, nuevo: 4, solicitud: 5, instalado: 6, perdido: 7 };
function list({ inbox = 'por_atender', q = '', motive = '' } = {}) {
  const rows = allConvs().map(c => Object.assign(c, { org: analyze(c) }));
  const counts = {};
  for (const r of rows) counts[r.org.inbox] = (counts[r.org.inbox] || 0) + 1;
  counts.cerca = rows.filter(r => r.org.inbox === 'ventas' && r.org.nearClose).length;
  let out = inbox === 'todas' ? rows : rows.filter(r => r.org.inbox === inbox);
  if (motive) out = out.filter(r => r.org.motive === motive);
  if (q) {
    const s = String(q).toLowerCase().trim();
    out = out.filter(r => [r.name, r.phone, r.customer_name, r.customer_code, r.labels, r.last_preview, r.lead_name, r.note].some(v => String(v || '').toLowerCase().includes(s)));
  }
  if (inbox === 'por_atender') out.sort((a, b) => (a.state === 'waiting_human' ? 0 : 1) - (b.state === 'waiting_human' ? 0 : 1) || String(a.org.waitingSince || '').localeCompare(String(b.org.waitingSince || '')));
  else if (inbox === 'ventas') out.sort((a, b) => (a.org.nearClose ? 0 : 1) - (b.org.nearClose ? 0 : 1) || STAGE_ORDER[a.org.stage] - STAGE_ORDER[b.org.stage] || String(b.last_message_at).localeCompare(String(a.last_message_at)));
  else out.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
  return { items: out.slice(0, 300), counts };
}

/** Panel lateral: datos del cliente o del lead. `money`: si la sesión puede ver montos. */
function info(convId, { money = false } = {}) {
  ensureSchema();
  const c = allConvs().find(x => x.id === Number(convId));
  if (!c) return null;
  const org = analyze(c);
  const out = { org, customer: null };
  if (c.customer_id) {
    const cu = db.prepare(`SELECT c.id, c.name, c.status, c.customer_code, c.address, c.reg_status, c.withdraw_status, p.name AS plan
      FROM customers c LEFT JOIN packages p ON p.id = c.package_id WHERE c.id=?`).get(c.customer_id);
    if (cu) {
      let tickets = 0;
      try { tickets = db.prepare("SELECT COUNT(*) n FROM tickets WHERE customer_id=? AND status IN ('open','in_progress')").get(cu.id).n; } catch (_) {}
      let onu = null;
      try { onu = db.prepare('SELECT status, onu_ref, seen_at FROM onu_inventory WHERE customer_id=? ORDER BY id DESC LIMIT 1').get(cu.id) || null; } catch (_) {}
      const debt = money ? db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0) t FROM invoices WHERE customer_id=? AND status='unpaid'").get(cu.id) : null;
      out.customer = Object.assign(cu, { tickets, onu, debt });
    }
  }
  return out;
}

function setOrg(convId, f) {
  ensureSchema();
  const id = Number(convId);
  if (!db.prepare('SELECT 1 FROM wa_conversations WHERE id=?').get(id)) throw new Error('Conversación no encontrada');
  const set = {};
  if (f.motive !== undefined) { if (f.motive && !MOTIVES[f.motive]) throw new Error('Motivo inválido'); set.motive = f.motive || ''; }
  if (f.lead_stage !== undefined) { if (f.lead_stage && !STAGES[f.lead_stage]) throw new Error('Etapa inválida'); set.lead_stage = f.lead_stage === 'perdido' ? '' : (f.lead_stage || ''); }
  if (f.lost_reason !== undefined) { if (f.lost_reason && !LOST[f.lost_reason]) throw new Error('Motivo de pérdida inválido'); set.lost_reason = f.lost_reason || ''; }
  if (f.internal !== undefined) set.internal = f.internal === '' || f.internal === null ? null : (Number(f.internal) ? 1 : 0);
  if (f.lead_name !== undefined) set.lead_name = String(f.lead_name || '').trim().slice(0, 120);
  for (const k of ['cedula_msg', 'fachada_msg']) {
    if (f[k] === undefined) continue;
    const v = f[k] ? Number(f[k]) : null;
    if (v && !db.prepare("SELECT 1 FROM wa_messages WHERE id=? AND conv_id=? AND media_type='image'").get(v, id)) throw new Error('Esa foto no es de esta conversación');
    set[k] = v;
  }
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE wa_conversations SET ${keys.map(k => k + '=?').join(', ')} WHERE id=?`).run(...keys.map(k => set[k]), id);
  return { ok: true };
}

// ── respuestas rápidas ──────────────────────────────────────────────────────
const DEFAULT_REPLIES = [
  { title: 'Pedir ubicación', text: 'Para confirmar la cobertura y coordinar la instalación, ¿nos podés enviar la ubicación de tu casa? 📍\n\nEn WhatsApp: tocá 📎 → *Ubicación* → *Enviar tu ubicación actual* (estando en la casa).\n\n¡Gracias!' },
  { title: 'Requisitos de instalación', text: '📋 *Requisitos para la instalación*\n\n✅ Foto del frente de tu cédula de identidad.\n✅ Foto de la fachada de la vivienda.\n✅ Tu *ubicación actual* por WhatsApp.\n\n💳 El primer mes se abona al finalizar la instalación; después los pagos son por adelantado.\nSi en algún momento das de baja el servicio, solo tenés que devolver los equipos entregados en comodato.' },
  { title: 'Planes', text: '📦 *Nuestros planes de internet por fibra óptica*\n\n{{planes}}\n\nSin contrato de permanencia. ¿Cuál te interesa?' },
  { title: 'Formas de pago', text: '{{formas_pago}}' },
  { title: 'Horario de atención', text: '🕗 Nuestro horario de atención es de *lunes a viernes de 08:00 a 17:00 hs*. Fuera de ese horario te respondemos en cuanto retomemos la actividad.' },
];
function quickReplies({ raw = false } = {}) {
  let list = DEFAULT_REPLIES;
  try { const v = getSetting('crm_quick_replies', ''); const arr = typeof v === 'string' ? (v ? JSON.parse(v) : null) : v; if (Array.isArray(arr) && arr.length) list = arr; } catch (_) {}
  if (raw) return list;
  const regional = require('../config/regional');
  const planes = db.prepare('SELECT name, price, speed_down FROM packages ORDER BY price').all()
    .map(p => `• ${p.speed_down ? Math.round(p.speed_down / 1000) + ' megas' : p.name}: ${regional.currencySymbol()} ${Number(p.price || 0).toLocaleString(regional.locale())} por mes`).join('\n');
  const pago = String(getSetting('corte_payment_info', '') || '').trim() || 'Consultanos las formas de pago disponibles.';
  return list.map(r => ({ title: String(r.title || ''), text: String(r.text || '').replace(/{{planes}}/g, planes).replace(/{{formas_pago}}/g, pago) }));
}
function saveQuickReplies(arr) {
  if (!Array.isArray(arr)) throw new Error('Formato inválido');
  const clean = arr.map(r => ({ title: String(r.title || '').trim().slice(0, 60), text: String(r.text || '').trim().slice(0, 3000) })).filter(r => r.title && r.text).slice(0, 30);
  require('../config/settingsManager').saveSettings({ crm_quick_replies: JSON.stringify(clean) });
  return clean.length;
}

// ── vincular a cliente / crear solicitud ────────────────────────────────────
function searchCustomers(q) {
  const s = String(q || '').trim();
  if (s.length < 2) return [];
  const like = '%' + s + '%';
  const digits = s.replace(/\D/g, '');
  return db.prepare(`SELECT id, name, customer_code, phone, status FROM customers
    WHERE name LIKE ? OR customer_code LIKE ? ${digits.length >= 4 ? 'OR phone LIKE ? OR alt_phones LIKE ?' : ''}
    ORDER BY (status='cancelled') ASC, name LIMIT 12`).all(...[like, like].concat(digits.length >= 4 ? ['%' + digits.slice(-8) + '%', '%' + digits.slice(-8) + '%'] : []));
}

function linkCustomer(convId, customerId) {
  ensureSchema();
  const c = db.prepare('SELECT * FROM wa_conversations WHERE id=?').get(Number(convId));
  if (!c) throw new Error('Conversación no encontrada');
  if (!c.phone) throw new Error('Este chat no tiene un número de teléfono visible; no se puede vincular.');
  const cust = db.prepare('SELECT id, name, phone, alt_phones FROM customers WHERE id=?').get(Number(customerId));
  if (!cust) throw new Error('Cliente no encontrado');
  const cp = require('../config/customerPhones');
  const regional = require('../config/regional');
  const already = cp.findByPhone(c.phone);
  if (already && already.id !== cust.id) throw new Error(`Ese número ya es de otro cliente: ${already.name}.`);
  if (!already) {
    const list = cp.parse(cp.list(cust).concat([regional.toLocalPhone(c.phone)]).join(','), { exceptId: cust.id, main: cust.phone });
    cp.save(cust.id, list);
  }
  db.prepare('UPDATE wa_conversations SET customer_id=? WHERE id=?').run(cust.id, c.id);
  return { ok: true, name: cust.name };
}

async function createRequest(convId, data, actor) {
  ensureSchema();
  const c = db.prepare('SELECT * FROM wa_conversations WHERE id=?').get(Number(convId));
  if (!c) throw new Error('Conversación no encontrada');
  if (!c.phone) throw new Error('Este chat no tiene un número de teléfono visible.');
  const org = analyze(Object.assign({}, c, { customer_status: null }));
  const lat = data.lat || (org.check.ubicacion.lat != null ? org.check.ubicacion.lat : '');
  const lng = data.lng || (org.check.ubicacion.lng != null ? org.check.ubicacion.lng : '');
  const inst = require('./installationService');
  const cust = await inst.createRequest({
    name: data.name, phone: c.phone, nik: data.nik || '', address: data.address, package_id: data.package_id,
    lat, lng, notes: ['Solicitud cargada desde Conversaciones de WhatsApp', String(data.notes || '').trim()].filter(Boolean).join(' — '),
  }, { source: 'WhatsApp', actor });
  db.prepare("UPDATE wa_conversations SET customer_id=?, lead_name=?, lead_stage='' WHERE id=?").run(cust.id, String(data.name || '').trim(), c.id);
  // fotos marcadas → documentos del cliente
  const docs = require('./customerDocumentService');
  const attached = [];
  for (const [col, kind] of [['cedula_msg', 'cedula'], ['fachada_msg', 'casa']]) {
    if (!c[col]) continue;
    try {
      const m = conv.message(c[col]);
      const rel = await conv.mediaPathFor(m, m.jid);
      const r = await conv.fetchMedia(rel);
      await docs.add(cust.id, kind, Buffer.from(await r.arrayBuffer()), actor);
      attached.push(docs.KINDS[kind]);
    } catch (e) { attached.push(docs.KINDS[kind] + ' (no se pudo adjuntar: ' + e.message + ')'); }
  }
  return { ok: true, customer: { id: cust.id, name: cust.name, code: cust.customer_code }, attached };
}

module.exports = {
  INBOXES, MOTIVES, STAGES, LOST, ensureSchema, analyze, list, info, setOrg, quickReplies, saveQuickReplies,
  searchCustomers, linkCustomer, createRequest,
};
