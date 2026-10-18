/**
 * Gestión de ONU VSOL a través de la OLT (OAM privado de VSOL, por Telnet).
 *
 * Probado en OLT VSOL V1600D EPON con ONU VSOL (4GE+8WiFi, 2GE+1POTS+8WiFi):
 *   show onu N pri support_info      → capacidades; las ONU no compatibles responden "unsupport capability"
 *   show onu N pri wifi_ssid 1 / 5   → red 2.4 GHz (SSID 1) y 5 GHz (SSID 5)
 *   onu N pri wifi_ssid S name X hide (enable|disable) auth_mode M encrypt_type E shared_key K rekey_interval R
 *                                    → "Msg:Config set ok!"
 *   onu N pri save_config            → guarda en la memoria de la ONU (sin esto se pierde al reiniciar la ONU)
 *   show onu N pri onu_status        → puertos LAN con cable (Link Up/Down)
 *   show onu N pri wan_conn          → WAN (PPPoE usuario, estado)
 * La configuración WiFi vive en la ONU (no en la OLT): "write file" de la OLT no hace falta para el WiFi.
 *
 * Convención de la empresa: la red 5G se llama igual que la 2.4 + "-5G", con la misma clave.
 * Las claves nunca se guardan en la base ni en el historial.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

const SSID_24 = 1;
const SSID_5 = 5;
const SUFFIX_5G = '-5G';
const wifiRules = require('../config/wifiRules'); // reglas únicas del WiFi (sin espacios ni caracteres especiales)
const NAME_RE = wifiRules.NAME_RE;          // sin espacios: la consola de la OLT corta en el espacio
const KEY_RE = wifiRules.KEY_RE; // sin espacios, "?" (ayuda de la consola), comillas ni "#" o ">" (fin del prompt)
const RECHECK_DAYS = 7;

// ── Esquema ──────────────────────────────────────────────────────────────────
let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS onu_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      olt_id INTEGER NOT NULL,
      onu_ref TEXT NOT NULL,           -- EPON0/4:11
      port INTEGER, onu_id INTEGER,
      mac TEXT, name TEXT, type TEXT, status TEXT,
      compatible INTEGER,              -- 1 sí, 0 no, NULL sin comprobar
      caps TEXT,                       -- resumen de support_info
      pppoe TEXT,
      customer_id INTEGER,
      ssid_name TEXT,                  -- nombre de la red 2.4 (última lectura)
      lan_ports TEXT,                  -- JSON [{port, up}]
      checked_at TEXT, seen_at TEXT,
      UNIQUE(olt_id, onu_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_onu_inv_customer ON onu_inventory(customer_id);
    CREATE TABLE IF NOT EXISTS wifi_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER, olt_id INTEGER, onu_ref TEXT,
      ssid_name TEXT,
      by_type TEXT, by_name TEXT,      -- customer | admin | staff
      status TEXT,                     -- applying | ok | failed
      step TEXT, error TEXT,
      created_at TEXT DEFAULT (NOW_LOCAL()), finished_at TEXT
    );
  `);
  _schemaOk = true;
}

// ── Telnet (una operación a la vez para no saturar la OLT) ────────────────────
let _chain = Promise.resolve();
function serial(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.catch(() => {});
  return run;
}

const clean = (s) => String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/ ?--More-- ?[\x00\x08 ]*/g, '').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');

function oltSvc() { return require('./oltService'); }
function getOlt(oltId) {
  const olt = oltSvc().getOltById(oltId);
  if (!olt) throw new Error('OLT no encontrada');
  return olt;
}

/** Ejecuta comandos dentro de "interface epon 0/port" y devuelve la salida de CADA comando. */
async function runOnPort(olt, port, cmds) {
  const o = oltSvc();
  const opts = Object.assign(o.telnetOptsFromOlt(olt), { enablePassword: olt.enable_password || olt.web_password, asArray: true });
  const all = ['configure terminal', `interface epon 0/${port}`, ...cmds, 'exit', 'exit'];
  for (const c of cmds) if (/[?\r\n]/.test(c)) throw new Error('comando inválido');
  const outs = await o.telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, all, opts);
  return outs.slice(2, 2 + cmds.length).map(clean);
}

/**
 * Guarda la configuración de la OLT ("write file", igual que System Configuration → Save).
 * OBLIGATORIO después de cualquier cambio en una ONU u OLT: al reiniciarse, la OLT vuelve a enviar a las ONU
 * lo que tiene guardado y se pierde todo lo que no se haya escrito (comprobado tras un corte de luz el 2026-10-14).
 */
async function writeOlt(olt) {
  const o = oltSvc();
  const opts = Object.assign(o.telnetOptsFromOlt(olt), { enablePassword: olt.enable_password || olt.web_password, asArray: true });
  const [out] = await o.telnetLoginAndRun(olt.host, olt.web_user, olt.web_password, ['write file'], opts);
  const ok = /saved/i.test(clean(out));
  if (!ok) throw new Error('la OLT no confirmó el guardado (write file)');
  return true;
}

/** "Clave : valor" → objeto. */
function kv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Za-z][A-Za-z0-9 ()/_-]*?)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && !/^epon-olt/i.test(line.trim())) out[m[1].trim()] = m[2];
  }
  return out;
}
const unsupported = (t) => /unsupport capability|doesn't exist|not support/i.test(t);

function parseSsid(t) {
  const k = kv(t);
  if (!k.Name) return null;
  return {
    name: k.Name, enabled: /enable/i.test(k.Status || ''), hidden: /enable/i.test(k.Hide || ''),
    auth: k['Auth Mode'] || null, enc: k['Encrypt Type'] || null, key: k['Preshared Key'] || null,
    rekey: parseInt(String(k['WPA Rekey Interval'] || '').replace(/\D/g, ''), 10),
  };
}
function parsePorts(t) {
  const k = kv(t);
  const ports = [];
  for (const [name, v] of Object.entries(k)) {
    const m = /^port(\d+)$/i.exec(name);
    if (m) ports.push({ port: Number(m[1]), up: /up/i.test(v) });
  }
  return ports.sort((a, b) => a.port - b.port);
}
function parseWan(t) {
  const k = kv(t);
  return { mode: k['Connect Mode'] || null, user: k['PPPoE UserName'] || null, status: k.Status || null, name: k.Name || null };
}

// ── Inventario ───────────────────────────────────────────────────────────────
const nowStamp = () => require('../config/billingCycle').nowStamp();

function vsolOlts() {
  return (oltSvc().getAllOlts() || []).filter(o => o.is_active !== 0 && /vsol/i.test(String(o.brand || '')));
}

/** Recorre las OLT VSOL: lista ONU, comprueba compatibilidad (una vez por semana) y asocia cliente. */
async function syncInventory({ force = false } = {}) {
  ensureSchema();
  const res = { olts: 0, onus: 0, checked: 0, compatible: 0, errors: [] };
  for (const olt of vsolOlts()) {
    res.olts++;
    try {
      await serial(async () => {
        const rows = await oltSvc().fetchVsolEponViaTelnet(olt);
        const enriched = oltSvc().enrichOnusWithCustomerData(rows.map(r => ({ ...r, sn: r.mac })));
        const upsert = db.prepare(`INSERT INTO onu_inventory (olt_id, onu_ref, port, onu_id, mac, name, type, status, customer_id, seen_at)
          VALUES (@olt_id, @onu_ref, @port, @onu_id, @mac, @name, @type, @status, @customer_id, @seen_at)
          ON CONFLICT(olt_id, onu_ref) DO UPDATE SET port=excluded.port, onu_id=excluded.onu_id, mac=excluded.mac, name=excluded.name,
            type=excluded.type, status=excluded.status, seen_at=excluded.seen_at,
            customer_id=COALESCE(onu_inventory.customer_id, excluded.customer_id)`);
        const stamp = nowStamp();
        for (const r of enriched) {
          const m = /EPON0\/(\d+):(\d+)/i.exec(r.id || '');
          if (!m) continue;
          upsert.run({ olt_id: olt.id, onu_ref: `EPON0/${m[1]}:${m[2]}`, port: Number(m[1]), onu_id: Number(m[2]), mac: r.mac || null,
            name: r.name || null, type: r.type || null, status: r.status || null, customer_id: r.customer_id || r.customerId || null, seen_at: stamp });
          res.onus++;
        }
        // Compatibilidad + usuario PPPoE de la WAN (asociación exacta con el cliente)
        const limit = require('../config/billingCycle').addDaysStamp(-RECHECK_DAYS);
        const pending = db.prepare(`SELECT * FROM onu_inventory WHERE olt_id = ? AND lower(status) = 'online'
          AND (? = 1 OR checked_at IS NULL OR checked_at <= ?) ORDER BY port, onu_id`).all(olt.id, force ? 1 : 0, limit);
        const byPort = new Map();
        for (const p of pending) { if (!byPort.has(p.port)) byPort.set(p.port, []); byPort.get(p.port).push(p); }
        for (const [port, list] of byPort) {
          for (let i = 0; i < list.length; i += 10) {
            const chunk = list.slice(i, i + 10);
            const outs = await runOnPort(olt, port, chunk.flatMap(o => [`show onu ${o.onu_id} pri support_info`, `show onu ${o.onu_id} pri wan_conn`, `show onu ${o.onu_id} pri wifi_ssid ${SSID_24}`]));
            chunk.forEach((o, j) => {
              const sup = outs[j * 3], wan = outs[j * 3 + 1], s24 = outs[j * 3 + 2];
              const k = kv(sup);
              const wifiOk = /ssid/i.test(k['WiFi Support'] || '') && Number(k['Wifi SSID'] || 0) >= SSID_5;
              const compatible = unsupported(sup) || !k['Ge Ports'] ? 0 : (wifiOk ? 1 : 0);
              const w = parseWan(wan);
              const ssid = parseSsid(s24);
              let customerId = null;
              if (w.user) {
                const c = db.prepare('SELECT id FROM customers WHERE lower(pppoe_username) = lower(?) LIMIT 1').get(w.user);
                if (c) customerId = c.id;
              }
              db.prepare(`UPDATE onu_inventory SET compatible = ?, caps = ?, pppoe = COALESCE(?, pppoe), customer_id = COALESCE(?, customer_id),
                ssid_name = COALESCE(?, ssid_name), checked_at = ? WHERE id = ?`)
                .run(compatible, compatible ? `${k['Ge Ports'] || '?'} LAN · WiFi ${k['WiFi Support'] || ''}`.trim() : (unsupported(sup) ? 'No compatible (otra marca o firmware)' : 'Sin WiFi gestionable'),
                  w.user || null, customerId, ssid ? ssid.name : null, nowStamp(), o.id);
              res.checked++; if (compatible) res.compatible++;
            });
          }
        }
      });
    } catch (e) {
      res.errors.push(`${olt.name}: ${e.message}`);
      logger.error(`[ONU] inventario ${olt.name}: ${e.message}`);
    }
  }
  return res;
}

function inventory() {
  ensureSchema();
  return db.prepare(`SELECT i.*, c.name AS customer_name, o.name AS olt_name FROM onu_inventory i
    LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN olts o ON o.id = i.olt_id ORDER BY i.olt_id, i.port, i.onu_id`).all();
}

function forCustomer(customerId) {
  ensureSchema();
  return db.prepare('SELECT * FROM onu_inventory WHERE customer_id = ? ORDER BY (compatible = 1) DESC, seen_at DESC LIMIT 1').get(customerId) || null;
}

// ── Lectura en vivo ──────────────────────────────────────────────────────────
/** Estado actual del equipo del cliente. includeKeys solo para quien puede ver la clave. */
async function readDetail(customerId, { includeKeys = false } = {}) {
  ensureSchema();
  const inv = forCustomer(customerId);
  if (!inv) return { ok: false, found: false, message: 'No se encontró la ONU de este cliente en la OLT.' };
  const base = { ok: true, found: true, onu_ref: inv.onu_ref, type: inv.type, mac: inv.mac, status: inv.status, compatible: inv.compatible, caps: inv.caps, checked_at: inv.checked_at };
  if (inv.compatible !== 1) return base;
  const olt = getOlt(inv.olt_id);
  const outs = await serial(() => runOnPort(olt, inv.port, [
    `show onu ${inv.onu_id} pri wifi_ssid ${SSID_24}`, `show onu ${inv.onu_id} pri wifi_ssid ${SSID_5}`,
    `show onu ${inv.onu_id} pri onu_status`, `show onu ${inv.onu_id} pri wan_conn`]));
  if (unsupported(outs[0])) return { ...base, ok: false, message: 'La ONU no respondió (¿apagada o desconectada?).' };
  const s24 = parseSsid(outs[0]), s5 = parseSsid(outs[1]);
  const ports = parsePorts(outs[2]);
  const wan = parseWan(outs[3]);
  db.prepare('UPDATE onu_inventory SET ssid_name = ?, lan_ports = ? WHERE id = ?').run(s24 ? s24.name : null, JSON.stringify(ports), inv.id);
  const strip = (s) => s && ({ name: s.name, enabled: s.enabled, hidden: s.hidden, auth: s.auth, ...(includeKeys ? { key: s.key } : {}) });
  return { ...base, wifi24: strip(s24), wifi5: strip(s5), ports, cablesConnected: ports.filter(p => p.up).length, wan,
    sameKey: !!(s24 && s5 && s24.key === s5.key), conventionOk: !!(s24 && s5 && s5.name === s24.name + SUFFIX_5G) };
}

// ── Cambio de WiFi ───────────────────────────────────────────────────────────
function validate(name, key) {
  let n = String(name || '').trim();
  if (n.toUpperCase().endsWith(SUFFIX_5G)) n = n.slice(0, -SUFFIX_5G.length);
  if (!NAME_RE.test(n)) throw new Error(wifiRules.NAME_MSG);
  const k = String(key || '');
  if (!KEY_RE.test(k)) throw new Error(wifiRules.KEY_MSG);
  return { name: n, key: k };
}

const AUTH = { WPA2PSK: 'wpa2psk', WPAPSK: 'wpapsk', 'WPAPSK/WPA2PSK': 'wpapsk/wpa2psk', WPA3PSK: 'wpa3psk', 'WPA2PSK/WPA3PSK': 'wpa2psk/wpa3psk' };
const ENC = { AES: 'aes', TKIP: 'tkip', TKIPAES: 'tkipaes' };
function setCmd(onuId, ssidIdx, name, key, cur) {
  const auth = (cur && AUTH[String(cur.auth || '').toUpperCase()]) || 'wpa2psk';
  const enc = (cur && ENC[String(cur.enc || '').toUpperCase()]) || 'aes';
  const hide = cur && cur.hidden ? 'enable' : 'disable';
  const rekey = cur && Number.isFinite(cur.rekey) && cur.rekey >= 0 ? cur.rekey : 86400;
  return `onu ${onuId} pri wifi_ssid ${ssidIdx} name ${name} hide ${hide} auth_mode ${auth} encrypt_type ${enc} shared_key ${key} rekey_interval ${rekey}`;
}

const _cooldown = new Map();

/**
 * Cambia nombre y clave de las dos redes (2.4 = nombre, 5G = nombre-5G, misma clave), verifica releyendo y guarda en la ONU.
 * actor: { type: 'customer'|'admin'|'staff', name }
 */
async function changeWifi(customerId, { name, key }, actor = {}, { notify = true } = {}) {
  ensureSchema();
  const v = validate(name, key);
  const inv = forCustomer(customerId);
  if (!inv) throw new Error('No se encontró la ONU de este cliente en la OLT.');
  if (inv.compatible !== 1) throw new Error('Esta ONU no permite cambios automáticos del WiFi.');
  if (actor.type === 'customer') {
    const last = _cooldown.get(customerId) || 0;
    if (Date.now() - last < 2 * 60 * 1000) throw new Error('Espere 2 minutos antes de volver a cambiar el WiFi.');
  }
  const change = db.prepare(`INSERT INTO wifi_changes (customer_id, olt_id, onu_ref, ssid_name, by_type, by_name, status, step) VALUES (?,?,?,?,?,?, 'applying', 'inicio')`)
    .run(customerId, inv.olt_id, inv.onu_ref, v.name, actor.type || 'admin', actor.name || '', ).lastInsertRowid;
  const setStep = (step) => db.prepare('UPDATE wifi_changes SET step = ? WHERE id = ?').run(step, change);
  const olt = getOlt(inv.olt_id);
  const id = inv.onu_id;
  try {
    const result = await serial(async () => {
      setStep('lectura');
      const before = await runOnPort(olt, inv.port, [`show onu ${id} pri wifi_ssid ${SSID_24}`, `show onu ${id} pri wifi_ssid ${SSID_5}`]);
      if (unsupported(before[0])) throw new Error('la ONU no respondió (¿apagada o desconectada?)');
      const c24 = parseSsid(before[0]), c5 = parseSsid(before[1]);
      setStep('cambio');
      const w = await runOnPort(olt, inv.port, [setCmd(id, SSID_24, v.name, v.key, c24), setCmd(id, SSID_5, v.name + SUFFIX_5G, v.key, c5)]);
      w.forEach((t, i) => { if (!/set ok/i.test(t)) throw new Error(`la OLT rechazó el cambio de la red ${i ? '5G' : '2.4'}: ${(t.match(/(Msg:[^\n]*|%[^\n]*)/) || ['sin respuesta'])[0]}`); });
      setStep('verificación');
      let a24 = null, a5 = null;
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const after = await runOnPort(olt, inv.port, [`show onu ${id} pri wifi_ssid ${SSID_24}`, `show onu ${id} pri wifi_ssid ${SSID_5}`]);
        a24 = parseSsid(after[0]); a5 = parseSsid(after[1]);
        if (a24 && a5 && a24.name === v.name && a24.key === v.key && a5.name === v.name + SUFFIX_5G && a5.key === v.key) break;
      }
      if (!(a24 && a24.name === v.name && a24.key === v.key)) throw new Error('la red 2.4 no quedó con los datos nuevos');
      if (!(a5 && a5.name === v.name + SUFFIX_5G && a5.key === v.key)) {
        // Algunas ONU con firmware viejo aceptan el cambio de la 5G por la OLT pero no lo aplican: se hace por TR-069
        setStep('5G por TR-069');
        const ok5 = await set5gViaTr069(customerId, a5 ? a5.name : '', v.name + SUFFIX_5G, v.key);
        if (ok5) {
          for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 2000));
            a5 = parseSsid((await runOnPort(olt, inv.port, [`show onu ${id} pri wifi_ssid ${SSID_5}`]))[0]);
            if (a5 && a5.name === v.name + SUFFIX_5G && a5.key === v.key) break;
          }
        }
        if (!(a5 && a5.name === v.name + SUFFIX_5G && a5.key === v.key)) throw new Error('la red 5G no quedó con los datos nuevos' + (ok5 ? '' : ' (y la ONU no responde por TR-069)'));
      }
      setStep('guardado');
      const sv = await runOnPort(olt, inv.port, [`onu ${id} pri save_config`]);
      if (/%|error|fail/i.test(sv[0])) throw new Error('no se pudo guardar en la memoria de la ONU');
      setStep('guardado en la OLT');
      await writeOlt(olt);
      return { ok: true };
    });
    db.prepare("UPDATE wifi_changes SET status = 'ok', step = 'listo', finished_at = (NOW_LOCAL()) WHERE id = ?").run(change);
    // El WiFi vigente queda guardado en la ficha (sirve para una ONU de reemplazo aunque esta no encienda)
    try { require('./customerEquipmentService').saveWifi(customerId, v.name, v.key); } catch (_) {}
    db.prepare('UPDATE onu_inventory SET ssid_name = ? WHERE id = ?').run(v.name, inv.id);
    if (actor.type === 'customer') _cooldown.set(customerId, Date.now());
    if (notify) notifyCustomer(customerId, v, actor).catch(() => {});
    logger.info(`[ONU] WiFi de cliente ${customerId} (${inv.onu_ref}) cambiado a "${v.name}" por ${actor.type}:${actor.name || '-'}`);
    return { ok: true, changeId: change, name: v.name, name5g: v.name + SUFFIX_5G, ...result };
  } catch (e) {
    const step = (db.prepare('SELECT step FROM wifi_changes WHERE id = ?').get(change) || {}).step;
    db.prepare("UPDATE wifi_changes SET status = 'failed', error = ?, finished_at = (NOW_LOCAL()) WHERE id = ?").run(e.message, change);
    logger.error(`[ONU] Falló cambio de WiFi cliente ${customerId} (${inv.onu_ref}) en "${step}": ${e.message}`);
    if (notify) notifyFailure(customerId, inv, step, e.message, actor).catch(() => {});
    const err = new Error(`No se pudo completar el cambio (${step}): ${e.message}. Ya avisamos al equipo técnico.`);
    err.changeId = change;
    throw err;
  }
}

/** Cambia la red 5G por TR-069 (respaldo para ONU que ignoran el cambio por la OLT). Devuelve true si la ONU lo confirmó. */
async function set5gViaTr069(customerId, currentName, name, key) {
  try {
    const dev = require('./onuClientsService').acsDevice(customerId);
    if (!dev) return false;
    let p = {}; try { p = JSON.parse(dev.params || '{}') || {}; } catch (_) {}
    const val = (k) => { const x = p[k]; return x && typeof x === 'object' ? (x.value ?? x._value ?? '') : (x ?? ''); };
    const IGD = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.';
    const idx = Object.keys(p).map(k => (new RegExp('^' + IGD.replace(/\./g, '\\.') + '(\\d+)\\.SSID$').exec(k) || [])[1]).filter(Boolean)
      .find(i => { const s = String(val(IGD + i + '.SSID')); return (currentName && s === currentName) || /-5G$/i.test(s); });
    if (!idx) return false;
    const acs = require('./acsServerService');
    const t = acs.createBuiltinTask(dev.id, 'setParameterValues', { parameterValues: [
      [IGD + idx + '.SSID', name, 'xsd:string'],
      [IGD + idx + '.PreSharedKey.1.KeyPassphrase', key, 'xsd:string'],
    ] });
    if (!t || !t.taskId) return false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const r = db.prepare('SELECT status FROM acs_tasks WHERE id = ?').get(t.taskId);
      if (r && r.status === 'completed') { logger.info(`[ONU] 5G de cliente ${customerId} cambiada por TR-069 (WLAN ${idx})`); return true; }
      if (r && /fail|skip/.test(r.status)) return false;
    }
    return false;
  } catch (e) { logger.warn('[ONU] 5G por TR-069: ' + e.message); return false; }
}

function history(customerId, limit = 10) {
  ensureSchema();
  return db.prepare('SELECT id, ssid_name, by_type, by_name, status, step, error, created_at, finished_at FROM wifi_changes WHERE customer_id = ? ORDER BY id DESC LIMIT ?').all(customerId, limit);
}
function recentChanges(limit = 50) {
  ensureSchema();
  return db.prepare(`SELECT w.*, c.name AS customer_name FROM wifi_changes w LEFT JOIN customers c ON c.id = w.customer_id ORDER BY w.id DESC LIMIT ?`).all(limit);
}

// ── Avisos ───────────────────────────────────────────────────────────────────
async function notifyCustomer(customerId, v, actor) {
  if (!require('../config/waGate').ready()) return;
  const c = db.prepare('SELECT name, phone, status FROM customers WHERE id = ?').get(customerId);
  if (!c || !c.phone || c.status === 'cancelled') return;
  // Si lo hizo la oficina (por teléfono), el cliente recibe la clave nueva; si lo hizo él mismo, no se repite.
  const keyLine = actor.type === 'customer' ? 'Clave: la que elegiste.' : `Clave nueva: *${v.key}*`;
  const msg = `📶 *Tu WiFi fue actualizado*\n\nRed 2.4 GHz: *${v.name}*\nRed 5 GHz: *${v.name}${SUFFIX_5G}*\n${keyLine}\n\n` +
    'Tus equipos se desconectaron: volvé a conectarlos a la red con la clave nueva.\n⚠️ No compartas tu clave.';
  await require('./waNotifyService').sendText(c.phone, msg);
}

/** Falla → administradores (whatsapp_admin_numbers) y personal de oficina con permiso "Gestionar WiFi de clientes". */
async function notifyFailure(customerId, inv, step, error, actor) {
  if (!require('../config/waGate').ready()) return;
  const c = db.prepare('SELECT name, customer_code FROM customers WHERE id = ?').get(customerId) || {};
  const quien = actor.type === 'customer' ? 'el cliente desde su portal' : `${actor.name || 'la oficina'}`;
  const msg = `⚠️ *Falló un cambio de WiFi*\n\nCliente: *${c.name || customerId}*${c.customer_code ? ' (' + c.customer_code + ')' : ''}\nONU: ${inv.onu_ref}\n` +
    `Pedido por: ${quien}\nPaso: ${step}\nDetalle: ${error}\n\nRevisalo en Clientes → ⋮ → Equipo y WiFi.`;
  const regional = require('../config/regional');
  const set = new Set();
  const admins = getSetting('whatsapp_admin_numbers', []);
  (Array.isArray(admins) ? admins : String(admins || '').split(',')).forEach(p => { const n = regional.normalizePhone(p); if (n && n.length >= 8) set.add(n); });
  try {
    const sp = require('../config/staffPermissions');
    db.prepare("SELECT id, phone FROM cashiers WHERE is_active = 1 AND COALESCE(phone,'') <> ''").all()
      .filter(s => sp.current(s.id).wifi_clientes)
      .forEach(s => { const n = regional.normalizePhone(s.phone); if (n && n.length >= 8) set.add(n); });
  } catch (_) {}
  const wa = require('./waNotifyService');
  for (const n of set) { try { await wa.sendText(n, msg); } catch (_) {} }
}

module.exports = { ensureSchema, syncInventory, inventory, forCustomer, readDetail, changeWifi, validate, history, recentChanges, SUFFIX_5G,
  writeOlt, _internal: { runOnPort, serial, getOlt, kv, writeOlt } };
