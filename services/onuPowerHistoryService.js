'use strict';
/**
 * Historial de potencia de las ONU: cada cierto tiempo se guarda la potencia (RX), el estado y la temperatura
 * de cada ONU vinculada a un cliente. La OLT no guarda historial ni el motivo de las caídas: con esto, ante un
 * equipo caído, se ve si la señal venía bajando (fibra / conector) o si estaba bien y se cortó de golpe (energía).
 *
 * Parámetros: onu_power_history_minutes (cada cuántos minutos, 30), onu_power_history_days (cuántos días se
 * guardan, 180), onu_rx_good / onu_rx_bad (umbrales, los mismos de services/onuPowerService.js).
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  db.exec(`CREATE TABLE IF NOT EXISTS onu_power_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    olt_id INTEGER, onu_ref TEXT,
    ts TEXT NOT NULL,
    online INTEGER NOT NULL DEFAULT 0,
    rx REAL, temp REAL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_onu_power_history_c ON onu_power_history(customer_id, ts)');
  _schema = true;
}

const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };
// umbrales en dBm (negativos): se respeta el valor configurado aunque se cargue sin signo
const dbm = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n !== 0 ? -Math.abs(n) : d; };
const toNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

let _busy = false, _lastAt = 0;
/** Toma una muestra de todas las ONU (si ya pasó el intervalo, o siempre con force). */
async function sample({ force = false } = {}) {
  if (_busy) return { skipped: 'busy' };
  ensureSchema();
  if (!force) {
    if (!_lastAt) { const r = db.prepare('SELECT MAX(ts) t FROM onu_power_history').get(); _lastAt = r && r.t ? Date.parse(r.t) : 0; }
    if (Date.now() - _lastAt < num('onu_power_history_minutes', 30) * 60e3 - 30e3) return { skipped: 'interval' };
  }
  _busy = true;
  try {
    const rows = await require('./onuPowerService').readAll();
    const inv = db.prepare('SELECT olt_id, onu_ref, customer_id FROM onu_inventory WHERE customer_id IS NOT NULL').all();
    const byRef = new Map(inv.map(i => [i.olt_id + '|' + i.onu_ref, i.customer_id]));
    const ts = new Date().toISOString();
    const ins = db.prepare('INSERT INTO onu_power_history (customer_id, olt_id, onu_ref, ts, online, rx, temp) VALUES (?,?,?,?,?,?,?)');
    let n = 0;
    db.transaction(() => {
      for (const r of rows) {
        const cid = byRef.get(r.olt_id + '|' + r.id);
        if (!cid) continue;
        const online = /^online$/i.test(String(r.status || '')) ? 1 : 0;
        ins.run(cid, r.olt_id, String(r.id), ts, online, online ? toNum(r.rx) : null, online ? toNum(r.temp) : null);
        n++;
      }
    })();
    _lastAt = Date.now();
    const days = num('onu_power_history_days', 180);
    db.prepare("DELETE FROM onu_power_history WHERE ts < ?").run(new Date(Date.now() - days * 86400e3).toISOString());
    return { ok: true, saved: n };
  } finally { _busy = false; }
}

function history(customerId, { days = 7, until = null } = {}) {
  ensureSchema();
  const end = until ? new Date(until) : new Date();
  const start = new Date(end.getTime() - days * 86400e3);
  return db.prepare('SELECT ts, online, rx, temp, onu_ref FROM onu_power_history WHERE customer_id=? AND ts>=? AND ts<=? ORDER BY ts')
    .all(Number(customerId), start.toISOString(), end.toISOString());
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (n) => (n == null ? '-' : (Math.round(n * 10) / 10).toFixed(1));

/**
 * Diagnóstico de la señal hasta un momento (por defecto, ahora): ¿venía bajando, estaba estable o se caía y volvía?
 * Devuelve { kind: 'sin_datos'|'degradacion'|'inestable'|'estable', text, base, last, min, flaps, samples }.
 */
function analyze(customerId, { until = null, days = 7 } = {}) {
  const h = history(customerId, { days, until });
  const on = h.filter(x => x.online && x.rx != null);
  if (on.length < 3) return { kind: 'sin_datos', text: 'Todavía no hay historial suficiente de la señal de este equipo.', samples: h.length };
  const good = dbm('onu_rx_good', -25), bad = dbm('onu_rx_bad', -27);
  const firstHalf = on.slice(0, Math.max(1, Math.floor(on.length / 2)));
  const base = median(firstHalf.map(x => x.rx));
  const lastN = on.slice(-3).map(x => x.rx);
  const last = median(lastN);
  const min = Math.min(...on.map(x => x.rx));
  // caídas y vueltas en las últimas 48 h
  const since = (until ? Date.parse(until) : Date.now()) - 48 * 3600e3;
  let flaps = 0;
  const recent = h.filter(x => Date.parse(x.ts) >= since);
  for (let i = 1; i < recent.length; i++) if (recent[i - 1].online && !recent[i].online) flaps++;
  const out = { base, last, min, flaps, samples: h.length };
  if (last <= bad || (base != null && base - last >= 2)) {
    const dropping = base != null && base - last >= 1;
    return { ...out, kind: 'degradacion', text: dropping
      ? `La señal venía bajando: de ${fmt(base)} a ${fmt(last)} dBm${last <= bad ? ' (ya en nivel malo)' : ''}. Probable problema de fibra, conector o empalme: conviene que pase el técnico.`
      : `La señal está en nivel malo (${fmt(last)} dBm; lo aceptable es ${fmt(bad)} o mejor). Puede cortarse en cualquier momento: revisar conectores, roseta y empalmes.` };
  }
  if (flaps >= 3) {
    return { ...out, kind: 'inestable', text: `El equipo se cayó y volvió ${flaps} veces en las últimas 48 h con señal ${fmt(last)} dBm. Puede ser energía inestable, un conector flojo o la ONU fallando.` };
  }
  return { ...out, kind: 'estable', text: `La señal estaba estable (${fmt(last)} dBm${last >= good ? ', buena' : ', al límite'}). Si se apagó de golpe, lo más probable es un corte de energía o el equipo desenchufado.` };
}

/** Datos para el gráfico de la ficha: puntos {t, rx|null} y los umbrales. */
function chart(customerId, days = 7) {
  const h = history(customerId, { days });
  return { points: h.map(x => ({ t: x.ts, rx: x.online ? x.rx : null })), good: dbm('onu_rx_good', -25), bad: dbm('onu_rx_bad', -27), days };
}

module.exports = { ensureSchema, sample, history, analyze, chart };
