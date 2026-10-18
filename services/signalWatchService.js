'use strict';
/**
 * Avisos preventivos de señal: abre un reclamo para el técnico ANTES de que el cliente se quede sin internet.
 *
 * Una vez por día (signal_watch_hour, 08 h) se analiza el historial de potencia de cada cliente activo cuyo equipo
 * está en línea (services/onuPowerHistoryService.js → analyze):
 *   - "degradacion": la señal bajó 2 dB o más en la semana, o ya está en nivel malo (onu_rx_bad, −27 dBm);
 *   - "inestable": el equipo se cayó y volvió 3 veces o más en 48 h.
 * Por cada uno (sin reclamo abierto y sin aviso en los últimos signal_watch_cooldown_days días) se crea un reclamo
 * "preventivo" con el diagnóstico, hasta signal_watch_max_per_day por día (primero los peores). A la administración le
 * llega un solo resumen. No se le escribe al cliente.
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

  const max = num('signal_watch_max_per_day', 3);
  const list = candidates(), todo = list.filter(x => !x.skip);
  const made = [];
  for (const x of todo.slice(0, max)) {
    const a = x.analysis, c = x.customer;
    const subject = x.kind === 'inestable' ? 'Equipo inestable (preventivo)' : (a.base != null && a.base - a.last >= 2 ? 'Señal bajando (preventivo)' : 'Señal baja (preventivo)');
    const msg = [
      'Reclamo preventivo creado por el sistema: el cliente todavía tiene servicio, pero la señal indica un problema.',
      a.text,
      x.kind === 'inestable' ? '' : `Potencia: ${fmt(a.base)} dBm al inicio de la semana → ${fmt(a.last)} dBm ahora (mínimo ${fmt(a.min)}).`,
      'Llevar medidor de potencia; revisar conectores, roseta, empalmes y el tramo hasta la caja NAP.',
    ].filter(Boolean).join('\n');
    try {
      const tid = require('./ticketService').createTicket(c.id, subject, msg, { status: 'open' }).lastInsertRowid;
      db.prepare('INSERT INTO signal_alerts (customer_id, kind, rx_base, rx_last, flaps, ticket_id, text) VALUES (?,?,?,?,?,?,?)').run(c.id, x.kind, a.base, a.last, a.flaps || 0, tid, a.text);
      made.push({ c, tid, subject, a });
    } catch (e) { logger.warn(`[Señal] no se pudo crear el reclamo de ${c.name}: ${e.message}`); }
  }
  if (made.length || todo.length > made.length) {
    const rest = todo.slice(made.length);
    try {
      await require('./waNotifyService').notifyAdmin(`📉 *AVISO PREVENTIVO DE SEÑAL*\n\nClientes con servicio pero con la señal en problemas:\n\n` +
        made.map(m => `• *${m.c.name}* — ${m.subject.replace(' (preventivo)', '')}: ${fmt(m.a.base)} → ${fmt(m.a.last)} dBm · reclamo #${m.tid}`).join('\n') +
        (rest.length ? `\n\nQuedan ${rest.length} más para los próximos días: ` + rest.map(r => r.customer.name).join(', ') : '') +
        `\n\nSe abrió un reclamo para que el técnico lo revise antes de que se queden sin internet.`);
    } catch (e) { logger.warn('[Señal] resumen: ' + e.message); }
  }
  logger.info(`[Señal] aviso preventivo: ${made.length} reclamo(s), ${todo.length - made.length} pendiente(s), ${list.length - todo.length} omitido(s)`);
  return { created: made.length, pending: todo.length - made.length, skipped: list.length - todo.length };
}

function recent(limit = 20) {
  ensureSchema();
  return db.prepare("SELECT s.*, c.name FROM signal_alerts s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.kind != '_run' ORDER BY s.id DESC LIMIT ?").all(limit);
}

module.exports = { ensureSchema, candidates, run, recent };
