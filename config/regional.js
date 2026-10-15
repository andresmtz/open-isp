/**
 * Configuración regional centralizada: moneda, formato numérico/fecha,
 * prefijo telefónico y zona horaria.
 *
 * Todo se lee de settings.json para que una instalación pueda cambiar de país
 * sin tocar código. Valores por defecto: Paraguay.
 *
 *   locale              'es-PY'            formato de números y fechas (Intl)
 *   currency_code       'PYG'
 *   currency_symbol     'Gs.'
 *   currency_decimals   0
 *   phone_country_code  '595'              sin '+'
 *   phone_trunk_prefix  '0'                prefijo nacional (09xx -> 5959xx)
 *   phone_min_digits    9                  dígitos nacionales sin el prefijo troncal
 *   phone_max_digits    9
 *   timezone            'America/Asuncion'
 */
// Carga diferida: settingsManager también usa este módulo (evita dependencia circular)
function getSetting(key, def) {
  return require('./settingsManager').getSetting(key, def);
}

const DEFAULTS = Object.freeze({
  locale: 'es-PY',
  currency_code: 'PYG',
  currency_symbol: 'Gs.',
  currency_decimals: 0,
  phone_country_code: '595',
  phone_trunk_prefix: '0',
  phone_min_digits: 9,
  phone_max_digits: 9,
  timezone: 'America/Asuncion'
});

function str(key) {
  const v = getSetting(key, DEFAULTS[key]);
  return String(v === undefined || v === null || v === '' ? DEFAULTS[key] : v).trim();
}

function int(key) {
  const n = parseInt(getSetting(key, DEFAULTS[key]), 10);
  return Number.isFinite(n) ? n : DEFAULTS[key];
}

function locale() {
  const loc = str('locale');
  try {
    new Intl.NumberFormat(loc);
    return loc;
  } catch (_) {
    return DEFAULTS.locale;
  }
}

function timezone() {
  const tz = str('timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch (_) {
    return DEFAULTS.timezone;
  }
}

const currencyCode = () => str('currency_code');
const currencySymbol = () => str('currency_symbol');
const currencyDecimals = () => Math.max(0, Math.min(4, int('currency_decimals')));
const phoneCountryCode = () => str('phone_country_code').replace(/\D/g, '');
const phoneTrunkPrefix = () => str('phone_trunk_prefix').replace(/\D/g, '');

/** Número con separador de miles del locale: 150000 -> "150.000" */
function formatNumber(value, decimals = currencyDecimals()) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toLocaleString(locale(), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

/** Monto con símbolo: 150000 -> "Gs. 150.000" (negativos: "-Gs. 150.000") */
function formatMoney(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const body = formatNumber(Math.abs(safe));
  return `${safe < 0 ? '-' : ''}${currencySymbol()} ${body}`;
}

/**
 * Normaliza un teléfono al formato internacional sin '+' (para WhatsApp/gateways).
 *   "0981 123 456"      -> "595981123456"
 *   "+595981123456"     -> "595981123456"
 *   "981123456"         -> "595981123456"
 *   "+55 11 91234 5678" -> "5511912345678"   (número de otro país: se escribe con + o 00)
 *   "5511912345678"     -> "5511912345678"   (ya internacional: más largo que un número local)
 * Devuelve '' si no hay dígitos.
 */
function normalizePhone(input) {
  const raw = String(input || '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  const cc = phoneCountryCode();
  const trunk = phoneTrunkPrefix();
  const explicitIntl = /^(\+|00)/.test(raw);
  if (d.startsWith('00')) d = d.slice(2);
  if (cc && d.startsWith(cc)) return d;
  if (explicitIntl) return d;
  const maxLocal = int('phone_max_digits') + trunk.length;
  if (d.length > maxLocal && d.length >= 11 && d.length <= 15) return d; // ya viene con código de otro país
  if (trunk && d.startsWith(trunk)) d = d.slice(trunk.length);
  return cc + d;
}

/** ¿El número (ya normalizado) es de otro país? */
function isForeignPhone(input) {
  const full = normalizePhone(input);
  const cc = phoneCountryCode();
  return !!(full && cc && !full.startsWith(cc));
}

/** Formato para mostrar/guardar: "595981123456" -> "0981123456"; otro país -> "+5511912345678" */
function toLocalPhone(input) {
  const full = normalizePhone(input);
  if (!full) return '';
  const cc = phoneCountryCode();
  if (cc && !full.startsWith(cc)) return '+' + full;
  const national = cc && full.startsWith(cc) ? full.slice(cc.length) : full;
  return phoneTrunkPrefix() + national;
}

/**
 * Teléfono de contacto que ve el CLIENTE (facturas, PDF, impresiones): WhatsApp de la empresa o teléfono de la empresa.
 * Nunca los "números de administrador para avisos" (son personales, solo para alertas internas).
 */
function publicContactPhone(settings) {
  const s = settings || {};
  const raw = String(s.company_whatsapp || s.company_phone || '').trim();
  return raw ? (toLocalPhone(raw) || raw) : '';
}

/** Variantes equivalentes de un número (para búsquedas en BD / ACS). */
function phoneVariants(input) {
  const full = normalizePhone(input);
  if (!full) return [];
  const local = toLocalPhone(full);
  const cc = phoneCountryCode();
  const national = cc && full.startsWith(cc) ? full.slice(cc.length) : full;
  return Array.from(new Set([full, local, national, '+' + full]));
}

/**
 * Valida el número. Local: longitud nacional (sin prefijo troncal ni código de país).
 * De otro país: debe escribirse con + (o 00) y el código del país; 8 a 15 dígitos en total (norma E.164).
 */
function isValidPhone(input) {
  const raw = String(input || '').trim();
  const full = normalizePhone(raw);
  const cc = phoneCountryCode();
  if (cc && full && !full.startsWith(cc)) {
    const written = /^(\+|00)/.test(raw) || raw.replace(/\D/g, '').length >= 11;
    return written && /^[1-9]\d{7,14}$/.test(full);
  }
  const national = cc && full.startsWith(cc) ? full.slice(cc.length) : full;
  return national.length >= int('phone_min_digits') && national.length <= int('phone_max_digits');
}

/** Mensaje de ayuda para un número inválido. */
function phoneHelp() {
  return `Número de WhatsApp inválido. Local: ${phoneExample()}. De otro país: con + y el código del país, ej. +55 11 91234 5678 (Brasil) o +54 9 11 1234 5678 (Argentina).`;
}

/** Ejemplo de número local para placeholders/mensajes de error. */
function phoneExample() {
  return getSetting('phone_example', '') || `${phoneTrunkPrefix()}981123456`;
}

/** Resuelve marcadores regionales en plantillas de mensajes: {{moneda}} / {{currency}} */
function applyPlaceholders(text) {
  if (text === undefined || text === null) return text;
  return String(text).replace(/\{\{\s*(moneda|currency)\s*\}\}/gi, currencySymbol());
}

/** Valores que se exponen al navegador (window.APP_*). */
function clientConfig() {
  return {
    locale: locale(),
    currencyCode: currencyCode(),
    currencySymbol: currencySymbol(),
    currencyDecimals: currencyDecimals(),
    phoneCountryCode: phoneCountryCode(),
    phoneTrunkPrefix: phoneTrunkPrefix(),
    phoneExample: phoneExample(),
    timezone: timezone()
  };
}

module.exports = {
  publicContactPhone,
  DEFAULTS,
  locale,
  timezone,
  currencyCode,
  currencySymbol,
  currencyDecimals,
  phoneCountryCode,
  phoneTrunkPrefix,
  formatNumber,
  formatMoney,
  normalizePhone,
  toLocalPhone,
  phoneVariants,
  isValidPhone,
  isForeignPhone,
  phoneHelp,
  phoneExample,
  applyPlaceholders,
  clientConfig
};
