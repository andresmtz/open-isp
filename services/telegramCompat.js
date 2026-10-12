/**
 * Adapter node-telegram-bot-api v1 -> v2.
 * v2 (>=2.0) tidak kompatibel dengan v1 (bot.onText, bot.sendMessage(chatId, text, opts), ...).
 * Adapter ini menyediakan permukaan API v1 yang dipakai services/telegramBot.js,
 * sehingga file itu tak perlu dirombak. Terisolasi di sini agar mudah dirawat.
 */
const { Bot } = require('node-telegram-bot-api');

class CompatBot {
  constructor(token) {
    this.token = token;
    this._bot = new Bot(token);
    this._msgHandlers = [];
    this._textHandlers = [];
    this._cbHandlers = [];
    this._errHandlers = [];

    // v2 = middleware (bukan EventEmitter). Satu middleware meneruskan ke semua handler v1.
    this._bot.on('message', (ctx) => this._dispatchMessage(ctx));
    this._bot.on('callback_query', (ctx) => this._dispatchCallback(ctx));

    // v1 `{ polling: true }` autostart; ditunda agar handler selesai didaftarkan lebih dulu.
    setImmediate(() => this.startPolling());
  }

  _run(handler, args) {
    try {
      const r = handler(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => this._emitError(e));
    } catch (e) {
      this._emitError(e);
    }
  }

  _dispatchMessage(ctx) {
    const msg = ctx.message;
    if (!msg) return;
    for (const h of this._msgHandlers) this._run(h, [msg]);
    if (typeof msg.text === 'string') {
      for (const { re, h } of this._textHandlers) {
        const m = msg.text.match(re);
        if (m) this._run(h, [msg, m]);
      }
    }
  }

  _dispatchCallback(ctx) {
    const q = ctx.callbackQuery;
    if (!q) return;
    for (const h of this._cbHandlers) this._run(h, [q]);
  }

  _emitError(e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (this._errHandlers.length) {
      for (const h of this._errHandlers) { try { h(err); } catch (_) {} }
    } else {
      console.error('Telegram error:', err.message);
    }
  }

  on(kind, handler) {
    if (kind === 'message') this._msgHandlers.push(handler);
    else if (kind === 'callback_query') this._cbHandlers.push(handler);
    else if (kind === 'polling_error' || kind === 'error') {
      this._errHandlers.push(handler);
      this._bot.catch((err) => this._emitError(err));
    }
    return this;
  }

  onText(re, handler) { this._textHandlers.push({ re, h: handler }); return this; }

  sendMessage(chatId, text, opts) { return this._bot.api.sendMessage({ chat_id: chatId, text, ...(opts || {}) }); }
  editMessageText(text, opts) { return this._bot.api.editMessageText({ text, ...(opts || {}) }); }
  answerCallbackQuery(id, opts) { return this._bot.api.answerCallbackQuery({ callback_query_id: id, ...(opts || {}) }); }
  getMe() { return this._bot.api.getMe(); }
  deleteWebHook() { return this._bot.api.deleteWebhook({}); }
  stopPolling() { try { this._bot.stop(); } catch (e) {} }
  startPolling() { this._bot.startPolling().catch((e) => this._emitError(e)); }
  isPolling() { return this._bot.isRunning(); }
}

module.exports = { CompatBot };
