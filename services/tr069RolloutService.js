/**
 * Activación de TR-069 en ONU VSOL compatibles, una por una, con verificación y vuelta atrás.
 *
 * Procedimiento (probado en EPON0/4:11 el 2026-10-14):
 *  1. `onu N pri tr069_mng enable acs_server url … inform enable inform_interval S reverse_connection …` y releer.
 *  2. La WAN fue creada en la propia ONU: `onu N pri wan_adv show` carga y muestra su configuración.
 *     Se cambia SOLO el modo: `onu N pri wan_adv index 1 route mode tr069_internet mtu M`.
 *     Se relee lo preparado (una sola WAN, mismo PPPoE, mismas asociaciones) y recién entonces `wan_adv commit`
 *     (puede responder "Time Out!" y aun así aplicarse).
 *  3. Verificación: una sola WAN, modo tr069_internet, estado EXACTO "connected", mismas asociaciones.
 *  4. Bien → `save_config`. Mal → volver a `mode internet` + commit y verificar que reconecte.
 *  5. SIEMPRE `write file` en la OLT (también tras volver atrás): si no, al reiniciarse la OLT reenvía la
 *     configuración vieja a la ONU y el cambio se pierde (pasó con un corte de luz el 2026-10-14).
 * Corte para el cliente: unos segundos mientras el PPPoE se reconecta.
 * La tanda se frena sola si fallan 2 ONU seguidas. Al terminar avisa al administrador por WhatsApp.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting, saveSettings } = require('../config/settingsManager');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS tr069_rollout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    olt_id INTEGER, onu_ref TEXT, customer_id INTEGER,
    status TEXT,            -- pending | running | ok | failed | skipped
    step TEXT, message TEXT,
    started_at TEXT, finished_at TEXT, created_at TEXT DEFAULT (NOW_LOCAL()))`);
  _schemaOk = true;
}

function mgr() { return require('./onuManageService'); }
const T = () => mgr()._internal;

function blocks(text) {
  return String(text || '').split('********************************').slice(1).map(b => {
    const g = (k) => ((new RegExp('^\\s*' + k + '\\s*:\\s*(.*)$', 'mi').exec(b) || [])[1] || '').trim();
    return { idx: g('WAN Index'), mode: g('WAN Mode'), status: g('Status'), lan: g('Binding LAN'), ssid: g('Binding SSID'), user: g('PPPoE UserName'), conn: g('Connect Mode') };
  });
}
const msgOf = (t) => (String(t || '').match(/(Msg:[^\n]*|%[^\n]*)/) || [''])[0].trim();

/** Activa TR-069 en una ONU. Devuelve { ok, step, message }. No lanza excepciones. */
async function enableOne(inv) {
  const { runOnPort, getOlt } = T();
  const olt = getOlt(inv.olt_id);
  const N = inv.onu_id, P = inv.port;
  const run = (cmds) => runOnPort(olt, P, cmds);
  let step = 'lectura';
  try {
    const url = getSetting('acs_public_url', ''), u = getSetting('acs_cpe_username', ''), p = getSetting('acs_cpe_password', '');
    const ru = getSetting('acs_cr_username', ''), rp = getSetting('acs_cr_password', '');
    const interval = Math.max(60, Number(getSetting('acs_inform_interval', 300)) || 300);
    for (const v of [url, u, p, ru, rp]) if (!v || /[\s?#>]/.test(v)) return { ok: false, step: 'ajustes', message: 'Faltan o son inválidas las credenciales del servidor TR-069 en los ajustes.' };

    // Estado inicial
    const [wan0] = await run([`show onu ${N} pri wan_conn`]);
    const before = blocks(wan0);
    if (before.length !== 1) return { ok: false, skip: true, step, message: `La ONU tiene ${before.length} WAN; se deja para revisar a mano.` };
    const w0 = before[0];
    if (!/pppoe/i.test(w0.conn)) return { ok: false, skip: true, step, message: `La WAN no es PPPoE (${w0.conn || '?'}); se deja para revisar a mano.` };
    if (w0.status !== 'connected') return { ok: false, skip: true, step, message: `La WAN no está conectada (${w0.status || '?'}); no se toca.` };

    // 1. Servidor TR-069
    step = 'tr069';
    const [t1] = await run([`onu ${N} pri tr069_mng enable acs_server url ${url} username ${u} password ${p} certificate disable inform enable inform_interval ${interval} reverse_connection username ${ru} password ${rp}`]);
    if (!/set ok/i.test(t1)) return { ok: false, step, message: 'La OLT no aceptó la configuración TR-069: ' + (msgOf(t1) || 'sin respuesta') };
    const [t2] = await run([`show onu ${N} pri tr069_mng`]);
    if (!t2.includes(url)) return { ok: false, step, message: 'La configuración TR-069 no quedó en la ONU.' };

    // 2. WAN → tr069_internet (si ya lo está, solo se guarda)
    if (!/tr069/i.test(w0.mode)) {
      step = 'preparar WAN';
      const [script] = await run([`onu ${N} pri wan_adv show`]);
      const mtu = (/wan_adv index 1 route mode \S+ mtu (\d+)/.exec(script) || [])[1];
      const pppLine = (/^.*wan_adv index 1 route ipv4 pppoe .*$/m.exec(script) || [''])[0].trim();
      const bindLine = (/^.*wan_adv index 1 bind .*$/m.exec(script) || [''])[0].trim();
      if (!mtu || !pppLine || /index [2-9]/.test(script)) return { ok: false, skip: true, step, message: 'La WAN preparada en la OLT no tiene la forma esperada; se deja para revisar a mano.' };
      const [m1] = await run([`onu ${N} pri wan_adv index 1 route mode tr069_internet mtu ${mtu}`]);
      if (/%|error|fail|not exist/i.test(m1)) return { ok: false, step, message: 'La OLT rechazó el cambio de modo: ' + msgOf(m1) };
      const [staged] = await run([`onu ${N} pri wan_adv show`]);
      if (!/index 1 route mode tr069_internet/.test(staged) || /index [2-9]/.test(staged) || !staged.includes(pppLine) || (bindLine && !staged.includes(bindLine))) {
        return { ok: false, step, message: 'Lo preparado no coincide con lo esperado; no se aplicó nada.' };
      }
      step = 'aplicar WAN';
      await run([`onu ${N} pri wan_adv commit`]);
      let after = [], good = false;
      for (let i = 0; i < 24; i++) {
        await wait(5000);
        after = blocks((await run([`show onu ${N} pri wan_conn`]))[0]);
        if (after.length === 1 && /tr069_internet/i.test(after[0].mode) && after[0].status === 'connected') { good = true; break; }
      }
      const sameBind = good && after[0].lan === w0.lan && after[0].ssid === w0.ssid && after[0].user === w0.user;
      if (!good || !sameBind) {
        step = 'vuelta atrás';
        await run([`onu ${N} pri wan_adv index 1 route mode internet mtu ${mtu}`]);
        await run([`onu ${N} pri wan_adv commit`]);
        let back = false;
        for (let i = 0; i < 24; i++) { await wait(5000); const b = blocks((await run([`show onu ${N} pri wan_conn`]))[0]); if (b.length === 1 && b[0].status === 'connected') { back = true; break; } }
        try { await T().writeOlt(olt); } catch (_) {}
        return { ok: false, step: 'aplicar WAN', message: (good ? 'Las asociaciones o el usuario cambiaron' : 'La WAN no volvió a conectar en 2 minutos') + (back ? '; se volvió al modo anterior y quedó conectada.' : '; SE INTENTÓ VOLVER ATRÁS PERO NO RECONECTÓ: revisar ya.'), critical: !back };
      }
    }

    // 3. Guardar en la ONU
    step = 'guardar';
    const [sv] = await run([`onu ${N} pri save_config`]);
    if (/%|error|fail/i.test(sv)) return { ok: false, step, message: 'No se pudo guardar en la ONU (la WAN quedó funcionando).' };
    step = 'guardar en la OLT';
    try { await T().writeOlt(olt); }
    catch (e) { return { ok: false, step, message: 'La ONU quedó bien pero la OLT no confirmó el guardado (write file): se perdería al reiniciarse la OLT.' }; }
    return { ok: true, step: 'listo', message: 'TR-069 activo; WAN conectada; guardado en la ONU y en la OLT.' };
  } catch (e) {
    return { ok: false, step, message: e.message };
  }
}

/** Prepara la lista de ONU a activar (compatibles, en línea, todavía sin TR-069).
 *  auto: para la puesta al día nocturna se dejan fuera las que ya fallaron u omitieron (esas van a mano). */
function plan({ auto = false } = {}) {
  ensureSchema();
  const done = new Set(db.prepare(`SELECT onu_ref FROM tr069_rollout WHERE ${auto ? "status IN ('ok','failed','skipped')" : "status = 'ok'"}`).all().map(r => r.onu_ref));
  const acsTags = db.prepare('SELECT tags FROM acs_devices').all().map(r => r.tags || '').join(' ');
  return mgr().inventory().filter(r => r.compatible === 1 && /online/i.test(r.status || '') && !done.has(r.onu_ref)
    && !(r.pppoe && acsTags.includes(`"${r.pppoe}"`)));
}

function status() {
  ensureSchema();
  const at = getSetting('tr069_rollout_at', '');
  const rows = db.prepare(`SELECT r.*, c.name AS customer_name FROM tr069_rollout r LEFT JOIN customers c ON c.id = r.customer_id ORDER BY r.id DESC LIMIT 100`).all();
  return { scheduledAt: at || null, running: _running, pendingCount: plan().length, catchupTime: getSetting('tr069_catchup_time', '03:00') || '03:00', rows };
}

function schedule(at) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(at || ''))) throw new Error('Fecha y hora inválidas (AAAA-MM-DD HH:MM).');
  saveSettings({ tr069_rollout_at: at });
}
function cancel() { saveSettings({ tr069_rollout_at: '' }); _stop = true; }

let _running = false, _stop = false;
async function runBatch({ by = 'programado', list = null } = {}) {
  ensureSchema();
  if (_running) return { skipped: 'en curso' };
  list = list || plan();
  if (!list.length) return { ok: 0, failed: 0, skipped: 0 };
  _running = true; _stop = false;
  const ins = db.prepare(`INSERT INTO tr069_rollout (olt_id, onu_ref, customer_id, status, step, started_at) VALUES (?,?,?, 'running', 'inicio', (NOW_LOCAL()))`);
  const upd = db.prepare(`UPDATE tr069_rollout SET status = ?, step = ?, message = ?, finished_at = (NOW_LOCAL()) WHERE id = ?`);
  const res = { ok: 0, failed: 0, skipped: 0, stoppedEarly: false, critical: [] };
  let consecutiveFails = 0;
  logger.info(`[TR-069] Activación por tanda (${by}): ${list.length} ONU`);
  try {
    for (const inv of list) {
      if (_stop) { res.stoppedEarly = true; break; }
      const id = ins.run(inv.olt_id, inv.onu_ref, inv.customer_id || null).lastInsertRowid;
      const r = await T().serial(() => enableOne(inv));
      if (r.ok) { res.ok++; consecutiveFails = 0; upd.run('ok', r.step, r.message, id); }
      else if (r.skip) { res.skipped++; upd.run('skipped', r.step, r.message, id); }
      else {
        res.failed++; consecutiveFails++; upd.run('failed', r.step, r.message, id);
        if (r.critical) res.critical.push(`${inv.onu_ref} ${inv.customer_name || ''}`.trim());
      }
      logger.info(`[TR-069] ${inv.onu_ref} ${inv.customer_name || ''}: ${r.ok ? 'OK' : (r.skip ? 'omitida' : 'FALLÓ')} (${r.step}) ${r.message}`);
      if (consecutiveFails >= 2) { res.stoppedEarly = true; break; }
      await wait(3000);
    }
  } finally {
    _running = false;
    if (!/^(manual|puesta al día)/.test(by)) saveSettings({ tr069_rollout_at: '' });
  }
  notifyAdmin(res, list.length).catch(() => {});
  return res;
}

async function notifyAdmin(res, total) {
  if (!require('../config/waGate').ready()) return;
  const msg = `📡 *Activación de TR-069 terminada*\n\nONU procesadas: ${res.ok + res.failed + res.skipped} de ${total}\n✅ Activadas: ${res.ok}\n⏭️ Omitidas (revisar a mano): ${res.skipped}\n❌ Fallidas: ${res.failed}` +
    (res.stoppedEarly ? '\n\n⚠️ La tanda se detuvo antes de terminar (2 fallas seguidas o cancelación).' : '') +
    (res.critical.length ? `\n\n🚨 SIN CONEXIÓN tras volver atrás: ${res.critical.join(', ')}` : '') +
    '\n\nDetalle en Red → Inventario de ONU.';
  const regional = require('../config/regional');
  const admins = getSetting('whatsapp_admin_numbers', []);
  const wa = require('./waNotifyService');
  for (const a of (Array.isArray(admins) ? admins : String(admins || '').split(','))) {
    const n = regional.normalizePhone(a); if (n && n.length >= 8) { try { await wa.sendText(n, msg); } catch (_) {} }
  }
}

/** Activa una sola ONU a pedido (botón del inventario). Corre en segundo plano; el resultado queda en la tabla. */
function startOne(onuRef) {
  if (_running) throw new Error('Ya hay una activación en curso; esperá a que termine.');
  const inv = mgr().inventory().find(r => r.onu_ref === onuRef);
  if (!inv) throw new Error('No se encontró esa ONU en el inventario.');
  if (inv.compatible !== 1) throw new Error('Esa ONU no es gestionable por TR-069.');
  if (!/online/i.test(inv.status || '')) throw new Error('La ONU está desconectada; se puede activar cuando vuelva a estar en línea.');
  runBatch({ by: 'manual', list: [inv] }).catch(e => logger.error('[TR-069] ' + e.message));
  return inv;
}

/** Lo llama el cron cada minuto: arranca la tanda cuando llega la hora programada (hora local)
 *  y, una vez por día a la hora de puesta al día, activa las compatibles que quedaron pendientes
 *  (reactivadas, instaladas después o desconectadas durante la tanda). */
async function tick() {
  if (_running) return;
  const now = require('../config/billingCycle').nowStamp().slice(0, 16);
  const at = String(getSetting('tr069_rollout_at', '') || '');
  if (at && now >= at) return runBatch({ by: 'programado ' + at });
  const daily = String(getSetting('tr069_catchup_time', '03:00') || '');
  if (!/^\d{2}:\d{2}$/.test(daily) || now.slice(11) !== daily) return;
  if (getSetting('tr069_catchup_last', '') === now.slice(0, 10)) return;
  saveSettings({ tr069_catchup_last: now.slice(0, 10) });
  const list = plan({ auto: true });
  if (list.length) await runBatch({ by: 'puesta al día ' + now, list });
}

module.exports = { ensureSchema, enableOne, plan, status, schedule, cancel, runBatch, startOne, tick };
