/**
 * Cobro rápido (ventana "Registrar pago"): lo usan la lista de clientes y "Pagos pendientes".
 * Muestra la deuda del cliente, propone el total y registra el cobro (total o parcial) en
 * POST /admin/customers/:id/receive, que también envía el comprobante por WhatsApp.
 * Necesita fmtMoney (lo inyecta el servidor en cada página).
 */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const METHODS = ['Transferencia', 'Efectivo', 'Giro', 'Depósito', 'Otro'];
  const MKEY = 'receive-last-method';
  const lastMethod = () => { try { return localStorage.getItem(MKEY) || METHODS[0]; } catch (_) { return METHODS[0]; } };
  const saveMethod = (m) => { try { localStorage.setItem(MKEY, m); } catch (_) {} };
  const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const periodo = p => { const [m, y] = String(p || '').split('/'); return MESES[Number(m) - 1] ? MESES[Number(m) - 1] + ' ' + y : p; };

  async function openReceive(id, opts) {
    opts = opts || {};
    try {
      const info = await (await fetch('/admin/customers/' + id + '/payment-info', { headers: { Accept: 'application/json' } })).json();
      if (!info.ok) { alert(info.message || 'Error'); return; }
      const d = info.debt;
      const old = document.getElementById('rcv-modal'); if (old) old.remove();
      const rows = d.items.length ? d.items.map(i => '<tr><td>' + esc(periodo(i.period)) + '</td><td style="text-align:right">' + fmtMoney(i.amount) + '</td><td style="text-align:right">' + (i.paid ? fmtMoney(i.paid) : '-') + '</td><td style="text-align:right;font-weight:700">' + fmtMoney(i.balance) + '</td></tr>').join('')
        : '<tr><td colspan="4" style="text-align:center;color:var(--muted)">Sin deuda (lo que cobres queda como saldo a favor)</td></tr>';
      const lm = lastMethod();
      const m = document.createElement('div');
      m.id = 'rcv-modal';
      m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px';
      m.innerHTML = '<div class="card" style="max-width:520px;width:100%;max-height:92vh;overflow:auto;margin:0">'
        + '<div class="card-hd"><h6><i class="bi bi-cash-coin"></i> Registrar pago — ' + esc(info.customer.name) + '</h6></div>'
        + '<div style="padding:14px">'
        + '<table class="dtbl" style="width:100%;font-size:12px"><thead><tr><th>Mes</th><th style="text-align:right">Monto</th><th style="text-align:right">Pagado</th><th style="text-align:right">Debe</th></tr></thead><tbody>' + rows + '</tbody></table>'
        + '<div style="display:flex;justify-content:space-between;margin:10px 0;font-weight:800;font-size:15px"><span>Deuda total</span><span>' + fmtMoney(d.total) + '</span></div>'
        + (d.credit > 0 ? '<div style="display:flex;justify-content:space-between;margin-bottom:10px;color:#10b981;font-weight:700"><span><i class="bi bi-piggy-bank"></i> Saldo a favor</span><span>' + fmtMoney(d.credit) + '</span></div>' : '')
        + '<div class="fg"><label class="fl">Monto recibido</label><input class="fc" id="rcv-amount" type="number" inputmode="numeric" min="0" step="1" style="font-size:18px;font-weight:700" value="' + Math.max(0, d.total - (d.credit || 0)) + '"></div>'
        + (d.credit > 0 && d.total > 0 ? '<label style="display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" id="rcv-credit" checked> Usar saldo a favor</label>' : '')
        + '<div class="fg"><label class="fl">Forma de pago</label><div id="rcv-methods" style="display:flex;gap:6px;flex-wrap:wrap">'
        + METHODS.map(x => '<button type="button" class="btn btn-sm ' + (x === lm ? 'btn-p' : 'btn-g') + '" data-m="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div></div>'
        + ((info.destinations || []).length ? '<div class="fg" id="rcv-dest-wrap"><label class="fl">¿A qué cuenta o billetera entró?</label><div id="rcv-dests" style="display:flex;gap:6px;flex-wrap:wrap">'
          + info.destinations.map(x => '<button type="button" class="btn btn-sm btn-g" data-d="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div></div>' : '')
        + '<div class="fg"><label class="fl">Nota (opcional)</label><input class="fc" id="rcv-note" placeholder="Ej.: comprobante 1234"></div>'
        + '<div class="hint" id="rcv-hint" style="margin:8px 0"></div>'
        + (d.carryOver > 0 ? '<div class="hint" style="margin-bottom:8px">Saldo trasladado pendiente (se suma a la próxima factura): <b>' + fmtMoney(d.carryOver) + '</b></div>' : '')
        + '<div style="font-size:12px;color:var(--muted);margin-bottom:6px"><i class="bi bi-whatsapp"></i> Al registrar, el cliente recibe el comprobante por WhatsApp y, si queda sin deuda, se le habilita el servicio.</div>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px"><button class="btn btn-g" type="button" id="rcv-cancel">Cancelar</button>'
        + '<button class="btn btn-g" type="button" id="rcv-act" style="display:none" title="Habilita el servicio; lo que falta se suma a la factura del próximo mes"><i class="bi bi-wifi"></i> Cobrar y activar</button>'
        + '<button class="btn btn-p" type="button" id="rcv-ok" style="min-width:150px"><i class="bi bi-check2"></i> Registrar pago</button></div>'
        + '</div></div>';
      document.body.appendChild(m);
      let method = lm, destination = '';
      const destWrap = m.querySelector('#rcv-dest-wrap');
      const showDest = () => { if (destWrap) destWrap.style.display = method === 'Efectivo' ? 'none' : ''; };
      m.querySelectorAll('#rcv-methods button').forEach(b => b.onclick = () => {
        method = b.dataset.m;
        m.querySelectorAll('#rcv-methods button').forEach(x => { x.classList.toggle('btn-p', x === b); x.classList.toggle('btn-g', x !== b); });
        showDest();
      });
      m.querySelectorAll('#rcv-dests button').forEach(b => b.onclick = () => {
        destination = destination === b.dataset.d ? '' : b.dataset.d;
        m.querySelectorAll('#rcv-dests button').forEach(x => { const on = x.dataset.d === destination; x.classList.toggle('btn-p', on); x.classList.toggle('btn-g', !on); });
      });
      showDest();
      const amt = m.querySelector('#rcv-amount'), cr = m.querySelector('#rcv-credit'), hint = m.querySelector('#rcv-hint');
      const btnAct = m.querySelector('#rcv-act'), btnOk = m.querySelector('#rcv-ok');
      const upd = () => {
        const a = Math.max(0, Number(amt.value) || 0) + (cr && cr.checked ? d.credit : 0);
        const partial = d.total > 0 && a < d.total && Number(amt.value) > 0;
        if (!d.total) hint.textContent = 'Sin deuda: todo el monto queda como saldo a favor.';
        else if (a < d.total) hint.textContent = 'Pago parcial de ' + fmtMoney(a) + ', faltan ' + fmtMoney(d.total - a) + '. «Solo cobrar»: la deuda sigue y el corte se aplica según el ciclo. «Cobrar y activar»: se habilita el servicio y lo que falta se suma a la factura del próximo mes.';
        else if (a > d.total) hint.textContent = 'Cubre toda la deuda; ' + fmtMoney(a - d.total) + ' quedan como saldo a favor.';
        else hint.textContent = 'Cubre toda la deuda.';
        btnAct.style.display = partial ? '' : 'none';
        btnOk.innerHTML = partial ? '<i class="bi bi-check2"></i> Solo cobrar' : '<i class="bi bi-check2"></i> Registrar pago';
      };
      amt.addEventListener('input', upd); if (cr) cr.addEventListener('change', upd); upd();
      m.querySelector('#rcv-cancel').onclick = () => m.remove();
      const send = async (btn, activate) => {
        // Igual que la "referencia" de WispHub: en pagos que no son en efectivo se indica a qué cuenta o billetera entró
        if (destWrap && method !== 'Efectivo' && !destination && Number(amt.value) > 0) { alert('Elegí a qué cuenta o billetera entró el pago.'); return; }
        if (activate && !confirm('Se habilita el servicio y el saldo faltante se suma a la factura del próximo mes. ¿Continuar?')) return;
        btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Registrando…';
        try {
          saveMethod(method);
          const r = await fetch('/admin/customers/' + id + '/receive', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ amount: Number(amt.value) || 0, use_credit: !!(cr && cr.checked), activate: !!activate, method, destination, note: m.querySelector('#rcv-note').value }) });
          const j = await r.json();
          alert(j.message || (j.ok ? 'Listo.' : 'Error'));
          if (j.ok) { m.remove(); if (typeof opts.onDone === 'function') opts.onDone(j); else location.reload(); }
          else { btn.disabled = false; upd(); }
        } catch (e) { alert('Error: ' + e.message); btn.disabled = false; upd(); }
      };
      btnOk.onclick = () => send(btnOk, false);
      btnAct.onclick = () => send(btnAct, true);
      setTimeout(() => { try { amt.focus(); amt.select(); } catch (_) {} }, 50);
    } catch (e) { alert('Error: ' + e.message); }
  }

  window.openReceive = openReceive;
})();
