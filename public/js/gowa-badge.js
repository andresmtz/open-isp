/* gowa-badge.js — versión de WhatsApp (GoWA) en la barra superior, junto al estado del servicio (solo administrador). */
(function () {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var st = null;
  function badge() {
    var a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.setAttribute('data-gowa-badge', '1');
    var cls = 'sn-badge-normal', icon = 'bi-whatsapp', label = 'WhatsApp ' + (st ? st.current : '…'), title = 'Versión de WhatsApp (GoWA)';
    if (st) {
      if (st.job && st.job.ok === null) { cls = 'sn-badge-warn sn-badge-pulse'; icon = 'bi-hourglass-split'; label = 'WhatsApp: actualizando…'; title = st.job.message || ''; }
      else if (st.connected === false || st.loggedIn === false) { cls = 'sn-badge-danger sn-badge-pulse'; label = 'WhatsApp desconectado'; title = 'WhatsApp no está conectado: los avisos no se envían'; }
      else if (st.updateAvailable) { cls = 'sn-badge-warn sn-badge-pulse'; icon = 'bi-arrow-up-circle-fill'; label = 'WhatsApp ' + st.current + ' · ' + st.latest + ' disponible'; title = 'Hay una actualización de WhatsApp (GoWA)'; }
      else { cls = 'sn-badge-primary'; title = 'WhatsApp conectado · versión al día'; }
    }
    a.className = 'sn-badge ' + cls;
    a.title = title;
    a.innerHTML = '<i class="bi ' + icon + '"></i><span>' + esc(label) + '</span>';
    a.addEventListener('click', details);
    return a;
  }
  function details() {
    if (!st) return;
    var h = '<div style="text-align:left;font-size:13px;line-height:1.6">'
      + '<b>Versión en uso:</b> ' + esc(st.current) + '<br>'
      + '<b>Última publicada:</b> ' + esc(st.latest || '—') + (st.latestDate ? ' (' + esc(st.latestDate) + ')' : '') + '<br>'
      + '<b>Conexión:</b> ' + (st.connected && st.loggedIn ? '✅ conectado' : '❌ desconectado — revisá WhatsApp → Conexión') + '<br>';
    var job = st.job;
    if (job && job.ok === null) h += '<br>⏳ <b>Actualizando a ' + esc(job.to) + ':</b> ' + esc(job.message);
    else if (st.updateAvailable) {
      h += '<br>⬆️ <b>Hay una actualización disponible.</b>' + (st.majorChange ? ' Es un cambio de versión mayor: conviene leer las novedades antes.' : '')
        + '<br>Se respalda la sesión antes de cambiar (no hay que volver a escanear el QR). WhatsApp se detiene unos 30 segundos. Si la versión nueva no arranca, vuelve sola a la anterior.';
      if (st.updaterReady) h += '<br><button type="button" id="gowaUpdBtn" class="btn btn-p btn-sm" style="margin-top:8px"><i class="bi bi-arrow-up-circle"></i> Actualizar a ' + esc(st.latest) + '</button>';
      else h += '<br><i>El actualizador del servidor no responde: no se puede aplicar desde acá.</i>';
    } else if (st.latest) h += '<br>✅ Está al día.';
    if (job && job.ok !== null && job.at && Date.now() - new Date(job.at).getTime() < 24 * 3600 * 1000) h += '<br><span style="font-size:12px">' + (job.ok ? '✅' : '⚠️') + ' Última actualización: ' + esc(job.message) + '</span>';
    if (st.latestUrl) h += '<br><a href="' + esc(st.latestUrl) + '" target="_blank" rel="noopener">Ver novedades de ' + esc(st.latest) + '</a>';
    h += '</div>';
    if (window.notify) window.notify(st.updateAvailable ? 'warning' : 'info', 'WhatsApp (GoWA)', h, { duration: 0 });
    var b = document.getElementById('gowaUpdBtn');
    if (b) b.addEventListener('click', function () { update(st.latest); });
  }
  function update(target) {
    if (!confirm('¿Actualizar WhatsApp (GoWA) a ' + target + '?\n\nSe respalda la sesión, WhatsApp se detiene unos 30 segundos y, si la versión nueva no arranca, vuelve sola a la anterior.')) return;
    fetch('/admin/gowa/update', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ target: target }) })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { window.notify('error', 'No se pudo actualizar', esc(j.message || 'Error')); return; }
        poll(0);
      }).catch(function (e) { window.notify('error', 'Error', esc(e.message)); });
  }
  function poll(n) {
    fetch('/admin/gowa/status', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { st = j; place(); }
      var job = j && j.job;
      if (job && job.ok === null && n < 60) { window.notifyLoading('⏳ ' + esc(job.message), 'Actualizando WhatsApp'); setTimeout(function () { poll(n + 1); }, 4000); return; }
      if (job && job.ok === true) window.notify('success', 'WhatsApp actualizado', esc(job.message) + (j.connected && j.loggedIn ? '<br>✅ Conectado.' : '<br>⏳ Reconectando… revisá en un minuto.'), { duration: 0 });
      else if (job && job.ok === false) window.notify('error', 'No se actualizó', esc(job.message), { duration: 0 });
      else window.notify('warning', 'Sin respuesta del servidor', 'El pedido quedó enviado; revisá el indicador en unos minutos.');
    }).catch(function () { setTimeout(function () { poll(n + 1); }, 4000); });
  }
  function place() {
    var ex = document.querySelector('[data-gowa-badge]');
    if (ex) { ex.replaceWith(badge()); return true; }
    var notice = document.querySelector('[data-notice-badge]');
    var target = document.querySelector('.topbar .tb-right') || document.querySelector('.tb-right');
    if (!target) return false;
    var b = badge();
    if (notice && notice.parentNode === target) notice.insertAdjacentElement('afterend', b); else target.insertBefore(b, target.firstChild);
    return true;
  }
  function load() {
    fetch('/admin/gowa/status', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) { st = j; place(); } }).catch(function () {});
  }
  function init() {
    var tries = 0;
    var t = setInterval(function () { if (document.querySelector('[data-notice-badge]') || ++tries > 15) { clearInterval(t); place(); load(); } }, 300);
    setInterval(load, 5 * 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
