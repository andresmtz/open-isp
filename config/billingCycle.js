/**
 * Ciclo de facturación parametrizable (Configuración → Automatización → Ciclo de facturación).
 *
 *   billing_invoice_day     día de emisión de facturas (1-31; se ajusta al último día del mes)
 *   billing_invoice_hour    hora de emisión (0-23)
 *   billing_period_mode     'current' = la factura es del mes en que se emite (pospago)
 *                           'next'    = la factura es del mes siguiente (prepago: emite el 28 → período del mes que viene)
 *   billing_due_day         día de vencimiento dentro del período (informativo / avisos)
 *   isolir_day              día de corte dentro del período (cada cliente puede tener el suyo en customers.isolate_day)
 *   billing_cut_hour        hora del corte (0-23)
 *   billing_void_previous_unpaid  true = al emitir una factura nueva se anulan las pendientes anteriores;
 *                                 false = la deuda se acumula (recomendado)
 *   promise_max_days        días máximos de una promesa de pago
 *   promise_default_days    días que se otorgan al habilitar un cliente con deuda
 *   promise_max_per_month   promesas permitidas por cliente por mes calendario (0 = sin límite)
 *
 * Todas las fechas se calculan en la zona horaria configurada (setting 'timezone').
 */
const { getSetting } = require('./settingsManager');

const DEFAULTS = {
  billing_invoice_day: 1,
  billing_invoice_hour: 0,
  billing_period_mode: 'current',
  billing_due_day: 5,
  isolir_day: 10,
  billing_cut_hour: 2,
  billing_void_previous_unpaid: false,
  promise_max_days: 7,
  promise_default_days: 3,
  promise_max_per_month: 1,
};

function int(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function bool(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }

function get() {
  const g = (k) => getSetting(k, DEFAULTS[k]);
  return {
    invoiceDay: int(g('billing_invoice_day'), 1, 1, 31),
    invoiceHour: int(g('billing_invoice_hour'), 0, 0, 23),
    periodMode: g('billing_period_mode') === 'next' ? 'next' : 'current',
    dueDay: int(g('billing_due_day'), 5, 1, 31),
    cutDay: int(g('isolir_day'), 10, 1, 31),
    cutHour: int(g('billing_cut_hour'), 2, 0, 23),
    voidPreviousUnpaid: bool(g('billing_void_previous_unpaid')),
    promiseMaxDays: int(g('promise_max_days'), 7, 1, 60),
    promiseDefaultDays: int(g('promise_default_days'), 3, 1, 60),
    promiseMaxPerMonth: int(g('promise_max_per_month'), 1, 0, 31),
  };
}

/** Normaliza lo que llega del formulario a valores válidos para settings.json. */
function sanitize(body) {
  const b = body || {};
  const out = {};
  const n = (k, min, max) => { if (b[k] !== undefined && b[k] !== '') out[k] = int(b[k], DEFAULTS[k], min, max); };
  n('billing_invoice_day', 1, 31);
  n('billing_invoice_hour', 0, 23);
  n('billing_due_day', 1, 31);
  n('isolir_day', 1, 31);
  n('billing_cut_hour', 0, 23);
  n('promise_max_days', 1, 60);
  n('promise_default_days', 1, 60);
  n('promise_max_per_month', 0, 31);
  if (b.billing_period_mode !== undefined) out.billing_period_mode = b.billing_period_mode === 'next' ? 'next' : 'current';
  if (b.billing_void_previous_unpaid !== undefined) out.billing_void_previous_unpaid = bool(b.billing_void_previous_unpaid);
  if (out.promise_default_days && out.promise_max_days && out.promise_default_days > out.promise_max_days) {
    out.promise_default_days = out.promise_max_days;
  }
  return out;
}

function timezone() { return getSetting('timezone', 'America/Asuncion') || 'America/Asuncion'; }

/** Fecha/hora local actual en la zona configurada: { year, month, day, hour, minute } */
function nowLocal(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date || new Date());
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
  return { year: o.year, month: o.month, day: o.day, hour: o.hour === 24 ? 0 : o.hour, minute: o.minute };
}

function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
function clampDay(year, month, day) { return Math.min(day, daysInMonth(year, month)); }
function pad(n) { return String(n).padStart(2, '0'); }
/** 'YYYY-MM-DD HH:00' — comparable como texto */
function stamp(year, month, day, hour) { return `${year}-${pad(month)}-${pad(day)} ${pad(hour || 0)}:00`; }
function nowStamp(date) { const n = nowLocal(date); return `${n.year}-${pad(n.month)}-${pad(n.day)} ${pad(n.hour)}:${pad(n.minute)}`; }

function shiftMonth(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Período que corresponde a una emisión hecha en (year, month). */
function periodForIssue(year, month, cfg) {
  return (cfg || get()).periodMode === 'next' ? shiftMonth(year, month, 1) : { year, month };
}

/** ¿Corresponde emitir ahora? Devuelve el período a facturar o null. */
function invoiceRunDue(date, cfg) {
  const c = cfg || get();
  const n = nowLocal(date);
  if (n.day !== clampDay(n.year, n.month, c.invoiceDay) || n.hour < c.invoiceHour) return null;
  return periodForIssue(n.year, n.month, c);
}

/** Momento de corte de una factura del período (year, month) para un cliente. */
function cutStampFor(periodYear, periodMonth, customer, cfg) {
  const c = cfg || get();
  const day = Number(customer && customer.isolate_day) || c.cutDay;
  return stamp(periodYear, periodMonth, clampDay(periodYear, periodMonth, day), c.cutHour);
}

function dueStampFor(periodYear, periodMonth, cfg) {
  const c = cfg || get();
  return stamp(periodYear, periodMonth, clampDay(periodYear, periodMonth, c.dueDay), 23);
}

/** Próximas fechas del ciclo, para mostrar en la configuración. */
function preview(date, cfg) {
  const c = cfg || get();
  const n = nowLocal(date);
  let issue = { year: n.year, month: n.month };
  const issueDay = clampDay(issue.year, issue.month, c.invoiceDay);
  if (n.day > issueDay || (n.day === issueDay && n.hour >= c.invoiceHour)) issue = shiftMonth(issue.year, issue.month, 1);
  const period = periodForIssue(issue.year, issue.month, c);
  return {
    issue: stamp(issue.year, issue.month, clampDay(issue.year, issue.month, c.invoiceDay), c.invoiceHour),
    period: `${pad(period.month)}/${period.year}`,
    due: stamp(period.year, period.month, clampDay(period.year, period.month, c.dueDay), 0).slice(0, 10),
    cut: cutStampFor(period.year, period.month, null, c),
  };
}

/** Período de servicio en curso: el de la última emisión ya ocurrida. */
function currentPeriod(date, cfg) {
  const c = cfg || get();
  const n = nowLocal(date);
  const issueDay = clampDay(n.year, n.month, c.invoiceDay);
  const issued = (n.day > issueDay || (n.day === issueDay && n.hour >= c.invoiceHour));
  const issue = issued ? { year: n.year, month: n.month } : shiftMonth(n.year, n.month, -1);
  return periodForIssue(issue.year, issue.month, c);
}

function addDaysStamp(days, date) {
  const d = new Date((date || new Date()).getTime() + days * 86400000);
  return nowStamp(d);
}

module.exports = {
  DEFAULTS, get, sanitize, nowLocal, nowStamp, stamp, daysInMonth, clampDay, shiftMonth,
  periodForIssue, currentPeriod, invoiceRunDue, cutStampFor, dueStampFor, preview, addDaysStamp,
};
