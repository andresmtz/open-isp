#!/usr/bin/env node
/**
 * Importa el historial de consumo diario exportado de WispHub.
 *   node scripts/wisphub-import-traffic.js trafico.json            (simulación)
 *   node scripts/wisphub-import-traffic.js trafico.json --apply    (escribe)
 * Formato: { "<id_servicio>": [["DD/MM/AAAA", descarga_MiB, subida_MiB], ...] }
 * Requiere que los clientes ya estén sincronizados (customers.wisphub_id).
 */
const fs = require('fs');
const path = require('path');
const file = process.argv[2];
if (!file) { console.error('Uso: node scripts/wisphub-import-traffic.js <archivo.json> [--apply]'); process.exit(1); }
const apply = process.argv.includes('--apply');
const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const r = require('../services/wisphubSyncService').importTraffic(data, { dryRun: !apply });
console.log(`${apply ? 'IMPORTADO' : 'SIMULACIÓN'}:`, JSON.stringify(r));
process.exit(0);
