'use strict';
/**
 * Versión de GoWA (WhatsApp): la que está en uso y la última publicada.
 *  - En uso: GOWA_VERSION, la misma variable con la que docker compose elige la imagen de gowa.
 *  - Última: releases de GitHub (aldinokemal/go-whatsapp-web-multidevice), consultada cada 6 h.
 *  - Conexión: estado del dispositivo vinculado (cada 60 s).
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');

// Carpeta compartida con el actualizador del host (scripts/gowa-updater.sh vía systemd)
const UPD = path.join(__dirname, '..', 'updater');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(UPD, f), 'utf8')); } catch (_) { return null; } };

const REPO = 'aldinokemal/go-whatsapp-web-multidevice';
let _latest = { at: 0, tag: '', date: '', url: '', notes: '' };
let _conn = { at: 0, connected: null, loggedIn: null };

const parse = (v) => (String(v || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
function newer(a, b) {
  const x = parse(a), y = parse(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

function current() {
  const st = readJson('status.json');
  return (st && st.current) || String(process.env.GOWA_VERSION || '').trim() || '';
}

/** ¿Está instalado el actualizador del host? (escribe status.json al menos cada hora) */
function updaterReady() {
  const st = readJson('status.json');
  return !!(st && st.at && Date.now() - new Date(st.at).getTime() < 3 * 3600 * 1000);
}

/** Pide al host la actualización a la última versión publicada. */
async function requestUpdate(target, actor) {
  const lat = await latest();
  if (!lat.tag || target !== lat.tag) throw new Error('Solo se puede actualizar a la última versión publicada (' + (lat.tag || '?') + ').');
  if (!newer(target, current())) throw new Error('Ya está en ' + current() + '.');
  if (!updaterReady()) throw new Error('El actualizador del servidor no está instalado o no responde.');
  if (fs.existsSync(path.join(UPD, 'request.json'))) throw new Error('Ya hay una actualización en curso.');
  const r = readJson('result.json');
  if (r && r.ok === null && Date.now() - new Date(r.at).getTime() < 10 * 60 * 1000) throw new Error('Ya hay una actualización en curso.');
  fs.writeFileSync(path.join(UPD, 'result.json'), JSON.stringify({ ok: null, from: current(), to: target, at: new Date().toISOString(), message: 'Pedido enviado al servidor…' }));
  fs.writeFileSync(path.join(UPD, 'request.json'), JSON.stringify({ target, actor: String(actor || ''), at: new Date().toISOString() }));
  _conn.at = 0;
  logger.info(`[GoWA] actualización a ${target} pedida por ${actor}`);
  return { ok: true };
}

async function latest() {
  if (Date.now() - _latest.at < 6 * 3600 * 1000 && _latest.tag) return _latest;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'open-isp' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('GitHub ' + r.status);
    const j = await r.json();
    _latest = { at: Date.now(), tag: j.tag_name || '', date: String(j.published_at || '').slice(0, 10), url: j.html_url || '', notes: String(j.body || '').slice(0, 1500) };
  } catch (e) {
    logger.warn('[GoWA] no se pudo consultar la última versión: ' + e.message);
    _latest.at = Date.now() - 5 * 3600 * 1000; // reintenta en 1 h
  }
  return _latest;
}

async function connection() {
  if (Date.now() - _conn.at < 20 * 1000 && _conn.connected !== null) return _conn;
  try {
    const r = await require('./gowaWhatsappService').gowaStatus();
    const res = (r && r.data && r.data.results) || {};
    _conn = { at: Date.now(), connected: !!res.is_connected, loggedIn: !!res.is_logged_in };
  } catch (_) { _conn = { at: Date.now(), connected: false, loggedIn: false }; }
  return _conn;
}

async function state() {
  const cur = current();
  const [lat, conn] = await Promise.all([latest(), connection()]);
  const updateAvailable = !!(cur && lat.tag && newer(lat.tag, cur));
  const major = updateAvailable && parse(lat.tag)[0] !== parse(cur)[0];
  return { current: cur || 'desconocida', latest: lat.tag || '', latestDate: lat.date, latestUrl: lat.url, notes: lat.notes,
    updateAvailable, majorChange: major, connected: conn.connected, loggedIn: conn.loggedIn,
    updaterReady: updaterReady(), job: readJson('result.json') };
}

module.exports = { state, current, latest, newer, requestUpdate, updaterReady };
