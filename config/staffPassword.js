/**
 * Contraseñas del personal (cajeros/oficina, técnicos, cobradores).
 *
 *  - Se guardan como hash scrypt (mismo formato que el administrador, config/adminAuth.js).
 *  - Las contraseñas antiguas en texto plano se aceptan una vez y se migran a hash en ese login.
 *  - authenticate() reemplaza a los "SELECT ... WHERE password = ?" en texto plano.
 */
const db = require('./database');
const { hashPassword, verifyHash } = require('./adminAuth');
const crypto = require('crypto');

const TABLES = new Set(['cashiers', 'technicians', 'collectors']);
const MIN_LENGTH = 8;

const isHashed = (v) => /^scrypt\$/.test(String(v || ''));

function hash(plain) {
  const p = String(plain || '');
  if (p.length < MIN_LENGTH) throw new Error(`La contraseña debe tener al menos ${MIN_LENGTH} caracteres.`);
  return hashPassword(p);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Devuelve la fila del usuario activo si usuario y contraseña son correctos; si no, null. */
function authenticate(table, username, password) {
  if (!TABLES.has(table)) throw new Error('tabla inválida');
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u || !p) return null;
  const row = db.prepare(`SELECT * FROM ${table} WHERE username = ? AND is_active = 1`).get(u);
  if (!row) { hashPassword('x'); return null; } // mismo costo con o sin usuario
  const stored = String(row.password || '');
  if (isHashed(stored)) return verifyHash(p, stored) ? row : null;
  if (!stored || !safeEqual(p, stored)) return null;
  // Texto plano antiguo: migrar a hash
  try { db.prepare(`UPDATE ${table} SET password = ? WHERE id = ?`).run(hashPassword(p), row.id); } catch (_) {}
  return row;
}

/** Valor a guardar en una actualización: hash nuevo, o el actual si el campo vino vacío. */
function forUpdate(table, id, plain) {
  if (!TABLES.has(table)) throw new Error('tabla inválida');
  if (String(plain || '') === '') {
    const row = db.prepare(`SELECT password FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new Error('Usuario no encontrado.');
    return row.password;
  }
  return hash(plain);
}

/** Cierra las sesiones abiertas de un usuario del panel (cajero/oficina). */
function closeCashierSessions(cashierId) {
  try {
    return db.prepare(`DELETE FROM sessions WHERE data LIKE '%"isCashier":true%' AND data LIKE ?`).run(`%"cashierId":${Number(cashierId)},%`).changes
      + db.prepare(`DELETE FROM sessions WHERE data LIKE '%"isCashier":true%' AND data LIKE ?`).run(`%"cashierId":${Number(cashierId)}}%`).changes;
  } catch (_) { return 0; }
}

module.exports = { hash, authenticate, forUpdate, isHashed, closeCashierSessions, MIN_LENGTH };
