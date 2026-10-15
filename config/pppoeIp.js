'use strict';
/**
 * IP fija para clientes PPPoE nuevos (como hacía WispHub): cada usuario PPPoE lleva su propia IP
 * (remote-address) y la IP del router (local-address). Los perfiles de los planes no tienen pool,
 * así que un usuario sin IP no podría navegar. Además, el corte por la lista Moroso funciona por IP:
 * con IP fija el cliente no la cambia al reconectar.
 *
 * Parámetros (Configuración):
 *   pppoe_local_address  IP del router para PPPoE              (por defecto 100.66.0.1)
 *   pppoe_ip_range       rango de IP para clientes            (por defecto 100.66.0.2-100.66.0.254)
 *   pppoe_ip_order       'desc' = de la más alta a la más baja (como WispHub) | 'asc'
 */
const db = require('./database');
const { getSetting } = require('./settingsManager');

const toInt = (ip) => String(ip).split('.').reduce((a, o) => a * 256 + (Number(o) & 255), 0);
const toIp = (n) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');
const isIp = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(s || '').trim());

function config() {
  const local = String(getSetting('pppoe_local_address', '100.66.0.1') || '100.66.0.1').trim();
  const range = String(getSetting('pppoe_ip_range', '100.66.0.2-100.66.0.254') || '').trim();
  const m = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(range);
  if (!isIp(local) || !m || !isIp(m[1]) || !isIp(m[2])) throw new Error('Rango de IP PPPoE mal configurado (pppoe_local_address / pppoe_ip_range).');
  return { local, from: toInt(m[1]), to: toInt(m[2]), order: getSetting('pppoe_ip_order', 'desc') === 'asc' ? 'asc' : 'desc' };
}

/** Elige la próxima IP libre (no usada por ningún cliente del sistema ni por ningún usuario del MikroTik). */
async function allocate(routerId) {
  const c = config();
  const used = new Set([toInt(c.local)]);
  for (const r of db.prepare("SELECT pppoe_remote_address a, static_ip b FROM customers WHERE status != 'cancelled'").all()) {
    if (isIp(r.a)) used.add(toInt(r.a));
    if (isIp(r.b)) used.add(toInt(r.b));
  }
  try {
    const mk = require('../services/mikrotikService');
    const { api } = await mk.getConnection(routerId || null);
    try { for (const s of await api.send(['/ppp/secret/print'])) if (isIp(s['remote-address'])) used.add(toInt(s['remote-address'])); }
    finally { try { api.close(); } catch (_) {} }
  } catch (_) { /* sin MikroTik: se usa lo registrado en el sistema */ }
  const step = c.order === 'asc' ? 1 : -1;
  for (let n = c.order === 'asc' ? c.from : c.to; c.order === 'asc' ? n <= c.to : n >= c.from; n += step) {
    if (!used.has(n)) return { remote: toIp(n), local: c.local };
  }
  throw new Error('No quedan IP libres en el rango PPPoE configurado.');
}

module.exports = { config, allocate };
