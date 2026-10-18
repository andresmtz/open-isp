'use strict';
/**
 * Exportación diaria de la configuración del MikroTik y de la OLT (solo lectura: no cambia nada en los equipos).
 *
 * - MikroTik: RouterOS 6 no entrega "/export" por la API, así que se lee cada sección por la API y se arma un
 *   script .rsc equivalente (para revisar y reimportar por partes) y una copia JSON con todo lo leído.
 *   Las entradas dinámicas (sesiones PPPoE activas, listas automáticas, etc.) no se guardan.
 * - OLT VSOL: "show running-config" por telnet (modo privilegiado, sin entrar a configuración).
 * Se guarda en backups/config/ (dentro de los datos del sistema), así entra en la copia horaria cifrada a Genesis.
 * Se conservan config_export_days días (30). Corre una vez por día (config_export_hour, 01 h) o si falta la de hoy.
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');

const DIR = path.join(__dirname, '..', 'backups', 'config');
const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };

// Secciones del MikroTik (RouterOS 6). "set": menús de un solo valor (se exportan con "set").
const MK_MENUS = [
  ['/system identity', 'set'], ['/system clock', 'set'], ['/system ntp client', 'set'], ['/ip dns', 'set'], ['/ip service'],
  ['/interface ethernet'], ['/interface vlan'], ['/interface bridge'], ['/interface bridge port'], ['/interface list'], ['/interface list member'],
  ['/interface pppoe-server server'], ['/interface l2tp-server server', 'set'], ['/interface sstp-server server', 'set'], ['/interface l2tp-client'], ['/interface eoip'], ['/interface gre'],
  ['/ip address'], ['/ip route'], ['/ip pool'], ['/ip dhcp-server'], ['/ip dhcp-server network'], ['/ip dhcp-server lease'], ['/ip dhcp-client'], ['/ip dns static'],
  ['/ip firewall filter'], ['/ip firewall nat'], ['/ip firewall mangle'], ['/ip firewall raw'], ['/ip firewall address-list'], ['/ip firewall service-port'],
  ['/ip ipsec profile'], ['/ip ipsec peer'], ['/ip ipsec identity'], ['/ip ipsec proposal'], ['/ip ipsec policy'],
  ['/ip hotspot'], ['/ip hotspot profile'], ['/ip hotspot user profile'], ['/ip hotspot user'],
  ['/ppp profile'], ['/ppp secret'], ['/ppp aaa', 'set'], ['/radius'], ['/radius incoming', 'set'],
  ['/queue type'], ['/queue simple'], ['/queue tree'],
  ['/routing bgp instance'], ['/routing bgp peer'], ['/routing bgp network'], ['/routing ospf instance'], ['/routing ospf network'], ['/routing filter'],
  ['/snmp', 'set'], ['/snmp community'], ['/tool netwatch'], ['/system scheduler'], ['/system script'], ['/system logging'], ['/system logging action'],
  ['/user group'], ['/user'], ['/ip neighbor discovery-settings', 'set'],
];
// Propiedades que son estado (no configuración) y no se exportan
const SKIP = new Set(['.id', 'dynamic', 'invalid', 'running', 'bytes', 'packets', 'slave', 'actual-mtu', 'actual-interface', 'mac-address-actual', 'last-link-up-time', 'last-link-down-time',
  'link-downs', 'last-logged-in', 'last-caller-id', 'last-disconnect-reason', 'total-bytes', 'total-packets', 'rate', 'packet-rate', 'queued-bytes', 'queued-packets', 'borrows', 'lends', 'pcq-queues',
  'dropped', 'last-started', 'run-count', 'next-run', 'creation-time', 'active', 'gateway-status', 'distance-actual', 'immediate-gw', 'expires-after', 'status', 'last-seen', 'active-address',
  'active-mac-address', 'active-client-id', 'active-server', 'host-name', 'radius', 'blocked', 'ph2-total', 'ph2-active', 'uptime', 'current-firmware', 'ifindex', 'timeout', 'hw-offload', 'hw', 'inactive',
  'source', 'owner', 'policy-template-group-actual', 'connection-rate', 'connection-bytes-left']);
const q = (v) => /^[A-Za-z0-9_.:\/,@*+-]+$/.test(v) ? v : '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\r?\n/g, '\\r\\n') + '"';

async function exportMikrotik() {
  const mk = require('./mikrotikService');
  const conn = await mk.getConnection();
  const json = {}, rsc = [`# Exportación AppsTec (leída por la API, RouterOS 6) — ${new Date().toISOString()}`, '# Revisar antes de importar: es una reconstrucción sección por sección.', ''];
  try {
    for (const [menu, mode] of MK_MENUS) {
      let rows;
      try { rows = await conn.api.send([menu.replace(/ /g, '/') + '/print']); } catch (_) { continue; } // menú inexistente en este equipo
      if (!Array.isArray(rows) || !rows.length) continue;
      const keep = rows.filter(r => String(r.dynamic) !== 'true' && String(r.default) !== 'true');
      json[menu] = rows;
      const lines = (mode === 'set' ? rows : keep).map(r => (mode === 'set' ? 'set ' : 'add ') + Object.entries(r)
        .filter(([k, v]) => !SKIP.has(k) && v !== '' && v != null && !(mode === 'set' && k === 'default') && !(k === 'disabled' && String(v) === 'false'))
        .map(([k, v]) => `${k}=${q(v)}`).join(' '));
      if (lines.length) rsc.push(menu, ...lines, '');
    }
  } finally { try { conn.api.close(); } catch (_) {} }
  return { rsc: rsc.join('\n'), json, sections: Object.keys(json).length };
}

async function exportOlts() {
  const o = require('./oltService');
  const out = [];
  for (const olt of (o.getActiveOlts ? o.getActiveOlts() : []) || []) {
    if (String(olt.brand || '').toLowerCase() !== 'vsol') continue;
    const opts = Object.assign(o.telnetOptsFromOlt(olt), { enablePassword: olt.enable_password || olt.web_password, asArray: true, timeout: 60000 });
    const [txt] = await o.telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, ['show running-config'], opts);
    const clean = String(txt || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/ ?--More-- ?[\x00\x08 ]*/g, '').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');
    if (clean.split('\n').length < 20) throw new Error('la OLT devolvió una configuración demasiado corta');
    out.push({ olt, text: clean });
  }
  return out;
}

let _busy = false;
async function run({ force = false } = {}) {
  if (_busy) return { skipped: 'busy' };
  _busy = true;
  try {
    const tz = getSetting('timezone', 'America/Asuncion');
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
    const day = `${p.year}-${p.month}-${p.day}`;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const done = fs.readdirSync(DIR).some(f => f.startsWith(day + '_mikrotik'));
    if (!force && (done || Number(p.hour) < num('config_export_hour', 1))) return { skipped: 'ya está la de hoy o todavía no es la hora' };
    const res = { day, mikrotik: null, olt: [] , errors: [] };
    try {
      const m = await exportMikrotik();
      const ident = (m.json['/system identity'] && m.json['/system identity'][0] && m.json['/system identity'][0].name) || 'mikrotik';
      const base = path.join(DIR, `${day}_mikrotik_${String(ident).replace(/[^\w.-]+/g, '_')}`);
      fs.writeFileSync(base + '.rsc', m.rsc, { mode: 0o600 });
      fs.writeFileSync(base + '.json', JSON.stringify(m.json, null, 1), { mode: 0o600 });
      res.mikrotik = { sections: m.sections, bytes: m.rsc.length };
    } catch (e) { res.errors.push('MikroTik: ' + e.message); }
    try {
      for (const x of await exportOlts()) {
        fs.writeFileSync(path.join(DIR, `${day}_olt_${String(x.olt.name || x.olt.id).replace(/[^\w.-]+/g, '_')}.txt`), x.text, { mode: 0o600 });
        res.olt.push({ name: x.olt.name, lines: x.text.split('\n').length });
      }
    } catch (e) { res.errors.push('OLT: ' + e.message); }
    // conservar solo los últimos días
    const keep = num('config_export_days', 30), cutoff = Date.now() - keep * 86400e3;
    for (const f of fs.readdirSync(DIR)) { const fp = path.join(DIR, f); try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (_) {} }
    if (res.errors.length) {
      logger.warn('[Config] exportación con errores: ' + res.errors.join(' · '));
      try { await require('./waNotifyService').notifyAdmin(`⚠️ *EXPORTACIÓN DE CONFIGURACIÓN*\n\nNo se pudo guardar la configuración de hoy:\n• ${res.errors.join('\n• ')}\n\nSe vuelve a intentar en la próxima hora.`); } catch (_) {}
    } else logger.info(`[Config] exportación OK: MikroTik ${res.mikrotik ? res.mikrotik.sections + ' secciones' : '-'}, OLT ${res.olt.map(o => o.lines + ' líneas').join(', ') || '-'}`);
    return res;
  } finally { _busy = false; }
}

function list() { try { return fs.readdirSync(DIR).sort().reverse().map(f => ({ file: f, size: fs.statSync(path.join(DIR, f)).size })); } catch (_) { return []; } }

module.exports = { run, list, exportMikrotik, exportOlts, DIR };
