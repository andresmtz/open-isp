const fs = require('fs');
const path = require('path');

const SUPPORTED_LANGS = new Set(['es', 'en', 'id']);
const FALLBACK_LANG = 'es';
// Si falta una clave en el idioma elegido: se busca en este orden
const FALLBACK_CHAIN = ['es', 'en', 'id'];

function loadLocale(lang) {
  try {
    const filePath = path.join(__dirname, `../locales/${lang}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

const dictionaries = {
  es: loadLocale('es'),
  en: loadLocale('en'),
  id: loadLocale('id')
};

function normalizeLang(input) {
  const lang = String(input || '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(lang) ? lang : FALLBACK_LANG;
}

function getNestedValue(obj, keyPath) {
  const keys = String(keyPath || '').split('.');
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function t(lang, key, fallback = '') {
  const useLang = normalizeLang(lang);
  const fromLang = getNestedValue(dictionaries[useLang], key);
  if (fromLang !== undefined) return fromLang;
  for (const fb of FALLBACK_CHAIN) {
    if (fb === useLang) continue;
    const v = getNestedValue(dictionaries[fb], key);
    if (v !== undefined) return v;
  }
  return fallback || key;
}

module.exports = {
  SUPPORTED_LANGS,
  FALLBACK_LANG,
  normalizeLang,
  t
};
