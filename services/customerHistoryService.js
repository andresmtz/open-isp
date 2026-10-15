'use strict';
/**
 * Historial del cliente (ficha → Historial): línea de tiempo con todo lo que le pasó.
 *
 * Fuentes: alta, facturas, pagos (cobros y facturas pagadas), anulaciones, promesas de pago, cambios de estado
 * y de plan (tabla customer_events, la llena un disparador de la base: cubre cortes automáticos, pagos,
 * promesas y cambios manuales), cambios de WiFi, activación de TR-069, órdenes de trabajo y reclamos,
 * mensajes de WhatsApp y acciones registradas en la auditoría.
 * Sin el permiso de ver montos, los importes se ocultan.
 */
const db = require('../config/database');
const regional = require('../config/regional');

let _schemaOk = false;
function ensureSchema() {
  if (_schemaOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS customer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, created_at TEXT DEFAULT (NOW_LOCAL()),
      type TEXT NOT NULL, old_value TEXT, new_value TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_customer_events_c ON customer_events(customer_id, created_at)');
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_customer_status_log AFTER UPDATE OF status ON customers
      WHEN COALESCE(OLD.status,'') != COALESCE(NEW.status,'')
      BEGIN INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (NEW.id, 'status', OLD.status, NEW.status); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_customer_plan_log AFTER UPDATE OF package_id ON customers
      WHEN COALESCE(OLD.package_id,0) != COALESCE(NEW.package_id,0)
      BEGIN INSERT INTO customer_events (customer_id, type, old_value, new_value) VALUES (NEW.id, 'plan', OLD.package_id, NEW.package_id); END`);
  _schemaOk = true;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const per = (m, y) => `${MESES[(Number(m) || 1) - 1]} ${y}`;
const STATUS = { active: 'Activo', suspended: 'Cortado', ditangguhkan: 'Habilitado con promesa', inactive: 'Inscripto (pendiente de instalación)', cancelled: 'Dado de baja', isolated: 'Cortado' };
const st = (s) => STATUS[String(s || '')] || String(s || '-');

function safe(fn) { try { return fn(); } catch (_) { return []; } }
function tableExists(name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }

/**
 * @returns {Array<{at:string, kind:string, icon:string, title:string, detail?:string, by?:string}>} del más reciente al más antiguo
 */
function timeline(customerId, { money = true, limit = 300 } = {}) {
  ensureSchema();
  const id = Number(customerId);
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) throw new Error('Cliente no encontrado');
  const fm = (n) => (money ? regional.formatMoney(Number(n) || 0) : '');
  const out = [];
  const push = (e) => { if (e && e.at) out.push(e); };

  // Alta
  push({ at: String(c.created_at || ''), kind: 'alta', icon: 'person-plus', title: c.status === 'inactive' ? 'Solicitud de instalación cargada' : 'Cliente dado de alta', detail: c.notes ? String(c.notes).slice(0, 160) : '' });
  if (c.install_date) push({ at: `${String(c.install_date).slice(0, 10)} 12:00`, kind: 'alta', icon: 'tools', title: 'Fecha de instalación' });

  // Facturas
  safe(() => db.prepare('SELECT * FROM invoices WHERE customer_id=?').all(id)).forEach(i => {
    const wh = /WispHub/i.test(i.notes || '');
    const at = wh ? `${i.period_year}-${String(i.period_month).padStart(2, '0')}-01 00:00` : String(i.created_at || '');
    push({ at, kind: 'factura', icon: 'receipt', title: `Factura de ${per(i.period_month, i.period_year)}` + (money ? ` — ${fm(i.amount)}` : ''),
      detail: [wh ? 'importada de WispHub' : '', i.status === 'void' ? 'anulada' : '', i.notes && !wh ? String(i.notes).slice(0, 160) : ''].filter(Boolean).join(' · ') });
  });

  // Pagos: cobros registrados + facturas pagadas sin cobro asociado (históricas)
  const covered = new Set();
  if (tableExists('payment_receipts')) {
    safe(() => db.prepare('SELECT * FROM payment_receipts WHERE customer_id=?').all(id)).forEach(r => {
      const allocs = safe(() => db.prepare('SELECT a.invoice_id, a.amount, i.period_month, i.period_year FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE a.receipt_id=?').all(r.id));
      allocs.forEach(a => covered.add(a.invoice_id));
      const what = allocs.length ? allocs.map(a => per(a.period_month, a.period_year)).join(', ') : (Number(r.credit_added) ? 'saldo a favor' : '');
      push({ at: String(r.created_at || ''), kind: 'pago', icon: 'cash-coin', title: 'Pago registrado' + (money ? ` — ${fm(r.amount)}` : ''),
        detail: [what, r.method, r.note].filter(Boolean).join(' · '), by: r.paid_by || '' });
      if (r.annulled_at) push({ at: String(r.annulled_at), kind: 'anulacion', icon: 'x-octagon', title: 'Pago anulado' + (money ? ` — ${fm(r.amount)}` : ''), detail: r.annul_reason || '', by: r.annulled_by || '' });
    });
  }
  safe(() => db.prepare("SELECT * FROM invoices WHERE customer_id=? AND status='paid' AND paid_at IS NOT NULL").all(id)).forEach(i => {
    if (covered.has(i.id)) return;
    const m = /Forma de pago:\s*([^|]+)/i.exec(i.notes || '');
    push({ at: String(i.paid_at), kind: 'pago', icon: 'cash-coin', title: `Pago de ${per(i.period_month, i.period_year)}` + (money ? ` — ${fm(i.amount_paid || i.amount)}` : ''),
      detail: [i.payment_method || (m ? m[1].trim() : ''), /WispHub/i.test(i.notes || '') ? 'registrado en WispHub' : ''].filter(Boolean).join(' · '), by: i.paid_by_name || '' });
  });

  // Promesas de pago
  safe(() => db.prepare('SELECT * FROM payment_promises WHERE customer_id=?').all(id)).forEach(p => {
    push({ at: String(p.created_at || ''), kind: 'promesa', icon: 'hand-thumbs-up', title: `Promesa de pago hasta ${String(p.until || '').slice(0, 16).replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1')}`,
      detail: [money && p.debt_amount ? `deuda ${fm(p.debt_amount)}` : '', p.note].filter(Boolean).join(' · '), by: p.created_by || '' });
    if (p.closed_at) push({ at: String(p.closed_at), kind: 'promesa', icon: 'hand-thumbs-up', title: p.status === 'kept' ? 'Promesa cumplida (pagó a tiempo)' : (p.status === 'broken' ? 'Promesa vencida sin pago' : `Promesa cerrada (${p.status})`) });
  });

  // Estado y plan (disparador)
  const pkgName = (pid) => { const r = pid ? db.prepare('SELECT name FROM packages WHERE id=?').get(pid) : null; return r ? r.name : (pid ? `#${pid}` : 'sin plan'); };
  safe(() => db.prepare('SELECT * FROM customer_events WHERE customer_id=?').all(id)).forEach(e => {
    if (e.type === 'status') {
      const n = String(e.new_value || '');
      const icon = n === 'suspended' ? 'slash-circle' : (n === 'active' ? 'check-circle' : 'arrow-left-right');
      const title = n === 'suspended' ? 'Servicio cortado' : (n === 'active' && ['suspended', 'ditangguhkan'].includes(String(e.old_value)) ? 'Servicio rehabilitado' : `Estado: ${st(e.old_value)} → ${st(n)}`);
      push({ at: String(e.created_at), kind: 'estado', icon, title });
    } else if (e.type === 'plan') {
      push({ at: String(e.created_at), kind: 'plan', icon: 'box-seam', title: `Cambio de plan: ${pkgName(e.old_value)} → ${pkgName(e.new_value)}` });
    }
  });

  // WiFi y TR-069
  safe(() => db.prepare('SELECT * FROM wifi_changes WHERE customer_id=?').all(id)).forEach(w => push({ at: String(w.created_at), kind: 'wifi', icon: 'wifi',
    title: w.status === 'ok' ? `WiFi cambiado: ${w.ssid_name} / ${w.ssid_name}-5G` : `Cambio de WiFi ${w.status === 'failed' ? 'fallido' : 'en curso'}`,
    detail: w.status === 'failed' ? `${w.step || ''} ${w.error || ''}`.trim() : '', by: w.by_type === 'customer' ? 'el cliente (portal)' : (w.by_name || '') }));
  safe(() => db.prepare("SELECT * FROM tr069_rollout WHERE customer_id=? AND status IN ('ok','failed')").all(id)).forEach(t => push({ at: String(t.finished_at || t.started_at || t.created_at),
    kind: 'equipo', icon: 'router', title: t.status === 'ok' ? 'Gestión remota (TR-069) activada en la ONU' : 'Falló la activación de TR-069', detail: t.status === 'ok' ? '' : (t.message || '') }));

  // Órdenes de trabajo y reclamos
  safe(() => db.prepare('SELECT t.*, tech.name tech_name FROM tickets t LEFT JOIN technicians tech ON tech.id=t.technician_id WHERE t.customer_id=?').all(id)).forEach(t => {
    push({ at: String(t.created_at), kind: 'reclamo', icon: t.kind === 'install' ? 'tools' : 'headset', title: (t.kind === 'install' ? 'Orden de instalación' : 'Reclamo') + ` N.º ${t.id}: ${t.subject}`,
      detail: [t.tech_name ? `asignado a ${t.tech_name}` : (t.technician_notes || '')].filter(Boolean).join(' · ') });
    if (t.status === 'resolved') push({ at: String(t.updated_at), kind: 'reclamo', icon: 'check2-square', title: `${t.kind === 'install' ? 'Instalación' : 'Reclamo'} N.º ${t.id} resuelto`, detail: t.technician_notes ? String(t.technician_notes).slice(0, 160) : '' });
  });

  // Fotos y documentos cargados
  if (tableExists('customer_documents')) {
    safe(() => db.prepare('SELECT * FROM customer_documents WHERE customer_id=?').all(id)).forEach(d => push({ at: String(d.created_at), kind: 'alta', icon: 'images',
      title: `Foto agregada: ${({ cedula: 'cédula', casa: 'casa', otro: 'otro documento' })[d.kind] || d.kind}`, by: d.uploaded_by || '' }));
  }

  // WhatsApp enviados
  safe(() => db.prepare("SELECT * FROM wa_chat_messages WHERE customer_id=? ORDER BY id DESC LIMIT 60").all(id)).forEach(m => {
    const first = String(m.message_text || '').split('\n').map(x => x.replace(/[*_]/g, '').trim()).find(Boolean) || '';
    push({ at: String(m.created_at), kind: 'whatsapp', icon: 'whatsapp', title: (m.direction === 'inbound' ? 'WhatsApp recibido: ' : 'WhatsApp enviado: ') + first.slice(0, 80) });
  });

  // Auditoría (acciones del personal sobre este cliente)
  const NICE = { UPDATE: 'Datos modificados', CREATE: 'Alta', DELETE: 'Eliminación', REBOOT_DEVICE: 'Reinicio del módem', CANCEL: 'Baja del servicio' };
  safe(() => db.prepare("SELECT * FROM audit_trail WHERE entity_type IN ('customer','customers') AND entity_id=?").all(String(id))).forEach(a => push({ at: String(a.created_at), kind: 'auditoria', icon: 'journal-text',
    title: NICE[a.action] || String(a.action || 'Acción'), by: a.actor_name || '' }));

  return out
    .map(e => ({ ...e, at: String(e.at).replace('T', ' ').slice(0, 16) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

module.exports = { ensureSchema, timeline };
