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
    var openedAt = 0;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      // si se acaba de abrir al pasar el mouse, el clic lo deja abierto (no lo cierra)
      var o = !d.classList.contains('open') || (Date.now() - openedAt < 600);
      closeAll(d); d.classList.toggle('open', o); if (o) openedAt = Date.now();
    });
    var t;
    d.addEventListener('mouseenter', function () { if (matchMedia('(hover:hover) and (min-width:901px)').matches) { clearTimeout(t); closeAll(d); if (!d.classList.contains('open')) openedAt = Date.now(); d.classList.add('open'); } });
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
    setTimeout(function () { if (typeof styleCharts === 'function') styleCharts(); }, 60);
  };
  syncIcon();

  /* ── Gráficos (Chart.js): paleta y tipografía del diseño nuevo, sin tocar cada pantalla ── */
  var v2css = function (n) { return getComputedStyle(doc.body).getPropertyValue(n).trim(); };
  var OLD = { 'adff2f': 'pine', '9ce62a': 'pine', '6366f1': 'ink', '818cf8': 'ink', '3fb950': 'pine', '34d399': 'pine', '22c55e': 'pine', '4ade80': 'pine', 'f85149': 'tomato', 'fb7185': 'tomato', 'ef4444': 'tomato', 'd29922': 'butter', 'f59e0b': 'butter', 'fbbf24': 'butter', '58a6ff': 'info', '38bdf8': 'info', '3b82f6': 'info', 'a78bfa': 'muted', '8b5cf6': 'muted' };
  var RGB = { '173,255,47': 'pine', '99,102,241': 'ink', '63,185,80': 'pine', '34,197,94': 'pine', '248,81,73': 'tomato', '239,68,68': 'tomato', '245,158,11': 'butter', '56,189,248': 'info', '59,130,246': 'info' };
  var PAL = function () { return { pine: v2css('--v2-pine') || '#2f5c50', tomato: v2css('--v2-tomato') || '#c8431f', butter: v2css('--v2-butter') || '#f2c94c', ink: v2css('--v2-ink') || '#17191a', info: v2css('--v2-info') || '#2d6a8f', muted: v2css('--v2-faint') || '#8e918c' }; };
  var hexA = function (hex, a) { var h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join(''); var n = parseInt(h, 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; };
  var swap = function (c, pal) {
    if (typeof c !== 'string') return c;
    var m = /^#([0-9a-f]{6})$/i.exec(c.trim()); if (m && OLD[m[1].toLowerCase()]) return pal[OLD[m[1].toLowerCase()]];
    var r = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)$/i.exec(c.trim());
    if (r) { var k = r[1] + ',' + r[2] + ',' + r[3]; if (RGB[k]) { var base = pal[RGB[k]]; return r[4] != null ? hexA(base.indexOf('#') === 0 ? base : '#17191a', Math.max(.18, Number(r[4]))) : base; } }
    return c;
  };
  var recolor = function (chart) {
    try {
      var pal = PAL();
      (chart.data.datasets || []).forEach(function (ds) {
        ['backgroundColor', 'borderColor', 'pointBackgroundColor', 'hoverBackgroundColor'].forEach(function (k) {
          if (Array.isArray(ds[k])) ds[k] = ds[k].map(function (c) { return swap(c, pal); }); else if (ds[k]) ds[k] = swap(ds[k], pal);
        });
        if (ds.borderRadius != null && typeof ds.borderRadius === 'number' && ds.borderRadius < 10) ds.borderRadius = 10;
      });
      chart.update('none');
    } catch (e) {}
  };
  var styleCharts = function () {
    if (!window.Chart) return;
    try {
      var C = window.Chart, txt = v2css('--v2-muted') || '#676a66', line = v2css('--v2-line') || 'rgba(0,0,0,.08)';
      C.defaults.font = Object.assign({}, C.defaults.font, { family: 'Urbanist, ui-sans-serif, system-ui, sans-serif', size: 12, weight: '600' });
      C.defaults.color = txt; C.defaults.borderColor = line;
      var inst = C.instances ? (typeof C.instances.forEach === 'function' ? C.instances : Object.values(C.instances)) : [];
      inst.forEach(function (ch) { recolor(ch); });
    } catch (e) {}
  };
  window.addEventListener('load', function () { styleCharts(); setTimeout(styleCharts, 1200); });

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
