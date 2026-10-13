#!/usr/bin/env node
/**
 * Importa clientes y facturas exportados desde la web de WispHub (sin API).
 *   node scripts/wisphub-import-file.js export.json           (simulación)
 *   node scripts/wisphub-import-file.js export.json --apply   (escribe)
 * Formato: { clients: [...filas de /clientes/json/], invoices: [...filas de /facturas/json/] }
 * Nunca toca el MikroTik.
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('Uso: node scripts/wisphub-import-file.js <export.json> [--apply]'); process.exit(1); }
const apply = process.argv.includes('--apply');
const source = JSON.parse(fs.readFileSync(file, 'utf8'));
require('../services/wisphubSyncService').run({ dryRun: !apply, source })
  .then(r => { console.log(JSON.stringify({ modo: apply ? 'IMPORTADO' : 'SIMULACIÓN', summary: r.summary, plans: r.plans, customers: r.customers, invoices: r.invoices, warnings: r.warnings }, null, 1)); process.exit(0); })
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
