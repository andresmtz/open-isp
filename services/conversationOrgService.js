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
  por_atender: 'Por atender', ventas: 'Ventas', soporte: 'Soporte técnico', pagos: 'Pagos y cobranza', clientes: 'Clientes',
  internas: 'Internas', avisos: 'Avisos enviados', archivo: 'Archivo', ocultas: 'Ocultas',
};
const IGNORE_REASONS = { personal: 'Personal', promocion: 'Promoción / publicidad', spam: 'Spam / desconocido', otro: 'Otro' };
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
  ['soporte', /(sin internet|no (anda|funciona|tengo internet|hay internet|me anda|carga|conecta|navega)|luz roja|luz (del )?los|los (en )?rojo|lent[oa]|se (corta|cae)|se cort[oó]|cambiar (la )?(clave|contraseñ)|router|m[oó]dem|se[ñn]al|desconect)/i],
  ['adicionales', /(c[aá]mara|seguridad|\btv\b|televis|notebook|computador|\bpc\b|impresora|celular|reparaci[oó]n|equipo inform)/i],
  ['instalacion', /(instal|precio|planes?\b|cobertura|llega (hasta|a)|contratar|cu[aá]nto (sale|cuesta|es)|megas|servicio nuevo|quiero (internet|el servicio|conectar)|fibra)/i],
];
// Temas por puntaje: cuenta lo que escribe el cliente (x2) y lo que respondemos nosotros (Meta AI / persona)
const TOPIC = {
  pago: /(comprobante|pago recibido|pagu[eé]|ya pag|\bpag(o|ar|ue)\b|transfer|\bgiro|dep[oó]sit|alias|cu[aá]nto debo|deuda|factura|monto|abon(ar|[eé]|o)|mango|tigo money|billetera)/i,
  soporte: /(sin (servicio|internet|wi-?fi|wfi|se[ñn]al|conexi|luz|energ)|no (anda|funciona|tengo (internet|wi-?fi|se[ñn]al)|hay (internet|se[ñn]al)|carga|conecta|navega|me anda|est[aá] funcionando|funcion)|est[aá] funcionando|luz roja|luces|\broja\b|qu[eé] pas[oó]|volver(á)? (el|la) (wi-?fi|internet|servicio|se[ñn]al)|reactiv|reinici|contraseñ|cotrace|clave|dispositivo|lent[oa]|se (corta|cae|cort[oó])|cable|router|m[oó]dem|\bonu\b|velocidad|conexi[oó]n|se[ñn]al)/i,
  baja: /(retir(ar|o|en|amos)|dar de baja|baja del servicio|ya no (quiero|voy|vamos|lo uso|usamos)|cancelar el servicio|devolver el equipo)/i,
  instalacion: /(instal|cobertura|requisitos|\bplan(es)?\b|precio|contratar|fachada|c[eé]dula|ubicaci[oó]n)/i,
  adicionales: /(c[aá]mara|seguridad|\btv\b|televis|notebook|computador|impresora|reparaci)/i,
};
const NOTICE = [
  ['Aviso final', /aviso final/i], ['Suspensión', /suspendid|suspensi[oó]n/i], ['Aviso de deuda', /aviso importante|aviso de deuda|registra.*sin pagar/i],
  ['Recordatorio de pago', /recordatorio|le recordamos|te recordamos|est[aá] por vencer/i], ['Confirmación de pago', /pago recibido|comprobante de pago|factura saldada/i],
];
// "Gracias", "Dale ok", "Perfecto muchas gracias", "Bueno estaremos atentos gracias", emojis…
const ACK_WORDS = 'ok+|okey|oki|okis|dale|listo|lista|gracias|grasias|graciass*|muchas|much[ií]simas|mil|perfecto|perfecta|genial|bueno|buen[ií]simo|excelente|de nada|igualmente|amable|muy|ya|si|s[ií]|entendido|entiendo|estaremos|estamos|quedo|atent[oa]s?|un|saludo|saludos|bendiciones|bendecido|d[ií]a|noche|tarde|buen|buena|buenas|joya|super|s[uú]per|obrigad[oa]|vale|correcto|correto|claro|exacto|seguro|tranqui|tranquilo|nomas|nom[aá]s|a|usted|vos|ustedes|tambi[eé]n|todo|bien|chau|hasta|luego';
const ACK_RE = new RegExp('^(?:(?:' + ACK_WORDS + ')|[\\s!¡.,;:¿?…\\-]|\\p{Extended_Pictographic}|\\uFE0F|\\u200D)+$', 'iu');
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
  add('dismissed_at', 'TEXT');
  add('ignored', 'INTEGER DEFAULT 0');
  add('ignored_reason', "TEXT DEFAULT ''");
  add('ignored_by', "TEXT DEFAULT ''");
  add('ignored_at', 'TEXT');
  add('purged_before', 'TEXT');
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

// Posibles clientes por nombre (para chats desde un número que no está en su ficha)
const NAME_STOP = new Set(['km', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'new', 'nuevo', 'pon', 'pon1', 'pon2', 'sra', 'sr', 'don', 'doña']);
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const words = (t) => norm(t).split(/[^a-zñ]+/).filter(w => w.length >= 3 && !NAME_STOP.has(w));
let _cust = { at: 0, list: [] };
function customersForMatch() {
  if (Date.now() - _cust.at < 120000) return _cust.list;
  const list = db.prepare("SELECT id, name, customer_code, status FROM customers WHERE status != 'cancelled'").all()
    .map(c => Object.assign(c, { w: new Set(words(c.name)) }));
  _cust = { at: Date.now(), list };
  return list;
}
function suggestCustomers(name) {
  const w = words(name);
  if (w.length < 2) return [];
  return customersForMatch()
    .map(c => ({ c, n: w.filter(x => c.w.has(x)).length }))
    .filter(x => x.n >= 2)
    .sort((a, b) => b.n - a.n).slice(0, 3)
    .map(x => ({ id: x.c.id, name: x.c.name, customer_code: x.c.customer_code, status: x.c.status }));
}

// ── análisis de una conversación ────────────────────────────────────────────
const _cache = new Map();
function analyze(c) {
  ensureSchema();
  const hour = Math.floor(Date.now() / 3600000);
  const key = [c.last_message_at, c.dismissed_at, c.ignored, c.state, c.customer_id, c.customer_status, c.motive, c.lead_stage, c.lost_reason, c.internal, c.cedula_msg, c.fachada_msg, c.lead_name, hour].join('|');
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

  // motivo: solo el "episodio" actual (desde la última pausa de más de 3 días), lo más nuevo pesa el doble
  // se mide desde el último mensaje del cliente (lo nuestro posterior también cuenta)
  const episode = [];
  const anchor = Math.max(0, msgs.findIndex(m => m.sender === 'cliente'));
  for (let i = 0; i < msgs.length; i++) {
    if (i > anchor && (new Date(msgs[i - 1].ts) - new Date(msgs[i].ts)) > 3 * 86400000) break;
    episode.push(msgs[i]);
  }
  const score = {};
  episode.forEach((m, i) => {
    if (m.sender === 'sistema' || m.sender === 'auto') return; // plantillas automáticas no definen el tema
    const w = (m.sender === 'cliente' ? 2 : 1) * (i < 3 ? 4 : (i < 8 ? 2 : 1));
    for (const [k, re] of Object.entries(TOPIC)) if (re.test(m.body || '')) score[k] = (score[k] || 0) + w;
  });
  // fotos del cliente que nosotros tratamos como comprobante
  const recent = episode.slice(0, 6);
  if (recent.some(m => m.sender === 'cliente' && m.media_type === 'image') && recent.some(m => m.sender !== 'cliente' && /comprobante|pago recibido/i.test(m.body || ''))) score.pago = (score.pago || 0) + 4;
  let motiveAuto = 'otro', best = 0;
  // 1) lo que escribió el cliente en sus últimos mensajes de texto manda
  const clientTexts = episode.filter(m => m.sender === 'cliente' && m.body && !ACK_RE.test(String(m.body).trim())).slice(0, 3);
  const cscore = {};
  clientTexts.forEach((m, i) => { for (const [k, re] of Object.entries(TOPIC)) if (re.test(m.body)) cscore[k] = (cscore[k] || 0) + (3 - i); });
  for (const k of ['soporte', 'baja', 'pago', 'instalacion', 'adicionales']) if ((cscore[k] || 0) > best) { best = cscore[k]; motiveAuto = k; }
  // 2) si el cliente no escribió nada que indique el tema (audios, fotos, "gracias"), se usa toda la conversación reciente
  if (!best) for (const k of ['soporte', 'pago', 'baja', 'instalacion', 'adicionales']) if ((score[k] || 0) > best) { best = score[k]; motiveAuto = k; }
  const isCustomer = !!c.customer_id && !['inactive', 'cancelled'].includes(c.customer_status);
  const REQ_RE = /requisitos|c[eé]dula|fachada|ubicaci[oó]n/i;
  const reqMsg = ours.slice().reverse().find(m => ['meta_ai', 'persona', 'auto'].includes(m.sender) && REQ_RE.test(m.body || ''));
  // Quien no es cliente y habló de instalar (o ya le pidieron requisitos) es una venta, aunque mencione el wifi
  if (!isCustomer && !['pago', 'baja', 'adicionales'].includes(motiveAuto) &&
      (reqMsg || fromClient.some(m => TOPIC.instalacion.test(m.body || '')))) motiveAuto = 'instalacion';
  // respondió a un aviso de cobranza sin otro tema claro → cobranza
  if (isCustomer && motiveAuto === 'otro' && notice && COBRANZA_NOTICES.has(notice.type) && episode.some(m => m.ts === notice.ts)) motiveAuto = 'cobranza';
  if (!isCustomer && motiveAuto === 'otro' && clientCount) motiveAuto = 'instalacion';
  const motive = c.motive || motiveAuto;

  // embudo de ventas
  const loc = fromClient.find(m => m.lat != null);
  const images = fromClient.filter(m => m.media_type === 'image').map(m => m.id);
  const askedReq = reqMsg;
  const informed = ours.find(m => /(\d{2,3}\.000|megas|\bplan(es)?\b|precio)/i.test(m.body || ''));
  const imgsAfterReq = askedReq ? fromClient.filter(m => m.media_type === 'image' && m.ts >= askedReq.ts).length : images.length;
  // Lo que Meta AI (o una persona) ya confirmó haber recibido
  const confirms = ours.filter(m => m.sender !== 'sistema' && (!askedReq || m.ts >= askedReq.ts)).map(m => m.body || '').join('\n');
  const gotCedula = /(recib|tengo|lleg|ten[ée]s|enviaste)[^.\n]{0,60}c[eé]dula/i.test(confirms);
  const gotFachada = /(recib|tengo|lleg|ten[ée]s|enviaste)[^.\n]{0,80}fachada/i.test(confirms);
  // Nombre: el que se cargó, el del cliente, o un mensaje que parece "nombre y apellido" después de pedir los requisitos
  const STOP = /\b(hola|buenas?|gracias|ok|okey|listo|dale|s[ií]|no|que|qu[eé]|tal|d[ií]as|tardes|noches|como|internet|wifi|pregunta|ma[ñn]ana|ahora|datos|porfa|favor)\b/i;
  const nameMsg = fromClient.find(m => (!askedReq || m.ts >= askedReq.ts) && m.body && !STOP.test(m.body) &&
    /^[A-Za-zÁÉÍÓÚÑáéíóúñü'´. ]{5,60}$/.test(m.body.trim()) && m.body.trim().split(/\s+/).length >= 2 && m.body.trim().split(/\s+/).length <= 5);
  const name = String(c.lead_name || c.customer_name || '').trim();
  const nameGuess = nameMsg ? nameMsg.body.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : '';
  const check = {
    nombre: { ok: !!name, probable: !name && !!nameGuess, value: name || nameGuess || c.name || '' },
    cedula: { ok: !!c.cedula_msg, probable: !c.cedula_msg && (gotCedula || imgsAfterReq >= 1), confirmed: gotCedula },
    fachada: { ok: !!c.fachada_msg, probable: !c.fachada_msg && (gotFachada || imgsAfterReq >= 2), confirmed: gotFachada },
    ubicacion: { ok: !!loc, lat: loc ? loc.lat : null, lng: loc ? loc.lng : null },
  };
  const missing = Object.keys(check).filter(k => !check[k].ok);
  const missingProbable = Object.keys(check).filter(k => !check[k].ok && !check[k].probable);

  let stageAuto = 'nuevo';
  if (c.customer_id && c.customer_status === 'inactive') stageAuto = 'solicitud';
  else if (isCustomer) stageAuto = 'instalado';
  else if (!missing.length) stageAuto = 'listo';
  else if (c.cedula_msg || c.fachada_msg || loc || imgsAfterReq > 0 || gotCedula || gotFachada) stageAuto = 'parciales';
  else if (askedReq) stageAuto = 'requisitos';
  else if (informed) stageAuto = 'informado';
  const stage = c.lost_reason ? 'perdido' : (c.lead_stage || stageAuto);
  const nearClose = ['parciales', 'listo'].includes(stage) && missingProbable.length <= 1;

  // ¿Lo último del contacto es solo un agradecimiento o un sticker? Entonces no espera respuesta
  const tail = [];
  for (const m of msgs) { if (m.sender !== 'cliente') break; tail.push(m); }
  const onlyAck = tail.length > 0 && tail.every(m => m.media_type === 'sticker' || (!m.media_type && ACK_RE.test(String(m.body || '').trim())));

  // bandeja
  const archiveDays = Math.max(1, Number(getSetting('crm_archive_days', 30)) || 30);
  const internal = c.internal === 1 || (c.internal !== 0 && staffPhones().has(intl(c.phone)));
  const old = !c.last_message_at || (Date.now() - new Date(c.last_message_at)) > archiveDays * 86400000;
  // el mismo cliente tiene una conversación más reciente desde otro número: esta queda en el archivo
  const newer = c.customer_id ? db.prepare('SELECT id FROM wa_conversations WHERE customer_id=? AND id!=? AND last_message_at > ? LIMIT 1').get(c.customer_id, c.id, c.last_message_at || '') : null;
  let inbox;
  if (c.ignored === 1) inbox = 'ocultas';
  else if (internal) inbox = 'internas';
  else if (c.state === 'closed' || old || newer) inbox = 'archivo';
  else if (!clientCount) inbox = 'avisos';
  else if (c.state === 'waiting_human' || (c.last_sender === 'cliente' && !onlyAck && !(c.dismissed_at && c.dismissed_at >= (c.last_inbound_at || '')))) inbox = 'por_atender';
  else if (!isCustomer) inbox = 'ventas';
  else if (['pago', 'cobranza', 'baja'].includes(motive)) inbox = 'pagos';
  else if (motive === 'soporte') inbox = 'soporte';
  else inbox = 'clientes';

  const suggest = !c.customer_id && !internal && clientCount ? suggestCustomers([c.name, c.lead_name].filter(Boolean).join(' ')) : [];
  const data = {
    inbox, motive, motiveAuto, stage, stageAuto, check, missing, nearClose, notice, internal, suggest, newerConv: newer ? newer.id : null,
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
function list({ inbox = 'por_atender', q = '', motive = '', admin = false } = {}) {
  let rows = allConvs().map(c => Object.assign(c, { org: analyze(c) }));
  // los chats ocultos (personales, promociones) solo los ve el administrador
  if (!admin) { rows = rows.filter(r => r.org.inbox !== 'ocultas'); if (inbox === 'ocultas') inbox = 'por_atender'; }
  const counts = {};
  for (const r of rows) counts[r.org.inbox] = (counts[r.org.inbox] || 0) + 1;
  counts.cerca = rows.filter(r => r.org.inbox === 'ventas' && r.org.nearClose).length;
  let out = inbox === 'todas' ? rows.filter(r => r.org.inbox !== 'ocultas') : rows.filter(r => r.org.inbox === inbox);
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
      const others = db.prepare('SELECT id, phone, name, last_message_at FROM wa_conversations WHERE customer_id=? AND id!=? ORDER BY last_message_at DESC').all(cu.id, c.id);
      out.customer = Object.assign(cu, { tickets, onu, debt, others });
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
  if (f.dismiss !== undefined) set.dismissed_at = f.dismiss ? new Date().toISOString() : null;
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
  const cust = db.prepare('SELECT id, name, phone, alt_phones FROM customers WHERE id=?').get(Number(customerId));
  if (!cust) throw new Error('Cliente no encontrado');
  if (!c.phone) {
    // chat sin número visible (identificador @lid de WhatsApp): solo se vincula la conversación
    db.prepare('UPDATE wa_conversations SET customer_id=? WHERE id=?').run(cust.id, c.id);
    _cache.clear(); _cust.at = 0;
    return { ok: true, name: cust.name, noPhone: true };
  }
  const cp = require('../config/customerPhones');
  const regional = require('../config/regional');
  const already = cp.findByPhone(c.phone);
  if (already && already.id !== cust.id) throw new Error(`Ese número ya es de otro cliente: ${already.name}.`);
  let asMain = false;
  if (!already) {
    const local = regional.toLocalPhone(c.phone.startsWith('595') ? c.phone : '+' + c.phone);
    if (!String(cust.phone || '').trim()) {
      // la ficha no tenía teléfono: este pasa a ser el principal (a ese número van los avisos)
      db.prepare('UPDATE customers SET phone=? WHERE id=?').run(local, cust.id);
      asMain = true;
    } else {
      const list = cp.parse(cp.list(cust).concat([local]).join(','), { exceptId: cust.id, main: cust.phone });
      cp.save(cust.id, list);
    }
  }
  db.prepare('UPDATE wa_conversations SET customer_id=? WHERE id=?').run(cust.id, c.id);
  _cache.clear(); _cust.at = 0;
  return { ok: true, name: cust.name, asMain };
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
  _cache.clear(); _cust.at = 0;
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

// ── ocultar / vaciar ────────────────────────────────────────────────────────
function ignore(ids, reason, actor) {
  ensureSchema();
  if (!IGNORE_REASONS[reason]) throw new Error('Motivo inválido');
  const list = [].concat(ids).map(Number).filter(Boolean);
  const st = db.prepare("UPDATE wa_conversations SET ignored=1, ignored_reason=?, ignored_by=?, ignored_at=?, unread=0, state=CASE WHEN state='waiting_human' THEN 'open' ELSE state END WHERE id=?");
  for (const id of list) st.run(reason, String(actor || ''), new Date().toISOString(), id);
  _cache.clear();
  return list.length;
}
function unignore(ids) {
  ensureSchema();
  const list = [].concat(ids).map(Number).filter(Boolean);
  const st = db.prepare("UPDATE wa_conversations SET ignored=0, ignored_reason='', ignored_by='', ignored_at=NULL WHERE id=?");
  for (const id of list) st.run(id);
  _cache.clear();
  return list.length;
}
/**
 * Borrar del sistema (nunca del WhatsApp del celular). Lo borrado no se vuelve a importar de GoWA (purged_before).
 *   clear  : vacía los mensajes; el chat queda en su bandeja
 *   purge  : vacía y oculta (lo nuevo de ese número tampoco se guarda)
 *   remove : borra el chat entero (mensajes y organización); reaparece solo si el contacto vuelve a escribir
 */
function clearMessages(list) {
  let n = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const id of list) {
      n += db.prepare('DELETE FROM wa_messages WHERE conv_id=?').run(id).changes;
      db.prepare("UPDATE wa_conversations SET purged_before=?, last_preview='(vaciado)', unread=0, cedula_msg=NULL, fachada_msg=NULL, state=CASE WHEN state='waiting_human' THEN 'open' ELSE state END WHERE id=?").run(now, id);
    }
  })();
  _cache.clear();
  return n;
}
function clear(ids) { ensureSchema(); const list = [].concat(ids).map(Number).filter(Boolean); return { convs: list.length, msgs: clearMessages(list) }; }
function purge(ids, reason, actor) {
  ensureSchema();
  const list = [].concat(ids).map(Number).filter(Boolean);
  const n = clearMessages(list);
  ignore(list, IGNORE_REASONS[reason] ? reason : 'otro', actor);
  return { convs: list.length, msgs: n };
}
function remove(ids) {
  ensureSchema();
  const list = [].concat(ids).map(Number).filter(Boolean);
  const n = clearMessages(list);
  db.prepare(`UPDATE wa_conversations SET last_message_at=NULL, last_inbound_at=NULL, last_preview='', last_sender='', state='open',
    handoff_at=NULL, handoff_alerted_at=NULL, attended_at=NULL, attended_by=NULL, assigned_to='', labels='', note='', motive='', lead_stage='',
    lost_reason='', lead_name='', dismissed_at=NULL, internal=NULL WHERE id IN (${list.map(() => '?').join(',') || 'NULL'})`).run(...list);
  _cache.clear();
  return { convs: list.length, msgs: n };
}

module.exports = {
  IGNORE_REASONS, ignore, unignore, purge, clear, remove,
  INBOXES, MOTIVES, STAGES, LOST, ensureSchema, analyze, list, info, setOrg, quickReplies, saveQuickReplies,
  searchCustomers, linkCustomer, createRequest,
};
