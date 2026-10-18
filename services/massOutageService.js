'use strict';
/**
 * Caídas masivas: varias ONU del mismo puerto PON que se apagan casi a la vez (corte de luz en la zona o de fibra).
 *
 * Cada pocos minutos se lee la OLT (la misma lectura del monitoreo, con caché). Por puerto:
 *   - se toman las ONU desconectadas con hora de desconexión (la que informa la OLT) de las últimas 6 h;
 *   - si dentro de una ventana de mass_outage_window_min minutos se cayeron al menos mass_outage_min equipos y eso es al
 *     menos mass_outage_ratio del puerto, se abre UNA caída masiva y se avisa una sola vez a la administración;
 *   - mientras la caída está abierta, sus clientes no reciben la consulta automática por equipo caído
 *     (services/outageService.js) ni se repite el aviso;
 *   - cuando vuelve la mayoría (mass_outage_restore_ratio), se cierra sola: aviso de restablecido y, si el aviso general
 *     de "Caída" lo publicó esta caída, se quita.
 * Desde Operación → Equipos caídos: publicar el aviso general, crear UN reclamo para el técnico o cerrarla a mano.
 * Si la OLT no responde varias lecturas seguidas, también se avisa (puede ser un corte de luz en el nodo).
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting, saveSettings } = require('../config/settingsManager');

const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };
const enabled = () => { const v = getSetting('mass_outage_enabled', true); return !(v === false || v === 'false' || v === 0 || v === '0'); };
const REASON = { energia: 'corte de energía (los equipos se apagaron)', fibra: 'corte de fibra / sin señal (LOS)', mixto: 'varios motivos' };

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  db.exec(`CREATE TABLE IF NOT EXISTS mass_outages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    olt_id INTEGER, port TEXT NOT NULL, started_at TEXT NOT NULL, detected_at TEXT DEFAULT (datetime('now')),
    reason TEXT DEFAULT '', members TEXT DEFAULT '[]', port_total INTEGER DEFAULT 0,
    state TEXT DEFAULT 'abierta', closed_at TEXT, closed_by TEXT DEFAULT '',
    notice_published INTEGER DEFAULT 0, ticket_id INTEGER, restored_count INTEGER DEFAULT 0
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mass_outages_state ON mass_outages(state)');
  _schema = true;
}

// "Sin energía (equipo apagado) (2026/10/18 15:08:35)" → ms (hora local de la OLT)
function deregTime(reason) {
  const m = /\((\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\)/.exec(String(reason || ''));
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return isNaN(t) ? null : t;
}
const kindOf = (reason) => /energ|power/i.test(reason || '') ? 'energia' : (/fibra|LOS|wire/i.test(reason || '') ? 'fibra' : 'otro');
const portOf = (id) => String(id || '').split(':')[0];
const members = (ev) => { try { return JSON.parse(ev.members || '[]'); } catch (_) { return []; } };

function openEvents() { ensureSchema(); return db.prepare("SELECT * FROM mass_outages WHERE state='abierta' ORDER BY id").all(); }
/** ¿El cliente está dentro de una caída masiva abierta? (para no mandarle la consulta individual) */
function isInMass(customerId) {
  const id = Number(customerId);
  return openEvents().some(ev => members(ev).some(m => Number(m.customer_id) === id));
}

const fmt = (ms) => new Date(ms).toLocaleString('es-PY', { timeZone: getSetting('timezone', 'America/Asuncion'), day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const dur = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
async function notify(text) { try { await require('./waNotifyService').notifyAdmin(text); } catch (e) { logger.warn('[Caída masiva] aviso: ' + e.message); } }

let _busy = false, _oltFails = {};
async function scan() {
  if (_busy || !enabled()) return { skipped: true };
  _busy = true;
  try {
    ensureSchema();
    const oltSvc = require('./oltService');
    const olts = (oltSvc.getActiveOlts ? oltSvc.getActiveOlts() : []) || [];
    const minN = num('mass_outage_min', 3), ratio = Math.min(1, num('mass_outage_ratio', 0.25)), winMs = num('mass_outage_window_min', 15) * 60000;
    const restoreRatio = Math.min(1, num('mass_outage_restore_ratio', 0.8));
    const now = Date.now(), res = { opened: 0, updated: 0, closed: 0 };

    for (const olt of olts) {
      let s;
      try { s = await oltSvc.getOltStats(olt.id, true); } catch (e) { s = { error: e.message }; }
      // OLT sin respuesta: aviso a la 3.ª lectura fallida seguida (y uno al volver)
      if (!s || s.error || !Array.isArray(s.onus) || !s.onus.length) {
        _oltFails[olt.id] = (_oltFails[olt.id] || 0) + 1;
        if (_oltFails[olt.id] === 3) await notify(`🚨 *OLT SIN RESPUESTA*\n\n📡 ${olt.name || 'OLT'} (${olt.host})\nNo responde hace varios minutos. Puede ser un corte de energía o de red en el nodo: todos sus clientes quedarían sin servicio.`);
        continue;
      }
      if ((_oltFails[olt.id] || 0) >= 3) await notify(`✅ *OLT RESPONDE DE NUEVO*\n\n📡 ${olt.name || 'OLT'} (${olt.host}) volvió a responder.`);
      _oltFails[olt.id] = 0;

      const byPort = {};
      for (const u of s.onus) (byPort[portOf(u.id)] = byPort[portOf(u.id)] || []).push(u);
      const open = openEvents().filter(ev => Number(ev.olt_id) === Number(olt.id));

      for (const [port, list] of Object.entries(byPort)) {
        const isOn = (u) => /^online$/i.test(String(u.status || ''));
        const ev = open.find(e => e.port === port);
        // caídas recientes con hora de la OLT (las "Sin registro" son equipos suspendidos o retirados: no cuentan)
        const down = list.filter(u => !isOn(u)).map(u => ({ u, t: deregTime(u.offline_reason) })).filter(x => x.t && now - x.t < 6 * 3600000).sort((a, b) => a.t - b.t);

        if (ev) {
          // actualizar: sumar las que se cayeron después dentro de la misma caída; cerrar si volvió la mayoría
          const ms = members(ev), ids = new Set(ms.map(m => m.onu));
          for (const x of down) if (!ids.has(x.u.id) && x.t >= Date.parse(ev.started_at) - winMs) { ms.push({ onu: x.u.id, customer_id: x.u.customer_id || null, name: x.u.customer_name || x.u.name, t: new Date(x.t).toISOString(), reason: x.u.offline_reason }); res.updated++; }
          const back = ms.filter(m => { const u = list.find(l => l.id === m.onu); return u && isOn(u); }).length;
          db.prepare('UPDATE mass_outages SET members=?, restored_count=? WHERE id=?').run(JSON.stringify(ms), back, ev.id);
          if (ms.length && back / ms.length >= restoreRatio) { await closeEvent(ev.id, 'automático', { back, total: ms.length }); res.closed++; }
          continue;
        }

        // detectar: la ventana de winMs con más caídas
        let best = [];
        for (let i = 0; i < down.length; i++) {
          const grp = down.filter(x => x.t >= down[i].t && x.t - down[i].t <= winMs);
          if (grp.length > best.length) best = grp;
        }
        if (best.length < minN || best.length < Math.ceil(ratio * list.length)) continue;
        if (now - best[best.length - 1].t > 60 * 60000) continue; // solo caídas recientes (no avisar de algo viejo)
        const kinds = best.map(x => kindOf(x.u.offline_reason));
        const reason = kinds.every(k => k === 'energia') ? 'energia' : (kinds.every(k => k === 'fibra') ? 'fibra' : (kinds.filter(k => k === 'energia').length > kinds.length / 2 ? 'energia' : (kinds.filter(k => k === 'fibra').length > kinds.length / 2 ? 'fibra' : 'mixto')));
        const ms = best.map(x => ({ onu: x.u.id, customer_id: x.u.customer_id || null, name: x.u.customer_name || x.u.name, t: new Date(x.t).toISOString(), reason: x.u.offline_reason }));
        const id = db.prepare('INSERT INTO mass_outages (olt_id, port, started_at, reason, members, port_total) VALUES (?,?,?,?,?,?)')
          .run(olt.id, port, new Date(best[0].t).toISOString(), reason, JSON.stringify(ms), list.length).lastInsertRowid;
        res.opened++;
        logger.warn(`[Caída masiva] ${port}: ${ms.length} de ${list.length} ONU caídas (${reason}) desde ${fmt(best[0].t)}`);
        await notify(`🚨 *CAÍDA MASIVA DETECTADA*\n\n📡 ${olt.name || 'OLT'} · puerto *${port.replace('EPON', 'EPON ')}*\n` +
          `👥 *${ms.length} de ${list.length}* equipos se apagaron entre las ${fmt(best[0].t).slice(-5)} y las ${fmt(best[best.length - 1].t).slice(-5)}\n` +
          `⚡ Motivo probable: ${REASON[reason]}\n\n` + ms.slice(0, 12).map(m => '• ' + (m.name || m.onu)).join('\n') + (ms.length > 12 ? `\n• … y ${ms.length - 12} más` : '') +
          `\n\nNo se les manda la consulta individual por equipo caído. Desde *Operación → Equipos caídos* podés publicar el aviso general o crear un reclamo para el técnico. (#${id})`);
      }
    }
    return res;
  } finally { _busy = false; }
}

async function closeEvent(id, by, info = {}) {
  ensureSchema();
  const ev = db.prepare('SELECT * FROM mass_outages WHERE id=?').get(Number(id));
  if (!ev || ev.state !== 'abierta') return false;
  db.prepare("UPDATE mass_outages SET state='cerrada', closed_at=?, closed_by=? WHERE id=?").run(new Date().toISOString(), String(by || ''), ev.id);
  // aviso general publicado por esta caída: se quita si sigue siendo el mismo
  let removed = false;
  if (ev.notice_published && String(getSetting('notice_mode', 'NORMAL')) === 'GANGGUAN_MASAL' && String(getSetting('notice_note', '')).indexOf(ev.port.replace('EPON', 'EPON ')) !== -1) {
    saveSettings({ notice_mode: 'NORMAL', notice_start: '', notice_note: '' }); removed = true;
  }
  const ms = members(ev);
  await notify(`✅ *CAÍDA MASIVA RESTABLECIDA*\n\n📡 Puerto *${ev.port.replace('EPON', 'EPON ')}*: ` +
    (info.total ? `volvieron ${info.back} de ${info.total} equipos` : `cerrada por ${by}`) + `\n⏱️ Duró ${dur(Date.now() - Date.parse(ev.started_at))}` +
    (removed ? '\n📢 Se quitó el aviso general de caída.' : (ev.notice_published ? '\n📢 El aviso general de caída sigue publicado (fue modificado a mano): quitalo desde Estado del servicio.' : '')) + (ev.ticket_id ? `\n🎫 Revisá el reclamo #${ev.ticket_id}.` : ''));
  logger.info(`[Caída masiva] #${ev.id} ${ev.port} cerrada (${by}); ${ms.length} equipos`);
  return true;
}

/** Publica el aviso general de "Caída" (Estado del servicio) con la zona afectada. */
function publishNotice(id) {
  ensureSchema();
  const ev = db.prepare('SELECT * FROM mass_outages WHERE id=?').get(Number(id));
  if (!ev || ev.state !== 'abierta') throw new Error('La caída ya está cerrada');
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: getSetting('timezone', 'America/Asuncion'), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ev.started_at)).reduce((o, x) => (o[x.type] = x.value, o), {});
  const why = ev.reason === 'energia' ? 'Hay un corte de energía en una zona de nuestra red.' : (ev.reason === 'fibra' ? 'Hay un corte de fibra en una zona de nuestra red.' : 'Hay una falla en una zona de nuestra red.');
  saveSettings({ notice_mode: 'GANGGUAN_MASAL', notice_start: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`,
    notice_note: `${why} El equipo técnico ya está trabajando para restablecer el servicio. (zona ${ev.port.replace('EPON', 'EPON ')})` });
  db.prepare('UPDATE mass_outages SET notice_published=1 WHERE id=?').run(ev.id);
  return true;
}

/** Crea UN reclamo para el técnico (a nombre del primer cliente afectado, con la lista completa). */
function createTicket(id, by) {
  ensureSchema();
  const ev = db.prepare('SELECT * FROM mass_outages WHERE id=?').get(Number(id));
  if (!ev) throw new Error('Caída no encontrada');
  if (ev.ticket_id) return ev.ticket_id;
  const ms = members(ev).filter(m => m.customer_id);
  if (!ms.length) throw new Error('Ningún equipo de esta caída está asignado a un cliente');
  const custs = ms.map(m => db.prepare('SELECT id, name, address, lat, lng FROM customers WHERE id=?').get(m.customer_id)).filter(Boolean);
  const subject = `Caída masiva en ${ev.port.replace('EPON', 'EPON ')} (${ms.length} clientes)`;
  const lines = [
    `Se apagaron ${ms.length} de ${ev.port_total} equipos del puerto ${ev.port.replace('EPON', 'EPON ')} desde las ${fmt(Date.parse(ev.started_at))}.`,
    `Motivo probable: ${REASON[ev.reason] || ev.reason}.`,
    ev.reason === 'fibra' ? 'Revisar el tramo de fibra y las cajas NAP que alimentan a estos clientes.' : 'Verificar si hay corte de energía en la zona; si hay luz, revisar la caja NAP / alimentación.',
    'Clientes afectados:', ...custs.map(c => `• ${c.name}${c.address ? ' — ' + c.address : ''}${c.lat && c.lng ? ' — https://maps.google.com/?q=' + c.lat + ',' + c.lng : ''}`),
  ];
  const tid = require('./ticketService').createTicket(custs[0].id, subject, lines.join('\n'), { status: 'open' }).lastInsertRowid;
  db.prepare('UPDATE mass_outages SET ticket_id=? WHERE id=?').run(tid, ev.id);
  logger.info(`[Caída masiva] #${ev.id}: reclamo #${tid} creado por ${by || '-'}`);
  return tid;
}

function list({ limit = 20 } = {}) {
  ensureSchema();
  return db.prepare('SELECT * FROM mass_outages ORDER BY id DESC LIMIT ?').all(limit).map(ev => Object.assign(ev, { members: members(ev), reasonText: REASON[ev.reason] || ev.reason }));
}

module.exports = { ensureSchema, scan, isInMass, openEvents, closeEvent, publishNotice, createTicket, list, deregTime, REASON };
