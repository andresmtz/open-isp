// Lokasi file settings.json — dapat diarahkan via env SETTINGS_PATH
// (dipakai agar settings bisa disimpan di direktori yang di-mount / persisten).
const path = require('path');
const settingsPath = process.env.SETTINGS_PATH
  ? path.resolve(process.env.SETTINGS_PATH)
  : path.join(__dirname, '..', 'settings.json');
module.exports = { settingsPath };
