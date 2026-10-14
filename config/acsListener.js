/**
 * Servidor TR-069 (ACS) en un puerto propio, separado del panel.
 *
 * Las ONU de los clientes llegan por la red de clientes: por eso el ACS NO se sirve en el puerto del panel
 * sino en `acs_listen_port` (7547 por defecto), y solo responde POST /acs con usuario y clave
 * (`acs_cpe_username` / `acs_cpe_password`). Cualquier otra ruta devuelve 404.
 *
 * Ajustes:
 *   use_builtin_acs      true para activarlo
 *   acs_listen_port      puerto (7547)
 *   acs_public_url       URL que se carga en las ONU (ej. http://10.255.0.12:7547/acs)
 *   acs_cpe_username / acs_cpe_password   credenciales que la ONU usa para hablar con el ACS
 *   acs_cr_username  / acs_cr_password    credenciales que el ACS usa para "despertar" a la ONU (conexión inversa)
 */
const crypto = require('crypto');
const { getSetting } = require('./settingsManager');
const { logger } = require('./logger');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Middleware: exige usuario y clave de CPE si están configurados (Basic). */
function requireCpeAuth(req, res, next) {
  const user = String(getSetting('acs_cpe_username', '') || '');
  const pass = String(getSetting('acs_cpe_password', '') || '');
  if (!user || !pass) return next(); // sin credenciales configuradas: comportamiento anterior
  const h = String(req.headers.authorization || '');
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (m) {
    const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (safeEqual(u, user) && safeEqual(rest.join(':'), pass)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="ACS"');
  return res.status(401).end();
}

const enabled = () => { const v = getSetting('use_builtin_acs', false); return v === true || v === 'true'; };

let _server = null;
function start() {
  if (_server || !enabled()) return;
  const port = Number(getSetting('acs_listen_port', 7547)) || 7547;
  const express = require('express');
  const acs = require('../services/acsServerService');
  const app = express();
  app.disable('x-powered-by');
  app.post('/acs', requireCpeAuth, express.raw({ type: () => true, limit: '2mb' }), acs.handleCwmpRequest);
  app.use((req, res) => res.status(404).end());
  _server = app.listen(port, () => logger.info(`[ACS] Servidor TR-069 escuchando en el puerto ${port} (solo POST /acs)`))
    .on('error', (e) => { logger.error(`[ACS] No se pudo abrir el puerto ${port}: ${e.message}`); _server = null; });
}

module.exports = { start, requireCpeAuth, enabled };
