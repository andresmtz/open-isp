'use strict';
/**
 * Nombre de cuenta del cliente (convención de la empresa): un mismo valor para
 *   - usuario PPPoE (y clave PPPoE, si pppoe_password_mode = 'same_as_user'),
 *   - descripción de la ONU en la OLT,
 *   - nombre del WiFi (2.4) y nombre + "-5G".
 * Formato: PrimerNombre + PrimerApellido, sin acentos ni espacios (ej. "YolandaLesme").
 * Si ya existe: PrimerNombre + SegundoApellido; después ambos apellidos; después un número.
 * Con 4 o más palabras los apellidos son las dos últimas; con 3 palabras se prueba primero la última
 * (ej. "Carmen Beatriz Benitez" → CarmenBenitez). Siempre se puede corregir al aprobar.
 *
 * Parámetros: pppoe_username_pattern ('first_last' | 'name' | 'customer_code'),
 *             pppoe_password_mode ('same_as_user' | 'random' | 'fixed' con pppoe_default_password).
 */
const db = require('./database');
const { getSetting } = require('./settingsManager');

const VALID = /^[A-Za-z0-9._-]{3,40}$/;

function words(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/gi, 'n')
    .replace(/[^A-Za-z\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function candidates(name) {
  const w = words(name);
  if (!w.length) return ['Cliente'];
  const given = w[0];
  if (w.length === 1) return [given];
  if (w.length === 2) return [given + w[1]];
  const s1 = w.length >= 4 ? w[w.length - 2] : w[2];
  const s2 = w.length >= 4 ? w[w.length - 1] : w[1];
  return [...new Set([given + s1, given + s2, given + s1 + s2])];
}

/** ¿El nombre ya lo usa otro cliente (usuario PPPoE) o figura en el MikroTik? (sin distinguir mayúsculas) */
function isTaken(name, { exceptCustomerId = null, mikrotikNames = null } = {}) {
  const n = String(name || '').toLowerCase();
  const r = db.prepare('SELECT id FROM customers WHERE LOWER(pppoe_username)=? AND id IS NOT ?').get(n, exceptCustomerId);
  if (r) return true;
  // nombres reservados por otras instalaciones asignadas (todavía sin usuario PPPoE)
  try {
    const q = db.prepare("SELECT id FROM customers WHERE LOWER(reg_account)=? AND id IS NOT ? AND status='inactive' AND reg_status='approved'").get(n, exceptCustomerId);
    if (q) return true;
  } catch (_) { /* columna todavía no creada */ }
  if (mikrotikNames && mikrotikNames.has(n)) return true;
  return false;
}

async function mikrotikSecretNames(routerId) {
  try {
    const { api } = await require('../services/mikrotikService').getConnection(routerId || null);
    try { return new Set((await api.send(['/ppp/secret/print'])).map(s => String(s.name || '').toLowerCase())); }
    finally { try { api.close(); } catch (_) {} }
  } catch (_) { return null; }
}

/** Propuesta de nombre de cuenta libre. */
async function suggest(customer) {
  const mk = await mikrotikSecretNames(customer && customer.router_id);
  const opts = { exceptCustomerId: customer ? customer.id : null, mikrotikNames: mk };
  const cands = candidates(customer && customer.name);
  for (const c of cands) if (!isTaken(c, opts)) return { name: c, candidates: cands, mikrotikChecked: !!mk };
  for (let i = 2; i < 100; i++) { const c = cands[0] + i; if (!isTaken(c, opts)) return { name: c, candidates: cands, mikrotikChecked: !!mk }; }
  throw new Error('No se pudo proponer un nombre de cuenta libre');
}

function passwordFor(username) {
  const mode = String(getSetting('pppoe_password_mode', 'random') || 'random');
  if (mode === 'same_as_user') return username;
  const fixed = String(getSetting('pppoe_default_password', '') || '').trim();
  if (mode === 'fixed' && fixed) return fixed;
  return require('crypto').randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).padEnd(8, '7');
}

module.exports = { VALID, words, candidates, isTaken, mikrotikSecretNames, suggest, passwordFor };
