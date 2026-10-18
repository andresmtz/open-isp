'use strict';
/**
 * Control de las copias de seguridad en el Proxmox Backup Server de Genesis.
 *
 * Cada 30 minutos se consulta el servidor de copias (solo lectura, token con permiso de auditoría) y se revisa la
 * última copia de cada grupo:
 *   - máquinas y contenedores (vm/…, ct/…): copia cada 6 h → aviso si la última tiene más de backup_watch_vm_hours (13 h)
 *   - datos del sistema (host/openisp-datos): copia cada hora → aviso si tiene más de backup_watch_data_hours (3 h)
 * Avisa una vez por WhatsApp a la administración cuando algo se atrasa, y otra cuando vuelve a estar al día.
 *
 * Ajustes: backup_pbs_url (https://10.10.1.94:8007), backup_pbs_datastore (faster), backup_pbs_token
 * (auth id y secreto: "usuario@pbs!token:secreto") y backup_pbs_fingerprint (huella del certificado del servidor).
 */
const https = require('https');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');

const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };
const NAMES = { 'vm/108': 'open-isp (sistema)', 'vm/104': 'MikroTik CHR', 'ct/103': 'cloudflared (túnel)', 'ct/105': 'Uptime Kuma', 'ct/106': 'AdGuard', 'ct/107': 'homelable', 'ct/112': 'MikroDash', 'host/openisp-datos': 'datos del sistema (cada hora)' };

function ensureSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS backup_watch (grp TEXT PRIMARY KEY, last_backup INTEGER, alerted INTEGER DEFAULT 0, checked_at TEXT)`);
}

// GET al servidor de copias; el certificado es propio: se acepta solo si su huella coincide con la configurada
function api(path) {
  const base = new URL(String(getSetting('backup_pbs_url', 'https://10.10.1.94:8007')));
  const token = String(getSetting('backup_pbs_token', '') || '');
  const fp = String(getSetting('backup_pbs_fingerprint', '') || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!token || !fp) return Promise.reject(new Error('sin configurar'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: base.hostname, port: base.port || 8007, path: '/api2/json' + path, method: 'GET', timeout: 15000,
      headers: { Authorization: 'PBSAPIToken=' + token },
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    }, (res) => {
      const cert = res.socket.getPeerCertificate();
      const got = String((cert && cert.fingerprint256) || '').toLowerCase().replace(/[^0-9a-f]/g, '');
      if (got !== fp) { res.resume(); return reject(new Error('el certificado del servidor de copias no coincide')); }
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode)); try { resolve(JSON.parse(b).data); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sin respuesta')));
    req.on('error', reject);
    req.end();
  });
}

async function notify(t) { try { await require('./waNotifyService').notifyAdmin(t); } catch (e) { logger.warn('[Copias] aviso: ' + e.message); } }
const ago = (s) => { const h = (Date.now() / 1000 - s) / 3600; return h < 1 ? Math.round(h * 60) + ' min' : (h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' días'); };

let _fails = 0;
async function check() {
  if (!getSetting('backup_pbs_token', '')) return { skipped: 'sin configurar' };
  ensureSchema();
  const store = String(getSetting('backup_pbs_datastore', 'faster'));
  let groups;
  try { groups = await api(`/admin/datastore/${encodeURIComponent(store)}/groups`); _fails = 0; }
  catch (e) {
    _fails++;
    logger.warn('[Copias] no se pudo consultar el servidor de copias: ' + e.message);
    if (_fails === 4) await notify(`⚠️ *SERVIDOR DE COPIAS SIN RESPUESTA*\n\nHace unas 2 horas que no se puede consultar el servidor de copias de Genesis (${e.message}). Revisá que Genesis esté encendido y conectado por la WireGuard.`);
    return { error: e.message };
  }
  const vmH = num('backup_watch_vm_hours', 13), dataH = num('backup_watch_data_hours', 3);
  const now = Date.now() / 1000, res = [];
  for (const g of groups || []) {
    const key = `${g['backup-type']}/${g['backup-id']}`;
    const last = Number(g['last-backup'] || 0);
    const limit = (g['backup-type'] === 'host' ? dataH : vmH) * 3600;
    const late = !last || now - last > limit;
    const prev = db.prepare('SELECT alerted FROM backup_watch WHERE grp=?').get(key);
    if (late && !(prev && prev.alerted)) await notify(`⚠️ *COPIA DE SEGURIDAD ATRASADA*\n\n💾 ${NAMES[key] || key}\nÚltima copia: ${last ? 'hace ' + ago(last) : 'nunca'} (debería ser cada ${g['backup-type'] === 'host' ? 'hora' : '6 h'}).\nRevisá Proxmox de Faster → Respaldo, y que Genesis esté en línea.`);
    if (!late && prev && prev.alerted) await notify(`✅ *COPIA DE SEGURIDAD AL DÍA*\n\n💾 ${NAMES[key] || key}: última copia hace ${ago(last)}.`);
    db.prepare(`INSERT INTO backup_watch (grp, last_backup, alerted, checked_at) VALUES (?,?,?,datetime('now'))
      ON CONFLICT(grp) DO UPDATE SET last_backup=excluded.last_backup, alerted=excluded.alerted, checked_at=excluded.checked_at`).run(key, last, late ? 1 : 0);
    res.push({ group: key, name: NAMES[key] || key, last, late, count: g['backup-count'] });
  }
  return { groups: res };
}

function status() { try { ensureSchema(); return db.prepare('SELECT * FROM backup_watch ORDER BY grp').all().map(r => Object.assign(r, { name: NAMES[r.grp] || r.grp })); } catch (_) { return []; } }

module.exports = { check, status, api };
