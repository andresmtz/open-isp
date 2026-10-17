'use strict';
/**
 * Conversaciones de WhatsApp (Fase 0 del CRM): bandeja única de lo que entra y sale por el número de la empresa.
 *
 * Fuentes (se combinan sin duplicar, la clave es el id del mensaje de WhatsApp):
 *  - Webhook de GoWA (tiempo real, trae ubicaciones y archivos): ingestWebhook()
 *  - Historial guardado por GoWA (/chats, /chat/{jid}/messages): sync() cada pocos segundos e importHistory()
 *
 * Quién envió cada mensaje propio (is_from_me) se deduce del id que genera cada cliente de WhatsApp:
 *  3EB0… = este sistema (GoWA) · CE… = Meta AI / respuestas automáticas de WhatsApp Business ·
 *  6A… = respuestas automáticas viejas de WhatsApp Business · el resto = una persona desde el celular.
 * Lo que se responde desde esta bandeja se registra primero con el nombre de quien respondió.
 *
 * Cuando Meta AI deriva ("Hemos pasado la conversación a un miembro del equipo"), la conversación queda
 * "Esperando a una persona" y, en horario de atención, se avisa a la oficina a los N minutos.
 *
 * Parámetros (Configuración):
 *   crm_handoff_alert_minutes  minutos de espera antes de avisar (por defecto 2)
 *   crm_business_hours         horario de atención humana, ej. "1-5 08:00-17:00" (lun a vie); varios separados por ;
 *   crm_brand                  nombre con el que se presenta el asistente (por defecto AppsTec.PY)
 *   crm_handoff_patterns       textos que indican derivación de Meta AI (separados por |)
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const logger = require('../config/logger');

const SENDERS = { cliente: 'Cliente', meta_ai: 'Meta AI', persona: 'Persona', sistema: 'Sistema', auto: 'Respuesta automática' };
const STATES = { open: 'Abierta', waiting_human: 'Esperando a una persona', human: 'Atendida por una persona', closed: 'Cerrada' };

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT UNIQUE NOT NULL,
      phone TEXT DEFAULT '',
      name TEXT DEFAULT '',
      customer_id INTEGER,
      state TEXT DEFAULT 'open',
      handoff_at TEXT,
      handoff_alerted_at TEXT,
      attended_at TEXT,
      attended_by TEXT,
      assigned_to TEXT DEFAULT '',
      labels TEXT DEFAULT '',
      note TEXT DEFAULT '',
      unread INTEGER DEFAULT 0,
      last_message_at TEXT,
      last_inbound_at TEXT,
      last_preview TEXT DEFAULT '',
      last_sender TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wa_conv_last ON wa_conversations(last_message_at);
    CREATE TABLE IF NOT EXISTS wa_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id INTEGER NOT NULL,
      wa_id TEXT UNIQUE,
      ts TEXT NOT NULL,
      from_me INTEGER DEFAULT 0,
      sender TEXT DEFAULT 'cliente',
      by_name TEXT DEFAULT '',
      body TEXT DEFAULT '',
      media_type TEXT DEFAULT '',
      media_path TEXT DEFAULT '',
      filename TEXT DEFAULT '',
      lat REAL, lng REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON wa_messages(conv_id, ts);
    CREATE TABLE IF NOT EXISTS wa_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT, chat_jid TEXT, payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const cols = db.prepare('PRAGMA table_info(wa_conversations)').all().map(c => c.name);
  if (!cols.includes('ignored')) db.exec('ALTER TABLE wa_conversations ADD COLUMN ignored INTEGER DEFAULT 0');
  if (!cols.includes('purged_before')) db.exec('ALTER TABLE wa_conversations ADD COLUMN purged_before TEXT');
  _schema = true;
  try { reclassifyWeb(); } catch (e) { logger.warn('[Conversaciones] reclasificar: ' + e.message); }
}

/** Una vez: los 3EB0 que no son plantillas pasan a "Persona (WhatsApp Web)". */
function reclassifyWeb() {
  if (db.getAppSetting && db.getAppSetting('wa_reclass_web_v1', '') === '1') return;
  const rows = db.prepare("SELECT id, conv_id, body FROM wa_messages WHERE wa_id LIKE '3EB0%' AND sender='sistema'").all();
  const convs = new Set();
  for (const r of rows) if (!TEMPLATE_RE.test(String(r.body || ''))) {
    db.prepare("UPDATE wa_messages SET sender='persona', by_name=CASE WHEN by_name='' THEN 'WhatsApp Web' ELSE by_name END WHERE id=?").run(r.id);
    convs.add(r.conv_id);
  }
  for (const id of convs) {
    const last = db.prepare('SELECT sender FROM wa_messages WHERE conv_id=? ORDER BY ts DESC, id DESC LIMIT 1').get(id);
    if (last) db.prepare('UPDATE wa_conversations SET last_sender=? WHERE id=?').run(last.sender, id);
  }
  if (db.saveAppSetting) db.saveAppSetting('wa_reclass_web_v1', '1');
  if (convs.size) logger.info(`[Conversaciones] ${convs.size} conversaciones con mensajes de WhatsApp Web reclasificados`);
}

// ── utilidades ──────────────────────────────────────────────────────────────
const iso = (t) => { const d = t ? new Date(t) : new Date(); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };
const phoneOf = (jid) => { const m = /^(\d{6,15})@s\.whatsapp\.net$/.exec(String(jid || '')); return m ? m[1] : ''; };
const isPersonal = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''));

function handoffRe() {
  const extra = String(getSetting('crm_handoff_patterns', '') || '').split('|').map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(['pasado la conversaci[oó]n a un miembro del equipo', ...extra].join('|'), 'i');
}

// Textos que solo manda el sistema (plantillas). Lo demás con id 3EB0 lo escribió una persona en WhatsApp Web/Desktop.
const TEMPLATE_RE = /(Estimado\/a|Estimado\(a\)|\*Faster\*|COMPROBANTE DE PAGO|PAGO RECIBIDO|Pago recibido con [ée]xito|RECORDATORIO|Recordatorio de pago|Aviso final|AVISO FINAL|suspendid|Bienvenido\/a|INSTALACI[OÓ]N ASIGNADA|NUEVA SOLICITUD|ID de cliente|Le informamos|Le recordamos|Le enviamos|^\s*(🧾|📢|🔔|🎉|🛠️|⚠️|🔴|📋|🙋|🧪))/;
function sentBySystem(id) {
  try { const r = db.prepare('SELECT kind FROM wa_sent_log WHERE wa_id=?').get(String(id)); return r ? r.kind : null; } catch (_) { return null; }
}
function senderOf(waId, fromMe, body) {
  if (!fromMe) return 'cliente';
  const id = String(waId || '');
  if (/^3EB0/i.test(id)) {
    const k = sentBySystem(id);
    if (k === 'bandeja') return 'persona';
    if (k) return 'sistema';
    return TEMPLATE_RE.test(String(body || '')) ? 'sistema' : 'persona';
  }
  if (/^CE/i.test(id)) return 'meta_ai';
  if (/^6A/i.test(id)) return 'auto';
  return 'persona';
}

function customerFor(phone) {
  if (!phone) return null;
  try { return require('../config/customerPhones').findByPhone(phone); } catch (_) { return null; }
}

/** Horario de atención humana: "1-5 08:00-17:00;6 08:00-12:00" (1 = lunes … 7 = domingo). */
function inBusinessHours(date) {
  const spec = String(getSetting('crm_business_hours', '1-5 08:00-17:00') || '').trim();
  const tz = getSetting('timezone', 'America/Asuncion') || 'America/Asuncion';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date || new Date());
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.find(p => p.type === 'weekday').value];
  const hm = Number(parts.find(p => p.type === 'hour').value) % 24 * 60 + Number(parts.find(p => p.type === 'minute').value);
  for (const seg of spec.split(';')) {
    const m = /^\s*(\d)(?:-(\d))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(seg);
    if (!m) continue;
    const d1 = +m[1], d2 = m[2] ? +m[2] : d1;
    if (wd >= d1 && wd <= d2 && hm >= (+m[3]) * 60 + (+m[4]) && hm < (+m[5]) * 60 + (+m[6])) return true;
  }
  return false;
}

// ── alta de conversaciones y mensajes ───────────────────────────────────────
function convFor(jid, name) {
  ensureSchema();
  let c = db.prepare('SELECT * FROM wa_conversations WHERE jid=?').get(jid);
  if (!c) {
    const phone = phoneOf(jid);
    const cust = customerFor(phone);
    db.prepare('INSERT OR IGNORE INTO wa_conversations (jid, phone, name, customer_id) VALUES (?,?,?,?)')
      .run(jid, phone, String(name || '').slice(0, 120), cust ? cust.id : null);
    c = db.prepare('SELECT * FROM wa_conversations WHERE jid=?').get(jid);
  } else if (name && !c.name) {
    db.prepare('UPDATE wa_conversations SET name=? WHERE id=?').run(String(name).slice(0, 120), c.id);
  }
  return c;
}

/**
 * Guarda un mensaje (si no existía) y actualiza el estado de la conversación.
 * m = { waId, jid, name, ts, fromMe, body, mediaType, mediaPath, filename, lat, lng, sender?, byName?, historical? }
 */
function upsertMessage(m) {
  ensureSchema();
  if (!m || !m.jid || !isPersonal(m.jid)) return { skipped: true };
  const conv = convFor(m.jid, m.fromMe ? '' : m.name);
  if (conv.ignored === 1) return { conv, ignored: true }; // chat oculto (personal, promoción…): no se guarda
  const ts = iso(m.ts);
  if (conv.purged_before && ts <= conv.purged_before) return { conv, purged: true }; // ya se borró: no se vuelve a importar
  const sender = m.sender || senderOf(m.waId, m.fromMe, m.body);
  if (!m.byName && sender === 'persona' && /^3EB0/i.test(String(m.waId || ''))) m.byName = 'WhatsApp Web';
  const body = String(m.body || '');
  if (m.waId) {
    const prev = db.prepare('SELECT id, media_path, lat FROM wa_messages WHERE wa_id=?').get(String(m.waId));
    if (prev) {
      // el webhook trae datos que el historial no tiene (ruta del archivo, ubicación): se completan
      if ((m.mediaPath && !prev.media_path) || (m.lat != null && prev.lat == null)) {
        db.prepare('UPDATE wa_messages SET media_path=COALESCE(NULLIF(?,\'\'),media_path), lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=?')
          .run(m.mediaPath || '', m.lat == null ? null : m.lat, m.lng == null ? null : m.lng, prev.id);
      }
      return { conv, isNew: false };
    }
  }
  db.prepare(`INSERT OR IGNORE INTO wa_messages (conv_id, wa_id, ts, from_me, sender, by_name, body, media_type, media_path, filename, lat, lng)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(conv.id, m.waId ? String(m.waId) : null, ts, m.fromMe ? 1 : 0, sender, String(m.byName || ''), body,
      String(m.mediaType || ''), String(m.mediaPath || ''), String(m.filename || ''), m.lat == null ? null : m.lat, m.lng == null ? null : m.lng);

  // estado de la conversación (solo si el mensaje es el más nuevo)
  const fresh = db.prepare('SELECT * FROM wa_conversations WHERE id=?').get(conv.id);
  const newest = !fresh.last_message_at || ts >= fresh.last_message_at;
  const preview = body ? body.replace(/\s+/g, ' ').slice(0, 140) : (m.lat != null ? '📍 Ubicación' : (m.mediaType ? '📎 ' + m.mediaType : ''));
  const set = {};
  if (newest) { set.last_message_at = ts; set.last_preview = preview; set.last_sender = sender; }
  if (sender === 'cliente') {
    if (!m.historical) set.unread = (fresh.unread || 0) + 1;
    if (!fresh.last_inbound_at || ts > fresh.last_inbound_at) set.last_inbound_at = ts;
    if (fresh.state === 'closed' && newest && !m.historical) set.state = 'open';
  } else if (sender === 'meta_ai' && handoffRe().test(body)) {
    if (!fresh.handoff_at || ts > fresh.handoff_at) {
      set.state = 'waiting_human'; set.handoff_at = ts; set.attended_at = null; set.attended_by = null;
      // lo importado del historial no genera avisos atrasados
      set.handoff_alerted_at = m.historical ? new Date().toISOString() : null;
    }
  } else if (sender === 'persona') {
    if (fresh.state === 'waiting_human' && (!fresh.handoff_at || ts >= fresh.handoff_at)) {
      set.state = 'human'; set.attended_at = ts; set.attended_by = m.byName || 'Celular';
    }
    if (newest && !m.historical) set.unread = 0;
  }
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE wa_conversations SET ${keys.map(k => k + '=?').join(', ')} WHERE id=?`).run(...keys.map(k => set[k]), conv.id);
  // respuesta a la consulta por equipo caído (services/outageService.js)
  if (!m.historical && (sender === 'cliente' || sender === 'meta_ai')) {
    const msg = { ts, sender, body, media_type: String(m.mediaType || '') };
    setImmediate(() => { require('./outageService').onMessage(conv.id, msg).catch(() => {}); });
  }
  return { conv, isNew: true, sender };
}

// ── webhook de GoWA ─────────────────────────────────────────────────────────
function mediaFrom(p) {
  for (const t of ['image', 'video', 'audio', 'document', 'sticker']) {
    const v = p[t];
    if (!v) continue;
    if (typeof v === 'string') return { type: t, path: v };
    return { type: t, path: v.path || '', caption: v.caption || '', filename: v.filename || '' };
  }
  return null;
}

function ingestWebhook(data) {
  ensureSchema();
  const ev = String((data && data.event) || '');
  const p = (data && data.payload) || {};
  if (ev === 'message') {
    const jid = String(p.chat_id || p.from || '');
    if (!isPersonal(jid)) return { skipped: true };
    const med = mediaFrom(p);
    const loc = p.location && typeof p.location === 'object' ? p.location : null;
    const contact = p.contact && typeof p.contact === 'object' ? p.contact : null;
    let body = String(p.body || (med && med.caption) || '');
    if (!body && contact) body = '👤 Contacto: ' + (contact.displayName || '') + (contact.phone_number ? ' (' + contact.phone_number + ')' : '');
    if (!body && loc) body = [loc.name, loc.address].filter(Boolean).join(' — ');
    const path = med && med.path && /^statics\//.test(String(med.path).replace(/^\/+/, '')) ? String(med.path).replace(/^\/+/, '') : '';
    return upsertMessage({
      waId: p.id, jid, name: p.sender_display_name || p.from_name || '', ts: p.timestamp, fromMe: !!p.is_from_me, body,
      mediaType: med ? med.type : (loc ? 'location' : ''), mediaPath: path, filename: (med && med.filename) || '',
      lat: loc ? Number(loc.degreesLatitude) : null, lng: loc ? Number(loc.degreesLongitude) : null,
    });
  }
  // Otros eventos (etiquetas, ediciones, borrados…): se guardan para estudiar cómo marca Meta AI las derivaciones
  if (ev && !/^(message\.ack|chat_presence)$/.test(ev)) {
    try {
      db.prepare('INSERT INTO wa_events (event, chat_jid, payload) VALUES (?,?,?)').run(ev, String(p.chat_id || p.from || ''), JSON.stringify(p).slice(0, 4000));
      db.prepare('DELETE FROM wa_events WHERE id <= (SELECT MAX(id) - 3000 FROM wa_events)').run();
    } catch (_) {}
  }
  return { event: ev };
}

// ── historial guardado por GoWA ─────────────────────────────────────────────
async function gowa(pathq) {
  const g = require('./gowaWhatsappService');
  const u = String(getSetting('gowa_username', '') || '').trim(), pw = String(getSetting('gowa_password', '') || '').trim();
  const raw = String(getSetting('gowa_basic_auth', '') || '').trim();
  const H = {};
  if ((u && pw) || raw) H.Authorization = 'Basic ' + Buffer.from(u && pw ? u + ':' + pw : raw).toString('base64');
  const dev = await g.resolveDeviceId(); if (dev) H['X-Device-Id'] = dev;
  const r = await fetch(g.baseUrl() + pathq, { headers: H, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('GoWA ' + r.status);
  return r;
}

function fromStore(jid, name, x, historical) {
  return upsertMessage({
    waId: x.id, jid, name: x.is_from_me ? '' : (x.sender_display_name || name), ts: x.timestamp, fromMe: !!x.is_from_me,
    body: x.content || '', mediaType: x.media_type || '', filename: x.filename || '', historical,
  });
}

async function chatMessages(jid, max) {
  let out = [];
  for (let off = 0; out.length < max; off += 100) {
    const r = await (await gowa(`/chat/${encodeURIComponent(jid)}/messages?limit=100&offset=${off}`)).json();
    const a = (r.results && r.results.data) || [];
    out = out.concat(a);
    if (a.length < 100) break;
  }
  return out;
}

/** Importa todo el historial que tiene GoWA (una vez; se puede repetir sin duplicar). */
async function importHistory() {
  ensureSchema();
  let chats = [];
  for (let off = 0; ; off += 100) {
    const r = await (await gowa(`/chats?limit=100&offset=${off}`)).json();
    const a = (r.results && r.results.data) || [];
    chats = chats.concat(a);
    if (a.length < 100) break;
  }
  let msgs = 0, convs = 0;
  for (const c of chats) {
    if (!isPersonal(c.jid)) continue;
    const list = (await chatMessages(c.jid, 5000)).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    if (!list.length) continue;
    convs++;
    for (const x of list) if (fromStore(c.jid, c.name, x, true).isNew) msgs++;
  }
  db.prepare("INSERT INTO wa_events (event, payload) VALUES ('import', ?)").run(JSON.stringify({ convs, msgs }));
  return { convs, msgs };
}

let _syncing = false, _relinkAt = 0;
/** Trae lo nuevo de los chats con actividad reciente (respaldo del webhook: mensajes del celular y de Meta AI). */
async function sync() {
  ensureSchema();
  if (_syncing) return { busy: true };
  _syncing = true;
  try {
    const r = await (await gowa('/chats?limit=40')).json();
    const chats = (r.results && r.results.data) || [];
    let n = 0;
    for (const c of chats) {
      if (!isPersonal(c.jid)) continue;
      const conv = db.prepare('SELECT last_message_at, purged_before FROM wa_conversations WHERE jid=?').get(c.jid);
      const seen = conv ? [conv.last_message_at, conv.purged_before].filter(Boolean).sort().pop() : null;
      if (seen && iso(c.last_message_time) <= seen) continue;
      const list = (await chatMessages(c.jid, conv ? 30 : 300)).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      for (const x of list) if (fromStore(c.jid, c.name, x, false).isNew) n++;
    }
    if (Date.now() - _relinkAt > 600000) { _relinkAt = Date.now(); relink(); }
    return { nuevos: n };
  } finally { _syncing = false; }
}

/** Ruta servible de un archivo: la del webhook o, si no hay, la descarga desde GoWA por id. */
async function mediaPathFor(msg, jid) {
  if (msg.media_path) return msg.media_path;
  if (!msg.wa_id) return '';
  const dl = await (await gowa(`/message/${encodeURIComponent(msg.wa_id)}/download?phone=${encodeURIComponent(jid)}`)).json();
  const rel = String((dl.results && dl.results.file_path) || '').replace(/^.*?statics\//, 'statics/');
  if (rel) db.prepare('UPDATE wa_messages SET media_path=? WHERE id=?').run(rel, msg.id);
  return rel;
}
async function fetchMedia(rel) { return gowa('/' + String(rel).replace(/^\/+/, '')); }

// ── avisos de derivación ────────────────────────────────────────────────────
function staffToAlert() {
  const sp = require('../config/staffPermissions');
  try {
    return db.prepare("SELECT id, name, phone FROM cashiers WHERE is_active = 1 AND COALESCE(phone,'') != ''").all()
      .filter(c => sp.current(c.id).conversaciones);
  } catch (_) { return []; }
}

async function checkHandoffs() {
  ensureSchema();
  if (!inBusinessHours()) return { fueraDeHorario: true };
  const mins = Math.max(0, Number(getSetting('crm_handoff_alert_minutes', 2)) || 2);
  const limit = new Date(Date.now() - mins * 60000).toISOString();
  const stale = new Date(Date.now() - 4 * 86400000).toISOString();
  const rows = db.prepare("SELECT * FROM wa_conversations WHERE state='waiting_human' AND handoff_alerted_at IS NULL AND handoff_at <= ? AND COALESCE(ignored,0)=0").all(limit);
  let sent = 0;
  for (const c of rows) {
    db.prepare('UPDATE wa_conversations SET handoff_alerted_at=? WHERE id=?').run(new Date().toISOString(), c.id);
    if (c.handoff_at < stale) continue; // demasiado vieja: no se avisa
    const cust = c.customer_id ? db.prepare('SELECT name, status FROM customers WHERE id=?').get(c.customer_id) : null;
    const last = db.prepare("SELECT body FROM wa_messages WHERE conv_id=? AND sender='cliente' AND body!='' ORDER BY ts DESC LIMIT 1").get(c.id);
    const waited = Math.max(1, Math.round((Date.now() - new Date(c.handoff_at)) / 60000));
    const base = String(getSetting('app_url', '') || '').replace(/\/+$/, '');
    const msg = `🙋 *Cliente esperando atención*\n\n` +
      `👤 ${cust ? cust.name + ' (cliente)' : (c.name || 'Contacto nuevo')}\n📞 ${c.phone || '-'}\n` +
      (last ? `💬 "${String(last.body).replace(/\s+/g, ' ').slice(0, 160)}"\n` : '') +
      `⏱️ Meta AI derivó la conversación hace ${waited} min y nadie respondió todavía.` +
      (base ? `\n\nAbrir: ${base}/admin/conversations?c=${c.id}` : '\n\nAbrí Conversaciones en el sistema.');
    try { await require('./waNotifyService').notifyAdmin(msg); sent++; } catch (e) { logger.warn('[Conversaciones] aviso admin: ' + e.message); }
    for (const s of staffToAlert()) {
      try { await require('./waNotifyService').sendText(require('../config/regional').normalizePhone(String(s.phone).replace(/\D/g, '')), msg); sent++; } catch (_) {}
    }
  }
  return { avisos: sent, conversaciones: rows.length };
}

// ── acciones desde la bandeja ───────────────────────────────────────────────
async function reply(convId, text, actor) {
  ensureSchema();
  const c = db.prepare('SELECT * FROM wa_conversations WHERE id=?').get(convId);
  if (!c) throw new Error('Conversación no encontrada');
  const msg = String(text || '').trim();
  if (!msg) throw new Error('Escribí un mensaje');
  if (msg.length > 4000) throw new Error('El mensaje es demasiado largo');
  const g = require('./gowaWhatsappService');
  const r = await g.sendGowaText(c.jid, msg);
  upsertMessage({ waId: r.id || null, jid: c.jid, ts: new Date().toISOString(), fromMe: true, body: msg, sender: 'persona', byName: actor || 'Oficina' });
  return { ok: true };
}

function setState(convId, state, actor) {
  ensureSchema();
  if (!STATES[state]) throw new Error('Estado inválido');
  const c = db.prepare('SELECT id FROM wa_conversations WHERE id=?').get(convId);
  if (!c) throw new Error('Conversación no encontrada');
  if (state === 'human') db.prepare("UPDATE wa_conversations SET state='human', attended_at=COALESCE(attended_at, ?), attended_by=COALESCE(attended_by, ?) WHERE id=?").run(new Date().toISOString(), actor || '', convId);
  else db.prepare('UPDATE wa_conversations SET state=? WHERE id=?').run(state, convId);
  return { ok: true };
}

function update(convId, fields) {
  ensureSchema();
  const allowed = { assigned_to: 80, labels: 300, note: 2000 };
  const keys = Object.keys(fields || {}).filter(k => allowed[k] !== undefined);
  if (!keys.length) return { ok: true };
  db.prepare(`UPDATE wa_conversations SET ${keys.map(k => k + '=?').join(', ')} WHERE id=?`)
    .run(...keys.map(k => String(fields[k] || '').trim().slice(0, allowed[k])), convId);
  return { ok: true };
}

function markRead(convId) { ensureSchema(); db.prepare('UPDATE wa_conversations SET unread=0 WHERE id=?').run(convId); }

/** Vuelve a vincular conversaciones con clientes (por si se cargó el teléfono después). */
function relink() {
  ensureSchema();
  let n = 0;
  for (const c of db.prepare("SELECT id, phone, customer_id FROM wa_conversations WHERE phone != ''").all()) {
    const cust = customerFor(c.phone);
    const id = cust ? cust.id : null;
    if (id !== c.customer_id) { db.prepare('UPDATE wa_conversations SET customer_id=? WHERE id=?').run(id, c.id); n++; }
  }
  return n;
}

// ── consultas para la pantalla ──────────────────────────────────────────────
function list({ filter, q, limit } = {}) {
  ensureSchema();
  const where = ['1=1'], args = [];
  if (filter === 'waiting') where.push("c.state='waiting_human'");
  else if (filter === 'unread') where.push('c.unread > 0');
  else if (filter === 'customers') where.push('c.customer_id IS NOT NULL');
  else if (filter === 'leads') where.push('c.customer_id IS NULL');
  else if (filter === 'closed') where.push("c.state='closed'");
  if (filter !== 'closed' && filter !== 'all') where.push("c.state!='closed'");
  if (q) {
    const like = '%' + String(q).trim() + '%';
    where.push('(c.name LIKE ? OR c.phone LIKE ? OR cu.name LIKE ? OR c.labels LIKE ? OR c.last_preview LIKE ?)');
    args.push(like, like, like, like, like);
  }
  return db.prepare(`
    SELECT c.*, cu.name AS customer_name, cu.status AS customer_status, cu.customer_code
    FROM wa_conversations c LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE ${where.join(' AND ')} AND c.last_message_at IS NOT NULL
    ORDER BY CASE WHEN c.state='waiting_human' THEN 0 ELSE 1 END, c.last_message_at DESC
    LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 500));
}

function counts() {
  ensureSchema();
  return db.prepare(`SELECT
      SUM(CASE WHEN state='waiting_human' THEN 1 ELSE 0 END) waiting,
      SUM(CASE WHEN unread>0 AND state!='closed' THEN 1 ELSE 0 END) unread,
      SUM(CASE WHEN state!='closed' THEN 1 ELSE 0 END) open
    FROM wa_conversations WHERE last_message_at IS NOT NULL`).get();
}

function get(convId) {
  ensureSchema();
  return db.prepare(`SELECT c.*, cu.name AS customer_name, cu.status AS customer_status, cu.customer_code, cu.address AS customer_address
    FROM wa_conversations c LEFT JOIN customers cu ON cu.id = c.customer_id WHERE c.id=?`).get(convId);
}

function messages(convId, { afterId, limit } = {}) {
  ensureSchema();
  if (afterId) return db.prepare('SELECT * FROM wa_messages WHERE conv_id=? AND id>? ORDER BY ts, id').all(convId, Number(afterId));
  return db.prepare('SELECT * FROM (SELECT * FROM wa_messages WHERE conv_id=? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts, id')
    .all(convId, Math.min(Number(limit) || 300, 2000));
}

function message(id) { ensureSchema(); return db.prepare('SELECT m.*, c.jid FROM wa_messages m JOIN wa_conversations c ON c.id=m.conv_id WHERE m.id=?').get(id); }

module.exports = {
  SENDERS, STATES, ensureSchema, senderOf, inBusinessHours, upsertMessage, ingestWebhook, importHistory, sync,
  checkHandoffs, reply, setState, update, markRead, relink, list, counts, get, messages, message, mediaPathFor, fetchMedia,
};
