'use strict';
/**
 * Configuración automática de la ONU de un cliente nuevo (OLT VSOL EPON por consola).
 *
 * Flujo:
 *   1. El técnico sube la foto de la etiqueta → se lee la MAC (labelReaderService).
 *   2. Se busca esa MAC entre las ONU NUEVAS de la OLT (sin descripción ni cliente) → se vincula.
 *   3. Se configura la ONU (solo esa ONU; nunca una con cliente o descripción):
 *        onu N description CUENTA
 *        onu N pri wan_adv add route
 *        onu N pri wan_adv index 1 route mode tr069_internet mtu 1492
 *        onu N pri wan_adv index 1 route ipv4 pppoe proxy disable user U pwd P mode auto nat enable
 *        onu N pri wan_adv index 1 bind lan1..lanK ssid1 ssid5
 *        onu N pri wan_adv commit            → se espera "connected" con ese usuario
 *        onu N pri tr069_mng enable …         → servidor TR-069
 *        WiFi elegido por el cliente (onuManageService.changeWifi: verifica, save_config y write file)
 *        onu N pri save_config + write file   (SIEMPRE, también si algo falla)
 *   4. Se verifica que el MikroTik vea la sesión PPPoE con la IP asignada.
 *   5. Todo bien → instalación realizada (factura con la fecha real + bienvenida). Algo mal → aviso a la
 *      oficina y al técnico con el paso que falló; la instalación se termina a mano.
 * Parámetro: onu_auto_provision_enabled (true/false).
 */
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

const onuMgr = () => require('./onuManageService');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const enabled = () => { const v = getSetting('onu_auto_provision_enabled', false); return v === true || v === 'true'; };

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  for (const [c, t] of [['reg_provision_status', 'TEXT'], ['reg_provision_log', 'TEXT'], ['reg_label_read', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE customers ADD COLUMN ${c} ${t}`);
  _schemaOk = true;
}

function wanBlocks(text) {
  return String(text || '').split(/\*{10,}/).filter(b => /WAN Index/i.test(b)).map(b => {
    const g = (k) => ((new RegExp('^\\s*' + k + '\\s*:\\s*(.*)$', 'mi').exec(b) || [])[1] || '').trim();
    return { idx: g('WAN Index'), mode: g('WAN Mode'), status: g('Status'), user: g('PPPoE UserName'), conn: g('Connect Mode') };
  });
}
const errOf = (t) => /(%\s*(Unknown|Invalid|Incomplete|Ambiguous)[^\n]*|Command incomplete[^\n]*|Error[^\n]*|Fail[^\n]*)/i.exec(String(t || ''));

function lanBinding(type) {
  const m = /(\d+)GE/i.exec(String(type || ''));
  const n = Math.max(1, Math.min(4, m ? Number(m[1]) : 2));
  return Array.from({ length: n }, (_, i) => `lan${i + 1}`).join(' ') + (/wifi/i.test(String(type || '')) ? ' ssid1 ssid5' : '');
}

async function notifyAll(customer, text) {
  const wa = require('./waNotifyService');
  try { await wa.notifyAdmin(text); } catch (_) {}
  // técnico de la orden de instalación
  try {
    const t = db.prepare("SELECT tech.phone FROM tickets t JOIN technicians tech ON tech.id=t.technician_id WHERE t.customer_id=? AND t.kind='install' AND t.status IN ('open','in_progress') LIMIT 1").get(customer.id);
    if (t && t.phone) await wa.sendText(require('../config/regional').normalizePhone(String(t.phone).replace(/\D/g, '')), text);
  } catch (_) {}
}

/** Configura la ONU vinculada al cliente. Devuelve { ok, step, message }. No lanza excepciones. */
async function provision(customerId, { actor = 'sistema' } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  const log = [];
  const note = (s) => { log.push(`${new Date().toISOString().slice(11, 19)} ${String(s).replace(/(pwd|password)\s+\S+/gi, '$1 ***')}`); };
  const finish = (r) => {
    db.prepare('UPDATE customers SET reg_provision_status=?, reg_provision_log=? WHERE id=?').run(r.ok ? 'ok' : `error: ${r.step}`, log.join('\n').slice(-4000), id);
    return r;
  };
  if (!c) return { ok: false, step: 'cliente', message: 'Cliente no encontrado' };
  const inv = onuMgr().forCustomer(id);
  if (!inv) return finish({ ok: false, step: 'vínculo', message: 'La ONU no está vinculada al cliente.' });
  const U = String(c.pppoe_username || ''), P = String(c.pppoe_password || '');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(U) || !/^[A-Za-z0-9._@-]{3,40}$/.test(P)) return finish({ ok: false, step: 'datos', message: 'Usuario o clave PPPoE con caracteres no admitidos por la OLT.' });
  if (inv.name && String(inv.name).trim() && String(inv.name).trim().toUpperCase() !== 'N/A' && String(inv.name).trim() !== U) return finish({ ok: false, step: 'seguridad', message: `La ONU ${inv.onu_ref} ya tiene la descripción "${inv.name}": no se toca.` });
  const { runOnPort, getOlt, serial, writeOlt } = onuMgr()._internal;
  const olt = getOlt(inv.olt_id);
  const N = inv.onu_id, port = inv.port;
  const run = async (cmds) => { const out = await runOnPort(olt, port, cmds); out.forEach((o, i) => note(`${cmds[i]} → ${String(o).replace(/\s+/g, ' ').slice(-120)}`)); return out; };
  let step = 'inicio';
  const result = await serial(async () => {
    try {
      // 0. Estado actual
      step = 'lectura';
      const [w0] = await run([`show onu ${N} pri wan_conn`]);
      if (/unsupport|not online|offline/i.test(w0) && !/WAN Index/i.test(w0)) return { ok: false, step, message: 'La ONU no responde (¿apagada o sin fibra?).' };
      const before = wanBlocks(w0);
      const already = before.length === 1 && before[0].user === U && /pppoe/i.test(before[0].conn);

      // 1. Descripción en la OLT
      step = 'descripción';
      const [d] = await run([`onu ${N} description ${U}`]);
      if (errOf(d)) return { ok: false, step, message: 'La OLT no aceptó la descripción: ' + errOf(d)[0] };

      // 2. WAN PPPoE (modo TR-069 + Internet)
      if (!already) {
        step = 'WAN';
        const del = before.map(b => Number(b.idx)).filter(Boolean).sort((a, b) => b - a).map(k => `onu ${N} pri wan_adv index ${k} delete`);
        const cmds = [...del,
          `onu ${N} pri wan_adv add route`,
          `onu ${N} pri wan_adv index 1 route mode tr069_internet mtu 1492`,
          `onu ${N} pri wan_adv index 1 route ipv4 pppoe proxy disable user ${U} pwd ${P} mode auto nat enable`,
          `onu ${N} pri wan_adv index 1 bind ${lanBinding(inv.type)}`];
        const outs = await run(cmds);
        const bad = outs.map(errOf).find(Boolean);
        if (bad) return { ok: false, step, message: 'La OLT no aceptó la configuración de la WAN: ' + bad[0] };
        const [staged] = await run([`onu ${N} pri wan_adv show`]);
        if (!new RegExp(`index 1 route ipv4 pppoe .*user ${U} `).test(staged) || /wan_adv index [2-9]/.test(staged)) return { ok: false, step, message: 'La WAN preparada no coincide con lo esperado; no se aplicó.' };
        await run([`onu ${N} pri wan_adv commit`]);
      }
      step = 'conexión PPPoE';
      let up = false;
      for (let i = 0; i < 24 && !up; i++) {
        await wait(5000);
        const b = wanBlocks((await run([`show onu ${N} pri wan_conn`]))[0]);
        up = b.length === 1 && b[0].user === U && b[0].status === 'connected';
      }
      if (!up) return { ok: false, step, message: 'La WAN no conectó en 2 minutos (revisar usuario/clave PPPoE en el MikroTik o la fibra).' };

      // 3. Servidor TR-069
      step = 'TR-069';
      const url = getSetting('acs_public_url', ''), au = getSetting('acs_cpe_username', ''), ap = getSetting('acs_cpe_password', '');
      const ru = getSetting('acs_cr_username', ''), rp = getSetting('acs_cr_password', '');
      const interval = Math.max(60, Number(getSetting('acs_inform_interval', 300)) || 300);
      if (url && au && ap && ru && rp) {
        const [t1] = await run([`onu ${N} pri tr069_mng enable acs_server url ${url} username ${au} password ${ap} certificate disable inform enable inform_interval ${interval} reverse_connection username ${ru} password ${rp}`]);
        if (!/set ok/i.test(t1)) note('TR-069: la OLT no confirmó (se sigue; se puede activar después desde el inventario)');
      }

      // 4. Guardar en la ONU (el WiFi, si está cargado, se aplica después con su propio guardado)
      step = 'guardar en la ONU';
      const [sv] = await run([`onu ${N} pri save_config`]);
      if (errOf(sv)) return { ok: false, step, message: 'No se pudo guardar en la ONU.' };
      return { ok: true, step: 'ONU', message: 'WAN PPPoE conectada, TR-069 y descripción cargados.' };
    } catch (e) {
      return { ok: false, step, message: e.message };
    } finally {
      // REGLA: todo cambio en la ONU/OLT termina con write file (también si algo falló)
      try { await writeOlt(olt); note('write file → guardado en la OLT'); } catch (e) { note('write file FALLÓ: ' + e.message); }
    }
  });
  if (!result.ok) {
    finish(result);
    await notifyAll(c, `⚠️ *Configuración automática de la ONU: falló*\nCliente: ${c.name}\nONU: ${inv.onu_ref} (${String(inv.mac || '').toUpperCase()})\nPaso: ${result.step}\nDetalle: ${result.message}\n\nTerminarla a mano en la OLT. Lo hecho hasta ese paso quedó guardado (write file).`);
    return result;
  }

  // 5. WiFi elegido por el cliente (verifica, save_config y write file)
  let wifiMsg = 'WiFi: sin datos cargados (queda el de fábrica).';
  try {
    const r = await require('./installationService').tryApplyWifi(id, actor);
    wifiMsg = r.ok ? r.message : 'WiFi: ' + r.message;
  } catch (e) { wifiMsg = 'WiFi: ' + e.message; }
  note(wifiMsg);

  // 6. Verificación en el MikroTik: sesión PPPoE activa con la IP asignada
  let session = null;
  for (let i = 0; i < 6 && !session; i++) {
    try {
      const { api } = await require('./mikrotikService').getConnection(c.router_id || null);
      try { session = (await api.send(['/ppp/active/print', `?name=${U}`]))[0] || null; } finally { try { api.close(); } catch (_) {} }
    } catch (_) {}
    if (!session) await wait(5000);
  }
  if (!session) {
    const r = finish({ ok: false, step: 'verificación MikroTik', message: 'La ONU quedó configurada pero el MikroTik no muestra la sesión PPPoE.' });
    await notifyAll(c, `⚠️ *ONU configurada, falta verificar*\nCliente: ${c.name}\nEl MikroTik no muestra la sesión PPPoE de ${U}. Revisar antes de confirmar la instalación.`);
    return r;
  }
  note(`MikroTik: sesión activa ${session.address || ''}`);
  finish({ ok: true, step: 'listo', message: 'ok' });

  // 7. Instalación realizada (factura con la fecha real + bienvenida) y orden cerrada
  let done = null;
  try {
    done = await require('./installationService').completeInstallation(id, { actor: 'configuración automática' });
    db.prepare("UPDATE tickets SET status='resolved', technician_notes=TRIM(COALESCE(technician_notes,'') || ' ONU configurada automáticamente'), updated_at=(NOW_LOCAL()) WHERE customer_id=? AND kind='install' AND status IN ('open','in_progress')").run(id);
  } catch (e) { note('alta: ' + e.message); }
  await notifyAll(c, `✅ *Instalación completa (automática)*\nCliente: ${c.name}\nONU: ${inv.onu_ref} · descripción ${U}\nPPPoE conectado · IP ${session.address || '-'}\n${wifiMsg}\nGuardado en la ONU y en la OLT (write file).` + (done && done.ok ? `\nPrimera factura: ${require('../config/regional').formatMoney(done.amount)}, vence ${String(done.plan.dueDate).split('-').reverse().join('/')}.` : ''));
  logger.info(`[Provisión] ${c.name}: ONU ${inv.onu_ref} configurada automáticamente`);
  return { ok: true, step: 'listo', message: 'Instalación completa.' };
}

/**
 * Intenta vincular y configurar a partir de la(s) foto(s) de la etiqueta.
 * @param {Buffer[]} images fotos originales (sin reducir)
 */
async function fromLabel(customerId, images, { actor = 'técnico' } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const reader = require('./labelReaderService');
  const inst = require('./installationService');
  const readMacs = [];
  for (const img of images || []) { try { (await reader.read(img)).macs.forEach(m => readMacs.push(m)); } catch (e) { logger.warn('[Etiqueta] ' + e.message); } }
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  db.prepare('UPDATE customers SET reg_label_read=? WHERE id=?').run(readMacs.length ? readMacs.map(m => `${reader.pretty(m.mac)} (${m.source})`).join(', ') : 'sin lectura', id);
  if (onuMgr().forCustomer(id)) return { linked: true, message: 'La ONU ya estaba vinculada.' };
  const cands = await inst.onuCandidates(id);
  const m = reader.matchCandidates(readMacs, cands);
  if (!m.match) {
    await notifyAll(c, `🔎 *Etiqueta de la ONU recibida — falta identificarla*\nCliente: ${c.name}\n${m.how}\nONU nuevas en la OLT: ${cands.length ? cands.map(x => `${x.onu_ref} ${String(x.mac).toUpperCase()}`).join(', ') : 'ninguna todavía (¿está conectada la fibra?)'}.\nElegila en Clientes → Inscriptos → "Equipo", o el sistema reintenta cuando aparezca.`);
    if (readMacs.length) db.prepare('UPDATE customers SET reg_onu_mac=COALESCE(reg_onu_mac, ?) WHERE id=?').run(reader.pretty(readMacs[0].mac).toLowerCase(), id);
    return { linked: false, message: m.how };
  }
  db.prepare('UPDATE customers SET reg_onu_mac=? WHERE id=?').run(String(m.match.mac).toLowerCase(), id);
  await inst.linkOnu(id, m.match.onu_ref, `etiqueta (${m.how})`);
  if (!enabled()) {
    await notifyAll(c, `🔗 *ONU identificada por la etiqueta*\nCliente: ${c.name}\n${m.match.onu_ref} · ${m.how}.\nLa configuración automática está desactivada: configurar la WAN a mano.`);
    return { linked: true, message: m.how };
  }
  const r = await provision(id, { actor });
  return { linked: true, provisioned: r.ok, message: m.how + ' · ' + r.message };
}

/** Reintento periódico: instalaciones asignadas con MAC leída cuya ONU todavía no apareció en la OLT. */
async function retryPending() {
  if (!enabled()) return;
  ensureSchema();
  const rows = db.prepare(`SELECT id, reg_onu_mac FROM customers WHERE status='inactive' AND reg_status='approved'
    AND reg_onu_mac IS NOT NULL AND COALESCE(reg_provision_status,'') = ''`).all();
  if (!rows.length) return;
  const inst = require('./installationService');
  for (const r of rows) {
    if (onuMgr().forCustomer(r.id)) continue;
    const cands = await inst.onuCandidates(r.id);
    const hit = cands.filter(x => String(x.mac || '').toLowerCase() === String(r.reg_onu_mac).toLowerCase());
    if (hit.length !== 1) continue;
    await inst.linkOnu(r.id, hit[0].onu_ref, 'etiqueta (reintento automático)');
    await provision(r.id, { actor: 'reintento automático' });
  }
}

module.exports = { ensureSchema, provision, fromLabel, retryPending, enabled, lanBinding };
