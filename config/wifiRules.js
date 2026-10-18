'use strict';
/**
 * Reglas únicas para el nombre (SSID) y la clave del WiFi del cliente.
 * Las usan todos los caminos: portal del cliente, técnicos, oficina, instalación, OLT (telnet) y ACS (TR-069).
 *
 *  - Sin espacios ni caracteres especiales: la consola de la OLT corta en el espacio y algunos signos
 *    ("?", comillas, "#", ">") tienen otro significado; además, los signos y acentos dan problemas al
 *    conectar algunos equipos y al dictar la clave por teléfono.
 *  - Permitido: letras sin acento (A-Z, a-z), números, punto (.), guion (-) y guion bajo (_).
 *    (el punto se usa en los nombres de siempre, p. ej. "Flia.Castillo")
 *  - Nombre: 1 a 28 caracteres (la red de 5 GHz se llama igual + "-5G", máximo 32).
 *  - Clave: 8 a 63 caracteres (límite del estándar WPA2).
 */
const NAME_RE = /^[A-Za-z0-9._-]{1,28}$/;
const KEY_RE = /^[A-Za-z0-9._-]{8,63}$/;

const NAME_HINT = 'De 1 a 28 caracteres, sin espacios, acentos ni ñ: solo letras, números, punto (.), guion (-) o guion bajo (_).';
const KEY_HINT = 'De 8 a 63 caracteres, sin espacios, acentos ni ñ: solo letras, números, punto (.), guion (-) o guion bajo (_).';
const NAME_MSG = 'El nombre del WiFi no es válido. ' + NAME_HINT;
const KEY_MSG = 'La clave del WiFi no es válida. ' + KEY_HINT;

const validName = (v) => NAME_RE.test(String(v == null ? '' : v));
const validKey = (v) => KEY_RE.test(String(v == null ? '' : v));
/** null si es válido; si no, el mensaje para mostrar. */
const checkName = (v) => (validName(v) ? null : NAME_MSG);
const checkKey = (v) => (validKey(v) ? null : KEY_MSG);
/** Nombre de la red 5G: igual que el de 2.4 + "-5G" (también se acepta un nombre válido sin el sufijo). */
const validName5 = (v) => { const t = String(v == null ? '' : v); return validName(t) || (/-5G$/i.test(t) && validName(t.slice(0, -3))); };
/** Campos opcionales de WiFi (vacío = no se cambia). Devuelve null o el mensaje. */
function checkOptional({ ssid24, pass24, ssid5, pass5 } = {}) {
  const t = (v) => String(v == null ? '' : v).trim();
  if (t(ssid24) && !validName(t(ssid24))) return NAME_MSG;
  if (t(ssid5) && !validName5(t(ssid5))) return NAME_MSG;
  if (t(pass24) && !validKey(t(pass24))) return KEY_MSG;
  if (t(pass5) && !validKey(t(pass5))) return KEY_MSG;
  return null;
}

module.exports = { NAME_RE, KEY_RE, NAME_HINT, KEY_HINT, NAME_MSG, KEY_MSG, validName, validName5, validKey, checkName, checkKey, checkOptional,
  // patrones para el atributo pattern de los formularios
  NAME_PATTERN: '[A-Za-z0-9._\\-]{1,28}', KEY_PATTERN: '[A-Za-z0-9._\\-]{8,63}' };
