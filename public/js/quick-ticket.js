/* quick-ticket.js — "Crear asistencia" desde el monitoreo de ONU o la lista de clientes.
 * Uso: quickTicket({ customerId | pppoe | tag, subject, detail })
 */
(function () {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var MOTIVOS = ['Sin internet', 'Revisar señal óptica (potencia)', 'Internet lento / se corta', 'Problema con el WiFi', 'Cambio o reubicación de equipo', 'Revisar cableado / fibra', 'Otro'];
  var state = {};

  function modal() {
    var m = document.getElementById('qtModal');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'mo'; m.id = 'qtModal';
    m.innerHTML =
      '<div class="mb" style="max-width:540px">' +
      '<div class="mh"><span class="mt"><i class="bi bi-tools"></i> Crear asistencia técnica</span><button type="button" class="mc" data-qt-close>&times;</button></div>' +
      '<div class="mbody">' +
      '<div id="qtCust" style="font-size:13px;margin-bottom:10px"></div>' +
      '<div id="qtOpen"></div>' +
      '<div class="fg"><label class="fl">Motivo *</label><select class="fs" id="qtMotivo"></select></div>' +
      '<div class="fg"><label class="fl">Asunto *</label><input class="fc" id="qtSubject" maxlength="150"></div>' +
      '<div class="fg"><label class="fl">Detalle para el técnico *</label><textarea class="fc" id="qtDetail" rows="5" maxlength="2000"></textarea></div>' +
      '<div class="fg"><label class="fl">Técnico</label><select class="fs" id="qtTech"></select><div class="text-muted" style="font-size:11px;margin-top:3px">Sin asignar: se avisa a los técnicos que pueden tomar reclamos.</div></div>' +
      '</div>' +
      '<div class="mf"><button type="button" class="btn btn-g" data-qt-close>Cancelar</button><button type="button" class="btn btn-p" id="qtSave"><i class="bi bi-send"></i> Crear y avisar</button></div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-qt-close]')) m.classList.remove('show'); });
    m.querySelector('#qtMotivo').addEventListener('change', function () {
      var v = this.value; if (v && v !== 'Otro') m.querySelector('#qtSubject').value = v + (state.extra ? ' ' + state.extra : '');
    });
    m.querySelector('#qtSave').addEventListener('click', save);
    return m;
  }

  function toast(ok, t) { if (window.notify) window.notify(ok ? 'success' : 'error', ok ? 'Listo' : 'Error', t); else alert(t); }

  function save() {
    var m = modal(), b = m.querySelector('#qtSave');
    var body = Object.assign({}, state.key, {
      subject: m.querySelector('#qtSubject').value, message: m.querySelector('#qtDetail').value, technician_id: m.querySelector('#qtTech').value,
    });
    b.disabled = true;
    fetch('/admin/tickets/quick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) { b.disabled = false; toast(d.ok, d.message); if (d.ok) m.classList.remove('show'); })
      .catch(function () { b.disabled = false; toast(false, 'No se pudo crear la asistencia'); });
  }

  window.quickTicket = function (opts) {
    opts = opts || {};
    var key = opts.customerId ? { customer_id: opts.customerId } : (opts.pppoe ? { pppoe: opts.pppoe, tag: opts.tag || '' } : { tag: opts.tag || '' });
    var qs = Object.keys(key).map(function (k) { return k + '=' + encodeURIComponent(key[k]); }).join('&');
    fetch('/admin/tickets/quick-info?' + qs).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return toast(false, d.message);
      state = { key: { customer_id: d.customer.id }, extra: opts.extra || '' };
      var m = modal();
      m.querySelector('#qtCust').innerHTML = '<b>' + esc(d.customer.name) + '</b> <span class="text-muted">' + esc(d.customer.code || '') + ' · ' + esc(d.customer.phone || '') + '</span>' +
        (d.customer.address ? '<div class="text-muted" style="font-size:12px"><i class="bi bi-geo-alt"></i> ' + esc(d.customer.address) + '</div>' : '');
      m.querySelector('#qtOpen').innerHTML = (d.open || []).length
        ? '<div class="alert alert-w" style="font-size:12.5px"><i class="bi bi-exclamation-triangle"></i> Ya tiene ' + d.open.length + ' asistencia(s) abierta(s): ' +
          d.open.map(function (t) { return '#' + t.id + ' ' + esc(t.subject); }).join(' · ') + '. Revisá que no sea el mismo problema.</div>'
        : '';
      var mo = m.querySelector('#qtMotivo');
      var pre = opts.motivo && MOTIVOS.indexOf(opts.motivo) !== -1 ? opts.motivo : '';
      mo.innerHTML = '<option value="">— Elegí —</option>' + MOTIVOS.map(function (x) { return '<option' + (x === pre ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('');
      m.querySelector('#qtSubject').value = opts.subject || (pre ? pre + (opts.extra ? ' ' + opts.extra : '') : '');
      m.querySelector('#qtDetail').value = opts.detail || '';
      m.querySelector('#qtTech').innerHTML = '<option value="">— Sin asignar —</option>' + (d.techs || []).map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + (t.area ? ' (' + esc(t.area) + ')' : '') + '</option>'; }).join('');
      m.classList.add('show');
    }).catch(function () { toast(false, 'No se pudo abrir la asistencia'); });
  };
})();
