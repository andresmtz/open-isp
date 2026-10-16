const db = require('../config/database');

function getAllTickets(status = null, opts = {}) {
  let query = `
    SELECT t.*, 
           CASE WHEN t.customer_id IS NULL OR t.customer_id = 0 THEN 'Tarea general / mantenimiento' ELSE COALESCE(c.name, 'Cliente #' || t.customer_id) END as customer_name, 
           COALESCE(c.phone, '-') as customer_phone, 
           COALESCE(c.address, '-') as customer_address, 
           tech.name as technician_name
    FROM tickets t
    LEFT JOIN customers c ON (t.customer_id = c.id AND t.customer_id != 0)
    LEFT JOIN technicians tech ON t.technician_id = tech.id
  `;

  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('t.status = ?'); params.push(status); }
  const { search, technicianId } = opts || {};
  if (search) {
    where.push('(t.subject LIKE ? OR t.message LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    const s = '%' + search + '%';
    params.push(s, s, s, s);
  }
  if (technicianId) { where.push('t.technician_id = ?'); params.push(Number(technicianId)); }

  const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
  query += whereSql + ` ORDER BY CASE WHEN t.status = 'open' THEN 1 WHEN t.status = 'in_progress' THEN 2 ELSE 3 END, t.created_at DESC`;
  return db.prepare(query).all(...params);
}

function getTicketsByCustomerId(customerId) {
  return db.prepare(`
    SELECT t.*, tech.name as technician_name
    FROM tickets t
    LEFT JOIN technicians tech ON t.technician_id = tech.id
    WHERE t.customer_id = ?
    ORDER BY t.created_at DESC
  `).all(customerId);
}

function getTicketById(id) {
  return db.prepare(`
    SELECT t.*, 
           CASE WHEN t.customer_id IS NULL OR t.customer_id = 0 THEN 'Tarea general / mantenimiento' ELSE COALESCE(c.name, 'Cliente #' || t.customer_id) END as customer_name, 
           COALESCE(c.phone, '-') as customer_phone, 
           COALESCE(c.address, '-') as customer_address, 
           tech.name as technician_name
    FROM tickets t
    LEFT JOIN customers c ON (t.customer_id = c.id AND t.customer_id != 0)
    LEFT JOIN technicians tech ON t.technician_id = tech.id
    WHERE t.id = ?
  `).get(id);
}

function createTicket(customerId, subject, message, extraData = {}) {
  const { customerPhotos, customerPhotoMetadata, technicianId, status } = extraData;
  const custId = (customerId && parseInt(customerId, 10) > 0) ? parseInt(customerId, 10) : 0;
  const techId = (technicianId && parseInt(technicianId, 10) > 0) ? parseInt(technicianId, 10) : null;
  const initialStatus = status || (techId ? 'in_progress' : 'open');
  
  return db.prepare(`
    INSERT INTO tickets (customer_id, subject, message, status, technician_id, customer_photos, customer_photo_metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, (NOW_LOCAL()), (NOW_LOCAL()))
  `).run(
    custId,
    subject,
    message,
    initialStatus,
    techId,
    customerPhotos || '',
    customerPhotoMetadata || ''
  );
}

function updateTicketStatus(id, status, technicianId = undefined) {
  setImmediate(() => { try { require('./installationService').onTicketStatus(id, status); } catch (_) {} });
  if (technicianId !== undefined) {
    const techId = (technicianId && parseInt(technicianId, 10) > 0) ? parseInt(technicianId, 10) : null;
    return db.prepare(`
      UPDATE tickets 
      SET status = ?, technician_id = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(status, techId, id);
  } else {
    return db.prepare(`
      UPDATE tickets 
      SET status = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(status, id);
  }
}

function deleteTicket(id) {
  return db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
}

function getTicketStats() {
  const open = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='open'").get().c;
  const inProgress = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='in_progress'").get().c;
  const resolved = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status='resolved'").get().c;
  return { open, inProgress, resolved, total: open + inProgress + resolved };
}

// ── Notas / información agregada a un ticket (historial) ──
let _notesOk = false;
function ensureNotes() {
  if (_notesOk) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ticket_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, author TEXT DEFAULT '', author_type TEXT DEFAULT 'oficina',
    text TEXT NOT NULL, notified INTEGER DEFAULT 0, created_at TEXT DEFAULT (NOW_LOCAL()))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ticket_notes ON ticket_notes(ticket_id)');
  _notesOk = true;
}
function addNote(ticketId, text, author, authorType = 'oficina', notified = false) {
  ensureNotes();
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new Error('Escribí la información a agregar');
  const r = db.prepare('INSERT INTO ticket_notes (ticket_id, author, author_type, text, notified) VALUES (?,?,?,?,?)')
    .run(Number(ticketId), String(author || '').slice(0, 80), authorType, t, notified ? 1 : 0);
  db.prepare('UPDATE tickets SET updated_at = NOW_LOCAL() WHERE id = ?').run(Number(ticketId));
  return Number(r.lastInsertRowid);
}
function notesFor(ticketId) { ensureNotes(); return db.prepare('SELECT * FROM ticket_notes WHERE ticket_id=? ORDER BY id').all(Number(ticketId)); }
function notesForMany(ids) {
  ensureNotes();
  const list = [].concat(ids).map(Number).filter(Boolean);
  if (!list.length) return {};
  const out = {};
  for (const n of db.prepare(`SELECT * FROM ticket_notes WHERE ticket_id IN (${list.map(() => '?').join(',')}) ORDER BY id`).all(...list)) (out[n.ticket_id] = out[n.ticket_id] || []).push(n);
  return out;
}

module.exports = {
  addNote, notesFor, notesForMany,
  getAllTickets,
  getTicketsByCustomerId,
  getTicketById,
  createTicket,
  updateTicketStatus,
  deleteTicket,
  getTicketStats
};
