#!/usr/bin/env node
/**
 * Importa las promesas de pago vigentes de WispHub (lista /promesas-de-pago/).
 *   node scripts/wisphub-import-promises.js promesas.json [--apply] [--offset=-05:00]
 * Formato: [{ "factura": "0000671", "creado": "10/10/2026 09:12", "limite": "15/10/2026 18:04", "creado_por": "..." }]
 * Las horas se toman como hora local del sistema (Paraguay). --offset=-05:00 solo para convertir desde otra zona.
 */
const fs = require('fs');
const path = require('path');
const file = process.argv[2];
if (!file) { console.error('Uso: node scripts/wisphub-import-promises.js <archivo.json> [--apply] [--offset=±HH:MM]'); process.exit(1); }
const apply = process.argv.includes('--apply');
const offArg = process.argv.find(a => a.startsWith('--offset='));
const off = offArg ? offArg.split('=')[1] : null;
const rows = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const r = require('../services/wisphubSyncService').importPromises(rows, { dryRun: !apply, sourceOffset: off });
console.log(`${apply ? 'IMPORTADO' : 'SIMULACIÓN'}:`, JSON.stringify(r, null, 1));
process.exit(0);
