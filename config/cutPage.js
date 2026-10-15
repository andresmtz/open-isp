'use strict';
/**
 * Textos de la pantalla de corte (/isolated), editables en Configuración → Pagos y pantalla de corte.
 * Variables: {{nombre}} cliente · {{id}} ID de cliente · {{plan}} plan · {{deuda}} total adeudado · {{empresa}} empresa.
 */
const DEFAULTS = {
  corte_tag: 'CORTE ADMINISTRATIVO',
  corte_title: 'Servicio suspendido',
  corte_message: 'Tu servicio de internet fue suspendido por falta de pago. Se habilita nuevamente al registrarse el pago.',
  corte_show_debt: true,
  corte_whatsapp_button: 'Enviar comprobante por WhatsApp',
  corte_whatsapp_text: 'Hola {{empresa}}, quiero regularizar mi servicio ({{nombre}}, ID {{id}}).',
  corte_footer: 'Si ya pagaste, enviá el comprobante. Cuando se registre el pago, esta página se actualiza sola.',
  corte_active_message: 'Tu servicio está habilitado. Si todavía no navegás, reiniciá tu equipo (router/ONU) y volvé a abrir el navegador.',
};

function texts(settings) {
  const s = settings || {};
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = s[k];
    if (typeof def === 'boolean') out[k] = v === undefined || v === '' ? def : !(v === false || v === 'false');
    else out[k] = (typeof v === 'string' && v.trim()) ? v.replace(/\r/g, '') : def;
  }
  return out;
}

function fill(text, vars) {
  return String(text || '').replace(/{{\s*(nombre|id|plan|deuda|empresa)\s*}}/gi, (_, k) => String((vars || {})[k.toLowerCase()] ?? ''));
}

module.exports = { DEFAULTS, texts, fill };
