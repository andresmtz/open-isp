'use strict';
/**
 * Avisos preventivos de señal: avisa ANTES de que el cliente se quede sin internet. No abre reclamos solo:
 * el personal decide con el aviso si hace falta uno (botón "Crear reclamo" en Equipos caídos → createTicket).
 *
 * Una vez por día (signal_watch_hour, 08 h) se analiza el historial de potencia de cada cliente activo cuyo equipo
 * está en línea (services/onuPowerHistoryService.js → analyze):
 *   - "degradacion": la señal bajó 2 dB o más en la semana, o ya está en nivel malo (onu_rx_bad, −27 dBm);
 *   - "inestable": el equipo se cayó y volvió 3 veces o más en 48 h.
 * Cada uno (sin reclamo abierto y sin aviso en los últimos signal_watch_cooldown_days días) queda registrado como
 * aviso y a la administración le llega un solo resumen por WhatsApp (primero los peores). No se le escribe al cliente.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };
const enabled = () => { const v = getSetting('signal_watch_enabled', true); return !(v === false || v === 'false' || v === 0 || v === '0'); };

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  db.exec(`CREATE TABLE IF NOT EXISTS signal_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, kind TEXT, rx_base REAL, rx_last REAL, flaps INTEGER,
    ticket_id INTEGER, text TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_signal_alerts_c ON signal_alerts(customer_id, created_at)');
  _schema = true;
}

const fmt = (n) => (n == null ? '-' : (Math.round(n * 10) / 10).toFixed(1).replace('.', ','));

/** Candidatos de hoy (sin crear nada). */
function candidates() {
  ensureSchema();
  const ph = require('./onuPowerHistoryService');
  const cooldown = num('signal_watch_cooldown_days', 14);
  const since = new Date(Date.now() - cooldown * 86400e3).toISOString().replace('T', ' ').slice(0, 19);
  const bad = -Math.abs(Number(getSetting('onu_rx_bad', -27)) || 27);
  const out = [];
  for (const c of db.prepare("SELECT id, name, customer_code, address FROM customers WHERE status='active'").all()) {
    const last = db.prepare('SELECT online FROM onu_power_history WHERE customer_id=? ORDER BY ts DESC LIMIT 1').get(c.id);
    if (!last || !last.online) continue; // si está apagado lo atienden las caídas (consulta automática / caída masiva)
    const a = ph.analyze(c.id);
    if (a.kind !== 'degradacion' && a.kind !== 'inestable') continue;
    const why = db.prepare("SELECT id FROM tickets WHERE customer_id=? AND status IN ('open','in_progress') LIMIT 1").get(c.id) ? 'tiene un reclamo abierto'
      : db.prepare('SELECT id FROM signal_alerts WHERE customer_id=? AND created_at >= ? LIMIT 1').get(c.id, since) ? `ya se avisó en los últimos ${cooldown} días` : '';
    // gravedad: cuánto bajó, o cuán por debajo del nivel malo está, o cuántas caídas tuvo
    const severity = a.kind === 'inestable' ? a.flaps : Math.max((a.base != null ? a.base - a.last : 0), bad - a.last + 1);
    out.push({ customer: c, analysis: a, kind: a.kind, severity, skip: why });
  }
  return out.sort((x, y) => y.severity - x.severity);
}

let _lastDay = '';
async function run({ force = false } = {}) {
  if (!enabled() && !force) return { skipped: 'desactivado' };
  ensureSchema();
  const tz = getSetting('timezone', 'America/Asuncion');
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  const day = `${p.year}-${p.month}-${p.day}`;
  if (!force) {
    if (Number(p.hour) < num('signal_watch_hour', 8) || _lastDay === day) return { skipped: 'fuera de hora o ya corrió hoy' };
    if (db.prepare("SELECT 1 FROM signal_alerts WHERE kind='_run' AND text=?").get(day)) { _lastDay = day; return { skipped: 'ya corrió hoy' }; }
  }
  _lastDay = day;
  db.prepare("INSERT INTO signal_alerts (customer_id, kind, text) VALUES (0, '_run', ?)").run(day);

  const list = candidates(), todo = list.filter(x => !x.skip);
  const ins = db.prepare('INSERT INTO signal_alerts (customer_id, kind, rx_base, rx_last, flaps, text) VALUES (?,?,?,?,?,?)');
  for (const x of todo) ins.run(x.customer.id, x.kind, x.analysis.base, x.analysis.last, x.analysis.flaps || 0, x.analysis.text);
  if (todo.length) {
    try {
      await require('./waNotifyService').notifyAdmin(`📉 *AVISO PREVENTIVO DE SEÑAL*\n\nClientes con servicio pero con la señal en problemas:\n\n` +
        todo.map(x => `• *${x.customer.name}* — ${subjectOf(x).replace(' (preventivo)', '')}: ${x.kind === 'inestable' ? x.analysis.flaps + ' caídas en 48 h' : fmt(x.analysis.base) + ' → ' + fmt(x.analysis.last) + ' dBm'}`).join('\n') +
        `\n\nSi hace falta que vaya el técnico, creá el reclamo desde Equipos caídos → Aviso preventivo de señal.`);
    } catch (e) { logger.warn('[Señal] resumen: ' + e.message); }
  }
  logger.info(`[Señal] aviso preventivo: ${todo.length} aviso(s), ${list.length - todo.length} omitido(s)`);
  return { alerted: todo.length, skipped: list.length - todo.length };
}

function subjectOf(x) {
  const a = x.analysis;
  return x.kind === 'inestable' ? 'Equipo inestable (preventivo)' : (a.base != null && a.base - a.last >= 2 ? 'Señal bajando (preventivo)' : 'Señal baja (preventivo)');
}

/** Lo decide el personal: crea el reclamo preventivo con el diagnóstico del aviso. */
function createTicket(customerId, { by = '' } = {}) {
  ensureSchema();
  const x = candidates().find(k => k.customer.id === Number(customerId));
  if (!x) throw new Error('Ese cliente ya no tiene la señal en problemas.');
  if (db.prepare("SELECT 1 FROM tickets WHERE customer_id=? AND status IN ('open','in_progress')").get(x.customer.id)) throw new Error('El cliente ya tiene un reclamo abierto.');
  const a = x.analysis;
  const msg = [
    `Reclamo preventivo${by ? ' creado por ' + by : ''}: el cliente todavía tiene servicio, pero la señal indica un problema.`,
    a.text,
    x.kind === 'inestable' ? '' : `Potencia: ${fmt(a.base)} dBm al inicio de la semana → ${fmt(a.last)} dBm ahora (mínimo ${fmt(a.min)}).`,
    'Llevar medidor de potencia; revisar conectores, roseta, empalmes y el tramo hasta la caja NAP.',
  ].filter(Boolean).join('\n');
  const tid = require('./ticketService').createTicket(x.customer.id, subjectOf(x), msg, { status: 'open' }).lastInsertRowid;
  const last = db.prepare("SELECT id FROM signal_alerts WHERE customer_id=? AND kind != '_run' ORDER BY id DESC LIMIT 1").get(x.customer.id);
  if (last) db.prepare('UPDATE signal_alerts SET ticket_id=? WHERE id=?').run(tid, last.id);
  else db.prepare('INSERT INTO signal_alerts (customer_id, kind, rx_base, rx_last, flaps, ticket_id, text) VALUES (?,?,?,?,?,?,?)').run(x.customer.id, x.kind, a.base, a.last, a.flaps || 0, tid, a.text);
  return { tid, name: x.customer.name };
}

function recent(limit = 20) {
  ensureSchema();
  return db.prepare("SELECT s.*, c.name FROM signal_alerts s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.kind != '_run' ORDER BY s.id DESC LIMIT ?").all(limit);
}

module.exports = { ensureSchema, candidates, run, recent, createTicket };
