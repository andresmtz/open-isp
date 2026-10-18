'use strict';
/**
 * Diseño nuevo (v2) para las pantallas fuera del panel de administración: ingresos (clientes, técnicos,
 * cobradores), panel del técnico, registro, consulta de deuda, páginas públicas y el portal del cliente.
 *
 * Se aplica al HTML ya generado (sin tocar cada vista), solo con el ajuste ui_design = v2. Con el
 * diseño anterior (classic) las pantallas quedan exactamente como estaban.
 *
 *  - Pantallas con landing.css: se agrega /css/v2/portal.css y la marca html[data-ui="v2"].
 *  - Portal del cliente (portal.ejs, Tailwind con colores propios): se cambian la paleta y la tipografía.
 *  - Logo: en lugar de la imagen, el cuadrado con la inicial de la empresa que usa el panel; se invierte
 *    con el tema (oscuro sobre claro / claro sobre oscuro).
 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const initial = (name) => esc((String(name || '').trim().match(/[\p{L}\p{N}]/u) || ['•'])[0].toUpperCase());

function landingPages(body, { brandName }) {
  const L = initial(brandName);
  body = body.replace('</head>', '  <link rel="stylesheet" href="/css/v2/portal.css?v=2">\n</head>');
  body = body.replace(/<html(\s|>)/i, (m, c) => '<html data-ui="v2"' + c);
  body = body.replace(/<meta name="theme-color" content="#0A0D14">/gi, '<meta name="theme-color" content="#111412">');
  // logo de la barra superior de las páginas públicas y del ingreso
  body = body.replace(/<img class="bmark"[^>]*>/g, `<span class="bmark v2-mark" aria-hidden="true">${L}</span>`);
  // logo de la tarjeta de ingreso / registro (imagen o ícono)
  body = body.replace(/<div class="auth-logo">[\s\S]*?<\/div>/g, `<div class="auth-logo v2-mark" aria-hidden="true">${L}</div>`);
  // barra superior del panel del técnico
  body = body.replace(/(<div class="portal-topnav">\s*<div class="t">)<i class="bi bi-tools"[^>]*><\/i>/, `$1<span class="v2-mark" aria-hidden="true">${L}</span>`);
  return body;
}

// Portal del cliente: paleta (lima y azul noche → tinta, crema y verde) y tipografía Urbanist
const PORTAL_VARS = `
<style id="v2-portal">
  :root{--lime:#f1eee8;--lime-2:#d6d2ca;--lime-rgb:241,238,232;--on-lime:#17191a;--lime-dim:rgba(241,238,232,.08);--lime-border:rgba(241,238,232,.16);
    --surface:#1c201e;--surface-2:#242927;--surface-3:#2a2f2c;--bg:#111412;--border:rgba(255,255,255,.08);--text:#f1eee8;
    --muted:rgba(241,238,232,.6);--muted-2:rgba(241,238,232,.36);--red:#f08a68;--red-dim:rgba(240,138,104,.12);--red-border:rgba(240,138,104,.32);
    --mesh-a:rgba(200,67,31,.26);--mesh-b:rgba(47,92,80,.5);--mesh-c:rgba(242,201,76,.09)}
  html.light{--lime:#17191a;--lime-2:#3a3d3e;--lime-rgb:23,25,26;--on-lime:#fbf8f2;--lime-dim:rgba(23,25,26,.06);--lime-border:rgba(23,25,26,.14);
    --surface:#fdfcf9;--surface-2:#f6f4ef;--surface-3:#efece5;--bg:#ebe8e1;--border:rgba(23,25,26,.09);--text:#17191a;
    --muted:rgba(23,25,26,.58);--muted-2:rgba(23,25,26,.34);--red:#c8431f;--red-dim:rgba(200,67,31,.1);--red-border:rgba(200,67,31,.28);
    --mesh-a:#f2d3bd;--mesh-b:#cfdfcd;--mesh-c:#f1e4bf}
  body{font-family:'Urbanist',ui-sans-serif,system-ui,sans-serif!important;font-weight:500;
    background:radial-gradient(62vw 62vw at -12% -26%,var(--mesh-a),transparent 62%),radial-gradient(58vw 58vw at 112% 116%,var(--mesh-b),transparent 62%),radial-gradient(40vw 40vw at 58% -18%,var(--mesh-c),transparent 62%),var(--bg)!important;background-attachment:fixed!important}
  .v2-mk{width:100%;height:100%;display:grid;place-items:center;background:var(--lime);color:var(--on-lime);font-weight:800;font-size:15px;line-height:1;border-radius:inherit}
  .v2-mk.lg{width:64px;height:64px;border-radius:20px;font-size:28px;margin:0 auto 12px}
  /* la tarjeta del cliente es oscura en los dos temas: dentro de ella, acentos claros */
  html.light .cc{--lime:#f1eee8;--lime-2:#d6d2ca;--lime-rgb:241,238,232;--on-lime:#17191a;--text:#f1eee8;--muted:rgba(241,238,232,.6);--border:rgba(255,255,255,.1)}
  .cc-brand-mark .v2-mk{background:#fbf8f2;color:#17191a;font-size:11px}
  .btn-lime,.btn-ghost,.btn-danger-soft{border-radius:999px!important}
  .nav-item{border-radius:999px}
  .nav-item.active{background:var(--lime);color:var(--on-lime);border-color:transparent}
</style>
`;

function customerPortal(body, { brandName, brandLogo }) {
  const L = initial(brandName);
  body = body.replace(/<meta name="theme-color" content="#0A0D14">/gi, '<meta name="theme-color" content="#111412">');
  body = body.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter[^>]*>/, '<link rel="stylesheet" href="/vendor/fonts/urbanist/urbanist.css">');
  body = body.replace(/'Inter'|'Space Grotesk'/g, "'Urbanist'");
  // logo → cuadrado con la inicial
  if (brandLogo) {
    body = body.replace(new RegExp('<img src="' + reEsc(esc(brandLogo)) + '"[^>]*>', 'g'), (m) =>
      /height:56px/.test(m) ? `<span class="v2-mk lg" aria-hidden="true">${L}</span>` : `<span class="v2-mk" aria-hidden="true">${L}</span>`);
  }
  // colores fijos
  body = body.replace(/stop-color="#ADFF2F"/g, 'style="stop-color:var(--lime)"');
  body = body.replace(/background:\s*#0A0D14/g, 'background:var(--on-lime)');
  body = body.replace(/color:\s*#0A0D14/g, 'color:var(--on-lime)');
  body = body.replace(/#ADFF2F|#C9FF6B/gi, 'var(--lime)');
  body = body.replace(/#9AEA1A|#7ECB0F|#8EDB1C|#62A009/gi, 'var(--lime-2)');
  body = body.replace(/rgba\(173,\s*255,\s*47,/g, 'rgba(var(--lime-rgb),');
  const DARK = { '#1B2233': '#2a2f2c', '#0F1420': '#1c201e', '#131A29': '#232826', '#0B0F18': '#151816', '#10170C': '#1f2a24', '#0A0E08': '#141a16', '#0A0D14': '#141715' };
  body = body.replace(/#1B2233|#0F1420|#131A29|#0B0F18|#10170C|#0A0E08|#0A0D14/gi, (m) => DARK[m.toUpperCase()] || m);
  body = body.replace(/rgba\(20,\s*24,\s*36,/g, 'rgba(24,28,26,');
  body = body.replace('</head>', PORTAL_VARS + '</head>');
  return body;
}

// Pantallas simples para el cliente (aviso de corte, cómo pagar): siguen el tema del teléfono
const SIMPLE_CSS = `
<style id="v2-simple">
  @import url('/vendor/fonts/urbanist/urbanist.css');
  :root{--bg:#ebe8e1;--card:rgba(255,255,255,.62);--text:#17191a;--muted:#676a66;--border:rgba(23,25,26,.09);--danger:#c8431f;--ok:#2f7a52;--accent:#17191a;
    --mesh-a:#f2d3bd;--mesh-b:#cfdfcd;--mesh-c:#f1e4bf;--ink:#17191a;--on-ink:#fbf8f2}
  @media (prefers-color-scheme: dark){:root{--bg:#111412;--card:rgba(255,255,255,.06);--text:#f1eee8;--muted:#a3a6a0;--border:rgba(255,255,255,.08);--danger:#f08a68;--ok:#6cc59a;--accent:#f1eee8;
    --mesh-a:rgba(200,67,31,.26);--mesh-b:rgba(47,92,80,.5);--mesh-c:rgba(242,201,76,.09);--ink:#f1eee8;--on-ink:#17191a}}
  body{font-family:'Urbanist',ui-sans-serif,system-ui,sans-serif!important;font-weight:500;
    background:radial-gradient(62vw 62vw at -12% -26%,var(--mesh-a),transparent 62%),radial-gradient(58vw 58vw at 112% 116%,var(--mesh-b),transparent 62%),var(--bg)!important;background-attachment:fixed!important}
  .card{border-radius:26px!important;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-color:var(--border)!important}
  .brand{display:flex;align-items:center;justify-content:center;gap:10px;font-weight:700!important;font-size:18px}
  .brand .v2-sq{width:40px;height:40px;border-radius:13px;background:var(--ink);color:var(--on-ink);display:grid;place-items:center;font-weight:800}
  h1{font-weight:600;letter-spacing:-.02em}
  .btn{border-radius:999px!important;background:var(--ink)!important;color:var(--on-ink)!important}
</style>
`;
function simplePages(body, { brandName }) {
  body = body.replace(/<div class="brand">([^<]*)<\/div>/, (m, name) => `<div class="brand"><span class="v2-sq" aria-hidden="true">${initial(String(name).trim() || brandName)}</span>${name}</div>`);
  return body.replace('</head>', SIMPLE_CSS + '</head>');
}

/** Transforma una página HTML si corresponde. `locals`: res.locals (uiDesign, brandName, brandLogo). */
function transform(body, locals) {
  if (typeof body !== 'string' || !locals || locals.uiDesign !== 'v2' || body.indexOf('</head>') === -1) return body;
  if (/<html[^>]*\sdata-ui="v2"/i.test(body) || body.indexOf('id="v2-portal"') !== -1 || body.indexOf('id="v2-simple"') !== -1) return body;
  try {
    if (body.indexOf('/css/landing.css') !== -1) return landingPages(body, locals);
    if (body.indexOf('tailwind.config') !== -1 && body.indexOf('--lime:#ADFF2F') !== -1) return customerPortal(body, locals);
    if (body.indexOf('.wrap{max-width:560px') !== -1 && body.indexOf('<div class="brand">') !== -1) return simplePages(body, locals);
  } catch (_) {}
  return body;
}

module.exports = { transform };
