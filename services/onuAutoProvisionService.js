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
  for (const [c, t] of [['reg_provision_status', 'TEXT'], ['reg_provision_log', 'TEXT'], ['reg_label_read', 'TEXT'], ['repl_pending', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE customers ADD COLUMN ${c} ${t}`);
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

/**
 * Avisa a administración (texto técnico) y al técnico de la orden (texto simple, sin términos de OLT/MikroTik).
 * techText null → el técnico no recibe nada.
 */
const TECH_WAIT = 'La oficina ya fue avisada y lo resuelve desde el sistema. Dejá la ONU conectada y encendida, y esperá su confirmación antes de irte.';
const techPower = async (id) => { try { const ps = require('./onuPowerService'); const p = await ps.forCustomer(id); return p && p.ok ? `\n📶 Potencia: ${p.rx} dBm (${p.level})` + (p.level !== 'buena' ? ` — ${p.advice}` : '') : ''; } catch (_) { return ''; } };

async function notifyAll(customer, text, techText = null) {
  const wa = require('./waNotifyService');
  try { await wa.notifyAdmin(text); } catch (_) {}
  if (!techText) return;
  // técnico de la orden (instalación o asistencia)
  try {
    // la orden puede haberse cerrado recién (instalación completa): se toma la última orden del técnico de las últimas 24 h
    const t = db.prepare(`SELECT tech.phone FROM tickets t JOIN technicians tech ON tech.id=t.technician_id
      WHERE t.customer_id=? AND (t.status IN ('open','in_progress') OR t.updated_at >= datetime(NOW_LOCAL(), '-1 day'))
      ORDER BY (t.status IN ('open','in_progress')) DESC, t.id DESC LIMIT 1`).get(customer.id);
    if (t && t.phone) await wa.sendText(require('../config/regional').normalizePhone(String(t.phone).replace(/\D/g, '')), techText);
  } catch (_) {}
}

/** Configura la ONU vinculada al cliente. Devuelve { ok, step, message }. No lanza excepciones. */
async function provision(customerId, { actor = 'sistema', mode = 'install' } = {}) {
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
  // El usuario PPPoE y la IP se crean recién ahora, al configurar la ONU (no al aprobar)
  try { await require('./installationService').ensureNetworkAccount(id); }
  catch (e) { await notifyAll(c, `⚠️ *No se pudo crear la cuenta PPPoE* de ${c.name}: ${e.message}`, `⏳ *${c.name}*: falta un paso de la oficina para darle internet. ${TECH_WAIT}`); return finish({ ok: false, step: 'cuenta PPPoE', message: e.message }); }
  Object.assign(c, db.prepare('SELECT pppoe_username, pppoe_password, pppoe_remote_address, router_id FROM customers WHERE id=?').get(id));
  const inv = onuMgr().forCustomer(id);
  if (!inv) return finish({ ok: false, step: 'vínculo', message: 'La ONU no está vinculada al cliente.' });
  const U = String(c.pppoe_username || ''), P = String(c.pppoe_password || '');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(U) || !/^[A-Za-z0-9._@-]{3,40}$/.test(P)) return finish({ ok: false, step: 'datos', message: 'Usuario o clave PPPoE con caracteres no admitidos por la OLT.' });
  if (inv.name && String(inv.name).trim() && String(inv.name).trim().toUpperCase() !== 'N/A' && String(inv.name).trim() !== U) return finish({ ok: false, step: 'seguridad', message: `La ONU ${inv.onu_ref} ya tiene la descripción "${inv.name}": no se toca.` });
  const { runOnPort, getOlt, serial, writeOlt } = onuMgr()._internal;
  const olt = getOlt(inv.olt_id);
  const N = inv.onu_id, port = inv.port;
  const run = async (cmds) => { const out = await runOnPort(olt, port, cmds); out.forEach((o, i) => note(`${cmds[i]} → ${String(o).replace(/\s+/g, ' ').slice(-120)}`)); return out; };

  // ONU que no admite la configuración remota de VSOL (TP-Link y otras): solo se identifica y se nombra en la OLT
  if (inv.compatible !== 1) {
    const r = await serial(async () => {
      try {
        const [d] = await run([`onu ${N} description ${U}`]);
        if (errOf(d)) return { ok: false, step: 'descripción', message: 'La OLT no aceptó la descripción: ' + errOf(d)[0] };
        return { ok: true };
      } catch (e) { return { ok: false, step: 'descripción', message: e.message }; }
      finally { try { await writeOlt(olt); note('write file → guardado en la OLT'); } catch (e) { note('write file FALLÓ: ' + e.message); } }
    });
    const why = inv.compatible === 0 ? 'no admite la configuración remota (TP-Link u otra marca)' : 'no se pudo comprobar si admite la configuración remota';
    finish({ ok: false, step: 'manual', message: why });
    await notifyAll(c, `🛠️ *ONU identificada — configurar a mano*\nCliente: ${c.name}\nONU: ${inv.onu_ref} · ${String(inv.mac || '').toUpperCase()} · ${inv.type || ''}\nEsta ONU ${why}.\n` +
      (r.ok ? `Ya quedó nombrada en la OLT como *${U}* (write file).\n` : `No se pudo poner la descripción: ${r.message}\n`) +
      `\nCargar en la ONU: WAN PPPoE usuario y clave *${U}*` + (c.reg_wifi_ssid ? `, WiFi "${c.reg_wifi_ssid}" / "${c.reg_wifi_ssid}-5G"` : '') + (mode === 'replace' ? `.\nDespués tocar "Confirmar cambio de equipo" en Equipo (da de baja la ONU vieja).` : `.\nDespués marcar "Instalación realizada".`), `🛠️ *${c.name}*: este modelo de ONU (${inv.type || 'otra marca'}) no se configura solo. Dejala conectada y encendida; la oficina te indica cómo seguir.`);
    return { ok: false, manual: true, step: 'manual', message: `ONU ${why}: configurar WAN y WiFi a mano.` };
  }
  let step = 'inicio';
  const result = await serial(async () => {
    try {
      // 0. Estado actual
      step = 'lectura';
      // Algunas ONU (recién salidas de fábrica) responden "VarNoResource" a wan_conn: se lee también wan_adv show
      const [w0, a0] = await run([`show onu ${N} pri wan_conn`, `onu ${N} pri wan_adv show`]);
      if (/unsupport|not online|offline/i.test(w0) && !/WAN Index/i.test(w0) && !/wan_adv/i.test(a0)) return { ok: false, step, message: 'La ONU no responde (¿apagada o sin fibra?).' };
      const before = wanBlocks(w0);
      const advIdx = [...new Set([...String(a0).matchAll(new RegExp(`onu ${N} pri wan_adv index (\\d+) route`, 'g'))].map(m => Number(m[1])))];
      for (const k of advIdx) if (!before.some(b => Number(b.idx) === k)) before.push({ idx: k });
      const already = (before.length === 1 && before[0].user === U && /pppoe/i.test(before[0].conn || '')) ||
        (advIdx.length === 1 && advIdx[0] === 1 && new RegExp(`index 1 route ipv4 pppoe .*user ${U} `).test(a0));

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
      // Conectada = sesión activa en el MikroTik con ese usuario (lo que cuenta) o la ONU informa "connected"
      const mkUp = async () => {
        try {
          const { api } = await require('./mikrotikService').getConnection(c.router_id || null);
          try { return (await api.send(['/ppp/active/print', `?name=${U}`])).length > 0; } finally { try { api.close(); } catch (_) {} }
        } catch (_) { return false; }
      };
      for (let i = 0; i < 24 && !up; i++) {
        await wait(5000);
        if (await mkUp()) { up = true; note('MikroTik: sesión PPPoE activa'); break; }
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
        // La OLT puede responder "set ok" sin que la ONU lo tome (pasó con una ONU recién salida de fábrica):
        // se relee y, si no quedó, se reintenta una vez.
        let [t2] = await run([`show onu ${N} pri tr069_mng`]);
        if (!String(t2).includes(url)) {
          await wait(10000);
          await run([`onu ${N} pri tr069_mng enable acs_server url ${url} username ${au} password ${ap} certificate disable inform enable inform_interval ${interval} reverse_connection username ${ru} password ${rp}`]);
          [t2] = await run([`show onu ${N} pri tr069_mng`]);
        }
        note(String(t2).includes(url) ? 'TR-069 verificado en la ONU' : 'TR-069: NO quedó en la ONU tras reintentar (activarlo después desde el inventario)');
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
    await notifyAll(c, `⚠️ *Configuración automática de la ONU: falló*\nCliente: ${c.name}\nONU: ${inv.onu_ref} (${String(inv.mac || '').toUpperCase()})\nPaso: ${result.step}\nDetalle: ${result.message}\n\nTerminarla a mano en la OLT. Lo hecho hasta ese paso quedó guardado (write file).`,
      `⚠️ *${c.name}*: ${mode === 'replace' ? 'la ONU nueva' : 'la ONU'} todavía no quedó lista automáticamente.${mode === 'replace' ? ' La ONU anterior sigue configurada.' : ''}\n${TECH_WAIT}\nMientras tanto revisá que la luz PON de la ONU esté fija (no parpadeando).` + await techPower(id));
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
    await notifyAll(c, `⚠️ *ONU configurada, falta verificar*\nCliente: ${c.name}\nEl MikroTik no muestra la sesión PPPoE de ${U}. Revisar antes de confirmar la instalación.`,
      `⚠️ *${c.name}*: la ONU quedó configurada pero todavía no se confirma que el cliente tenga internet.\n${TECH_WAIT}` + await techPower(id));
    return r;
  }
  note(`MikroTik: sesión activa ${session.address || ''}`);
  finish({ ok: true, step: 'listo', message: 'ok' });

  let powerTxt = '';
  try { const pw = await require('./onuPowerService').forCustomer(id); powerTxt = require('./onuPowerService').text(pw); note(powerTxt); } catch (_) {}
  if (mode === 'replace') {
    logger.info(`[Provisión] ${c.name}: ONU de reemplazo ${inv.onu_ref} configurada`);
    return { ok: true, step: 'listo', message: `ONU ${inv.onu_ref} configurada. ${wifiMsg}` + (powerTxt ? `\n📶 ${powerTxt}` : ''), session, inv };
  }

  // 7. Instalación realizada (factura con la fecha real + bienvenida) y orden cerrada
  let done = null;
  try {
    done = await require('./installationService').completeInstallation(id, { actor: 'configuración automática' });
    db.prepare("UPDATE tickets SET status='resolved', technician_notes=TRIM(COALESCE(technician_notes,'') || ' ONU configurada automáticamente'), updated_at=(NOW_LOCAL()) WHERE customer_id=? AND kind='install' AND status IN ('open','in_progress')").run(id);
  } catch (e) { note('alta: ' + e.message); }
  await notifyAll(c, `✅ *Instalación completa (automática)*\nCliente: ${c.name}\nONU: ${inv.onu_ref} · descripción ${U}\nPPPoE conectado · IP ${session.address || '-'}\n${powerTxt ? '📶 ' + powerTxt + '\n' : ''}${wifiMsg}\nGuardado en la ONU y en la OLT (write file).` + (done && done.ok ? `\nPrimera factura: ${require('../config/regional').formatMoney(done.amount)}, vence ${String(done.plan.dueDate).split('-').reverse().join('/')}.` : ''),
    `✅ *Instalación completa — ${c.name}*\nEl cliente ya tiene internet.` + (powerTxt ? `\n📶 ${powerTxt}` : '') +
    (c.reg_wifi_ssid ? `\n📡 WiFi: ${c.reg_wifi_ssid} / ${c.reg_wifi_ssid}-5G` : '') +
    (done && done.ok ? `\n\n💵 Cobrale ${require('../config/regional').formatMoney(done.plan.installPayment)} (primer mes) y recordale que su primera factura es de ${require('../config/regional').formatMoney(done.amount)} y vence el ${String(done.plan.dueDate).split('-').reverse().join('/')}.` : '') +
    `\n\nNo tenés que hacer nada más en el sistema.`);
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
    await notifyAll(c, `🔎 *Etiqueta de la ONU recibida — falta identificarla*\nCliente: ${c.name}\n${m.how}\nONU nuevas en la OLT: ${cands.length ? cands.map(x => `${x.onu_ref} ${String(x.mac).toUpperCase()}`).join(', ') : 'ninguna todavía (¿está conectada la fibra?)'}.\nElegila en Clientes → Inscriptos → "Equipo", o el sistema reintenta cuando aparezca.`,
      `🔎 *${c.name}*: recibimos la foto de la etiqueta pero todavía no encontramos la ONU.\nRevisá que esté conectada a la fibra y encendida (luz PON fija). El sistema vuelve a probar solo cada 2 minutos.` + (m.how && /No se pudo leer/.test(m.how) ? '\nLa foto no se pudo leer: sacá otra más de cerca, con buena luz, y volvé a subirla.' : ''));
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

// ── Cambio de equipo (asistencia técnica) ──────────────────────────────────────────────────
const REPLACE_REASONS = { falla: 'La ONU no enciende o falla', electrico: 'Daño eléctrico', cambio_modelo: 'Cambio de modelo / mejora', otro: 'Otro motivo' };

/** Da de baja una ONU en la OLT (solo esa: número y puerto validados; nunca "all"/"offline") y guarda (write file). */
async function deregisterOnu(old, { by = '' } = {}) {
  const m = /^EPON0\/(\d+):(\d+)$/.exec(String(old && old.onu_ref || ''));
  if (!m || Number(m[1]) !== Number(old.port) || Number(m[2]) !== Number(old.onu_id)) throw new Error('Referencia de la ONU vieja inválida; no se da de baja.');
  const N = Number(old.onu_id);
  if (!Number.isInteger(N) || N < 1 || N > 65535) throw new Error('Número de ONU inválido.');
  const { runOnPort, getOlt, serial, writeOlt } = onuMgr()._internal;
  const olt = getOlt(old.olt_id);
  // Verificación en vivo: en esa posición tiene que estar la MISMA ONU (misma MAC); si no, no se toca nada
  const nm = (x) => String(x || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const gone = await serial(async () => {
    const live = (await require('./oltService').fetchVsolEponViaTelnet(olt)).find(r => r.id === old.onu_ref);
    if (!live) return true;
    if (!nm(live.mac) || nm(live.mac) !== nm(old.mac)) throw new Error(`En ${old.onu_ref} hay otra ONU (MAC ${live.mac || '?'}, se esperaba ${old.mac || '?'}); no se da de baja.`);
    try { await runOnPort(olt, Number(old.port), [`no onu auth onuid ${N}`]); }
    finally { await writeOlt(olt); }
    return false;
  });
  db.prepare('DELETE FROM onu_inventory WHERE olt_id=? AND onu_ref=?').run(old.olt_id, old.onu_ref);
  if (gone) { logger.info(`[Baja de ONU] ${old.onu_ref} ya no figura en la OLT; solo se quita del inventario`); return { alreadyGone: true }; }
  logger.info(`[Baja de ONU] ${old.onu_ref} (${old.mac}) dada de baja en la OLT por ${by}`);
  return { removed: true };
}

/** Cierra el cambio: da de baja la vieja y actualiza el historial de equipos. */
async function finishReplacement(customerId, { by = '', ticketId = null, reason = '' } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  const pend = c && c.repl_pending ? JSON.parse(c.repl_pending) : null;
  const eq = require('./customerEquipmentService');
  const newInv = onuMgr().forCustomer(id);
  if (!newInv) throw new Error('No hay ONU nueva vinculada.');
  const oldEq = eq.current(id);
  let dereg = 'no había ONU anterior registrada';
  if (pend && pend.old) {
    const still = db.prepare('SELECT * FROM onu_inventory WHERE olt_id=? AND onu_ref=?').get(pend.old.olt_id, pend.old.onu_ref);
    if (still && String(still.mac || '').toLowerCase() === String(pend.old.mac || '').toLowerCase()) {
      try { await deregisterOnu(still, { by }); dereg = `ONU anterior ${pend.old.onu_ref} dada de baja en la OLT`; }
      catch (e) { dereg = `NO se pudo dar de baja la ONU anterior ${pend.old.onu_ref}: ${e.message}`; }
    } else dereg = `la ONU anterior ${pend.old.onu_ref} ya no figuraba en la OLT`;
  }
  if (oldEq && oldEq.onu_ref !== newInv.onu_ref) eq.retire(oldEq.id, { reason: (pend && pend.reason) || reason || 'Cambio de equipo', by });
  eq.attach(id, newInv, { by, ticketId: (pend && pend.ticketId) || ticketId });
  db.prepare("UPDATE customers SET repl_pending=NULL WHERE id=?").run(id);
  const tId = (pend && pend.ticketId) || ticketId;
  if (tId) db.prepare("UPDATE tickets SET technician_notes=TRIM(COALESCE(technician_notes,'') || ' Equipo cambiado: ' || ?), updated_at=(NOW_LOCAL()) WHERE id=?").run(`${newInv.onu_ref} ${String(newInv.mac || '').toUpperCase()}`, tId);
  try { db.prepare("INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (?, 'install', NULL, ?)").run(id, `Cambio de equipo: ${oldEq ? oldEq.onu_ref + ' → ' : ''}${newInv.onu_ref} (${(pend && pend.reason) || reason || '-'}; por ${by})`); } catch (_) {}
  return { ok: true, dereg, newInv };
}

/**
 * Cambio de ONU desde una orden de asistencia: lee la etiqueta de la nueva, la configura con la misma cuenta y el WiFi
 * guardado (o el nuevo que cargue el técnico) y, si todo anda, da de baja la vieja. Si algo falla, la vieja NO se toca.
 */
async function replaceOnu(customerId, images, { reasonKey = 'falla', reasonText = '', ticketId = null, actor = 'técnico', wifi = null } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c || !['active', 'suspended', 'ditangguhkan'].includes(c.status)) throw new Error('Solo se cambia el equipo de un cliente con servicio.');
  const reason = (REPLACE_REASONS[reasonKey] || REPLACE_REASONS.otro) + (String(reasonText || '').trim() ? ': ' + String(reasonText).trim().slice(0, 150) : '');
  const reader = require('./labelReaderService');
  const inst = require('./installationService');
  const readMacs = [];
  for (const img of images || []) { try { (await reader.read(img)).macs.forEach(m => readMacs.push(m)); } catch (_) {} }
  db.prepare('UPDATE customers SET reg_label_read=? WHERE id=?').run(readMacs.length ? readMacs.map(m => `${reader.pretty(m.mac)} (${m.source})`).join(', ') : 'sin lectura', id);
  const old = onuMgr().forCustomer(id);
  const oldSnap = old ? { olt_id: old.olt_id, onu_ref: old.onu_ref, port: old.port, onu_id: old.onu_id, mac: old.mac } : null;
  // WiFi para la nueva: el que cargue el técnico o el guardado en la ficha
  const w = (wifi && wifi.ssid) ? { ssid: wifi.ssid, key: wifi.key || c.wifi_key } : { ssid: c.wifi_ssid, key: c.wifi_key };
  if (w.ssid && w.key) {
    const v = onuMgr().validate(String(w.ssid), String(w.key));
    db.prepare("UPDATE customers SET reg_wifi_ssid=?, reg_wifi_key=?, reg_wifi_status='pendiente' WHERE id=?").run(v.name, v.key, id);
  } else db.prepare("UPDATE customers SET reg_wifi_status=NULL WHERE id=?").run(id);
  const pend = { old: oldSnap, reason, ticketId, actor, macs: readMacs.map(m => m.mac), at: new Date().toISOString() };
  db.prepare('UPDATE customers SET repl_pending=?, reg_provision_status=NULL WHERE id=?').run(JSON.stringify(pend), id);

  const cands = await inst.onuCandidates(id);
  const m = reader.matchCandidates(readMacs, cands);
  if (!m.match) {
    await notifyAll(c, `🔎 *Cambio de equipo — falta identificar la ONU nueva*
Cliente: ${c.name}
${m.how}
ONU nuevas en la OLT: ${cands.length ? cands.map(x => `${x.onu_ref} ${String(x.mac).toUpperCase()}`).join(', ') : 'ninguna todavía (¿está conectada la fibra?)'}.
El sistema reintenta cada 2 minutos; o elegila en el panel (Equipo).`,
      `🔎 *${c.name}*: recibimos la foto de la etiqueta de la ONU nueva pero todavía no la encontramos.\nRevisá que esté conectada a la fibra y encendida (luz PON fija). El sistema vuelve a probar solo cada 2 minutos.` + (m.how && /No se pudo leer/.test(m.how) ? '\nLa foto no se pudo leer: sacá otra más de cerca, con buena luz, y volvé a subirla.' : ''));
    return { ok: false, message: m.how };
  }
  return applyReplacement(id, m.match, { how: m.how, actor });
}

async function applyReplacement(customerId, cand, { how = '', actor = '' } = {}) {
  const id = Number(customerId);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  // la nueva pasa a ser la ONU del cliente (la vieja queda registrada en la OLT hasta confirmar)
  db.transaction(() => {
    db.prepare('UPDATE onu_inventory SET customer_id=NULL WHERE customer_id=?').run(id);
    db.prepare('UPDATE onu_inventory SET customer_id=?, checked_at=NULL WHERE onu_ref=? AND olt_id=?').run(id, cand.onu_ref, cand.olt_id);
  })();
  try { await onuMgr().syncInventory(); } catch (_) {}
  const inv = onuMgr().forCustomer(id);
  if (!inv) return { ok: false, message: 'No se pudo vincular la ONU nueva.' };
  const r = await provision(id, { actor, mode: 'replace' });
  if (r.manual) return { ok: false, manual: true, message: 'ONU nueva no compatible: configurar a mano y luego "Confirmar cambio de equipo".' };
  if (!r.ok) return r;   // la vieja no se toca; provision ya avisó el paso que falló
  const f = await finishReplacement(id, { by: actor });
  await notifyAll(c, `✅ *Cambio de equipo completo*
Cliente: ${c.name}
ONU nueva: ${inv.onu_ref} · ${String(inv.mac || '').toUpperCase()} (${how})
${r.message}
${f.dereg}.
Guardado en la ONU y en la OLT (write file).`,
    `✅ *Cambio de equipo completo — ${c.name}*\nLa ONU nueva ya tiene internet${c.wifi_ssid ? ` con el WiFi ${c.wifi_ssid}` : ''}.` + await techPower(id) + `\nPodés llevarte la ONU anterior. No tenés que hacer nada más en el sistema.`);
  return { ok: true, message: 'Cambio de equipo completo.' };
}

/** Reintento periódico: instalaciones asignadas con MAC leída cuya ONU todavía no apareció en la OLT. */
async function retryPending() {
  if (!enabled()) return;
  ensureSchema();
  const inst = require('./installationService');
  // cambios de equipo esperando que la ONU nueva aparezca en la OLT
  for (const r of db.prepare("SELECT id, repl_pending FROM customers WHERE repl_pending IS NOT NULL AND COALESCE(reg_provision_status,'') = ''").all()) {
    let p = null; try { p = JSON.parse(r.repl_pending); } catch (_) {}
    if (!p || !p.macs || !p.macs.length) continue;
    const cands = await inst.onuCandidates(r.id);
    const m = require('./labelReaderService').matchCandidates(p.macs.map(x => ({ mac: x, source: 'código de barras' })), cands);
    if (m.match) await applyReplacement(r.id, m.match, { how: m.how + ' (reintento)', actor: p.actor || 'reintento automático' });
  }
  const rows = db.prepare(`SELECT id, reg_onu_mac FROM customers WHERE status='inactive' AND reg_status='approved'
    AND reg_onu_mac IS NOT NULL AND COALESCE(reg_provision_status,'') = ''`).all();
  if (!rows.length) return;
  for (const r of rows) {
    if (onuMgr().forCustomer(r.id)) continue;
    const cands = await inst.onuCandidates(r.id);
    const hit = cands.filter(x => String(x.mac || '').toLowerCase() === String(r.reg_onu_mac).toLowerCase());
    if (hit.length !== 1) continue;
    await inst.linkOnu(r.id, hit[0].onu_ref, 'etiqueta (reintento automático)');
    await provision(r.id, { actor: 'reintento automático' });
  }
}

module.exports = { ensureSchema, provision, fromLabel, retryPending, enabled, lanBinding, replaceOnu, applyReplacement, finishReplacement, deregisterOnu, REPLACE_REASONS };
