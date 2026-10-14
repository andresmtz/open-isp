/**
 * Autenticación del administrador principal.
 *
 *  - La contraseña se guarda como hash scrypt (settings.admin_password_hash), nunca en texto plano.
 *  - Si había una contraseña en texto plano (admin_password, versiones anteriores), se acepta una vez
 *    y se migra a hash automáticamente.
 *  - Sin contraseña configurada: el usuario/contraseña de fábrica SOLO funciona desde la red local
 *    (conexión directa, no a través de un proxy/túnel) y obliga a crear una contraseña propia.
 *    Desde internet no se puede entrar hasta que exista una contraseña.
 */
const crypto = require('crypto');
const { getSetting, saveSettings } = require('./settingsManager');

const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'demo-isp123';
const MIN_LENGTH = 10;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyHash(plain, stored) {
  try {
    const [algo, N, r, p, saltB64, keyB64] = String(stored || '').split('$');
    if (algo !== 'scrypt') return false;
    const key = Buffer.from(keyB64, 'base64');
    const test = crypto.scryptSync(String(plain), Buffer.from(saltB64, 'base64'), key.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(key, test);
  } catch (_) { return false; }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function username() { return String(getSetting('admin_username', DEFAULT_USER) || DEFAULT_USER).trim(); }
function hasPassword() { return !!String(getSetting('admin_password_hash', '') || '').trim() || !!String(getSetting('admin_password', '') || '').trim(); }

/** ¿La petición llega directo desde la red local (no por Cloudflare/proxy)? */
function isDirectLan(req) {
  const h = req.headers || {};
  if (h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h['x-real-ip']) return false;
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1';
}

/**
 * Verifica usuario y contraseña. Devuelve { ok, mustChange } o { ok:false, reason }.
 */
function verify(user, pass, req) {
  if (String(user || '').trim().toLowerCase() !== username().toLowerCase()) return { ok: false };
  const hash = String(getSetting('admin_password_hash', '') || '').trim();
  if (hash) return { ok: verifyHash(pass, hash), mustChange: false };
  const legacy = String(getSetting('admin_password', '') || '');
  if (legacy) {
    if (!safeEqual(pass, legacy)) return { ok: false };
    // Migrar a hash y borrar el texto plano
    saveSettings({ admin_password_hash: hashPassword(pass), admin_password: '' });
    return { ok: true, mustChange: String(pass).length < MIN_LENGTH };
  }
  // Sin contraseña configurada: solo credenciales de fábrica y solo desde la red local
  if (!safeEqual(pass, DEFAULT_PASS)) return { ok: false };
  if (!req || !isDirectLan(req)) return { ok: false, reason: 'no_password_remote' };
  return { ok: true, mustChange: true };
}

/** Cambia la contraseña (y opcionalmente el usuario). Valida la actual si ya existe una. */
function change({ current, next, confirm, newUsername }, req) {
  if (hasPassword() || !(req && isDirectLan(req))) {
    const v = verify(username(), current, req);
    if (!v.ok) throw new Error('La contraseña actual no es correcta.');
  }
  const n = String(next || '');
  if (n.length < MIN_LENGTH) throw new Error(`La nueva contraseña debe tener al menos ${MIN_LENGTH} caracteres.`);
  if (n !== String(confirm || '')) throw new Error('La confirmación no coincide.');
  if (n === DEFAULT_PASS || /^(admin|password|12345)/i.test(n)) throw new Error('Elegí una contraseña que no sea de fábrica ni obvia.');
  const out = { admin_password_hash: hashPassword(n), admin_password: '' };
  const u = String(newUsername || '').trim();
  if (u) {
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(u)) throw new Error('El usuario debe tener 3 a 32 caracteres (letras, números, punto, guion).');
    out.admin_username = u;
  }
  saveSettings(out);
  return { username: out.admin_username || username() };
}

module.exports = { verify, change, hasPassword, username, isDirectLan, hashPassword, verifyHash, MIN_LENGTH };
