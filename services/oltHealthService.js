'use strict';
/**
 * Salud de la OLT VSOL (EPON V1600D): CPU, memoria, tiempo encendida y temperatura de los módulos PON.
 * La consola (telnet) de este modelo no informa esos datos; se leen de su interfaz web (solo lectura):
 *   /action/systeminfo.html → CPU, memoria, tiempo encendida
 *   /action/poninfo.html    → temperatura, voltaje, corriente y potencia TX de cada módulo PON
 *   /action/fan.html        → modo del ventilador y temperatura de encendido
 * La OLT no tiene sensor general: la "temperatura de la OLT" es la del módulo PON más caliente.
 * Usa las credenciales web de la OLT cargadas en el sistema. Resultado en caché 60 s.
 * Parámetro: olt_temp_warn (°C, por defecto 60) para marcar la temperatura como alta.
 */
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

const cache = new Map();
const TTL = 60000;

function text(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&#37;/g, '%').replace(/&deg;/g, '°').replace(/\s+/g, ' ');
}

async function fetchPages(olt) {
  const base = `http://${olt.host}${olt.web_port && Number(olt.web_port) !== 80 ? ':' + olt.web_port : ''}`;
  const ctl = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
  const body = new URLSearchParams({ user: olt.web_user || '', pass: olt.web_password || '', button: 'Login', who: '100' }).toString();
  await fetch(base + '/action/main.html', { method: 'POST', body, redirect: 'manual', signal: ctl(8000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const get = async (p) => { const r = await fetch(base + '/action/' + p, { redirect: 'manual', signal: ctl(8000) }); return Buffer.from(await r.arrayBuffer()).toString('latin1'); };
  const [sys, pon, fan] = await Promise.all([get('systeminfo.html'), get('poninfo.html'), get('fan.html')]);
  return { sys, pon, fan };
}

function parse({ sys, pon, fan }) {
  const s = text(sys), p = text(pon);
  if (!/CPU Usage/i.test(s)) throw new Error('la OLT no devolvió su estado (¿credenciales web?)');
  const num = (re, t) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const up = /Running Time\s+(\d+)\s*Days?\s+(\d+)\s*Hours?\s+(\d+)\s*Minutes?/i.exec(s);
  const ports = [];
  const re = /PON(\d+)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Detail/gi;
  let m; while ((m = re.exec(p))) ports.push({ port: `PON${m[1]}`, temp: Number(m[2]), voltage: Number(m[3]), bias: Number(m[4]), txPower: Number(m[5]) });
  const fanThr = /name='temperature'[^>]*value="(\d+)"/i.exec(fan || '');
  const fanMode = /mode(\d)\.checked/i.exec(fan || '');
  const temp = ports.length ? Math.max(...ports.map(x => x.temp)) : null;
  return {
    ok: true,
    cpu: num(/CPU Usage\s+(\d+(?:\.\d+)?)\s*%/i, s),
    ram: num(/Memory Usage\s+(\d+(?:\.\d+)?)\s*%/i, s),
    uptime: up ? `${up[1]}d ${up[2]}h ${up[3]}m` : null,
    temp, ports,
    fan: { mode: ({ 1: 'encendido', 2: 'apagado', 3: 'automático' })[fanMode ? fanMode[1] : ''] || '-', threshold: fanThr ? Number(fanThr[1]) : null },
    tempWarn: Number(getSetting('olt_temp_warn', 60)) || 60,
    at: new Date().toISOString(),
  };
}

async function health(olt) {
  if (!olt || String(olt.brand || '').toLowerCase() !== 'vsol' || !olt.web_user) return null;
  const c = cache.get(olt.id);
  if (c && Date.now() - c.t < TTL) return c.data;
  try {
    const data = parse(await fetchPages(olt));
    cache.set(olt.id, { t: Date.now(), data });
    return data;
  } catch (e) {
    logger.warn(`[OLT ${olt.name || olt.id}] salud: ${e.message}`);
    const data = { ok: false, error: e.message };
    cache.set(olt.id, { t: Date.now(), data });
    return data;
  }
}

module.exports = { health, _parse: parse };
