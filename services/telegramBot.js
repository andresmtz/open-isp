const { CompatBot } = require('./telegramCompat');
const { getSetting, getNowLocal } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const mikrotikSvc = require('./mikrotikService');
const customerDevice = require('./customerDeviceService');
const whatsappService = require('./whatsappService');
const db = require('../config/database');
const monitoringSvc = require('./monitoringService');
const oltSvc = require('./oltService');
const ticketSvc = require('./ticketService');
const regional = require('../config/regional');

let bot = null;

function initTelegram() {
  const enabled = getSetting('telegram_enabled', false);
  const token = getSetting('telegram_bot_token', '');

  if (!enabled || !token) {
    if (bot) {
      bot.stopPolling();
      bot = null;
      logger.info('Telegram Bot: Dihentikan (Nonaktif)');
    }
    return;
  }

  // Jika token berubah, kita harus stop bot lama dan buat baru
  if (bot && bot.token !== token) {
    bot.stopPolling();
    bot = null;
    logger.info('Telegram Bot: Token berubah, me-restart bot...');
  }

  if (bot) {
    logger.info('Telegram Bot: Sudah berjalan, melewati inisialisasi.');
    return; 
  }

  bot = new CompatBot(token);

  // ── Wrapper aman: bila Telegram gagal parse Markdown (mis. underscore pada
  // username pelanggan), kirim ulang otomatis TANPA parse_mode.
  (function () {
    const _send = bot.sendMessage.bind(bot);
    bot.sendMessage = async function (chatId, text, opts) {
      try { return await _send(chatId, text, opts); }
      catch (e) {
        const m = String((e && e.message) || '');
        if (m.includes('parse entities')) {
          const o = Object.assign({}, opts); delete o.parse_mode;
          return _send(chatId, text, o);
        }
        throw e;
      }
    };
    const _edit = bot.editMessageText.bind(bot);
    bot.editMessageText = async function (text, opts) {
      try { return await _edit(text, opts); }
      catch (e) {
        const m = String((e && e.message) || '');
        if (m.includes('parse entities')) {
          const o = Object.assign({}, opts); delete o.parse_mode;
          return _edit(text, o);
        }
        throw e;
      }
    };
  })();
  
  // Clear webhook to ensure polling works (Sync)
  bot.deleteWebHook().then(() => {
    bot.getMe().then(me => {
      logger.info(`Telegram Bot: Terhubung sebagai @${me.username}`);
    }).catch(e => logger.error('Telegram Bot Error (getMe):', e.message));
  }).catch(e => logger.error('Telegram Bot Error (deleteWebHook):', e.message));

  // Middleware Admin Check (Fetch latest ID every time)
  const isAdmin = (msg) => {
    const currentAdminId = getSetting('telegram_admin_id', '').toString();
    return msg.from.id.toString() === currentAdminId;
  };

  // Helper Mikhmon Parser
  const parseMikhmon = (script) => {
    if (!script) return null;
    const s = String(script).trim();
    
    // Cari pattern :put (",rem, ... , ... , ...
    // Updated regex untuk support format: :put (",rem,4000,2d,5000,,Disable,");
    const putMatch = s.match(/:\s*put\s*\(\s*[",]rem[",]?\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)/i);
    if (putMatch) {
      const cost = String(putMatch[1] || '').trim();
      const validity = String(putMatch[2] || '').trim();
      const priceStr = String(putMatch[3] || '').trim();
      const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;
      
      if (validity && price > 0) {
        return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
      }
    }
    
    // Fallback: split by comma
    const parts = s.split(',').map(p => String(p).trim());
    let remIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes('rem')) {
        remIdx = i;
        break;
      }
    }
    
    if (remIdx >= 0 && remIdx + 3 < parts.length) {
      const cost = String(parts[remIdx + 1] || '').trim();
      const validity = String(parts[remIdx + 2] || '').trim();
      const priceStr = String(parts[remIdx + 3] || '').trim();
      const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;
      
      if (validity && price > 0) {
        return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
      }
    }
    
    return null;
  };

  const isTruthy = (value) => {
    if (value === true || value === 1) return true;
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === '1' || normalized === 'on';
  };

  const formatGangguanCount = (scriptRow) => {
    const raw = scriptRow && scriptRow.source != null ? String(scriptRow.source) : '0';
    const count = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  };

  const loadPppoeSnapshot = async () => {
    const [secrets, active, scripts] = await Promise.all([
      mikrotikSvc.getPppoeSecrets(),
      mikrotikSvc.getPppoeActive(),
      mikrotikSvc.getSystemScripts()
    ]);
    const customers = customerSvc.getAllCustomers();

    const activeMap = new Map();
    (active || []).forEach((row) => {
      const name = String(row && row.name ? row.name : '').trim();
      if (name) activeMap.set(name, row);
    });

    const scriptMap = new Map();
    (scripts || []).forEach((row) => {
      const name = String(row && row.name ? row.name : '').trim();
      if (name) scriptMap.set(name, row);
    });

    const customerMap = new Map();
    (customers || []).forEach((row) => {
      const username = String(row && row.pppoe_username ? row.pppoe_username : '').trim();
      if (username) customerMap.set(username, row);
    });

    return {
      secrets: Array.isArray(secrets) ? secrets : [],
      active: Array.isArray(active) ? active : [],
      activeMap,
      scriptMap,
      customerMap
    };
  };

  const buildOfflineEntries = (snapshot) => {
    return snapshot.secrets
      .filter((secret) => {
        const username = String(secret && secret.name ? secret.name : '').trim();
        if (!username) return false;
        if (isTruthy(secret && secret.disabled)) return false;
        return !snapshot.activeMap.has(username);
      })
      .map((secret) => {
        const username = String(secret.name || '').trim();
        const customer = snapshot.customerMap.get(username) || null;
        const script = snapshot.scriptMap.get(username) || null;
        return {
          username,
          customerName: customer && customer.name ? customer.name : '-',
          phone: customer && customer.phone ? customer.phone : '-',
          profile: secret && secret.profile ? secret.profile : '-',
          service: secret && secret.service ? secret.service : '-',
          password: secret && secret.password ? secret.password : '-',
          failCount: formatGangguanCount(script)
        };
      })
      .sort((a, b) => {
        if (b.failCount !== a.failCount) return b.failCount - a.failCount;
        return a.username.localeCompare(b.username, 'id');
      });
  };

  const buildOfflineTelegramText = (snapshot) => {
    const now = getNowLocal();
    const offline = buildOfflineEntries(snapshot);
    const lines = [];
    lines.push('USER PPPoE OFFLINE');
    lines.push('============================');
    lines.push(`Fecha : ${now}`);
    lines.push('============================');
    lines.push('');
    lines.push('RINGKASAN');
    lines.push(`Total Secret : ${snapshot.secrets.length}`);
    lines.push(`Total activos : ${snapshot.active.length}`);
    lines.push(`Total Offline: ${offline.length}`);
    lines.push('');
    lines.push('USUARIOS DESCONECTADOS');

    if (offline.length === 0) {
      lines.push('Todos los usuarios están en línea.');
    } else {
      offline.slice(0, 20).forEach((row, index) => {
        lines.push(`${index + 1}. ${row.username}`);
        lines.push(`   Cliente : ${row.customerName}`);
        lines.push(`   WA        : ${row.phone}`);
        lines.push(`   Plan    : ${row.profile}`);
        lines.push(`   Caídas  : ${row.failCount}x`);
      });
      if (offline.length > 20) {
        lines.push(`...y ${offline.length - 20} usuarios desconectados más.`);
      }
    }

    lines.push('');
    lines.push('Detalle de un usuario: /cekpppoe usuario');
    lines.push('Contoh: /cekpppoe budi001');
    return lines.join('\n');
  };

  const buildPppoeUserDetailText = async (username) => {
    const target = String(username || '').trim();
    if (!target) throw new Error('El usuario PPPoE es obligatorio');

    const snapshot = await loadPppoeSnapshot();
    const secret = snapshot.secrets.find((row) => String(row && row.name ? row.name : '').trim() === target);
    if (!secret) {
      throw new Error(`No se encontró el usuario PPPoE "${target}"`);
    }

    const activeRow = snapshot.activeMap.get(target) || null;
    const customer = snapshot.customerMap.get(target) || null;
    const script = snapshot.scriptMap.get(target) || null;
    const offline = buildOfflineEntries(snapshot);

    const date = getNowLocal();
    const online = !!activeRow;
    const lines = [];
    lines.push('DETALLE PPPoE');
    lines.push('============================');
    lines.push(`Fecha     : ${date}`);
    lines.push(`Status    : ${online ? 'ONLINE' : 'OFFLINE'}`);
    lines.push('============================');
    lines.push('SERVICIO');
    lines.push(`Cliente : ${customer && customer.name ? customer.name : '-'}`);
    lines.push(`No. WA    : ${customer && customer.phone ? customer.phone : '-'}`);
    lines.push(`Username  : ${secret.name || '-'}`);
    lines.push(`Password  : ${secret.password || '-'}`);
    lines.push(`Service   : ${secret.service || '-'}`);
    lines.push(`Profile   : ${secret.profile || '-'}`);
    lines.push('');
    lines.push('EQUIPO');
    lines.push(`IP activa  : ${activeRow && activeRow.address ? activeRow.address : '-'}`);
    lines.push(`MAC/Caller : ${activeRow && (activeRow.callerId || activeRow['caller-id']) ? (activeRow.callerId || activeRow['caller-id']) : '-'}`);
    lines.push('');
    lines.push('CAÍDAS');
    lines.push(`Cantidad de caídas : ${formatGangguanCount(script)}x desconectado`);
    lines.push(`Total Secret    : ${snapshot.secrets.length}`);
    lines.push(`Total Active    : ${snapshot.active.length}`);
    lines.push(`Total Offline   : ${offline.length}`);

    if (!online && offline.length) {
      lines.push('');
      lines.push('User Offline Lain');
      offline.slice(0, 10).forEach((row) => {
        lines.push(`- ${row.username} (${row.failCount}x)`);
      });
      if (offline.length > 10) lines.push(`...y ${offline.length - 10} más.`);
    }

    return lines.join('\n');
  };

  // Main Menu (Inline Keyboard for better visibility)
  const mainMenu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Statistik', callback_data: 'menu_stats' }, { text: '👥 Clientes', callback_data: 'menu_cust' }],
        [{ text: '🎫 Voucher', callback_data: 'menu_vouch' }, { text: '💰 Facturas', callback_data: 'menu_bill' }],
        [{ text: '⚙️ MikroTik Status', callback_data: 'menu_mt' }],
        [{ text: '🖥️ Sistema', callback_data: 'menu_sys' }, { text: '💰 Deudas', callback_data: 'menu_arrears' }],
        [{ text: '💰 Pendapatan', callback_data: 'menu_pendapatan' }],
        [{ text: '🎫 Tickets', callback_data: 'menu_tiket' }, { text: '📡 OLT', callback_data: 'menu_olt' }, { text: '📶 Trafik', callback_data: 'menu_trafik' }],
        [{ text: '🔄 Refresh', callback_data: 'menu_main' }]
      ]
    }
  };

  bot.onText(/\/start|\/menu/i, (msg) => {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, `Lo siento, no tenés acceso de administrador.\nTu Chat ID: ${msg.from.id}`);
    bot.sendMessage(msg.chat.id, '🏠 *PANEL ADMIN ' + getSetting('company_header', 'OPEN-ISP') + '*\nElegí una opción del menú:', { parse_mode: 'Markdown', ...mainMenu });
  });

  bot.on('message', async (msg) => {
    if (!isAdmin(msg)) return;
    const text = msg.text;
    if (text === '/start' || text === '/menu') return; // Handled by onText
    
    // Logika handle text manual jika diperlukan (misal untuk perintah kick/edit)
  });

  // Callback Query Handling
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: 'Acceso denegado' });

    if (data === 'menu_main') {
      bot.editMessageText('🏠 *PANEL ADMIN ' + getSetting('company_header', 'OPEN-ISP') + '*\nElegí una opción del menú:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        ...mainMenu
      });
    }

    else if (data === 'menu_stats') {
      const stats = customerSvc.getCustomerStats();
      const billing = billingSvc.getDashboardStats();
      let res = `*📊 ESTADÍSTICAS DEL SISTEMA*\n\n`;
      res += `👥 Clientes: ${stats.total}\n`;
      res += `✅ Activos: ${stats.active}\n`;
      res += `🚫 Terisolir: ${stats.suspended}\n\n`;
      res += `💰 Ingresos del mes: ${regional.currencySymbol()} ${billing.thisMonth.toLocaleString(regional.locale())}\n`;
      res += `⏳ Sin pagar: ${billing.unpaidCount} facturas`;
      
      bot.sendMessage(chatId, res, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] }
      });
    }

    else if (data === 'menu_cust') {
      bot.sendMessage(chatId, '👥 *CLIENTES*\nElegí una acción:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Buscar cliente', callback_data: 'cust_search' }],
            [{ text: '🚫 Clientes suspendidos', callback_data: 'cust_suspended' }],
            [{ text: '📡 List ONU (GenieACS)', callback_data: 'cust_listonu' }],
            [{ text: '⬅️ Volver', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'menu_bill') {
      bot.sendMessage(chatId, '💰 *FACTURAS*\nElegí una acción:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏳ Facturas pendientes', callback_data: 'bill_unpaid' }],
            [{ text: '📈 Ingresos de hoy', callback_data: 'bill_today' }],
            [{ text: '⬅️ Volver', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'menu_vouch') {
      bot.sendMessage(chatId, '🎫 *MANAJEMEN VOUCHER*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Crear ficha', callback_data: 'vouch_create' }],
            [{ text: '📜 Perfiles hotspot', callback_data: 'vouch_profiles' }],
            [{ text: '⬅️ Volver', callback_data: 'menu_main' }]
          ]
        }
      });
    }
    
    else if (data === 'menu_mt') {
      bot.sendMessage(chatId, '⚙️ *STATUS MIKROTIK*\nPilih data:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Resource System', callback_data: 'mt_resource' }],
            [{ text: '🟢 Usuarios activos (PPPoE/HS)', callback_data: 'mt_active' }],
            [{ text: '🔴 User Offline (PPPoE)', callback_data: 'mt_offline' }],
            [{ text: '🔑 List PPPoE Secrets', callback_data: 'mt_pppoe' }],
            [{ text: '⬅️ Volver', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'menu_sys') {
      try { bot.sendMessage(chatId, tgSistemText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] } }); }
      catch (e) { bot.sendMessage(chatId, 'Error:' + e.message); }
    }
    else if (data === 'menu_arrears') {
      try { bot.sendMessage(chatId, tgTunggakanText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] } }); }
      catch (e) { bot.sendMessage(chatId, 'Error:' + e.message); }
    }
    else if (data === 'menu_tiket') {
      try { bot.sendMessage(chatId, tgTiketText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] } }); }
      catch (e) { bot.sendMessage(chatId, 'Error:' + e.message); }
    }
    else if (data === 'menu_olt') {
      bot.sendMessage(chatId, '📡 Leyendo el estado de la OLT, esperá…');
      try { bot.sendMessage(chatId, await tgOltText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] } }); }
      catch (e) { bot.sendMessage(chatId, 'Error:' + e.message); }
    }
    else if (data === 'menu_trafik') {
      try { bot.sendMessage(chatId, await tgTrafikText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] } }); }
      catch (e) { bot.sendMessage(chatId, 'Error:' + e.message); }
    }

    else if (data === 'menu_pendapatan') {
      try { bot.sendMessage(chatId, tgPendapatanText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] } }); }
      catch (e) { bot.sendMessage(chatId, 'Error:' + e.message); }
    }
    else if (data === 'mt_resource') {
      try {
        const res = await mikrotikSvc.getSystemResource();
        let txt = `*⚙️ MIKROTIK STATUS*\n\n`;
        txt += `Model: ${res.boardName || res['board-name'] || '-'}\n`;
        txt += `CPU: ${res.cpuLoad || res['cpu-load'] || '0'}%\n`;
        txt += `Uptime: ${res.uptime}\n`;
        txt += `Version: ${res.version}`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'No se pudieron leer los datos del MikroTik:' + e.message);
      }
    }

    else if (data === 'mt_active') {
      try {
        const pppoe = await mikrotikSvc.getPppoeActive();
        const hs = await mikrotikSvc.getHotspotActive();
        const scripts = await mikrotikSvc.getSystemScripts();
        
        let txt = `*🟢 USUARIOS ACTIVOS*\n\n`;
        txt += `🌐 *PPPoE (${pppoe.length}):*\n`;
        pppoe.slice(0, 15).forEach(a => {
          const s = scripts.find(sc => sc.name === a.name);
          const failCount = s ? (s.source || '0') : '0';
          txt += `• \`${a.name}\` (${a.address}) [⚡${failCount}]\n`;
        });
        
        txt += `\n📶 *Hotspot (${hs.length}):*\n`;
        hs.slice(0, 5).forEach(h => {
          txt += `• \`${h.user}\` (${h.address})\n`;
        });
        
        txt += `\n_⚡ = caídas detectadas_`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_offline') {
      try {
        const snapshot = await loadPppoeSnapshot();
        bot.sendMessage(chatId, buildOfflineTelegramText(snapshot));
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_pppoe') {
      try {
        const secrets = await mikrotikSvc.getPppoeSecrets();
        let txt = `*🔑 PPPoE SECRETS (${secrets.length})*\n\n`;
        secrets.slice(0, 20).forEach(s => {
          txt += `• \`${s.name}\` (${s.profile})\n`;
        });
        if (secrets.length > 20) txt += `\n_Mostrando 20 de ${secrets.length}..._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'cust_search') {
      bot.sendMessage(chatId, '🔍 *BUSCAR CLIENTE*\nEscribí `/cari [nombre/whatsapp]`\n\nEjemplo: `/cari juan` o `/cari 0981`', { parse_mode: 'Markdown' });
    }

    else if (data === 'cust_listonu') {
      const customerDevice = require('./customerDeviceService');
      let res = await customerDevice.listDevicesWithTags(30);
      
      // Jika kosong, coba ambil semua perangkat
      if (!res.ok || res.devices.length === 0) {
        res = await customerDevice.listAllDevices(30);
      }

      if (!res.ok || res.devices.length === 0) {
        return bot.sendMessage(chatId, '📭 No se detectaron ONU en GenieACS.');
      }

      let txt = `*📡 LISTA DE ONU (GenieACS)*\n\n`;
      res.devices.forEach(d => {
        const id = d._id || 'Unknown ID';
        const tags = Array.isArray(d._tags) ? d._tags.join(', ') : (d._tags || '-');
        txt += `• \`${id}\`\n  └ Tag: ${tags}\n`;
      });
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'cust_suspended') {
      const customers = customerSvc.getAllCustomers().filter(c => c.status === 'suspended');
      if (customers.length === 0) return bot.sendMessage(chatId, '✅ Tidak ada pelanggan yang terisolir.');
      let txt = `*🚫 CLIENTES SUSPENDIDOS (${customers.length})*\n\n`;
      customers.slice(0, 15).forEach(c => {
        txt += `• *${c.name}* (${c.phone})\n`;
      });
      if (customers.length > 15) txt += `\n_...y ${customers.length - 15} más._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_unpaid') {
      const invoices = billingSvc.getAllInvoices().filter(i => i.status === 'unpaid');
      if (invoices.length === 0) return bot.sendMessage(chatId, '✅ Semua tagihan sudah lunas!');
      let txt = `*⏳ FACTURAS PENDIENTES (${invoices.length})*\n\n`;
      invoices.slice(0, 15).forEach(i => {
        const c = customerSvc.getCustomerById(i.customer_id);
        txt += `• ${c ? c.name : 'Unknown'} - ${regional.currencySymbol()} ${i.amount.toLocaleString(regional.locale())}\n`;
      });
      if (invoices.length > 15) txt += `\n_...y ${invoices.length - 15} más._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_today') {
      try {
        const stats = billingSvc.getTodayRevenue();
        const total = stats.total || 0;
        const count = stats.count || 0;
        
        let txt = `*📈 INGRESOS DE HOY*\n\n`;
        txt += `💰 Total: *${regional.currencySymbol()} ${total.toLocaleString(regional.locale())}*\n`;
        txt += `🧾 Cantidad: ${count} transacciones\n\n`;
        txt += `_Según los pagos verificados hoy (hora local)._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'vouch_profiles') {
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const buttons = [];
        
        // Filter profiles that have Mikhmon Price
        const filtered = profiles.filter(p => parseMikhmon(p.onLogin));

        if (filtered.length === 0) {
          return bot.sendMessage(chatId, '⚠️ No hay planes con precio de venta (formato Mikhmon).');
        }

        filtered.forEach((p, index) => {
          const meta = parseMikhmon(p.onLogin);
          if (index % 2 === 0) buttons.push([]);
          buttons[buttons.length - 1].push({ text: `🎫 ${p.name} (${regional.currencySymbol()} ${meta.price})`, callback_data: `vouch_gen:${p.name}` });
        });
        buttons.push([{ text: '⬅️ Volver', callback_data: 'menu_vouch' }]);
        
        bot.sendMessage(chatId, '*📜 ELEGIR PLAN DE FICHA*\nHacé clic en un plan para crear el PIN:', { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }
    
    else if (data.startsWith('vouch_gen:')) {
      const profileName = data.split(':')[1];
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const profile = profiles.find(p => p.name === profileName);
        if (!profile) throw new Error('Perfil no encontrado');

        const meta = parseMikhmon(profile.onLogin);
        if (!meta) throw new Error('No se encontraron precio/duración del perfil (formato Mikhmon)');

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        
        await mikrotikSvc.addHotspotUser({
          server: 'all',
          name: pin,
          password: pin,
          profile: profileName,
          'limit-uptime': meta.validity,
          comment: `vc-${pin}-${profileName}`
        });
        
        let res = `*🎫 FICHA CREADA (INMEDIATA)*\n\n`;
        res += `🎫 CÓDIGO: \`${pin}\`\n`;
        res += `💰 Harga: ${regional.currencySymbol()} ${meta.price}\n`;
        res += `⏳ Durasi: ${meta.validity}\n`;
        res += `📦 Plan: ${profileName}\n`;
        res += `\n_Ingrese el código de arriba en la página de acceso del hotspot._`;
        
        bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error:' + e.message);
      }
    }
    
    bot.answerCallbackQuery(query.id);
  });

  // Custom Commands
  bot.onText(/\/vouch (\S+) (\S+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const [_, profile, limit, comment] = match;
    try {
      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      await mikrotikSvc.addHotspotUser({
        server: 'all', name: pin, password: pin, profile, 'limit-uptime': limit, comment
      });
      bot.sendMessage(msg.chat.id, `*🎫 FICHA CREADA*\n\n🎫 CÓDIGO: \`${pin}\`\n📦 Plan: ${profile}\n⏳ Límite: ${limit}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Error:' + e.message);
    }
  });

  bot.onText(/\/vcr\s+(\S+)\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const code = match[1];
    const profile = match[2];
    try {
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
      const comment = `vc ${code} ${dateStr}`;

      await mikrotikSvc.addHotspotUser({
        name: code,
        password: code,
        profile: profile,
        comment: comment
      });

      bot.sendMessage(chatId, `✅ Ficha hotspot *${code}* creada.\n\n👤 Usuario: \`${code}\`\n🔑 Clave: \`${code}\`\n📦 Perfil: *${profile}*\n📝 Comentario: *${comment}*`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo crear la ficha:' + e.message);
    }
  });

  bot.onText(/\/kick (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const user = match[1];
      await mikrotikSvc.kickPppoeUser(user);
      await mikrotikSvc.kickHotspotUser(user);
      bot.sendMessage(msg.chat.id, `✅ Sesión *${user}* desconectada.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Error:' + e.message);
    }
  });

  bot.onText(/\/editpppoe (\S+) (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const [_, user, profile] = match;
      await mikrotikSvc.setPppoeProfile(user, profile);
      bot.sendMessage(msg.chat.id, `✅ Perfil de *${user}* cambiado a *${profile}*.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Error:' + e.message);
    }
  });

  bot.onText(/\/cekpppoe (\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const username = match[1];
      const detail = await buildPppoeUserDetailText(username);
      bot.sendMessage(msg.chat.id, detail);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'No se pudo verificar el PPPoE:' + e.message);
    }
  });

  bot.onText(/\/cari (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const query = match[1].toLowerCase();
    const customers = customerSvc.getAllCustomers().filter(c => 
      c.name.toLowerCase().includes(query) || c.phone.includes(query)
    );
    
    if (customers.length === 0) return bot.sendMessage(msg.chat.id, `❌ Pelanggan dengan keyword "${query}" tidak ditemukan.`);
    
    let res = `*🔍 HASIL PENCARIAN (${customers.length})*\n\n`;
    customers.slice(0, 10).forEach(c => {
      res += `👤 *${c.name}*\n📞 ${c.phone}\n🚦 Status: ${c.status === 'active' ? '✅ Aktif' : '🚫 Terisolir'}\n\n`;
    });
    if (customers.length > 10) res += `_...y ${customers.length - 10} más._`;
    bot.sendMessage(msg.chat.id, res, { parse_mode: 'Markdown' });
  });


  // ── Monitoring (admin): helper + perintah /sistem /tunggakan /tiket /olt /trafik ──
  function tgSistemText() {
    const h = monitoringSvc.getHealthStatus();
    const m = (h && h.metrics) ? h.metrics : monitoringSvc.getAllMetrics();
    const sys = (m && m.system) || {};
    const cpu = (sys.cpu && sys.cpu.usage != null) ? sys.cpu.usage : '-';
    const cores = (sys.cpu && sys.cpu.cores) ? sys.cpu.cores : '-';
    const ram = (sys.memory && sys.memory.percentage != null) ? sys.memory.percentage : '-';
    const ramUsed = (sys.memory && sys.memory.used) ? sys.memory.used : '-';
    const ramTotal = (sys.memory && sys.memory.total) ? sys.memory.total : '-';
    const disk = (m && m.disk && m.disk.percentage) ? m.disk.percentage : '-';
    const la = sys.loadAverage || {};
    let t = `🖥️ *MONITOREO DEL SISTEMA*\n\n`;
    t += `⚙️ CPU : *${cpu}%* (${cores} core)\n`;
    t += `🧠 RAM : *${ram}%* (${ramUsed}/${ramTotal})\n`;
    t += `📀 Disk: *${disk}*\n`;
    t += `⏳ Load: ${la['1min'] != null ? la['1min'] : '-'} / ${la['5min'] != null ? la['5min'] : '-'} / ${la['15min'] != null ? la['15min'] : '-'}\n`;
    t += `🕒 Uptime: ${sys.uptime || '-'}\n`;
    if (h && h.issues && h.issues.length) t += `\n🔴 *Masalah:*\n- ${h.issues.join('\n- ')}`;
    if (h && h.warnings && h.warnings.length) t += `\n🟡 *Peringatan:*\n- ${h.warnings.join('\n- ')}`;
    return t;
  }

  function tgTunggakanText() {
    const row = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount - COALESCE(amount_paid,0)),0) s FROM invoices WHERE status='unpaid'").get();
    const top = db.prepare("SELECT c.name, COALESCE(c.customer_code,'-') code, SUM(i.amount) t FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.status='unpaid' GROUP BY i.customer_id ORDER BY t DESC LIMIT 8").all();
    let t = `💰 *DEUDAS*\n\nTotal: *${row.c} facturas*\nMonto: *${regional.currencySymbol()} ${Number(row.s).toLocaleString(regional.locale())}*\n`;
    if (top.length) { t += `\n*Top ${top.length}:*\n`; top.forEach((r, i) => { t += `${i + 1}. ${r.name} (${r.code}) — ${regional.currencySymbol()} ${Number(r.t).toLocaleString(regional.locale())}\n`; }); }
    return t;
  }

  function tgTiketText() {
    const s = ticketSvc.getTicketStats();
    const open = ticketSvc.getAllTickets('open') || [];
    let t = `🎫 *TICKETS*\n\nAbiertos: *${s.open}* · En curso: *${s.inProgress}* · Resueltos: *${s.resolved}*\n`;
    if (open.length) { t += `\n*Open terbaru:*\n`; open.slice(0, 8).forEach(x => { t += `#${x.id} ${x.subject} — ${x.customer_name || '-'}\n`; }); }
    return t;
  }

  async function tgOltText() {
    const o = await oltSvc.getAllOltsStats();
    let t = `📡 *OLT STATUS*\n\nONU total: *${o.onus_total}*\n🟢 Online: *${o.onus_online}*\n🔴 Offline: *${o.onus_offline}*\n🟡 Lemah: *${o.onus_weak}*\n`;
    if (o.error) t += `\n_Catatan: ${o.error}_`;
    return t;
  }

  async function tgTrafikText() {
    let count = 0;
    try { const map = await mikrotikSvc.getAllActiveSessionsMap(); count = (map && map.size != null) ? map.size : ((map && map.length) || 0); } catch (e) {}
    return `📶 *SESIONES ACTIVAS*\n\nPPPoE/hotspot en línea: *${count}* sesiones\n`;
  }

  const backBtn = { inline_keyboard: [[{ text: '⬅️ Volver', callback_data: 'menu_main' }]] };

  bot.onText(/\/(sistem|monitor|health)/i, async (msg) => {
    if (!isAdmin(msg)) return;
    try { bot.sendMessage(msg.chat.id, tgSistemText(), { parse_mode: 'Markdown', reply_markup: backBtn }); }
    catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });
  bot.onText(/\/tunggakan/i, async (msg) => {
    if (!isAdmin(msg)) return;
    try { bot.sendMessage(msg.chat.id, tgTunggakanText(), { parse_mode: 'Markdown', reply_markup: backBtn }); }
    catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });
  bot.onText(/\/tiket/i, async (msg) => {
    if (!isAdmin(msg)) return;
    try { bot.sendMessage(msg.chat.id, tgTiketText(), { parse_mode: 'Markdown', reply_markup: backBtn }); }
    catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });
  bot.onText(/\/(olt|oltstatus|olt-status)/i, async (msg) => {
    if (!isAdmin(msg)) return;
    bot.sendMessage(msg.chat.id, '📡 Leyendo el estado de la OLT, esperá…');
    try { bot.sendMessage(msg.chat.id, await tgOltText(), { parse_mode: 'Markdown', reply_markup: backBtn }); }
    catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });
  bot.onText(/\/(trafik|online)/i, async (msg) => {
    if (!isAdmin(msg)) return;
    try { bot.sendMessage(msg.chat.id, await tgTrafikText(), { parse_mode: 'Markdown', reply_markup: backBtn }); }
    catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });

  bot.onText(/\/(offline|pppoeoffline|pppoe-offline)/i, async (msg) => {
    if (!isAdmin(msg)) return;
    try { const snap = await loadPppoeSnapshot(); bot.sendMessage(msg.chat.id, buildOfflineTelegramText(snap)); }
    catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });
  bot.onText(/\/(aktif|pppoeonline|pppoe-online)/i, async (msg) => {
    if (!isAdmin(msg)) return;
    try {
      const snap = await loadPppoeSnapshot();
      const active = snap.active || [];
      let t = `🟢 *PPPoE EN LÍNEA*\n\nTotal activos: *${active.length}*\n`;
      active.slice(0, 20).forEach((s, i) => { t += `${i + 1}. ${(s && (s.name || s.user)) || '-'}\n`; });
      if (active.length > 20) t += `\n_...y ${active.length - 20} más._`;
      bot.sendMessage(msg.chat.id, t, { parse_mode: 'Markdown', reply_markup: backBtn });
    } catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });
  function tgPendapatanText() {
    const tr = billingSvc.getTodayRevenue();
    const today = Number((tr && tr.total != null) ? tr.total : (tr || 0)) || 0;
    const stats = billingSvc.getDashboardStats() || {};
    const month = Number(stats.thisMonth || 0);
    return `💰 *INGRESOS*\n\n📅 Hoy: *${regional.currencySymbol()} ${today.toLocaleString(regional.locale())}*\n🗓️ Este mes: *${regional.currencySymbol()} ${month.toLocaleString(regional.locale())}*\n⏳ Sin pagar: *${stats.unpaidCount || 0} facturas*\n`;
  }
  bot.onText(/\/(pendapatan|kas|revenue)/i, async (msg) => {
    if (!isAdmin(msg)) return;
    try { bot.sendMessage(msg.chat.id, tgPendapatanText(), { parse_mode: 'Markdown', reply_markup: backBtn }); }
    catch (e) { bot.sendMessage(msg.chat.id, 'Error:' + e.message); }
  });

  bot.onText(/\/cekterhubung\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const tag = match[1];
    try {
      let dev = null;
      try { dev = await customerDevice.findDeviceByTag(tag); } catch (e) {}
      if (!dev) { try { dev = await customerDevice.findDeviceWithTagVariants(tag); } catch (e) {} }
      if (!dev) return bot.sendMessage(chatId, '❌ Equipo/etiqueta "' + tag + '" no encontrado.');
      const m = customerDevice.mapDeviceData(dev, tag, false) || {};
      const st = String(m.status || '').toLowerCase() === 'online' ? '🟢 Online' : '🔴 Offline';
      let t = '📶 *CONECTADOS*\n\n';
      t += '🏷️ Tag: ' + tag + '\n';
      t += '📡 Status: ' + st + '\n';
      if (m.lastInform) t += '🕒 Last Inform: ' + m.lastInform + '\n';
      if (m.ssid && m.ssid !== '-') t += '📶 SSID: ' + m.ssid + '\n';
      bot.sendMessage(chatId, t, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, 'Error:' + e.message); }
  });

  bot.onText(/\/ringkasan/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      const stats = billingSvc.getDashboardStats();
      const formatter = new Intl.NumberFormat(regional.locale(), { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
      let res = `💰 *RINGKASAN BILLING*\n\n` +
        `📈 *Total Pendapatan:* ${formatter.format(stats.totalRevenue)}\n` +
        `📅 *Este mes:* ${formatter.format(stats.thisMonth)}\n` +
        `⏳ *Piutang (Pending):* ${formatter.format(stats.pendingAmount)}\n` +
        `🧾 *Facturas pendientes:* ${stats.unpaidCount}\n\n` +
        `💡 _Usá los otros comandos para ver el detalle._`;
      bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo obtener el resumen de facturación:' + e.message);
    }
  });

  bot.onText(/\/lunas(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const keyRaw = String(match[1] || '').trim();
    if (!keyRaw) return bot.sendMessage(chatId, '❌ Formato: `/lunas IDFACTURA` o `/lunas nombre/teléfono/pppoe/etiqueta`', { parse_mode: 'Markdown' });

    try {
      let targetInvId = null;
      let targetInv = null;
      const isNumeric = /^\d+$/.test(keyRaw);
      if (isNumeric) {
        targetInvId = Number(keyRaw);
        targetInv = billingSvc.getInvoiceById(targetInvId);
      }

      if (!targetInv) {
        let cust =
          (isNumeric ? customerSvc.getCustomerById(Number(keyRaw)) : null) ||
          customerSvc.findCustomerByAny(keyRaw);

        if (!cust) {
          const candidates = customerSvc.getAllCustomers(keyRaw) || [];
          const unique = Array.from(new Map(candidates.map(c => [c.id, c])).values());
          if (unique.length === 1) {
            cust = customerSvc.getCustomerById(unique[0].id);
          } else if (unique.length > 1) {
            const top = unique.slice(0, 5).map(c =>
              `- ID:${c.id} • ${c.name || '-'} • ${c.phone || '-'} • PPPoE:${c.pppoe_username || '-'}`
            ).join('\n');
            return bot.sendMessage(chatId, `⚠️ Nombre/ID poco específico. Se encontraron ${unique.length} clientes:\n\n${top}\n\nVolvé a enviar: \`/lunas IDCLIENTE\``);
          }
        }

        if (cust) {
          const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
          if (unpaid && unpaid.length > 0) {
            targetInv = unpaid[0];
            targetInvId = targetInv.id;
          } else {
            return bot.sendMessage(chatId, `✅ El cliente *${cust.name}* no tiene facturas pendientes.`, { parse_mode: 'Markdown' });
          }
        }
      }

      if (!targetInv) return bot.sendMessage(chatId, `❌ No se encontró la factura o el cliente *${keyRaw}*.`, { parse_mode: 'Markdown' });
      if (targetInvId != null) {
        const enriched = billingSvc.getInvoiceById(targetInvId);
        if (enriched) targetInv = enriched;
      }
      if (targetInv && targetInv.status === 'paid') {
        return bot.sendMessage(chatId, `✅ La factura *#${targetInv.id}* ya está PAGADA.`, { parse_mode: 'Markdown' });
      }

      billingSvc.markAsPaid(targetInvId, 'Telegram Bot Admin', 'Paid via Telegram Command');

      const customer = customerSvc.getCustomerById(targetInv.customer_id);
      const formatter = new Intl.NumberFormat(regional.locale(), { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
      const customerName = String(targetInv.customer_name || customer?.name || targetInv.customer_name || '-');
      const notifyTag = customer?.genieacs_tag || customer?.pppoe_username || customer?.phone || targetInv.customer_phone || targetInv.genieacs_tag || '';
      
      const appUrl = (getSetting('public_base_url', '') || '').replace(/\/$/, '');
      const portalUrl = appUrl ? `${appUrl}/customer` : '';
      const template = db.getAppSetting('whatsapp_payment_success_message', '');

      const waMessage = whatsappService.formatPaymentSuccessMessage({
        customerName,
        invoiceId: targetInvId,
        customerUsername: customer?.pppoe_username || customer?.id || '-',
        customerCode: customer?.customer_code || '',
        packageName: targetInv.package_name || '-',
        periodMonth: targetInv.period_month,
        periodYear: targetInv.period_year,
        amount: targetInv.amount,
        paymentMethod: 'Telegram Admin / Kasir',
        paidAt: new Date(),
        companyName: getSetting('company_header', 'OPEN-ISP'),
        companyPhone: getSetting('company_phone', ''),
        portalUrl,
        customTemplate: template
      });
      
      // Dynamic import of whatsappBot
      const waBot = await import('./whatsappBot.mjs').catch(() => null);
      let waNotifStatus = 'no enviado (WhatsApp desconectado)';

      if (customer && customer.status === 'suspended') {
        const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === targetInv.customer_id);
        const unpaidCount = freshCustomer && Number.isFinite(Number(freshCustomer.unpaid_count)) ? Number(freshCustomer.unpaid_count) : 1;
        if (unpaidCount === 0) {
          await customerSvc.activateCustomer(targetInv.customer_id);
          if (waBot && waBot.currentSock) {
            const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage + `\n\n🟢 Su servicio de internet ya está activo nuevamente.`);
            waNotifStatus = ok ? 'terkirim' : 'gagal';
          }
          await bot.sendMessage(chatId, `✅ Factura *#${targetInvId}* PAGADA. El cliente *${customerName}* fue rehabilitado automáticamente.\n📩 WhatsApp al cliente: ${waNotifStatus}`);
        } else {
          if (waBot && waBot.currentSock) {
            const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage + `\n\n⚠️ Todavía tiene ${unpaidCount} facturas pendientes.`);
            waNotifStatus = ok ? 'terkirim' : 'gagal';
          }
          await bot.sendMessage(chatId, `✅ Factura *#${targetInvId}* PAGADA. Quedan ${unpaidCount} facturas pendientes.\n📩 WhatsApp al cliente: ${waNotifStatus}`);
        }
      } else {
        if (waBot && waBot.currentSock) {
          const ok = await waBot.notifyCustomer(waBot.currentSock, null, notifyTag, waMessage);
          waNotifStatus = ok ? 'terkirim' : 'gagal';
        }
        await bot.sendMessage(chatId, `✅ Factura *#${targetInvId}* (de ${customerName}) marcada como PAGADA.\n📩 WhatsApp al cliente: ${waNotifStatus}`);
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo actualizar el estado:' + e.message);
    }
  });

  bot.onText(/\/generate\s+(\d+)\s+(\d+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const month = Number(match[1]);
    const year = Number(match[2]);
    try {
      const res = billingSvc.generateMonthlyInvoices(month, year);
      bot.sendMessage(chatId, `✅ Facturas generadas para el período *${month}/${year}*.\n🧾 Cantidad: ${res.generatedCount} facturas nuevas.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudieron generar las facturas:' + e.message);
    }
  });

  bot.onText(/\/isolir(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const targetId = String(match[1] || '').trim();
    if (!targetId) return bot.sendMessage(chatId, '❌ Formato: `/isolir ID/Nombre/PPPoE/Teléfono`');
    try {
      const cust = customerSvc.findCustomerByAny(targetId);
      if (!cust) return bot.sendMessage(chatId, `❌ No se encontró el cliente *${targetId}*.`, { parse_mode: 'Markdown' });
      await customerSvc.suspendCustomer(cust.id);
      bot.sendMessage(chatId, `✅ Se cortó el servicio de *${cust.name}* (ID: ${cust.id}).`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo cortar:' + e.message);
    }
  });

  bot.onText(/\/buka(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const targetId = String(match[1] || '').trim();
    if (!targetId) return bot.sendMessage(chatId, '❌ Formato: `/buka ID/Nombre/PPPoE/Teléfono`');
    try {
      const cust = customerSvc.findCustomerByAny(targetId);
      if (!cust) return bot.sendMessage(chatId, `❌ No se encontró el cliente *${targetId}*.`, { parse_mode: 'Markdown' });
      await customerSvc.activateCustomer(cust.id);
      bot.sendMessage(chatId, `✅ Se rehabilitó el servicio de *${cust.name}* (ID: ${cust.id}).`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo rehabilitar al cliente:' + e.message);
    }
  });

  bot.onText(/\/listonu/i, async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    try {
      let res = await customerDevice.listDevicesWithTags(50);
      if (!res.ok || res.devices.length === 0) {
        res = await customerDevice.listAllDevices(50);
      }
      if (!res.ok || res.devices.length === 0) {
        return bot.sendMessage(chatId, '📭 No se detectaron ONU en GenieACS.');
      }
      let txt = `*📡 LISTA DE ONU (GenieACS)*\n\n`;
      res.devices.forEach(d => {
        const id = d._id || 'Unknown ID';
        const tags = Array.isArray(d._tags) ? d._tags.join(', ') : (d._tags || '-');
        txt += `• \`${id}\`\n  └ Tag: ${tags}\n`;
      });
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo listar las ONU:' + e.message);
    }
  });

  bot.onText(/\/(?:info|cekstatus)\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;
      
      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ No se encontró *${inputTag}* en GenieACS.`);
      }
      
      const data = await customerDevice.getCustomerDeviceData(targetTag);
      let t = `*📡 DETALLE DE ONU: ${data.lokasi || targetTag}*\n\n`;
      t += `🟢 Status: ${data.status || '-'}\n`;
      t += `📶 SSID: ${data.ssid || '-'}\n`;
      t += `⏱️ Last Inform: ${data.lastInform || '-'}\n`;
      t += `📡 RX Power: ${data.rxPower || '-'}\n`;
      t += `🌐 PPPoE IP: ${data.pppoeIP || '-'}\n`;
      t += `👤 PPPoE User: ${data.pppoeUsername || '-'}\n`;
      t += `⏳ Uptime: ${data.uptime || '-'}\n`;
      t += `⏳ PPPoE Uptime: ${data.pppoeUptime || '-'}\n`;
      t += `📱 User WiFi: ${data.totalAssociations || '0'}\n`;
      t += `🔧 Model: ${data.model || '-'}\n`;
      t += `🏷️ Serial Number: ${data.serialNumber || '-'}\n`;
      t += `💾 Firmware: ${data.softwareVersion || '-'}`;
      bot.sendMessage(chatId, t, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo verificar el estado de la ONU:' + e.message);
    }
  });

  bot.onText(/\/reboot\s+(\S+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ No se encontró *${inputTag}* en GenieACS.`);
      }

      await bot.sendMessage(chatId, `⏳ Mencoba me-reboot ONU *${targetTag}*...`, { parse_mode: 'Markdown' });
      const ok = await customerDevice.rebootDevice(targetTag);
      if (ok) {
        bot.sendMessage(chatId, `✅ Se envió la orden de reinicio a la ONU *${targetTag}*.`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ No se pudo reiniciar la ONU *${targetTag}*.`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo reiniciar la ONU:' + e.message);
    }
  });

  bot.onText(/\/gantissid\s+(\S+)\s+(.+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    const newSSID = match[2];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ No se encontró *${inputTag}* en GenieACS.`);
      }

      await bot.sendMessage(chatId, `⏳ Cambiando el SSID de *${targetTag}* a *${newSSID}*...`, { parse_mode: 'Markdown' });
      const ok = await customerDevice.updateSSID(targetTag, newSSID);
      if (ok) {
        bot.sendMessage(chatId, `✅ SSID de *${targetTag}* cambiado a *${newSSID}*.`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ No se pudo cambiar el SSID de *${targetTag}*.`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo cambiar el SSID:' + e.message);
    }
  });

  bot.onText(/\/gantisandi\s+(\S+)\s+(.+)/i, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const inputTag = match[1];
    const newPass = match[2];
    try {
      const cust = customerSvc.findCustomerByAny(inputTag);
      const targetTag = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone || inputTag) : inputTag;

      const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
      if (!targetDevice) {
        return bot.sendMessage(chatId, `❌ No se encontró *${inputTag}* en GenieACS.`);
      }

      if (newPass.length < 8) {
        return bot.sendMessage(chatId, `⚠️ La contraseña del WiFi debe tener al menos 8 caracteres.`);
      }

      await bot.sendMessage(chatId, `⏳ Cambiando la contraseña del WiFi de *${targetTag}*...`);
      const ok = await customerDevice.updatePassword(targetTag, newPass);
      if (ok) {
        bot.sendMessage(chatId, `✅ Contraseña del WiFi de *${targetTag}* cambiada a: \`${newPass}\``, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `❌ No se pudo cambiar la contraseña del WiFi de *${targetTag}*.`);
      }
    } catch (e) {
      bot.sendMessage(chatId, '❌ No se pudo cambiar la contraseña del WiFi:' + e.message);
    }
  });

  bot.on('polling_error', (error) => {
    logger.error('Telegram Polling Error:', error.message);
  });
}

// Export for manual re-init from settings
async function notifyAdmin(text) {
  try {
    const adminId = String(getSetting('telegram_admin_id', '') || '').trim();
    if (!bot || !adminId || !text) return false;
    const ids = adminId.split(/[,s]+/).filter(Boolean);
    let ok = false;
    for (const id of ids) {
      try { await bot.sendMessage(id, text, { parse_mode: 'Markdown' }); ok = true; }
      catch (e) { try { await bot.sendMessage(id, String(text)); ok = true; } catch (e2) {} }
    }
    return ok;
  } catch (e) { return false; }
}

module.exports = { initTelegram, notifyAdmin };
