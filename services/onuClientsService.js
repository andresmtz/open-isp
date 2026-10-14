/**
 * Equipos conectados a la ONU del cliente (TR-069 + OLT).
 *
 * Fuentes:
 *  - TR-069 (servidor propio, services/acsServerService.js): cantidad de equipos por red WiFi
 *    (WLANConfiguration.N.TotalAssociations), tabla de equipos (Hosts.Host: MAC, IP, activo) y
 *    equipos asociados a cada red (AssociatedDevice: MAC).
 *  - OLT (services/onuManageService.js): puertos LAN con cable (Link Up/Down).
 *
 * Probado en ONU VSOL/Realtek: no informa nombres de equipo y marca todos los Hosts como "Ethernet",
 * por eso la banda sale de las listas de asociados y los nombres los pone el cliente o la oficina.
 * Índices TR-069 de este modelo: WLANConfiguration.1 = 5G, .5 = 2.4 (se identifican por el SSID, no por el número).
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

const IGD = 'InternetGatewayDevice.LANDevice.1.';

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS customer_device_names (
    customer_id INTEGER NOT NULL, mac TEXT NOT NULL, name TEXT NOT NULL, updated_at TEXT DEFAULT (NOW_LOCAL()),
    PRIMARY KEY (customer_id, mac))`);
  _schemaOk = true;
}

/** Equipo TR-069 del cliente: por la etiqueta vinculada o por el usuario PPPoE en sus tags. */
function acsDevice(customerId) {
  const c = db.prepare('SELECT genieacs_tag, pppoe_username FROM customers WHERE id = ?').get(customerId);
  if (!c) return null;
  let d = c.genieacs_tag ? db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(c.genieacs_tag) : null;
  if (!d && c.pppoe_username) {
    d = db.prepare(`SELECT * FROM acs_devices WHERE tags LIKE ? ORDER BY last_inform DESC LIMIT 1`).get(`%"${String(c.pppoe_username).replace(/[%_"]/g, '')}"%`);
  }
  return d || null;
}

function params(dev) {
  try { return JSON.parse(dev.params || '{}') || {}; } catch (_) { return {}; }
}
const val = (p, k) => { const v = p[k]; return v && typeof v === 'object' ? (v.value ?? v._value ?? '') : (v ?? ''); };
const normMac = (m) => String(m || '').trim().toLowerCase();

/** Índices WLAN presentes con su SSID. */
function wlans(p) {
  const out = [];
  for (const k of Object.keys(p)) {
    const m = /^InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.(\d+)\.SSID$/.exec(k);
    if (m) out.push({ idx: Number(m[1]), ssid: String(val(p, k) || '') });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/** Pide a la ONU datos frescos (se aplica en segundos gracias a la conexión inversa). Espera hasta `waitMs`. */
async function refresh(customerId, { waitMs = 15000 } = {}) {
  const dev = acsDevice(customerId);
  if (!dev) return { ok: false, reason: 'sin_tr069' };
  const acs = require('./acsServerService');
  const p = params(dev);
  const idx = wlans(p).filter(w => w.ssid).map(w => w.idx);
  const ids = [];
  const add = (name, payload) => { const r = acs.createBuiltinTask(dev.id, name, payload); if (r && r.taskId) ids.push(r.taskId); };
  add('getParameterValues', { parameterNames: idx.map(i => `${IGD}WLANConfiguration.${i}.TotalAssociations`) });
  add('refreshObject', { objectName: `${IGD}Hosts.Host` });
  for (const i of idx) add('refreshObject', { objectName: `${IGD}WLANConfiguration.${i}.AssociatedDevice` });
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await new Promise(r => setTimeout(r, 1000));
    const pend = db.prepare(`SELECT COUNT(*) n FROM acs_tasks WHERE device_id = ? AND status = 'pending'`).get(dev.id).n;
    if (!pend) break;
  }
  // Los totales llegan en el resultado de la tarea: se guardan también en params para la próxima lectura
  try {
    const r = db.prepare(`SELECT result FROM acs_tasks WHERE id = ? AND status = 'completed'`).get(ids[0]);
    if (r && r.result) {
      const res = JSON.parse(r.result);
      const fresh = params(acsDevice(customerId) || dev);
      Object.assign(fresh, res);
      db.prepare('UPDATE acs_devices SET params = ? WHERE id = ?').run(JSON.stringify(fresh), dev.id);
    }
  } catch (e) { logger.warn('[ONU clientes] ' + e.message); }
  return { ok: true };
}

/** Resumen para la ficha y el portal. */
function summary(customerId) {
  ensureSchema();
  const dev = acsDevice(customerId);
  const inv = require('./onuManageService').forCustomer(customerId);
  let lan = [];
  try { lan = JSON.parse((inv && inv.lan_ports) || '[]'); } catch (_) { lan = []; }
  const cables = lan.filter(x => x.up).length;
  if (!dev) return { tr069: false, cables, lanPorts: lan.length, total: cables, bands: [], devices: [] };

  const p = params(dev);
  const names = new Map(db.prepare('SELECT mac, name FROM customer_device_names WHERE customer_id = ?').all(customerId).map(r => [normMac(r.mac), r.name]));
  const ws = wlans(p);
  const bandOf = (ssid) => (/-5G$/i.test(ssid) ? '5G' : '2.4');
  const assocBand = new Map();
  const bands = ws.filter(w => w.ssid).map(w => {
    const count = Number(val(p, `${IGD}WLANConfiguration.${w.idx}.TotalAssociations`)) || 0;
    for (const k of Object.keys(p)) {
      const m = new RegExp(`^InternetGatewayDevice\\.LANDevice\\.1\\.WLANConfiguration\\.${w.idx}\\.AssociatedDevice\\.\\d+\\.AssociatedDeviceMACAddress$`).exec(k);
      if (m) assocBand.set(normMac(val(p, k)), bandOf(w.ssid));
    }
    return { ssid: w.ssid, band: bandOf(w.ssid), count };
  }).filter(b => b.ssid);

  const devices = [];
  const hostIdx = new Set(Object.keys(p).map(k => (/^InternetGatewayDevice\.LANDevice\.1\.Hosts\.Host\.(\d+)\./.exec(k) || [])[1]).filter(Boolean));
  for (const i of [...hostIdx].sort((a, b) => a - b)) {
    const base = `${IGD}Hosts.Host.${i}.`;
    const mac = normMac(val(p, base + 'MACAddress'));
    if (!mac) continue;
    const active = String(val(p, base + 'Active')) === '1' || String(val(p, base + 'Active')).toLowerCase() === 'true';
    if (!active) continue;
    const host = String(val(p, base + 'HostName') || '').trim();
    const band = assocBand.get(mac);
    // MAC "privada" (bit local): típico de celulares y tablets modernos
    const privateMac = /^.[26ae]/i.test(mac);
    devices.push({
      mac, ip: String(val(p, base + 'IPAddress') || ''),
      name: names.get(mac) || host || null,
      guess: privateMac ? 'Celular o tablet' : 'Equipo',
      conn: band ? `WiFi ${band}` : (cables ? 'WiFi o cable' : 'WiFi'),
    });
  }
  const wifiTotal = bands.reduce((s, b) => s + b.count, 0);
  const total = Math.max(wifiTotal + cables, devices.length);
  // Algunas ONU informan la cantidad por red pero no el detalle de todos los equipos (lista 2.4 vacía en Realtek):
  // se muestra el total real y cuántos están identificados.
  return {
    tr069: true, updatedAt: dev.last_inform, bands, cables, lanPorts: lan.length,
    total, identified: devices.length, unidentified: Math.max(0, total - devices.length), devices,
  };
}

function setName(customerId, mac, name) {
  ensureSchema();
  const m = normMac(mac);
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) throw new Error('Equipo inválido');
  const n = String(name || '').trim().slice(0, 40);
  if (!n) { db.prepare('DELETE FROM customer_device_names WHERE customer_id = ? AND mac = ?').run(customerId, m); return; }
  db.prepare(`INSERT INTO customer_device_names (customer_id, mac, name) VALUES (?,?,?)
    ON CONFLICT(customer_id, mac) DO UPDATE SET name = excluded.name, updated_at = (NOW_LOCAL())`).run(customerId, m, n);
}

module.exports = { ensureSchema, acsDevice, refresh, summary, setName };
