/**
 * Caídas de equipos: consulta automática al cliente cuando su ONU lleva mucho tiempo apagada.
 *
 * Flujo:
 *  1. scan() (cada 15 min) lee las ONU de la(s) OLT. Si la ONU de un cliente activo y al día
 *     está apagada hace más de outage_query_hours, sin asistencia abierta, se le pregunta por
 *     WhatsApp (dentro de outage_send_hours) qué ve: sin energía, luz roja, luces normales o de viaje.
 *  2. onMessage() lee la respuesta (1-4 o palabras clave) y actúa:
 *     1 sin energía → se espera y se vuelve a preguntar una vez; 2 luz roja → asistencia automática;
 *     3 luces normales → asistencia; 4 de viaje → no se pregunta más hasta que vuelva.
 *  3. Si no responde en outage_noreply_hours se avisa a la oficina para llamarlo.
 *  4. Si la ONU vuelve, el caso se cierra (y la asistencia sin técnico asignado también).
 *
 * Parámetros (settings): outage_query_enabled, outage_query_hours, outage_send_hours,
 * outage_noreply_hours, outage_reask_hours, outage_msg_query, outage_msg_1..4, outage_msg_back.
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const regional = require('../config/regional');

const STATES = {
  consultado: 'Consultado, esperando respuesta',
  sin_energia: 'Sin energía eléctrica',
  asistencia: 'Asistencia creada',
  ausente: 'De viaje / no usa el servicio',
  foto: 'Mandó foto o texto: revisar',
  sin_respuesta: 'Sin respuesta: llamar',
  restablecido: 'Se restableció',
  cerrado: 'Cerrado',
};
const OPEN_STATES = ['consultado', 'sin_energia', 'asistencia', 'ausente', 'foto', 'sin_respuesta'];

const DEFAULTS = {
  outage_msg_query: 'Hola {{nombre}} 👋, te escribimos de *{{empresa}}*. Vemos que tu equipo de internet está sin conexión desde el {{fecha}}. Para ayudarte rápido, respondé con un número:\n\n' +
    '*1* – Estoy sin energía eléctrica / el equipo está apagado\n*2* – El equipo tiene una *luz roja* (LOS)\n*3* – Las luces están normales pero no tengo internet\n*4* – Estoy de viaje / no uso el servicio por ahora\n\n' +
    'También podés mandarnos una *foto del equipo* con las luces.',
  outage_msg_1: 'Entendido, gracias {{nombre}}. Cuando vuelva la energía el equipo se reconecta solo. Si después de eso sigue sin internet, escribinos.',
  outage_msg_2: 'Gracias {{nombre}}. La luz roja indica un problema en la fibra: ya agendamos la visita de un técnico, te vamos a contactar para coordinar.',
  outage_msg_3: 'Gracias {{nombre}}. Ya pasamos tu caso a soporte técnico, te vamos a contactar para revisarlo.',
  outage_msg_4: 'Perfecto {{nombre}}, gracias por avisar. Cuando vuelvas, si algo no funciona, escribinos.',
  outage_msg_back: 'Hola {{nombre}}, vemos que tu equipo ya volvió a conectarse ✅. Si notás algún problema, escribinos.',
};

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  db.exec(`CREATE TABLE IF NOT EXISTS onu_outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    olt_id INTEGER, onu_id TEXT DEFAULT '',
    down_since TEXT, detected_at TEXT DEFAULT (datetime('now')),
    state TEXT DEFAULT 'consultado',
    conv_id INTEGER, asked_at TEXT, asked_count INTEGER DEFAULT 0,
    answer TEXT DEFAULT '', answered_at TEXT,
    ticket_id INTEGER, noreply_alerted_at TEXT,
    meta_ai INTEGER DEFAULT 0,
    resolved_at TEXT, notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_onu_outages_cust ON onu_outages(customer_id, state)');
  // ONU vistas apagadas: cuándo se las vio apagadas por primera vez (cuando el ACS no sabe desde cuándo)
  db.exec(`CREATE TABLE IF NOT EXISTS onu_offline_seen (customer_id INTEGER PRIMARY KEY, first_seen TEXT NOT NULL)`);
  _schema = true;
}

const S = (k) => { const v = getSetting(k, DEFAULTS[k]); return v == null || v === '' ? (DEFAULTS[k] || '') : String(v); };
const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };
const enabled = () => String(getSetting('outage_query_enabled', true)) !== 'false';
const H = 3600e3;

function inSendHours(date) {
  const spec = String(getSetting('outage_send_hours', '1-6 08:00-19:00') || '').trim();
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

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  const tz = getSetting('timezone', 'America/Asuncion') || 'America/Asuncion';
  const p = new Intl.DateTimeFormat('es-PY', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => (p.find(x => x.type === t) || {}).value || '';
  return `${g('day')}/${g('month')} a las ${g('hour')}:${g('minute')}`;
}

function fill(tpl, c, extra) {
  const first = String(c.name || '').trim().split(/\s+/)[0] || '';
  const vars = Object.assign({ nombre: first, empresa: getSetting('company_header', '') || '' }, extra || {});
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

// ── condiciones ─────────────────────────────────────────────────────────────
// Al día: sin facturas impagas de meses anteriores ni del mes actual ya vencidas.
function isUpToDate(c) {
  const now = new Date();
  const cur = now.getFullYear() * 12 + now.getMonth() + 1;
  const dueDay = Number(c.isolate_day || 0) || Number(getSetting('isolir_day', 10) || 10) || 10;
  const rows = db.prepare("SELECT period_month, period_year FROM invoices WHERE customer_id=? AND voided_at IS NULL AND status != 'paid'").all(c.id);
  return !rows.some(r => {
    const p = Number(r.period_year) * 12 + Number(r.period_month);
    return p < cur || (p === cur && now.getDate() > dueDay);
  });
}
const openTicket = (cid) => db.prepare("SELECT id FROM tickets WHERE customer_id=? AND status IN ('open','in_progress') LIMIT 1").get(cid);
const openOutage = (cid) => db.prepare(`SELECT * FROM onu_outages WHERE customer_id=? AND state IN (${OPEN_STATES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(cid, ...OPEN_STATES);

// Último reporte del ACS (es la mejor referencia de "desde cuándo" porque la OLT no guarda la hora de la caída)
function acsInfo(c) {
  if (!c.genieacs_tag) return {};
  try {
    const r = db.prepare('SELECT last_inform, params FROM acs_devices WHERE id=?').get(c.genieacs_tag);
    if (!r) return {};
    let rx = null;
    try {
      const p = JSON.parse(r.params || '{}');
      const k = Object.keys(p).find(x => /EponInterfaceConfig\.RXPower$|XPON.*RXPower$|WANPONInterfaceConfig\.RXPower$/i.test(x));
      let v = k ? p[k] : null; if (v && typeof v === 'object') v = v._value != null ? v._value : v.value;
      const n = Number(v);
      if (Number.isFinite(n) && n !== 0) rx = n > 0 ? +(30 + Math.log10(n * 1e-7) * 10).toFixed(1) : n;
    } catch (_) {}
    return { lastInform: r.last_inform ? new Date(r.last_inform).toISOString() : null, rx };
  } catch (_) { return {}; }
}

// Chat del cliente: la conversación más reciente de sus números; si no hay, su teléfono principal
function chatFor(c) {
  const conv = db.prepare("SELECT id, jid FROM wa_conversations WHERE customer_id=? AND COALESCE(ignored,0)=0 ORDER BY COALESCE(last_inbound_at, last_message_at, '') DESC LIMIT 1").get(c.id);
  if (conv) return conv;
  const digits = regional.normalizePhone(String(c.phone || '').replace(/\D/g, ''));
  if (!digits || digits.length < 9) return null;
  const jid = digits + '@s.whatsapp.net';
  const cs = require('./conversationService');
  cs.ensureSchema();
  let row = db.prepare('SELECT id, jid FROM wa_conversations WHERE jid=?').get(jid);
  if (!row) {
    db.prepare('INSERT INTO wa_conversations (jid, phone, name, customer_id) VALUES (?,?,?,?)').run(jid, digits, c.name || '', c.id);
    row = db.prepare('SELECT id, jid FROM wa_conversations WHERE jid=?').get(jid);
  }
  return row;
}

async function sendTo(convId, text) {
  return require('./conversationService').reply(convId, text, 'Sistema (caída de equipo)');
}

// ── detección ───────────────────────────────────────────────────────────────
let _busy = false;
async function scan({ dryRun = false } = {}) {
  if (_busy) return { skipped: 'busy' };
  _busy = true;
  try {
    ensureSchema();
    const oltSvc = require('./oltService');
    const olts = (oltSvc.getActiveOlts ? oltSvc.getActiveOlts() : []) || [];
    const offline = new Map(), online = new Set();
    let read = 0;
    for (const o of olts) {
      const s = await oltSvc.getOltStats(o.id, true);
      if (!s || s.error || !Array.isArray(s.onus)) continue;
      read++;
      for (const u of s.onus) {
        if (!u.customer_id) continue;
        if (/^online$/i.test(String(u.status || ''))) online.add(u.customer_id);
        else if (!offline.has(u.customer_id)) offline.set(u.customer_id, { olt: o, onu: u });
      }
    }
    if (!read) return { skipped: 'sin datos de OLT' };
    const nowIso = new Date().toISOString();

    // Simulación: quién recibiría la consulta ahora, sin enviar ni guardar nada
    if (dryRun) {
      const minH = num('outage_query_hours', 24), out = [];
      for (const [cid, info] of offline) {
        const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
        if (!c) continue;
        const acs = acsInfo(c);
        const seen = db.prepare('SELECT first_seen FROM onu_offline_seen WHERE customer_id=?').get(cid);
        const since = acs.lastInform && (!seen || acs.lastInform < seen.first_seen) ? acs.lastInform : (seen ? seen.first_seen : null);
        const why = c.status !== 'active' ? 'no está activo (' + c.status + ')' : openOutage(cid) ? 'ya tiene un caso abierto'
          : !since ? 'recién detectada (se cuenta desde ahora)' : Date.now() - Date.parse(since) < minH * H ? 'apagada hace menos de ' + minH + ' h'
          : openTicket(cid) ? 'tiene asistencia abierta' : !isUpToDate(c) ? 'tiene deuda vencida' : !chatFor(c) ? 'sin teléfono' : '';
        out.push({ name: c.name, onu: info.onu.id, since, rx: acs.rx, send: !why, why });
      }
      return { dryRun: true, sendHours: inSendHours(), candidates: out };
    }

    // ONU que volvieron
    for (const cid of online) {
      db.prepare('DELETE FROM onu_offline_seen WHERE customer_id=?').run(cid);
      const o = openOutage(cid);
      if (o) await restored(o);
    }
    for (const cid of offline.keys()) db.prepare('INSERT OR IGNORE INTO onu_offline_seen (customer_id, first_seen) VALUES (?,?)').run(cid, nowIso);

    if (!enabled()) return { offline: offline.size, asked: 0 };
    const minH = num('outage_query_hours', 24), noreplyH = num('outage_noreply_hours', 24), reaskH = num('outage_reask_hours', 24);
    const canSend = inSendHours() && require('../config/waGate').ready();
    let asked = 0;

    for (const [cid, info] of offline) {
      const c = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
      if (!c || c.status !== 'active') continue;
      const o = openOutage(cid);
      if (o) {
        // sin respuesta: se avisa a la oficina una vez
        if (o.state === 'consultado' && !o.noreply_alerted_at && o.asked_at && Date.now() - Date.parse(o.asked_at) > noreplyH * H) {
          await alertNoReply(o, c);
        }
        // sin energía: si sigue apagado, se vuelve a preguntar una sola vez
        if (o.state === 'sin_energia' && canSend && o.asked_count < 2 && o.answered_at && Date.now() - Date.parse(o.answered_at) > reaskH * H) {
          if (await ask(c, o.id, o.down_since)) asked++;
        }
        continue;
      }
      if (!canSend) continue;
      const acs = acsInfo(c);
      const seen = db.prepare('SELECT first_seen FROM onu_offline_seen WHERE customer_id=?').get(cid);
      const since = acs.lastInform && (!seen || acs.lastInform < seen.first_seen) ? acs.lastInform : (seen && seen.first_seen);
      if (!since || Date.now() - Date.parse(since) < minH * H) continue;
      if (openTicket(cid) || !isUpToDate(c)) continue;
      const id = db.prepare('INSERT INTO onu_outages (customer_id, olt_id, onu_id, down_since, state, asked_count) VALUES (?,?,?,?,\'consultado\',0)')
        .run(cid, info.olt.id, String(info.onu.id || ''), since).lastInsertRowid;
      if (await ask(c, id, since)) asked++;
      else db.prepare('DELETE FROM onu_outages WHERE id=?').run(id);
    }
    return { offline: offline.size, asked };
  } finally { _busy = false; }
}

async function ask(c, outageId, since) {
  const chat = chatFor(c);
  if (!chat) { logger.warn(`[Caídas] ${c.name}: sin teléfono para consultar`); return false; }
  try {
    await sendTo(chat.id, fill(S('outage_msg_query'), c, { fecha: fmtDate(since) }));
    db.prepare("UPDATE onu_outages SET state='consultado', conv_id=?, asked_at=?, asked_count=asked_count+1, answer='', answered_at=NULL, noreply_alerted_at=NULL WHERE id=?")
      .run(chat.id, new Date().toISOString(), outageId);
    logger.info(`[Caídas] Consulta enviada a ${c.name} (equipo apagado desde ${since})`);
    return true;
  } catch (e) { logger.warn(`[Caídas] No se pudo consultar a ${c.name}: ${e.message}`); return false; }
}

async function alertNoReply(o, c) {
  db.prepare('UPDATE onu_outages SET state=\'sin_respuesta\', noreply_alerted_at=? WHERE id=?').run(new Date().toISOString(), o.id);
  const phones = [c.phone];
  try { require('../config/customerPhones').list(c).forEach(p => phones.push(p)); } catch (_) {}
  const list = [...new Set(phones.filter(Boolean).map(String))].join(' / ');
  try {
    await require('./waNotifyService').notifyAdmin(`📵 *EQUIPO CAÍDO SIN RESPUESTA*\n\n👤 ${c.name}${c.customer_code ? ' (' + c.customer_code + ')' : ''}\n📞 ${list || '-'}\n⏱️ Sin conexión desde el ${fmtDate(o.down_since)}\n\nNo respondió la consulta automática: conviene llamarlo.`);
  } catch (e) { logger.warn('[Caídas] aviso sin respuesta: ' + e.message); }
}

async function restored(o) {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(o.customer_id);
  let note = 'La ONU volvió a conectarse.';
  if (o.ticket_id) {
    const t = db.prepare('SELECT id, status, technician_id FROM tickets WHERE id=?').get(o.ticket_id);
    if (t && t.status === 'open' && !t.technician_id) {
      const ts = require('./ticketService');
      ts.updateTicketStatus(t.id, 'resolved');
      try { ts.addNote(t.id, 'Se cerró sola: la ONU volvió a conectarse antes de asignar técnico.', 'Sistema', 'oficina'); } catch (_) {}
      note += ` Asistencia #${t.id} cerrada (sin técnico asignado).`;
    } else if (t && ['open', 'in_progress'].includes(t.status)) {
      try { require('./ticketService').addNote(t.id, 'Aviso: la ONU del cliente volvió a conectarse.', 'Sistema', 'oficina'); } catch (_) {}
    }
  }
  db.prepare("UPDATE onu_outages SET state='restablecido', resolved_at=?, notes=TRIM(notes || ' ' || ?) WHERE id=?").run(new Date().toISOString(), note, o.id);
  if (c && o.conv_id && o.state !== 'ausente' && S('outage_msg_back') && require('../config/waGate').ready()) {
    try { await sendTo(o.conv_id, fill(S('outage_msg_back'), c)); } catch (_) {}
  }
  logger.info(`[Caídas] ${c ? c.name : o.customer_id}: ${note}`);
}

// ── respuestas del cliente ──────────────────────────────────────────────────
function parseAnswer(body) {
  const t = String(body || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!t) return null;
  const m = /^\*?\s*([1-4])\s*\*?(?:[\s.,)!-]|$)/.exec(t);
  if (m) return m[1];
  if (/luz roja|\broj[oa]\b|parpade/.test(t)) return '2';
  if (/(sin|no hay|no tengo|se corto la|corte de) (luz|energia|electricidad)|apagad|desenchuf|\bande\b/.test(t)) return '1';
  if (/de viaje|viaj|no estoy|no uso|ausente/.test(t)) return '4';
  if (/(luces|todo) (normal|bien|verde)|luz verde/.test(t)) return '3';
  return null;
}

async function onMessage(convId, msg) {
  try {
    ensureSchema();
    const o = db.prepare(`SELECT * FROM onu_outages WHERE conv_id=? AND state IN ('consultado','sin_respuesta','foto') ORDER BY id DESC LIMIT 1`).get(convId);
    if (!o || !o.asked_at || String(msg.ts) < o.asked_at) return;
    if (msg.sender === 'meta_ai') { db.prepare('UPDATE onu_outages SET meta_ai=1 WHERE id=?').run(o.id); return; }
    if (msg.sender !== 'cliente') return;
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(o.customer_id);
    if (!c) return;
    const ans = parseAnswer(msg.body);
    const now = new Date().toISOString();
    if (!ans) {
      if (o.state !== 'foto') db.prepare("UPDATE onu_outages SET state='foto', answer=?, answered_at=? WHERE id=?").run(msg.media_type ? '📷 foto' : String(msg.body || '').slice(0, 200), now, o.id);
      return; // queda en "Por atender" para que alguien lo mire
    }
    const set = (state, extra) => db.prepare(`UPDATE onu_outages SET state=?, answer=?, answered_at=?${extra ? ', ' + extra : ''} WHERE id=?`).run(state, ans, now, o.id);
    if (ans === '1') set('sin_energia');
    else if (ans === '4') set('ausente');
    else {
      const tid = await createTicket(c, o, ans);
      set('asistencia', 'ticket_id=' + Number(tid || 0));
    }
    try { await sendTo(convId, fill(S('outage_msg_' + ans), c)); } catch (e) { logger.warn('[Caídas] respuesta: ' + e.message); }
    try { require('./conversationOrgService').setOrg?.(convId, { dismiss: true }); } catch (_) {}
    logger.info(`[Caídas] ${c.name} respondió ${ans}`);
  } catch (e) { logger.warn('[Caídas] onMessage: ' + e.message); }
}

async function createTicket(c, o, ans) {
  const acs = acsInfo(c);
  const subject = ans === '2' ? 'Revisar fibra (luz roja / LOS)' : 'Sin internet: ONU sin registrar (luces normales)';
  const lines = [
    ans === '2' ? 'El cliente informó LUZ ROJA en el equipo (respuesta a la consulta automática).' : 'El cliente informó luces normales pero sin internet (respuesta a la consulta automática).',
    `ONU apagada en la OLT desde el ${fmtDate(o.down_since)}${o.onu_id ? ' (' + o.onu_id + ')' : ''}.`,
    acs.rx != null ? `Última potencia reportada: ${acs.rx} dBm${acs.rx <= -27 ? ' (señal débil antes de caerse)' : ''}.` : '',
    ans === '2' ? 'Llevar medidor de potencia; revisar conectores, roseta y tramo hasta la caja.' : 'Revisar ONU, cableado y registro en la OLT.',
  ].filter(Boolean);
  const ts = require('./ticketService');
  const tid = ts.createTicket(c.id, subject, lines.join('\n'), { status: 'open' }).lastInsertRowid;
  try {
    const waNotify = require('./waNotifyService');
    const digits = regional.normalizePhone(String(c.phone || '').replace(/\D/g, ''));
    const mapQ = (c.lat && c.lng) ? (c.lat + ',' + c.lng) : String(c.address || '');
    const msg = `📌 *NUEVA TAREA PARA TÉCNICOS*\n\n🎫 *Ticket:* #${tid}\n👤 *Cliente:* ${c.name}\n📞 *Contacto:* ${c.phone || '-'}\n📍 *Dirección:* ${c.address || '-'}\n` +
      `📝 *Problema/tarea:* ${subject}\n💬 *Detalle:* ${lines.join(' ')}\n\nRevisalo en tu panel de técnico para darle seguimiento.` +
      `\n🔗 *Accesos rápidos:*\n` + (digits ? `• 💬 Chat con el cliente: https://wa.me/${digits}\n` : '') +
      (mapQ ? `• 📍 Ubicación: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQ)}` : '');
    const list = require('../config/techPermissions').broadcastRecipients();
    for (const t of list) await waNotify.sendText(regional.normalizePhone(String(t.phone).replace(/\D/g, '')), msg);
    await waNotify.notifyAdmin(`🛠️ Asistencia #${tid} creada automáticamente: ${c.name} — ${subject}.`);
  } catch (e) { logger.warn('[Caídas] aviso de asistencia: ' + e.message); }
  return tid;
}

// ── panel ───────────────────────────────────────────────────────────────────
function list({ all } = {}) {
  ensureSchema();
  const rows = db.prepare(`SELECT o.*, c.name, c.customer_code, c.phone FROM onu_outages o LEFT JOIN customers c ON c.id=o.customer_id
    ${all ? '' : `WHERE o.state IN (${OPEN_STATES.map(() => '?').join(',')}) OR o.created_at >= datetime('now','-7 days')`}
    ORDER BY o.id DESC LIMIT 300`).all(...(all ? [] : OPEN_STATES));
  return rows.map(r => Object.assign(r, { stateLabel: STATES[r.state] || r.state, open: OPEN_STATES.includes(r.state) }));
}
function close(id, actor) {
  ensureSchema();
  db.prepare("UPDATE onu_outages SET state='cerrado', resolved_at=?, notes=TRIM(notes || ' ' || ?) WHERE id=?").run(new Date().toISOString(), 'Cerrado por ' + (actor || 'oficina') + '.', Number(id));
  return { ok: true };
}
function settings() {
  const out = {
    outage_query_enabled: enabled(),
    outage_query_hours: num('outage_query_hours', 24),
    outage_noreply_hours: num('outage_noreply_hours', 24),
    outage_reask_hours: num('outage_reask_hours', 24),
    outage_send_hours: String(getSetting('outage_send_hours', '1-6 08:00-19:00') || ''),
  };
  for (const k of Object.keys(DEFAULTS)) out[k] = S(k);
  return out;
}

module.exports = { STATES, OPEN_STATES, DEFAULTS, ensureSchema, scan, onMessage, parseAnswer, list, close, settings, inSendHours, isUpToDate };
