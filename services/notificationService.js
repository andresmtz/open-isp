'use strict';
/**
 * Avisos de la campana de la barra superior: lo que hay para revisar ahora.
 *
 * Cada aviso sale del estado actual (no es una lista de mensajes guardados): cuando se resuelve, desaparece solo.
 * Solo se muestran los de las secciones que la persona puede ver (mismo menú y permisos), y los del sistema
 * (WhatsApp desconectado, copias atrasadas) solo al administrador.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

const n = (sql, ...a) => { try { return Number((db.prepare(sql).get(...a) || {}).c || 0); } catch (_) { return 0; } };
const plural = (k, one, many) => k + ' ' + (k === 1 ? one : many);

/**
 * @param session  sesión del panel
 * @param canSee   (clave del menú) => boolean
 */
async function forSession(session, canSee) {
  const items = [];
  const add = (it) => { if (it.count > 0) items.push(it); };

  if (canSee('conversations')) {
    try {
      const c = require('./conversationOrgService').list({ inbox: 'por_atender', admin: !!session.isAdmin }).counts || {};
      const unread = Number(c.unreadTotal || 0), waiting = Number(c.por_atender || 0);
      if (unread || waiting) items.push({ key: 'chats', icon: 'bi bi-whatsapp', tone: unread ? 'info' : 'muted', count: unread,
        title: unread ? plural(unread, 'chat con mensajes sin leer', 'chats con mensajes sin leer') : 'Chats por atender',
        detail: waiting ? plural(waiting, 'esperando respuesta', 'esperando respuesta') : '', href: '/admin/conversations' });
    } catch (e) { logger.warn('[Avisos] chats: ' + e.message); }
  }

  if (canSee('pending_payments')) {
    let k = 0; try { k = require('./paymentProofService').pending().length; } catch (_) {}
    add({ key: 'proofs', icon: 'bi bi-receipt', tone: 'warn', count: k, title: plural(k, 'comprobante de pago para verificar', 'comprobantes de pago para verificar'),
      detail: 'Llegaron por WhatsApp', href: '/admin/pending-payments' });
  }

  if (canSee('outages')) {
    const mass = n("SELECT COUNT(*) c FROM mass_outages WHERE state='abierta'");
    add({ key: 'mass', icon: 'bi bi-broadcast', tone: 'danger', count: mass, title: plural(mass, 'caída general activa', 'caídas generales activas'),
      detail: 'Varios clientes del mismo puerto PON', href: '/admin/outages' });
    let st = []; try { st = require('./outageService').OPEN_STATES; } catch (_) {}
    const down = st.length ? n(`SELECT COUNT(*) c FROM onu_outages WHERE state IN (${st.map(() => '?').join(',')})`, ...st) : 0;
    add({ key: 'down', icon: 'bi bi-wifi-off', tone: 'warn', count: down, title: plural(down, 'equipo caído en seguimiento', 'equipos caídos en seguimiento'),
      detail: '', href: '/admin/outages' });
  }

  if (canSee('tickets')) {
    const t = n("SELECT COUNT(*) c FROM tickets WHERE status='open' AND (technician_id IS NULL OR technician_id='')");
    add({ key: 'tickets', icon: 'bi bi-headset', tone: 'warn', count: t, title: plural(t, 'reclamo sin técnico asignado', 'reclamos sin técnico asignado'),
      detail: '', href: '/admin/tickets' });
  }

  if (session.isAdmin) {
    try {
      const wa = require('./waNotifyService');
      if (require('../config/settingsManager').getSetting('whatsapp_enabled', false) && !(await wa.isConnected()))
        items.push({ key: 'wa', icon: 'bi bi-exclamation-octagon', tone: 'danger', count: 1, title: 'WhatsApp desconectado',
          detail: 'No salen ni entran mensajes', href: '/admin/whatsapp' });
    } catch (_) {}
    const late = n('SELECT COUNT(*) c FROM backup_watch WHERE alerted=1');
    add({ key: 'backup', icon: 'bi bi-hdd-network', tone: 'danger', count: late, title: plural(late, 'copia de seguridad atrasada', 'copias de seguridad atrasadas'),
      detail: 'Revisá el servidor de copias', href: '' });
  }

  return { total: items.reduce((t, i) => t + (i.count || 0), 0), items };
}

module.exports = { forSession };
