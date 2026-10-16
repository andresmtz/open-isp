'use strict';
/**
 * Retiro de equipo (paso previo a cancelar el servicio).
 *
 * 1. La oficina genera una ORDEN DE RETIRO (ticket kind 'retiro') y la asigna a un técnico, a la oficina o al
 *    administrador. El cliente sigue igual (activo o cortado): no se toca nada en la red.
 * 2. Quien retira ve en su orden qué equipo llevarse (modelo, MAC, foto de la etiqueta) y la foto de la casa.
 *    Al tenerlo en su poder marca "Equipo retirado" con la foto de la etiqueta (se compara la MAC con la registrada)
 *    o "No se pudo retirar" con el motivo.
 * 3. Recién con el equipo retirado, la oficina toca "Cancelar servicio" (customerService.cancelCustomer):
 *    borra el usuario PPPoE del MikroTik, libera la IP, da de baja la ONU en la OLT (write file) y anula las
 *    facturas pendientes. La cancelación es siempre manual.
 *
 * customers.withdraw_status: NULL | 'pendiente' | 'retirado' | 'no_retirado'; withdraw_info: texto del resultado.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const regional = require('../config/regional');

const REASONS = { baja: 'El cliente pidió la baja', mora: 'Falta de pago', mudanza: 'Mudanza / cambio de domicilio', otro: 'Otro motivo' };
const FAIL_REASONS = { ausente: 'No había nadie en la casa', no_entrega: 'El cliente no quiere entregar el equipo', perdido: 'Equipo perdido o robado', danado: 'Equipo dañado', no_ubicable: 'No se ubicó el domicilio', otro: 'Otro motivo' };

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  require('./installationService').ensureSchema(); // tickets.kind
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  for (const [c, t] of [['withdraw_status', 'TEXT'], ['withdraw_info', 'TEXT'], ['withdraw_ticket_id', 'INTEGER']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE customers ADD COLUMN ${c} ${t}`);
  }
  _schemaOk = true;
}

const inst = () => require('./installationService');
const waNotify = () => require('./waNotifyService');
const mapLink = (lat, lng) => (String(lat || '').trim() && String(lng || '').trim()) ? `https://maps.google.com/?q=${encodeURIComponent(String(lat).trim())},${encodeURIComponent(String(lng).trim())}` : '';
function logEvent(id, text) {
  try { db.prepare("INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (?, 'install', NULL, ?)").run(id, String(text).slice(0, 300)); } catch (_) {}
}
function openTicket(id) {
  return db.prepare("SELECT * FROM tickets WHERE customer_id=? AND kind='retiro' AND status IN ('open','in_progress') ORDER BY id DESC LIMIT 1").get(id) || null;
}

/** Qué equipo hay que retirar (lo registrado en la ficha y en la OLT). */
function equipmentOf(id) {
  let eq = null, inv = null;
  try { eq = require('./customerEquipmentService').current(id); } catch (_) {}
  try { inv = require('./onuManageService').forCustomer(id); } catch (_) {}
  const mac = String((eq && eq.mac) || (inv && inv.mac) || '').toUpperCase();
  let extras = [];
  try { extras = require('./extraServicesService').equipmentFor(id); } catch (_) {}
  return { type: (eq && eq.type) || (inv && inv.type) || '', mac, onu_ref: (eq && eq.onu_ref) || (inv && inv.onu_ref) || '', labelDocId: eq && eq.label_doc_id, extras };
}

function message(id, ticketId) {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  const e = equipmentOf(id);
  const loc = mapLink(c.lat, c.lng);
  return `📦 *RETIRO DE EQUIPO*\n\n👤 *Cliente:* ${c.name}\n📞 *Teléfono:* ${c.phone || '-'}\n📍 *Dirección:* ${c.address || '-'}` +
    (loc ? `\n🗺️ *Ubicación:* ${loc}` : '') +
    `\n\n🔌 *Equipo a retirar:* ${e.type || 'ONU'}${e.mac ? `\n🏷️ *MAC:* ${e.mac}` : ''}` +
    (e.extras && e.extras.length ? e.extras.map(x => `\n📺 *También retirar:* ${x.equipment} (${x.name})${x.serial ? ` · serie ${x.serial}` : ''}`).join('') : '') +
    `\n_(Revisá que la MAC de la etiqueta coincida: así te llevás el equipo correcto.)_` +
    `\n\nCuando lo tengas en tu poder, en tu orden N.º ${ticketId} tocá *"Equipo retirado"* y subí la foto de la etiqueta. Si no se pudo, tocá *"No se pudo retirar"* e indicá el motivo.`;
}

async function sendPhotos(id, who) {
  if (!who || who.type === 'admin' || !who.phone) return;
  const n = regional.normalizePhone(String(who.phone).replace(/\D/g, ''));
  const docs = require('./customerDocumentService');
  const c = db.prepare('SELECT name, address FROM customers WHERE id=?').get(id) || {};
  try {
    const casa = docs.list(id, { kinds: ['casa'] })[0];
    const fp = casa && docs.filePath(casa);
    if (fp) await waNotify().sendImage(n, require('fs').readFileSync(fp), `🏠 Casa de ${c.name} — ${c.address || ''}`.trim());
  } catch (_) {}
  try {
    const e = equipmentOf(id);
    const lab = e.labelDocId ? docs.get(e.labelDocId) : docs.list(id, { kinds: ['etiqueta'] })[0];
    const fp = lab && docs.filePath(lab);
    if (fp) await waNotify().sendImage(n, require('fs').readFileSync(fp), `🏷️ Etiqueta del equipo a retirar — ${c.name}`);
  } catch (_) {}
}

/** Genera la orden de retiro y avisa a quien la hace. */
async function create(customerId, { installer, reason = 'baja', notes = '', actor = 'Admin' } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new Error('Cliente no encontrado.');
  if (c.status === 'cancelled') throw new Error('El cliente ya está cancelado.');
  if (c.status === 'inactive') throw new Error('Es un inscripto (no tiene equipo instalado).');
  if (openTicket(id)) throw new Error('Ya tiene una orden de retiro abierta. Usá "Reenviar datos" o anulala.');
  const who = inst().findInstaller(installer);
  if (!who) throw new Error('Elegí quién va a retirar el equipo.');
  const why = REASONS[reason] || REASONS.otro;
  const extra = String(notes || '').trim().slice(0, 300);
  const e = equipmentOf(id);
  const body = `Retiro de equipo — ${why}.${extra ? `\nNotas: ${extra}` : ''}\n` +
    `Teléfono: ${c.phone || '-'}\nDirección: ${c.address || '-'}` + (mapLink(c.lat, c.lng) ? `\nUbicación: ${mapLink(c.lat, c.lng)}` : '') +
    `\nEquipo a retirar: ${e.type || 'ONU'}${e.mac ? ' · MAC ' + e.mac : ''}` +
    `\n\nCuando tengas el equipo, tocá "Equipo retirado" y subí la foto de la etiqueta.`;
  const tk = require('./ticketService').createTicket(id, `Retiro de equipo — ${c.name}`, body, { technicianId: who.type === 'tech' ? who.id : null, status: 'in_progress' });
  const ticketId = Number(tk && tk.lastInsertRowid);
  db.prepare("UPDATE tickets SET kind='retiro', technician_notes=? WHERE id=?").run(who.type === 'tech' ? '' : `Retira: ${who.name}`, ticketId);
  db.prepare("UPDATE customers SET withdraw_status='pendiente', withdraw_info=?, withdraw_ticket_id=? WHERE id=?")
    .run(`${who.type}:${who.id}:${who.name}|${why}`, ticketId, id);
  let msg = message(id, ticketId); if (extra) msg += `\n\n📝 ${extra}`;
  const notified = await (async () => { try { if (who.type === 'admin') { await waNotify().notifyAdmin(msg); return true; } return await inst()._sendTo(who.phone, msg); } catch (_) { return false; } })();
  if (notified) await sendPhotos(id, who);
  logEvent(id, `Orden de retiro de equipo N.º ${ticketId} asignada a ${who.name} (${why}; por ${actor})`);
  logger.info(`[Retiro] ${c.name}: orden #${ticketId} asignada a ${who.name} por ${actor}`);
  return { ok: true, ticketId, installer: who, notified };
}

function assignee(id) {
  const c = db.prepare('SELECT withdraw_info FROM customers WHERE id=?').get(id) || {};
  const [k] = String(c.withdraw_info || '').split('|');
  const [type, idStr] = k.split(':');
  return type === 'admin' ? inst().findInstaller('admin') : inst().findInstaller(`${type}:${idStr}`);
}

async function resend(customerId, { actor = 'Admin' } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const t = openTicket(id);
  if (!t) throw new Error('No tiene una orden de retiro abierta.');
  const who = assignee(id);
  if (!who) throw new Error('No se encontró a quien tiene asignado el retiro. Anulá la orden y generala de nuevo.');
  if (who.type !== 'admin' && !regional.isValidPhone(who.phone || '')) throw new Error(`${who.name} no tiene un WhatsApp válido cargado (${who.phone || 'vacío'}). Corregilo en Usuarios.`);
  let ok = false;
  try { ok = who.type === 'admin' ? (await waNotify().notifyAdmin(message(id, t.id)), true) : await inst()._sendTo(who.phone, message(id, t.id)); } catch (_) {}
  if (ok) await sendPhotos(id, who);
  logEvent(id, `Datos del retiro reenviados a ${who.name}${ok ? '' : ' (no se pudo enviar)'} (por ${actor})`);
  return { ok, installer: who, phone: who.type === 'admin' ? '' : regional.toLocalPhone(who.phone) };
}

/** Anula la orden (ej. el cliente pagó y sigue). */
function cancelOrder(customerId, { actor = 'Admin', reason = '' } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const t = openTicket(id);
  const who = t ? assignee(id) : null;
  const why = String(reason || '').trim() || 'sin motivo';
  if (t) db.prepare("UPDATE tickets SET status='resolved', kind='retiro_anulado', technician_notes=TRIM(COALESCE(technician_notes,'') || ' Retiro anulado: ' || ?), updated_at=(NOW_LOCAL()) WHERE id=?").run(why, t.id);
  db.prepare('UPDATE customers SET withdraw_status=NULL, withdraw_info=NULL, withdraw_ticket_id=NULL WHERE id=?').run(id);
  const c = db.prepare('SELECT name FROM customers WHERE id=?').get(id) || {};
  if (who) inst()._tellInstaller(who, `ℹ️ Se anuló el retiro de equipo de *${c.name}*. No hace falta que vayas.`).catch(() => {});
  logEvent(id, `Orden de retiro anulada (${why}; por ${actor})`);
  return { ok: true };
}

/** Avisos a administración y oficina. */
async function notifyOffice(text) {
  try { await waNotify().notifyAdmin(text); } catch (_) {}
  for (const s of inst()._officeRecipients()) { try { await inst()._sendTo(s.phone, text); } catch (_) {} }
}

/** El técnico ya tiene el equipo: guarda la foto, compara la MAC y avisa a la oficina para cancelar. */
async function markRetrieved(customerId, { images = [], notes = '', by = '', ticketId = null } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const t = openTicket(id);
  if (!t || (ticketId && Number(ticketId) !== t.id)) throw new Error('No hay una orden de retiro abierta.');
  const docs = require('./customerDocumentService');
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  const e = equipmentOf(id);
  for (const b of images) { try { await docs.add(id, 'retiro', b, by); } catch (err) { logger.warn('[Retiro] foto: ' + err.message); } }
  // Comparación de la MAC de la etiqueta con la registrada
  let check = images.length ? 'no se pudo leer la MAC en la foto' : 'sin foto de la etiqueta';
  if (images.length && e.mac) {
    try {
      const lr = require('./labelReaderService');
      const want = lr.norm(e.mac);
      const read = [];
      for (const b of images) read.push(...(await lr.read(b)).macs);
      if (read.some(r => r.mac === want)) check = '✅ MAC coincide con la registrada';
      else if (read.some(r => r.mac.slice(0, 6) === want.slice(0, 6) && Math.abs(parseInt(r.mac.slice(6), 16) - parseInt(want.slice(6), 16)) <= 8)) check = '✅ MAC correlativa a la registrada (mismo equipo)';
      else if (read.length) check = `⚠️ la MAC leída (${read.map(r => lr.pretty(r.mac)).join(', ')}) NO coincide con la registrada (${e.mac})`;
    } catch (err) { check = 'no se pudo leer la etiqueta: ' + err.message; }
  }
  const note = String(notes || '').trim().slice(0, 300);
  db.prepare("UPDATE tickets SET status='resolved', technician_notes=TRIM(COALESCE(technician_notes,'') || ' Equipo retirado: ' || ?), updated_at=(NOW_LOCAL()) WHERE id=?").run(`${check}${note ? ' — ' + note : ''}`, t.id);
  db.prepare("UPDATE customers SET withdraw_status='retirado', withdraw_info=? WHERE id=?").run(`Retirado por ${by} el ${new Date().toLocaleDateString('es-PY', { timeZone: regional.timezone() })}: ${check}${note ? ' — ' + note : ''}`, id);
  logEvent(id, `Equipo retirado por ${by} (${check})${note ? ': ' + note : ''}`);
  await notifyOffice(`📦 *Equipo retirado* — ${c.name}\nPor: ${by}\nEquipo: ${e.type || 'ONU'}${e.mac ? ' · ' + e.mac : ''}\n${check}${note ? '\n📝 ' + note : ''}\n\n👉 Ya podés cancelar el servicio: Clientes → ${c.name} → *Cancelar servicio*.`);
  return { ok: true, check };
}

/** No se pudo retirar: queda registrado; la oficina decide (reintentar, cargo o cancelar igual). */
async function markFailed(customerId, { motive = 'otro', detail = '', by = '', ticketId = null } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const t = openTicket(id);
  if (!t || (ticketId && Number(ticketId) !== t.id)) throw new Error('No hay una orden de retiro abierta.');
  const label = (FAIL_REASONS[motive] || FAIL_REASONS.otro) + (String(detail || '').trim() ? ': ' + String(detail).trim().slice(0, 200) : '');
  const c = db.prepare('SELECT name FROM customers WHERE id=?').get(id) || {};
  db.prepare("UPDATE tickets SET status='resolved', kind='retiro_fallido', technician_notes=TRIM(COALESCE(technician_notes,'') || ' No se pudo retirar: ' || ?), updated_at=(NOW_LOCAL()) WHERE id=?").run(label, t.id);
  db.prepare("UPDATE customers SET withdraw_status='no_retirado', withdraw_info=? WHERE id=?").run(`No se pudo retirar (${by}): ${label}`, id);
  logEvent(id, `No se pudo retirar el equipo (${by}): ${label}`);
  await notifyOffice(`⚠️ *No se pudo retirar el equipo* — ${c.name}\nPor: ${by}\nMotivo: ${label}\n\nPodés generar otra orden de retiro, agregar un cargo por el equipo o cancelar el servicio igual.`);
  return { ok: true };
}

module.exports = { ensureSchema, REASONS, FAIL_REASONS, create, resend, cancelOrder, markRetrieved, markFailed, equipmentOf, openTicket };
