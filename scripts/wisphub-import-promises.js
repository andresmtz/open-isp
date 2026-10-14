#!/usr/bin/env node
/**
 * Importa las promesas de pago vigentes de WispHub (lista /promesas-de-pago/).
 *   node scripts/wisphub-import-promises.js promesas.json [--apply] [--offset=-05:00]
 * Formato: [{ "factura": "0000671", "creado": "10/10/2026 09:12", "limite": "15/10/2026 18:04", "creado_por": "..." }]
 * --offset: zona horaria en que WispHub muestra las horas (pie de página del panel). Por defecto -05:00.
 */
const fs = require('fs');
const path = require('path');
const file = process.argv[2];
if (!file) { console.error('Uso: node scripts/wisphub-import-promises.js <archivo.json> [--apply] [--offset=-05:00]'); process.exit(1); }
const apply = process.argv.includes('--apply');
const off = (process.argv.find(a => a.startsWith('--offset=')) || '--offset=-05:00').split('=')[1];
const rows = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const r = require('../services/wisphubSyncService').importPromises(rows, { dryRun: !apply, sourceOffset: off });
console.log(`${apply ? 'IMPORTADO' : 'SIMULACIÓN'}:`, JSON.stringify(r, null, 1));
process.exit(0);
