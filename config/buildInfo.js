'use strict';
/**
 * Versión del sistema: la genera scripts/deploy.sh al publicar (build-info.json, fuera de git).
 *   build    número de versión (cantidad de cambios publicados; sube con cada cambio)
 *   commit   identificador corto del cambio
 *   date     fecha y hora del último cambio
 *   deployedAt fecha y hora de la publicación
 *   changes  últimos cambios [{ h, date, subject }]
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'build-info.json');
let _cache = null;
function get() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { _cache = { build: null, commit: '', date: null, changes: [] }; }
  return _cache;
}
/** Texto corto: "v240 · 17/10/2026 23:56" */
function label() {
  const b = get();
  if (!b.build) return '';
  const d = b.date ? new Date(b.date) : null;
  const f = d && !isNaN(d) ? d.toLocaleString('es-PY', { timeZone: 'America/Asuncion', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') : '';
  return `v${b.build}${f ? ' · ' + f : ''}`;
}
module.exports = { get, label };
