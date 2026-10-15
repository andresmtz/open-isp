'use strict';
/**
 * Fotos y documentos del cliente: cédula (frente/dorso), casa (fachada) y otros.
 *
 * Privacidad:
 *  - Los archivos NO están en la carpeta pública: se guardan en database/documents/<cliente>/ (volumen
 *    persistente) y solo se sirven por rutas con sesión y permiso.
 *  - Cédula y "otros": solo administrador y personal de oficina con permiso "Ver clientes".
 *  - Casa: además, el técnico que tiene asignada una orden de ese cliente (nunca la cédula).
 * Las fotos se reducen (máx. 1600 px, JPEG) y se les quitan los metadatos (ubicación del celular, etc.).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/database');
const { logger } = require('../config/logger');

const ROOT = path.join(__dirname, '..', 'database', 'documents');
const KINDS = { cedula: 'Cédula', casa: 'Casa', etiqueta: 'Etiqueta de la ONU', otro: 'Otro' };
const MAX_PER_KIND = 6;

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS customer_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, kind TEXT NOT NULL,
    file TEXT NOT NULL, size INTEGER, uploaded_by TEXT, created_at TEXT DEFAULT (NOW_LOCAL()))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_customer_documents_c ON customer_documents(customer_id)');
  _schemaOk = true;
}

/** Guarda una imagen subida (buffer). Devuelve la fila creada. */
async function add(customerId, kind, buffer, uploadedBy) {
  ensureSchema();
  const k = KINDS[kind] ? kind : 'otro';
  const cid = Number(customerId);
  if (!db.prepare('SELECT 1 FROM customers WHERE id=?').get(cid)) throw new Error('Cliente no encontrado');
  const n = db.prepare('SELECT COUNT(*) n FROM customer_documents WHERE customer_id=? AND kind=?').get(cid, k).n;
  if (n >= MAX_PER_KIND) throw new Error(`Ya hay ${MAX_PER_KIND} fotos de tipo ${KINDS[k]}; borrá alguna antes de agregar otra.`);
  let out;
  try {
    out = await require('sharp')(buffer).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch (e) { throw new Error('El archivo no es una imagen válida.'); }
  const dir = path.join(ROOT, String(cid));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${k}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(dir, name), out);
  const r = db.prepare('INSERT INTO customer_documents (customer_id, kind, file, size, uploaded_by) VALUES (?,?,?,?,?)').run(cid, k, name, out.length, String(uploadedBy || '').slice(0, 80));
  logger.info(`[Documentos] ${KINDS[k]} agregada al cliente ${cid} por ${uploadedBy || '-'}`);
  return get(r.lastInsertRowid);
}

function get(id) { ensureSchema(); return db.prepare('SELECT * FROM customer_documents WHERE id=?').get(Number(id)) || null; }

function list(customerId, { kinds } = {}) {
  ensureSchema();
  const rows = db.prepare('SELECT * FROM customer_documents WHERE customer_id=? ORDER BY kind, id').all(Number(customerId));
  return kinds ? rows.filter(r => kinds.includes(r.kind)) : rows;
}

function filePath(doc) {
  const p = path.join(ROOT, String(doc.customer_id), path.basename(doc.file));
  return fs.existsSync(p) ? p : null;
}

function remove(id, by) {
  const d = get(id);
  if (!d) return false;
  const p = filePath(d);
  if (p) { try { fs.unlinkSync(p); } catch (_) {} }
  db.prepare('DELETE FROM customer_documents WHERE id=?').run(d.id);
  logger.info(`[Documentos] ${KINDS[d.kind] || d.kind} del cliente ${d.customer_id} eliminada por ${by || '-'}`);
  return true;
}

/** ¿El técnico tiene una orden (abierta o en curso) de ese cliente? */
function techHasCustomer(techId, customerId) {
  return !!db.prepare("SELECT 1 FROM tickets WHERE technician_id=? AND customer_id=? AND status IN ('open','in_progress') LIMIT 1").get(Number(techId), Number(customerId));
}

module.exports = { KINDS, ensureSchema, add, get, list, filePath, remove, techHasCustomer };
