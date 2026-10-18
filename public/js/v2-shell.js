/* v2-shell.js — Diseño nuevo: menús de la barra superior, buscador rápido (Ctrl+K) y tema claro/oscuro. */
(function () {
  'use strict';
  if (window.__v2ShellInit) return;
  window.__v2ShellInit = true;
  var doc = document;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  /* ── Menús desplegables (clic; en escritorio también al pasar el mouse) ── */
  var dds = doc.querySelectorAll('.v2-dd');
  var closeAll = function (except) { dds.forEach(function (d) { if (d !== except) d.classList.remove('open'); }); };
  dds.forEach(function (d) {
    var btn = d.querySelector('button');
    btn.addEventListener('click', function (e) { e.stopPropagation(); var o = !d.classList.contains('open'); closeAll(d); d.classList.toggle('open', o); });
    var t;
    d.addEventListener('mouseenter', function () { if (matchMedia('(hover:hover) and (min-width:901px)').matches) { clearTimeout(t); closeAll(d); d.classList.add('open'); } });
    d.addEventListener('mouseleave', function () { if (matchMedia('(hover:hover) and (min-width:901px)').matches) { t = setTimeout(function () { d.classList.remove('open'); }, 180); } });
  });
  doc.addEventListener('click', function (e) { if (!e.target.closest('.v2-dd')) closeAll(); });

  /* ── Tema ── */
  var syncIcon = function () {
    var dark = doc.documentElement.getAttribute('data-theme') !== 'light';
    doc.querySelectorAll('.v2-th').forEach(function (i) { i.className = 'bi ' + (dark ? 'bi-sun' : 'bi-moon-stars') + ' v2-th'; });
  };
  window.v2Theme = function () {
    if (typeof window.toggleAppTheme === 'function') window.toggleAppTheme();
    else {
      var cur = doc.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      doc.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('app-theme', cur); } catch (e) {}
    }
    syncIcon();
  };
  syncIcon();

  /* ── Buscador rápido ── */
  var pal = doc.getElementById('v2Pal'), inp = doc.getElementById('v2PalQ'), res = doc.getElementById('v2PalRes');
  if (!pal) return;
  var links = [];
  doc.querySelectorAll('.v2-nav a.v2-pill, .v2-menu a.v2-mi').forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (!href || href.indexOf('javascript') === 0 || /logout|lang\//.test(href)) return;
    var grp = a.closest('.v2-mg'), sec = a.closest('.v2-dd');
    var where = [sec && sec.querySelector('.v2-pill') ? sec.querySelector('.v2-pill').textContent.trim() : '', grp && grp.querySelector('.v2-mh') ? grp.querySelector('.v2-mh').textContent.trim() : ''].filter(Boolean).join(' · ');
    var ic = a.querySelector('i'); var label = a.textContent.trim();
    if (!links.some(function (l) { return l.href === href; })) links.push({ href: href, label: label, where: where, icon: ic ? ic.className : 'bi bi-arrow-right' });
  });
  var norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };
  var sel = 0;
  var render = function () {
    var q = norm(inp.value.trim()), h = '', items = [];
    var found = links.filter(function (l) { return !q || norm(l.label + ' ' + l.where).indexOf(q) !== -1; }).slice(0, 12);
    if (q) items.push({ href: '/admin/customers?status=all&search=' + encodeURIComponent(inp.value.trim()), label: 'Buscar "' + inp.value.trim() + '" en clientes', where: 'Clientes', icon: 'bi bi-person-search' });
    items = items.concat(found);
    if (!items.length) { res.innerHTML = '<div class="v2-mh">Sin resultados</div>'; return; }
    sel = Math.min(sel, items.length - 1);
    h = items.map(function (l, i) { return '<a href="' + esc(l.href) + '"' + (i === sel ? ' class="sel"' : '') + '><i class="' + esc(l.icon) + '"></i>' + esc(l.label) + (l.where ? '<small>' + esc(l.where) + '</small>' : '') + '</a>'; }).join('');
    res.innerHTML = (q ? '' : '<div class="v2-mh">Ir a…</div>') + h;
  };
  window.v2Palette = function () { pal.hidden = false; inp.value = ''; sel = 0; render(); setTimeout(function () { inp.focus(); }, 30); };
  var close = function () { pal.hidden = true; };
  pal.addEventListener('click', function (e) { if (e.target === pal) close(); });
  inp.addEventListener('input', function () { sel = 0; render(); });
  inp.addEventListener('keydown', function (e) {
    var as = res.querySelectorAll('a');
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, as.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); var a = res.querySelectorAll('a')[sel]; if (a) location.href = a.getAttribute('href'); }
    else if (e.key === 'Escape') close();
  });
  doc.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (pal.hidden) window.v2Palette(); else close(); }
    else if (e.key === 'Escape' && !pal.hidden) close();
  });
})();
