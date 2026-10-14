'use strict';
/**
 * Plantillas predeterminadas de WhatsApp (español).
 *
 * Se guardan en app_settings al arrancar SOLO si la clave todavía no existe,
 * así todas las partes del sistema que hacen db.getAppSetting('whatsapp_...')
 * usan estos textos, y lo que el administrador edite en el panel se respeta.
 *
 * Variables disponibles (se mantienen los nombres originales del sistema):
 *   {{nama}} nombre · {{id_pelanggan}} ID de cliente · {{paket}} plan
 *   {{tagihan}} / {{total}} monto · {{moneda}} símbolo de moneda
 *   {{rincian}} / {{periode}} período · {{link}} enlace al portal
 *   {{company}} empresa · {{company_phone}} teléfono de la empresa
 *   {{bulan_nunggak}} meses adeudados · {{batas}} límite de meses
 *   {{no_invoice}} N.º de factura · {{waktu}} fecha/hora · {{metode}} forma de pago
 *   {{penerima}} cobrado por · {{pago}} formas de pago (Configuración del ciclo → Pantalla de corte)
 * Texto alternativo al azar: {Hola|Buenas} elige una opción en cada envío.
 */

const TEMPLATES = {
  whatsapp_auto_billing_message:
`{Hola|Buenas}, *{{nama}}* 👋

Le recordamos que tiene una factura de internet pendiente:

📦 *Plan:* {{paket}}
💰 *Monto:* {{moneda}} {{tagihan}}
📅 *Período:* {{rincian}}

Por favor, regularice su pago antes de la fecha de corte para evitar la suspensión del servicio.
Puede consultar su factura aquí: {{link}}

Si ya realizó el pago, ignore este mensaje.
¡Gracias!
— {{company}}`,

  whatsapp_billing_qris_message:
`{Hola|Buenas}, *{{nama}}* 👋

Le enviamos el detalle de su factura:

📦 *Plan:* {{paket}}
📅 *Período:* {{periode}}
💰 *Monto:* {{moneda}} {{qris_nominal}}

{{qris_qr}}

¡Gracias!
— {{company}}`,

  whatsapp_payment_success_message:
`🧾 *COMPROBANTE DE PAGO*
🏢 *{{company}}*
────────────────────────────
Estimado/a *{{nama}}*,

Recibimos y registramos su pago. ¡Muchas gracias!

📋 *Detalle del pago:*
• *Factura N.º:* {{no_invoice}}
• *ID de cliente:* {{id_pelanggan}}
• *Plan:* {{paket}}
• *Período:* {{periode}}
• *Fecha:* {{waktu}}
• *Forma de pago:* {{metode}}
• *Cobrado por:* {{penerima}}
• *Total pagado:* *{{moneda}} {{total}}*
• *Estado:* *PAGADO ✅*
{{tunggakan_info}}
📄 *Factura (PDF):* {{link_pdf}}
🔗 *Consultar facturas:* {{link_portal}}
📞 *Atención al cliente:* {{cs_phone}}

Conserve este mensaje como comprobante de pago.
— {{company}}`,

  whatsapp_isolir_message:
`{Hola|Buenas}, *{{nama}}*

Le informamos que su servicio de internet fue *suspendido* porque tiene facturas pendientes:

• ID de cliente: *{{id_pelanggan}}*
• Plan: {{paket}}
• Total adeudado: *{{moneda}} {{tagihan}}*

Al registrar su pago, el servicio se rehabilita automáticamente.
Detalle de su deuda: {{link}}

Si ya pagó o necesita ayuda, responda a este mensaje.
— {{company}}`,

  whatsapp_arrears_warning_message:
`*Aviso de deuda*

Estimado/a *{{nama}}* (ID: {{id_pelanggan}}),

Le informamos que su servicio de internet registra *{{bulan_nunggak}} mes(es)* sin pagar.

📦 Plan: {{paket}}
💰 Total adeudado: {{moneda}} {{tagihan}}
📅 Período: {{rincian}}

Si la deuda llega a {{batas}} meses, el servicio será dado de baja y para volver a conectarse deberá solicitar una nueva instalación.

Detalle de su deuda: {{link}}
Ante cualquier consulta, estamos a su disposición.
— {{company}}`,

  whatsapp_cut_debt_message:
`{Hola|Buenas}, *{{nama}}* 👋

Le recordamos que su servicio de internet sigue *suspendido* por una deuda pendiente:

💰 *Total adeudado:* {{moneda}} {{tagihan}}
📅 *Períodos:* {{rincian}}

*Formas de pago:*
{{pago}}

Al registrar su pago, el servicio se rehabilita. Si ya pagó, envíenos el comprobante por este medio.
— {{company}}`,

  whatsapp_autolunas_message:
`✅ *Factura saldada*

Estimado/a *{{nama}}* (ID: {{id_pelanggan}}),

Su factura del período {{rincian}} quedó registrada como *PAGADA*.

💵 Monto: *{{moneda}} {{tagihan}}*

¡Gracias!
— {{company}}`,

  whatsapp_deactivated_message:
`⚠️ *Servicio dado de baja*

Estimado/a *{{nama}}* (ID: {{id_pelanggan}}),

Su servicio de internet fue *dado de baja* por registrar *{{bulan_nunggak}} meses* sin pagar.

💵 Total adeudado: *{{moneda}} {{tagihan}}*

Para regularizar su situación, comuníquese con nosotros.
Detalle de su deuda: {{link}}
— {{company}}`,

  whatsapp_deleted_message:
`Estimado/a *{{nama}}*,

Su cuenta de internet fue *eliminada* por registrar *{{bulan_nunggak}} meses* sin pagar.

Si desea volver a contratar el servicio, deberá solicitar una nueva instalación.
— {{company}}`
};

/** Nombres de las plantillas para mostrar en el panel. */
const LABELS = {
  whatsapp_auto_billing_message: 'Recordatorio de pago',
  whatsapp_billing_qris_message: 'Factura con QR',
  whatsapp_payment_success_message: 'Comprobante de pago',
  whatsapp_isolir_message: 'Aviso de corte',
  whatsapp_cut_debt_message: 'Aviso de deuda a cortados (periódico)',
  whatsapp_arrears_warning_message: 'Aviso de deuda',
  whatsapp_autolunas_message: 'Factura saldada automáticamente',
  whatsapp_deactivated_message: 'Baja por deuda',
  whatsapp_deleted_message: 'Eliminación por deuda'
};

function getDefault(key) {
  return TEMPLATES[key] || '';
}

/** Guarda en la base las plantillas que todavía no existen. Devuelve las claves creadas. */
function seedDefaults(db) {
  const created = [];
  for (const [key, text] of Object.entries(TEMPLATES)) {
    try {
      const row = db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(key);
      if (!row) {
        db.saveAppSetting(key, text);
        created.push(key);
      }
    } catch (_) { /* tabla aún no creada: se reintenta en el próximo arranque */ }
  }
  return created;
}

module.exports = { TEMPLATES, LABELS, getDefault, seedDefaults };
