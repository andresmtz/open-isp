'use strict';
/**
 * Fotos de perfil de WhatsApp de los contactos (vía GoWA), guardadas localmente y renovadas cada cierto tiempo.
 *
 *  - Solo se obtienen las que el contacto tiene visibles; si la ocultó o no tiene, queda sin foto y se vuelve a
 *    intentar en el próximo ciclo.
 *  - Se guardan reducidas (192 px, JPEG) en database/avatars/<id de la conversación>.jpg (volumen persistente) y se
 *    sirven solo por una ruta con sesión.
 *  - De a pocas por vez y con pausa entre cada una, para no saturar a WhatsApp.
 *
 * Parámetros: wa_avatar_days (cada cuántos días se renueva cada foto, 7), wa_avatar_per_run (cuántas por ciclo, 15).
 */
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

const DIR = path.join(__dirname, '..', 'database', 'avatars');
const num = (k, d) => { const n = Number(getSetting(k, d)); return Number.isFinite(n) && n > 0 ? n : d; };

let _schema = false;
function ensureSchema() {
  if (_schema) return;
  require('./conversationService').ensureSchema();
  const cols = db.prepare('PRAGMA table_info(wa_conversations)').all().map(c => c.name);
  if (!cols.includes('avatar_file')) db.exec('ALTER TABLE wa_conversations ADD COLUMN avatar_file TEXT');
  if (!cols.includes('avatar_checked_at')) db.exec('ALTER TABLE wa_conversations ADD COLUMN avatar_checked_at TEXT');
  fs.mkdirSync(DIR, { recursive: true });
  _schema = true;
}

/** Busca y guarda la foto de una conversación. Devuelve 'ok' | 'none'. */
async function refreshOne(conv) {
  ensureSchema();
  const now = new Date().toISOString();
  const g = require('./gowaWhatsappService');
  let url = null;
  try { url = await g.getAvatarUrl(conv.jid, { preview: false }); }
  catch (e) {
    // "hidden" / sin foto / número sin WhatsApp: se marca como revisada sin foto
    if (!/hidden|not.?found|no profile|not exist|item-not-found|404/i.test(e.message || '')) throw e; // GoWA caído u otro error: se reintenta
  }
  if (!url) {
    const old = conv.avatar_file ? path.join(DIR, path.basename(conv.avatar_file)) : null;
    if (old && fs.existsSync(old)) fs.unlinkSync(old);
    db.prepare('UPDATE wa_conversations SET avatar_file=NULL, avatar_checked_at=? WHERE id=?').run(now, conv.id);
    return 'none';
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('No se pudo descargar la foto (HTTP ' + r.status + ')');
  const buf = Buffer.from(await r.arrayBuffer());
  const out = await require('sharp')(buf).resize(192, 192, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
  const file = conv.id + '.jpg';
  fs.writeFileSync(path.join(DIR, file), out);
  db.prepare('UPDATE wa_conversations SET avatar_file=?, avatar_checked_at=? WHERE id=?').run(file, now, conv.id);
  return 'ok';
}

let _busy = false;
/** Renueva las fotos vencidas (las conversaciones más recientes primero). */
async function refreshDue({ limit } = {}) {
  if (_busy) return { skipped: 'busy' };
  _busy = true;
  try {
    ensureSchema();
    if (String(getSetting('wa_gateway_type', 'gowa') || '').toLowerCase() !== 'gowa') return { skipped: 'gateway' };
    if (!require('../config/waGate').ready()) return { skipped: 'wa' };
    const days = num('wa_avatar_days', 7);
    const before = new Date(Date.now() - days * 86400e3).toISOString();
    const rows = db.prepare(`SELECT id, jid, avatar_file FROM wa_conversations
      WHERE COALESCE(ignored,0)=0 AND jid LIKE '%@s.whatsapp.net' AND (avatar_checked_at IS NULL OR avatar_checked_at < ?)
      ORDER BY COALESCE(last_message_at,'') DESC LIMIT ?`).all(before, limit || num('wa_avatar_per_run', 15));
    let ok = 0, none = 0, err = 0;
    for (const c of rows) {
      try { (await refreshOne(c)) === 'ok' ? ok++ : none++; }
      catch (e) { err++; logger.warn(`[Fotos WhatsApp] conversación ${c.id}: ${e.message}`); }
      await new Promise(res => setTimeout(res, 1500 + Math.random() * 1500));
    }
    if (rows.length) logger.info(`[Fotos WhatsApp] ${ok} foto(s) nuevas, ${none} sin foto visible, ${err} error(es)`);
    return { checked: rows.length, ok, none, err };
  } finally { _busy = false; }
}

/** Ruta absoluta de la foto de una conversación, o null. */
function fileFor(convId) {
  ensureSchema();
  const r = db.prepare('SELECT avatar_file FROM wa_conversations WHERE id=?').get(Number(convId));
  if (!r || !r.avatar_file) return null;
  const p = path.join(DIR, path.basename(r.avatar_file));
  return fs.existsSync(p) ? p : null;
}

/** Foto del cliente: la de su conversación más reciente que tenga foto. */
function forCustomer(customerId) {
  ensureSchema();
  const r = db.prepare("SELECT id, avatar_checked_at FROM wa_conversations WHERE customer_id=? AND avatar_file IS NOT NULL AND COALESCE(ignored,0)=0 ORDER BY COALESCE(last_message_at,'') DESC LIMIT 1").get(Number(customerId));
  return r ? { convId: r.id, url: `/admin/conversations/${r.id}/avatar?v=${encodeURIComponent(r.avatar_checked_at || '')}` } : null;
}

module.exports = { ensureSchema, refreshOne, refreshDue, fileFor, forCustomer, DIR };
