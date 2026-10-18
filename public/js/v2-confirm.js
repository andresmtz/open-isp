/* v2-confirm.js — Diseño nuevo: reemplaza la ventana de confirmación del navegador (confirm) por una propia,
   con el mismo estilo del sistema y en los dos temas, sin tocar cada pantalla.

   confirm() del navegador detiene todo hasta que se responde; una ventana propia no puede hacer eso. Por eso:
   cuando la confirmación viene de un clic, del envío de un formulario o de un cambio en una lista, se cancela esa
   acción, se muestra la ventana nueva y, si se acepta, se repite la misma acción (esta vez el sistema ya la da por
   confirmada). Si la confirmación aparece en otro momento (por ejemplo, después de una espera), se usa la del
   navegador como antes, para no romper nada. */
(function () {
  'use strict';
  if (window.__v2Confirm) return;
  window.__v2Confirm = true;
  var nativeConfirm = window.confirm.bind(window);
  var accepted = [], clearT = null, open = false;

  var css = '' +
    '.v2c-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(20,18,15,.38);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;animation:v2cF .16s ease}' +
    '.v2c-box{width:min(440px,100%);background:var(--v2-solid,var(--v2p-card-solid,#f6f4ef));color:var(--v2-text,var(--text,#17191a));border-radius:28px;box-shadow:0 24px 60px -18px rgba(40,30,20,.45),0 2px 6px rgba(40,30,20,.1);padding:22px 22px 18px;font-family:Urbanist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;animation:v2cU .22s cubic-bezier(.2,.8,.2,1)}' +
    '.v2c-ic{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;font-size:20px;margin-bottom:12px;background:rgba(23,25,26,.07)}' +
    '.v2c-ic.danger{background:rgba(200,67,31,.12);color:#c8431f}' +
    '.v2c-t{font-size:17px;font-weight:700;letter-spacing:-.01em;margin:0 0 6px}' +
    '.v2c-m{font-size:14px;line-height:1.5;white-space:pre-line;opacity:.85;max-height:50vh;overflow:auto}' +
    '.v2c-b{display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}' +
    '.v2c-b button{height:42px;padding:0 20px;border-radius:999px;font:700 14px Urbanist,ui-sans-serif,system-ui,sans-serif;cursor:pointer;border:1px solid rgba(23,25,26,.14);background:transparent;color:inherit}' +
    '.v2c-b button:hover{background:rgba(23,25,26,.06)}' +
    '.v2c-b .ok{background:#17191a;color:#fbf8f2;border-color:transparent}' +
    '.v2c-b .ok:hover{background:#17191a;transform:translateY(-1px)}' +
    '.v2c-b .ok.danger{background:#c8431f;color:#fbf8f2}' +
    '[data-theme="dark"] .v2c-box,html.dark .v2c-box{background:#1c201e;color:#f1eee8;box-shadow:0 24px 60px -18px rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.08)}' +
    '[data-theme="dark"] .v2c-ic,html.dark .v2c-ic{background:rgba(255,255,255,.08)}' +
    '[data-theme="dark"] .v2c-b button,html.dark .v2c-b button{border-color:rgba(255,255,255,.16)}' +
    '[data-theme="dark"] .v2c-b button:hover,html.dark .v2c-b button:hover{background:rgba(255,255,255,.08)}' +
    '[data-theme="dark"] .v2c-b .ok,html.dark .v2c-b .ok{background:#f1eee8;color:#17191a}' +
    '[data-theme="dark"] .v2c-b .ok.danger,html.dark .v2c-b .ok.danger{background:#d8532d;color:#fbf8f2}' +
    '@keyframes v2cF{from{opacity:0}to{opacity:1}}@keyframes v2cU{from{transform:translateY(10px) scale(.98)}to{transform:none}}' +
    '@media (prefers-reduced-motion:reduce){.v2c-ov,.v2c-box{animation:none}}';
  var st = document.createElement('style'); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  var DANGER = /borr|elimin|cancel|vaciar|deshacer|quitar|retir|desactiv|cortar|suspend|ocultar|reiniciar|reboot|desconect|baja/i;
  function dialog(msg, onOk) {
    open = true;
    var danger = DANGER.test(msg);
    var ov = document.createElement('div'); ov.className = 'v2c-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    var box = document.createElement('div'); box.className = 'v2c-box';
    box.innerHTML = '<div class="v2c-ic' + (danger ? ' danger' : '') + '"><i class="bi ' + (danger ? 'bi-exclamation-triangle' : 'bi-question-lg') + '"></i></div>' +
      '<div class="v2c-t">' + (danger ? 'Confirmá antes de seguir' : 'Confirmar') + '</div><div class="v2c-m"></div>' +
      '<div class="v2c-b"><button type="button" class="no">Cancelar</button><button type="button" class="ok' + (danger ? ' danger' : '') + '">Aceptar</button></div>';
    box.querySelector('.v2c-m').textContent = msg;
    ov.appendChild(box); document.body.appendChild(ov);
    var prev = document.activeElement;
    var close = function (ok) {
      document.removeEventListener('keydown', key, true);
      ov.remove(); open = false;
      try { if (prev && prev.focus) prev.focus({ preventScroll: true }); } catch (_) {}
      if (ok) onOk(); else { accepted = []; }
    };
    var key = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    document.addEventListener('keydown', key, true);
    box.querySelector('.no').onclick = function () { close(false); };
    box.querySelector('.ok').onclick = function () { close(true); };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(false); });
    setTimeout(function () { box.querySelector('.ok').focus(); }, 30);
  }

  // Repite la acción que pidió la confirmación
  function replay(ev, el) {
    if (ev.type === 'submit') {
      var f = el.closest ? el.closest('form') : el;
      if (f && f.requestSubmit) { try { f.requestSubmit(ev.submitter || undefined); return; } catch (_) {} }
      if (f) f.submit();
    } else if (ev.type === 'change' || ev.type === 'input') {
      el.dispatchEvent(new Event(ev.type, { bubbles: true }));
    } else {
      el.click();
    }
  }

  // Confirmaciones ya aceptadas: valen solo para el mismo elemento y por unos segundos (cadena de varias preguntas)
  var replaying = false;
  window.confirm = function (message) {
    var msg = String(message == null ? '' : message);
    var ev = window.event;
    var t = ev && ev.type;
    var target = ev && ev.target;
    for (var i = 0; i < accepted.length; i++) if (accepted[i].msg === msg && target && (accepted[i].el === target || (accepted[i].el.contains && accepted[i].el.contains(target)) || (target.contains && target.contains(accepted[i].el)))) return true;
    if (open || !document.body || !ev || ['click', 'submit', 'change', 'input'].indexOf(t) === -1 || !target || target.nodeType !== 1 || (ev.isTrusted === false && !replaying && t !== 'submit')) return nativeConfirm(msg);
    var el = target;
    dialog(msg, function () {
      accepted.push({ msg: msg, el: el });
      clearTimeout(clearT); clearT = setTimeout(function () { accepted = []; }, 4000);
      replaying = true;
      try { replay(ev, el); } finally { replaying = false; }
    });
    return false;
  };
})();
