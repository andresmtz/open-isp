'use strict';
/**
 * Potencia óptica de la ONU de un cliente, leída en el momento desde la OLT (VSOL por consola, ~1,5 s).
 * RX = lo que recibe la ONU por la fibra (lo que importa). Umbrales (parámetros):
 *   onu_rx_good  (por defecto -25 dBm): igual o mejor → buena
 *   onu_rx_bad   (por defecto -27 dBm): peor → mala (cortes y lentitud); entre ambos → al límite
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');

let _cache = { at: 0, rows: null, olt: null };

function verdict(rx) {
  const n = parseFloat(rx);
  const good = Number(getSetting('onu_rx_good', -25)), bad = Number(getSetting('onu_rx_bad', -27));
  if (!Number.isFinite(n)) return { level: 'sin dato', color: 'gray', advice: 'La ONU no informa la potencia (¿apagada o sin fibra?).' };
  if (n >= -8) return { level: 'demasiado alta', color: 'orange', advice: 'Señal muy fuerte: revisar que no falte un atenuador/splitter.' };
  if (n >= good) return { level: 'buena', color: 'green', advice: 'Potencia correcta.' };
  if (n >= bad) return { level: 'al límite', color: 'orange', advice: 'Funciona pero justa: limpiar los conectores y revisar empalmes y curvas de la fibra.' };
  return { level: 'mala', color: 'red', advice: 'Puede cortarse o andar lento: limpiar conectores, revisar empalmes, curvas cerradas o el puerto de la caja NAP.' };
}

async function readAll() {
  if (_cache.rows && Date.now() - _cache.at < 15000) return _cache.rows;
  const olts = db.prepare("SELECT * FROM olts WHERE is_active=1 AND lower(brand)='vsol'").all();
  const oltSvc = require('./oltService');
  const rows = [];
  for (const olt of olts) for (const r of await oltSvc.fetchVsolEponViaTelnet(olt)) rows.push({ ...r, olt_id: olt.id });
  _cache = { at: Date.now(), rows };
  return rows;
}

/** Potencia de la ONU vinculada al cliente (o de una referencia EPON0/P:N dada). */
async function forCustomer(customerId, { onuRef = null } = {}) {
  const inv = onuRef ? db.prepare('SELECT * FROM onu_inventory WHERE onu_ref=?').get(onuRef) : require('./onuManageService').forCustomer(Number(customerId));
  if (!inv) return { ok: false, message: 'El cliente todavía no tiene una ONU vinculada.' };
  const rows = await readAll();
  const r = rows.find(x => x.olt_id === inv.olt_id && String(x.id) === String(inv.onu_ref));
  if (!r) return { ok: false, message: `La ONU ${inv.onu_ref} no figura en la OLT.` };
  const v = verdict(r.rx);
  return { ok: true, onu: inv.onu_ref, status: r.status, rx: r.rx, tx: r.tx, temp: r.temp, distance: r.distance, ...v, at: new Date().toISOString() };
}

function text(p) {
  if (!p || !p.ok) return p ? p.message : '';
  return `Potencia: ${p.rx} dBm (${p.level})` + (p.distance && p.distance !== '-' ? ` · distancia ${p.distance} m` : '');
}

module.exports = { forCustomer, verdict, text, readAll };
