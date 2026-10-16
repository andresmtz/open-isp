const crypto = require('crypto');
const { getSetting, getSettings, saveSettings } = require('../config/settingsManager');
const { getAppSetting, saveAppSetting } = require('../config/database');

const FEATURE_PASSWORD_HASH = 'af03458614be223016c5bc1c0788eaefc6a6bfd0c11cdcd4bc520f49d0cb474a'; // sha256 kode aktivasi — plaintext hanya di settings.json (activation_code), tidak di repo
const FEATURE_CONTACT_PHONE = '081947215703';

function getFeaturePasswordHash() {
  return getSetting('feature_password_hash', FEATURE_PASSWORD_HASH);
}

function getFeatureContactPhone() {
  return getSetting('feature_contact_phone', FEATURE_CONTACT_PHONE);
}

const SETTINGS_KEY = 'sidebar_menu_states';
const STATE_VISIBLE = 'visible';
const STATE_HIDDEN = 'hidden';
const STATE_LOCKED = 'locked';
const VALID_STATES = new Set([STATE_VISIBLE, STATE_HIDDEN, STATE_LOCKED]);

const MENU_DEFINITIONS = [
  { key: 'dashboard', section: 'main', href: '/admin', icon: 'bi bi-speedometer2', labelKey: 'admin.nav.dashboard', labelDefault: 'Panel', roles: ['admin', 'cashier'], bottomNav: true, bottomNavOrder: 1, activePages: ['dashboard'] },
  { key: 'network', section: 'main', href: '/admin/mikrotik', icon: 'bi bi-diagram-3', labelKey: 'admin.nav.network', labelDefault: 'Red', roles: ['admin', 'cashier'], activePages: ['mikrotik', 'radius_settings', 'acs_pro', 'onu_provision', 'olts', 'onu_inventory', 'monitoring'], children: [
    { key: 'mikrotik', section: 'main', href: '/admin/mikrotik', icon: 'bi bi-router', labelKey: 'admin.nav.mikrotik', labelDefault: 'MikroTik', roles: ['admin', 'cashier'], activePages: ['mikrotik'] },
    { key: 'radius_server', section: 'main', href: '/admin/radius-settings', icon: 'bi bi-broadcast', labelKey: 'admin.nav.radius_server', labelDefault: 'Servidor RADIUS', roles: ['admin'], activePages: ['radius_settings'] },
    { key: 'acs_pro', section: 'main', href: '/admin/acs', icon: 'bi bi-hdd-network', labelKey: 'admin.nav.acs_pro', labelDefault: 'GenieACS Pro', roles: ['admin'], activePages: ['acs_pro'] },
    { key: 'onu_provision', section: 'main', href: '/admin/onu-provision', icon: 'bi bi-hdd-network-fill', labelKey: 'admin.nav.onu_provision', labelDefault: 'Alta de ONU', roles: ['admin'], activePages: ['onu_provision'] },
    { key: 'onu_inventory', section: 'main', href: '/admin/onu-inventory', icon: 'bi bi-router', labelKey: 'admin.nav.onu_inventory', labelDefault: 'Inventario de ONU', roles: ['admin', 'cashier'], activePages: ['onu_inventory'] },
    { key: 'olts', section: 'main', href: '/admin/olts', icon: 'bi bi-hdd-fill', labelKey: 'admin.nav.olt_management', labelDefault: 'OLT', roles: ['admin', 'cashier'], activePages: ['olts'] },
    { key: 'monitoring', section: 'main', href: '/admin/monitoring', icon: 'bi bi-activity', labelKey: 'admin.nav.monitoring', labelDefault: 'Monitoreo del sistema', roles: ['admin'], activePages: ['monitoring'] }
  ] },
  { key: 'map', section: 'main', href: '/admin/map', icon: 'bi bi-map', labelKey: 'admin.nav.network_map', labelDefault: 'Mapa de red', roles: ['admin', 'cashier'], bottomNav: true, bottomNavOrder: 4, activePages: ['map'] },
  { key: 'conversations', section: 'main', href: '/admin/conversations', icon: 'bi bi-chat-dots', labelKey: 'admin.nav.conversations', labelDefault: 'Conversaciones', roles: ['admin', 'cashier'], activePages: ['conversations'] },
  { key: 'whatsapp', section: 'main', href: '/admin/whatsapp', icon: 'bi bi-whatsapp', labelKey: 'admin.nav.whatsapp', labelDefault: 'WhatsApp', roles: ['admin', 'cashier'], cashierHref: '/admin/whatsapp/live-chat', activePages: ['whatsapp','broadcast','whatsapp_live_chat','whatsapp_templates'] },
  { key: 'automation', section: 'main', href: '/admin/automation', icon: 'bi bi-robot', labelKey: 'admin.nav.automation', labelDefault: 'Automatización', roles: ['admin'], activePages: ['automation'] },

  { key: 'grp_customers', section: 'billing', href: '/admin/customers', icon: 'bi bi-people', labelKey: 'admin.nav.customers', labelDefault: 'Clientes', roles: ['admin', 'cashier'], bottomNav: true, bottomNavOrder: 2, activePages: ['customers', 'onu_stickers'], children: [
    { key: 'customers', section: 'billing', href: '/admin/customers', icon: 'bi bi-people', labelKey: 'admin.nav.customers_data', labelDefault: 'Datos del cliente', roles: ['admin', 'cashier'], activePages: ['customers'] },
    { key: 'onu_stickers', section: 'billing', href: '/admin/onu-stickers', icon: 'bi bi-qr-code', labelKey: 'admin.nav.onu_stickers', labelDefault: 'Etiquetas de ONU', roles: ['admin', 'cashier'], activePages: ['onu_stickers'] }
  ] },
  { key: 'grp_packages', section: 'billing', href: '/admin/packages', icon: 'bi bi-box-seam', labelKey: 'admin.nav.grp_packages', labelDefault: 'Planes y fichas', roles: ['admin', 'cashier'], activePages: ['packages', 'voucher_packages', 'vouchers_discounts', 'discounts', 'promo_slides'], children: [
    { key: 'packages', section: 'billing', href: '/admin/packages', icon: 'bi bi-box-seam', labelKey: 'admin.nav.internet_packages', labelDefault: 'Planes de internet', roles: ['admin', 'cashier'], activePages: ['packages'] },
    { key: 'voucher_packages', section: 'billing', href: '/admin/vouchers/packages', icon: 'bi bi-ticket-detailed', labelKey: 'admin.nav.voucher_packages', labelDefault: 'Planes de fichas', roles: ['admin', 'cashier'], activePages: ['voucher_packages'] },
    { key: 'vouchers_discounts', section: 'billing', href: '/admin/vouchers-discounts', icon: 'bi bi-ticket-perforated', labelKey: 'admin.nav.vouchers_discounts', labelDefault: 'Costo de instalación', roles: ['admin'], activePages: ['vouchers_discounts'] },
    { key: 'discounts', section: 'billing', href: '/admin/discounts', icon: 'bi bi-percent', labelKey: 'admin.nav.discounts', labelDefault: 'Descuentos', roles: ['admin', 'cashier'], activePages: ['discounts'] },
    { key: 'promo_slides', section: 'billing', href: '/admin/promo-slides', icon: 'bi bi-image', labelKey: 'admin.nav.promo_slides', labelDefault: 'Diapositivas de promoción', roles: ['admin'], activePages: ['promo_slides'] }
  ] },
  { key: 'grp_billing', section: 'billing', href: '/admin/billing', icon: 'bi bi-receipt', labelKey: 'admin.nav.invoices', labelDefault: 'Facturación', roles: ['admin', 'cashier'], bottomNav: true, bottomNavOrder: 3, activePages: ['billing', 'collector_payments', 'pending_payments'], children: [
    { key: 'pending_payments', section: 'billing', href: '/admin/pending-payments', icon: 'bi bi-cash-coin', labelKey: 'admin.nav.pending_payments', labelDefault: 'Pagos pendientes', roles: ['admin', 'cashier'], activePages: ['pending_payments'] },
    { key: 'billing', section: 'billing', href: '/admin/billing', icon: 'bi bi-receipt', labelKey: 'admin.nav.invoices_list', labelDefault: 'Facturas', roles: ['admin', 'cashier'], activePages: ['billing'] },
    { key: 'collector_payments', section: 'billing', href: '/admin/collector-payments', icon: 'bi bi-check2-square', labelKey: 'admin.nav.collector_payments', labelDefault: 'Aprobación de cobradores', roles: ['admin', 'cashier'], activePages: ['collector_payments'] }
  ] },

  { key: 'grp_finance', section: 'finance', href: '/admin/reports', icon: 'bi bi-cash-stack', labelKey: 'admin.nav.grp_finance', labelDefault: 'Finanzas', roles: ['admin', 'cashier'], activePages: ['reports', 'account_collections', 'cashiers_reports', 'payroll', 'cash_in', 'expenses', 'expense_categories'], children: [
    { key: 'reports', section: 'finance', href: '/admin/reports', icon: 'bi bi-bar-chart-line', labelKey: 'admin.nav.finance_report', labelDefault: 'Reporte financiero', roles: ['admin', 'cashier'], activePages: ['reports'] },
    { key: 'account_collections', section: 'finance', href: '/admin/finance/by-account', icon: 'bi bi-bank', labelKey: 'admin.nav.account_collections', labelDefault: 'Cobros por cuenta', roles: ['admin'], activePages: ['account_collections'] },
    { key: 'cashiers_reports', section: 'finance', href: '/admin/cashiers/reports', icon: 'bi bi-journal-text', labelKey: 'admin.nav.cashiers_reports', labelDefault: 'Reporte de cajeros', roles: ['admin', 'cashier'], activePages: ['cashiers_reports'] },
    { key: 'cash_in', section: 'finance', href: '/admin/finance/cash-in', icon: 'bi bi-cash-stack', labelKey: 'admin.nav.cash_in', labelDefault: 'Otros ingresos', roles: ['admin', 'cashier'], activePages: ['cash_in'] },
    { key: 'expenses', section: 'finance', href: '/admin/finance/expenses', icon: 'bi bi-wallet2', labelKey: 'admin.nav.expenses', labelDefault: 'Gastos', roles: ['admin', 'cashier'], activePages: ['expenses'] },
    { key: 'expense_categories', section: 'finance', href: '/admin/finance/expense-categories', icon: 'bi bi-tags', labelKey: 'admin.nav.expense_categories', labelDefault: 'Categorías de gastos', roles: ['admin'], activePages: ['expense_categories'] },
    { key: 'payroll', section: 'finance', href: '/admin/payroll', icon: 'bi bi-wallet2', labelKey: 'admin.nav.payroll', labelDefault: 'Sueldos', roles: ['admin'], activePages: ['payroll'] }
  ] },

  { key: 'grp_service', section: 'service', href: '/admin/tickets', icon: 'bi bi-headset', labelKey: 'admin.nav.grp_service', labelDefault: 'Servicio', roles: ['admin', 'cashier'], activePages: ['tickets', 'inventory', 'attendance'], children: [
    { key: 'tickets', section: 'service', href: '/admin/tickets', icon: 'bi bi-headset', labelKey: 'admin.nav.customer_tickets', labelDefault: 'Reclamos de clientes', roles: ['admin', 'cashier'], activePages: ['tickets'] },
    { key: 'inventory', section: 'service', href: '/admin/inventory', icon: 'bi bi-boxes', labelKey: 'admin.nav.inventory', labelDefault: 'Inventario (stock)', roles: ['admin', 'cashier'], activePages: ['inventory'] },
    { key: 'attendance', section: 'service', feature: 'staff_attendance', href: '/admin/attendance', icon: 'bi bi-calendar-check', labelKey: 'admin.nav.attendance', labelDefault: 'Asistencia del personal', roles: ['admin', 'cashier'], activePages: ['attendance'] }
  ] },

  { key: 'cashier_attendance', section: 'cashier', feature: 'staff_attendance', href: '/admin/cashiers/attendance', icon: 'bi bi-calendar-check', labelKey: 'admin.nav.cashier_attendance', labelDefault: 'Mi asistencia', roles: ['cashier'], activePages: ['cashier_attendance'] },

  { key: 'grp_users', section: 'user_management', href: '/admin/technicians', icon: 'bi bi-person-gear', labelKey: 'admin.nav.grp_users', labelDefault: 'Usuarios', roles: ['admin', 'cashier'], activePages: ['technicians', 'cashiers', 'collectors', 'areas'], children: [
    { key: 'technicians', section: 'user_management', href: '/admin/technicians', icon: 'bi bi-person-gear', labelKey: 'admin.nav.technicians', labelDefault: 'Técnicos', roles: ['admin'], activePages: ['technicians'] },
    { key: 'cashiers', section: 'user_management', href: '/admin/cashiers', icon: 'bi bi-person-vcard', labelKey: 'admin.nav.cashiers', labelDefault: 'Personal de oficina', roles: ['admin'], activePages: ['cashiers'] },
    { key: 'collectors', section: 'user_management', href: '/admin/collectors', icon: 'bi bi-person-badge', labelKey: 'admin.nav.collectors', labelDefault: 'Cobradores', roles: ['admin'], activePages: ['collectors'] },
    { key: 'areas', section: 'user_management', href: '/admin/areas', icon: 'bi bi-geo-alt', labelKey: 'admin.nav.areas', labelDefault: 'Zonas', roles: ['admin', 'cashier'], activePages: ['areas'] }
  ] },

  { key: 'grp_system', section: 'system', href: '/admin/settings', icon: 'bi bi-gear', labelKey: 'admin.nav.grp_system', labelDefault: 'Sistema', roles: ['admin'], activePages: ['update', 'service_notice', 'settings', 'ewallet_logs', 'backup', 'audit_logs'], children: [
    { key: 'wisphub', section: 'system', feature: 'wisphub_migration', href: '/admin/wisphub', icon: 'bi bi-arrow-left-right', labelKey: 'admin.nav.wisphub', labelDefault: 'Migración WispHub', roles: ['admin'] },
    { key: 'update', section: 'system', feature: 'github_update', href: '/admin/update', icon: 'bi bi-cloud-arrow-down', labelKey: 'admin.nav.update', labelDefault: 'Actualizar desde GitHub', roles: ['admin'], activePages: ['update'] },
    { key: 'service_notice', section: 'system', href: '/admin/service-notice', icon: 'bi bi-megaphone-fill', labelKey: 'admin.nav.service_notice', labelDefault: 'Estado del servicio', roles: ['admin'], activePages: ['service_notice'] },
    { key: 'settings', section: 'system', href: '/admin/settings', icon: 'bi bi-gear', labelKey: 'admin.nav.settings', labelDefault: 'Configuración', roles: ['admin'], activePages: ['settings'] },
    { key: 'ewallet_logs', section: 'system', feature: 'gateways', href: '/admin/ewallet-logs', icon: 'bi bi-journal-text', labelKey: 'admin.nav.log_rekap', labelDefault: 'Registros y resúmenes', roles: ['admin'], activePages: ['ewallet_logs'] },
    { key: 'backup', section: 'system', href: '/admin/backup', icon: 'bi bi-hdd-stack', labelKey: 'admin.nav.backup', labelDefault: 'Respaldo y recuperación', roles: ['admin'], activePages: ['backup'] },
    { key: 'audit_logs', section: 'system', href: '/admin/audit-logs', icon: 'bi bi-shield-lock', labelKey: 'admin.nav.audit_logs', labelDefault: 'Registro de actividad', roles: ['admin'], activePages: ['audit_logs'] }
  ] }

];

const DEFAULT_MENU_STATES = {
  dashboard: STATE_VISIBLE,
  mikrotik: STATE_VISIBLE,
  network: STATE_VISIBLE,
  grp_customers: STATE_VISIBLE,
  grp_packages: STATE_VISIBLE,
  grp_billing: STATE_VISIBLE,
  grp_finance: STATE_VISIBLE,
  grp_service: STATE_VISIBLE,
  grp_users: STATE_VISIBLE,
  grp_system: STATE_VISIBLE,
  map: STATE_VISIBLE,
  radius_server: STATE_VISIBLE,
  map: STATE_VISIBLE,
  acs_pro: STATE_VISIBLE,
  onu_provision: STATE_HIDDEN, // sus comandos son para GPON por SSH; no usar con VSOL EPON
  olts: STATE_VISIBLE,
  whatsapp: STATE_VISIBLE,
  automation: STATE_VISIBLE,
  broadcast: STATE_VISIBLE,
  whatsapp_live_chat: STATE_VISIBLE,
  promo_slides: STATE_VISIBLE,
  customers: STATE_VISIBLE,
  onu_stickers: STATE_VISIBLE,
  packages: STATE_VISIBLE,
  voucher_packages: STATE_VISIBLE,
  billing: STATE_VISIBLE,
  reports: STATE_VISIBLE,
  cashiers_reports: STATE_VISIBLE,
  account_collections: STATE_VISIBLE,
  conversations: STATE_VISIBLE,
  collector_payments: STATE_VISIBLE,
  tickets: STATE_VISIBLE,
  inventory: STATE_VISIBLE,
  attendance: STATE_VISIBLE,
  payroll: STATE_VISIBLE,
  cash_in: STATE_VISIBLE,
  expenses: STATE_VISIBLE,
  expense_categories: STATE_VISIBLE,
  cashier_attendance: STATE_VISIBLE,
  technicians: STATE_VISIBLE,
  cashiers: STATE_VISIBLE,
  collectors: STATE_VISIBLE,
  areas: STATE_VISIBLE,
  update: STATE_VISIBLE,
  vouchers_discounts: STATE_VISIBLE,
  discounts: STATE_VISIBLE,
  service_notice: STATE_VISIBLE,
  settings: STATE_VISIBLE,
  ewallet_logs: STATE_VISIBLE,
  backup: STATE_VISIBLE,
  monitoring: STATE_VISIBLE,
  audit_logs: STATE_VISIBLE
};

const SECTION_DEFINITIONS = [
  { key: 'main', labelKey: 'admin.section.main', labelDefault: 'PRINCIPAL' },
  { key: 'billing', labelKey: 'admin.section.billing', labelDefault: 'FACTURACIÓN' },
  { key: 'finance', labelKey: 'admin.section.finance', labelDefault: 'FINANZAS' },
  { key: 'service', labelKey: 'admin.section.service', labelDefault: 'SERVICIO' },
  { key: 'cashier', labelKey: 'admin.section.cashier', labelDefault: 'CAJA' },
  { key: 'user_management', labelKey: 'admin.section.user_management', labelDefault: 'USUARIOS' },
  { key: 'system', labelKey: 'admin.section.system', labelDefault: 'SISTEMA' }
];

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function normalizeState(value) {
  const normalized = String(value || '').trim().toLowerCase();
  // Sin bloqueo por código de activación: un estado 'locked' guardado de antes se trata como oculto
  if (normalized === STATE_LOCKED) return STATE_HIDDEN;
  return VALID_STATES.has(normalized) ? normalized : STATE_VISIBLE;
}

function allMenuDefs() {
  const out = [];
  for (const m of MENU_DEFINITIONS) {
    out.push(m);
    if (Array.isArray(m.children)) { for (const c of m.children) out.push(c); }
  }
  return out;
}

function getStoredMenuStates() {
  // Coba ambil dari Database dulu (Lebih Aman)
  let raw = getAppSetting(SETTINGS_KEY, null);
  let activationKeys = getAppSetting('sidebar_activation_keys', {});

  // Fallback ke settings.json jika di DB masih kosong (Migration)
  if (raw === null) {
    raw = getSetting(SETTINGS_KEY, {});
    activationKeys = getSetting('sidebar_activation_keys', {});
    // Langsung migrasi ke DB agar kedepannya pakai DB
    if (Object.keys(raw).length > 0) {
      saveAppSetting(SETTINGS_KEY, raw);
      saveAppSetting('sidebar_activation_keys', activationKeys);
    }
  }

  const stateMap = {};

  for (const menu of allMenuDefs()) {
    const defaultState = DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
    let storedState = raw && raw[menu.key] ? raw[menu.key] : defaultState;
    
    const normalized = normalizeState(storedState);

    stateMap[menu.key] = normalized;
  }
  return stateMap;
}

function saveMenuStates(stateMap) {
  const activationKeys = getAppSetting('sidebar_activation_keys', {});
  const passwordHash = getFeaturePasswordHash();

  for (const key in stateMap) {
    const newState = stateMap[key];
    const defaultState = DEFAULT_MENU_STATES[key] || STATE_VISIBLE;

    // Jika menu yang aslinya LOCKED diaktifkan (jadi visible/hidden), generate kunci
    if (defaultState === STATE_LOCKED && newState !== STATE_LOCKED) {
      activationKeys[key] = sha256(key + passwordHash);
    } else if (newState === STATE_LOCKED) {
      // Jika dikunci kembali, hapus kuncinya
      delete activationKeys[key];
    }
  }

  // Simpan ke Database (Utama)
  saveAppSetting(SETTINGS_KEY, sanitizeMenuStates(stateMap));
  saveAppSetting('sidebar_activation_keys', activationKeys);

  // Hanya gunakan database, tidak perlu backup ke settings.json
  return true;
}

function sanitizeMenuStates(input) {
  const clean = {};
  for (const menu of allMenuDefs()) {
    const defaultState = DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
    let state = input && input[menu.key] ? input[menu.key] : defaultState;
    
    clean[menu.key] = normalizeState(state);
  }
  return clean;
}

// Personal de oficina: además del rol, el menú se ve solo si tiene permiso (config/staffPermissions.js)
function staffHref(menu) { return menu.cashierHref || menu.href; }
function staffCanOpen(menu, session) {
  const sp = require('../config/staffPermissions');
  const path = String(staffHref(menu) || '').split('?')[0].replace(/^\/admin/, '') || '/';
  return sp.allows(session, 'GET', path);
}
function staffFirstHref(menu, session) {
  if (staffCanOpen(menu, session)) return staffHref(menu);
  for (const ch of (menu.children || [])) {
    if ((ch.roles || []).includes('cashier') && staffCanOpen(ch, session)) return staffHref(ch);
  }
  return null;
}

function isMenuAllowedForSession(menu, session) {
  // Funciones opcionales desactivadas (config/payments.js): el menú no se muestra
  if (menu.feature && !require('../config/payments').featureEnabled(menu.feature)) return false;
  const roles = Array.isArray(menu.roles) ? menu.roles : ['admin'];
  if (roles.includes('admin') && session && session.isAdmin) return true;
  if (roles.includes('cashier') && session && session.isCashier) return !!staffFirstHref(menu, session);
  return false;
}

function enrichMenu(menu, states) {
  const state = states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
  const locked = state === STATE_LOCKED;
  const hidden = state === STATE_HIDDEN;
  const out = {
    ...menu,
    state,
    locked,
    hidden,
    hrefResolved: menu.href,
    lockedMessage: locked ? `El menú "${menu.labelDefault}" está bloqueado. Contactá a ${getFeatureContactPhone()} para obtener el código de activación.` : ''
  };
  if (Array.isArray(menu.children)) {
    out.children = menu.children.map((ch) => enrichMenu(ch, states));
  }
  return out;
}

function resolveForSession(menu, session) {
  if (session && session.isCashier && !session.isAdmin) menu.hrefResolved = staffFirstHref(menu, session) || menu.hrefResolved;
  return menu;
}

function getSidebarSections(session) {
  const states = getStoredMenuStates();
  return SECTION_DEFINITIONS.map((section) => {
    const items = MENU_DEFINITIONS
      .filter((menu) => menu.section === section.key)
      .filter((menu) => isMenuAllowedForSession(menu, session))
      .map((menu) => {
        const enriched = resolveForSession(enrichMenu(menu, states), session);
        if (Array.isArray(enriched.children)) {
          enriched.children = enriched.children
            .filter((ch) => isMenuAllowedForSession(ch, session))
            .filter((ch) => !ch.hidden)
            .map((ch) => resolveForSession(ch, session));
        }
        return enriched;
      })
      .filter((menu) => !menu.hidden);

    return {
      ...section,
      items
    };
  }).filter((section) => section.items.length > 0);
}

function getBottomNavItems(session) {
  const states = getStoredMenuStates();
  return MENU_DEFINITIONS
    .filter((menu) => menu.bottomNav)
    .filter((menu) => isMenuAllowedForSession(menu, session))
    .map((menu) => resolveForSession(enrichMenu(menu, states), session))
    .filter((menu) => !menu.hidden)
    .sort((a, b) => (a.bottomNavOrder || 99) - (b.bottomNavOrder || 99));
}

function getConfigMenus() {
  const states = getStoredMenuStates();
  return MENU_DEFINITIONS.map((menu) => {
    const section = SECTION_DEFINITIONS.find((s) => s.key === menu.section);
    return {
      ...menu,
      state: states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE,
      roleLabel: menu.roles.includes('admin') && menu.roles.includes('cashier')
        ? 'Admin y cajero'
        : menu.roles.includes('cashier')
          ? 'Cajero'
          : 'Admin',
      sectionLabel: section?.labelDefault || menu.section,
      sectionLabelKey: section?.labelKey || ''
    };
  });
}

function getMenuDefinition(key) {
  const top = MENU_DEFINITIONS.find((menu) => menu.key === key);
  if (top) return top;
  for (const menu of MENU_DEFINITIONS) {
    if (Array.isArray(menu.children)) {
      const ch = menu.children.find((c) => c.key === key);
      if (ch) return ch;
    }
  }
  return null;
}

function isFeaturePasswordValid(password) {
  return sha256(password) === getFeaturePasswordHash();
}

function evaluateMenuAccess(menuKey, session) {
  const menu = getMenuDefinition(menuKey);
  if (!menu) {
    return { allowed: true, state: STATE_VISIBLE, menu: null };
  }

  if (!isMenuAllowedForSession(menu, session)) {
    return { allowed: false, state: 'forbidden', menu, reason: 'forbidden' };
  }

  const states = getStoredMenuStates();
  const state = states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
  if (state === STATE_HIDDEN) {
    return { allowed: false, state, menu, reason: 'hidden' };
  }
  if (state === STATE_LOCKED) {
    return { allowed: false, state, menu, reason: 'locked' };
  }
  return { allowed: true, state, menu, reason: null };
}

module.exports = {
  getFeatureContactPhone,
  getFeaturePasswordHash,
  STATE_VISIBLE,
  STATE_HIDDEN,
  STATE_LOCKED,
  MENU_DEFINITIONS,
  getSidebarSections,
  getBottomNavItems,
  getConfigMenus,
  getMenuDefinition,
  getStoredMenuStates,
  sanitizeMenuStates,
  isFeaturePasswordValid,
  saveMenuStates,
  evaluateMenuAccess,
};
