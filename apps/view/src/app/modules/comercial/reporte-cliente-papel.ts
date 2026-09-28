import type { ClienteCandidato, ReporteDocumento, ReporteLinea, ReporteFiltrosUI } from './tickets.service';

/**
 * TK.8 — El **papel** del reporte por cliente, tamaño carta.
 *
 * Se arma en el navegador y se imprime desde un **iframe oculto** con su propio `@page`, igual
 * que el ticket de venta: no abre ventana emergente (el navegador la bloquea) ni usa
 * `window.print()` sobre la página, que imprimiría la aplicación entera.
 *
 * ⚠️ **Por qué acá y no un PDF del servidor.** El PDF server-side (Chromium compartido, como la
 * carta del ticket) queda para el siguiente incremento. Éste sale del mismo dato que ya está en
 * pantalla, así que no puede discrepar de lo que la persona acaba de revisar y marcar — que es
 * justamente el riesgo de un reporte "de selección": si el papel lo arma otro proceso con otra
 * consulta, puede traer documentos que el humano había quitado.
 *
 * ⚠️ **El papel DECLARA su alcance.** Un reporte donde alguien eligió qué entra tiene que decir
 * cuántos quedaron fuera; si no, quien lo recibe cree que es todo (ADR-056). Y las notas de
 * crédito van en negativo y en su lugar por fecha, para que el total sea lo que el cliente pagó.
 */

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const money = (v: number) =>
  (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

/** Se parte el string, NO `new Date(iso)`: un `date` leído como UTC sale con el día anterior. */
const fechaCorta = (iso: string | null): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

const hoy = () => new Date().toLocaleDateString('es-MX', {
  timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric',
});

/** Qué periodo pidió quien lo emite, dicho con palabras y no con parámetros. */
function periodo(f: ReporteFiltrosUI): string {
  if (f.date_from && f.date_to) return `${fechaCorta(f.date_from)} – ${fechaCorta(f.date_to)}`;
  if (f.date_from) return `desde el ${fechaCorta(f.date_from)}`;
  if (f.date_to) return `hasta el ${fechaCorta(f.date_to)}`;
  return 'todo el histórico disponible';
}

/** Los filtros que acotan, en una línea legible. Vacío ⇒ no se imprime la línea. */
function acotes(f: ReporteFiltrosUI): string[] {
  const out: string[] = [];
  if (f.min) out.push(`importe desde ${money(Number(f.min))}`);
  if (f.max) out.push(`importe hasta ${money(Number(f.max))}`);
  if (f.folio) out.push(`folio que contenga "${f.folio}"`);
  if (f.warehouse_codes) out.push(`sólo la sucursal ${f.warehouse_codes}`);
  if (f.caja) out.push(`sólo caja ${f.caja} (deja fuera facturas y notas de crédito)`);
  if (f.atendio) out.push(`sólo lo atendido por ${f.atendio}`);
  if (f.brand_id) out.push('sólo documentos que traen la marca elegida, completos');
  if (f.supplier_id) out.push('sólo documentos que traen el proveedor elegido, completos');
  if (f.solo_con_descuento) out.push('sólo documentos con descuento');
  return out;
}

export function cuerpoReporteCliente(
  c: ClienteCandidato, docs: ReporteDocumento[], f: ReporteFiltrosUI, fuera: number,
): string {
  const total = docs.reduce((s, d) => s + d.total, 0);
  const desc = docs.reduce((s, d) => s + d.descuento, 0);
  const abonos = docs.filter((d) => d.origen === 'abono');
  const plazas = new Set(docs.map((d) => d.sucursal)).size;
  const ac = acotes(f);

  // [TK.11] Cada compra es su propia fila, y cuando viene el detalle arrastra las partidas
  // debajo, con las MISMAS cinco columnas de dinero que el ticket en carta.
  //
  // ⚠️ `lineas` distingue tres estados y los tres se imprimen distinto:
  //   · `null`/ausente  → no se pidió el detalle: la compra va sola, como siempre.
  //   · `[]`            → se pidió y el ERP no tiene partidas: se DICE, no se calla.
  //   · con elementos   → se listan.
  const partidas = (d: ReporteDocumento): string => {
    if (d.lineas == null) return '';
    if (!d.lineas.length) {
      return `<tr class="sub"><td colspan="7" class="vacio">Esta compra no tiene detalle de productos en el sistema.</td></tr>`;
    }
    const enc = `<tr class="sub subh"><td></td><td>Producto</td><td class="r">Cantidad</td>
      <td class="r">Precio original</td><td class="r">Precio con desc.</td>
      <td class="r">Desc. por pieza</td><td class="r">Descuento total</td></tr>`;
    const filas = (d.lineas as ReporteLinea[]).map((l) => {
      const rebaja = l.descuento_linea > 0;
      // Sin precio de lista no se sabe cuánto se bajó por unidad; un 0.00 diría que no hubo.
      const pieza = l.lista_conocida && rebaja ? '-' + money(l.descuento_unitario) : '—';
      return `<tr class="sub">
        <td></td>
        <td>${esc(l.descripcion || l.sku || '')}</td>
        <td class="m r">${l.cantidad}${l.unidad ? ' ' + esc(l.unidad) : ''}</td>
        <td class="m r">${l.lista_conocida ? money(l.precio_lista) : '<i>sin dato</i>'}</td>
        <td class="m r">${money(l.precio_pagado)}</td>
        <td class="m r ahorro">${pieza}</td>
        <td class="m r ahorro">${rebaja ? '-' + money(l.descuento_linea) : '—'}</td>
      </tr>`;
    }).join('');
    return enc + filas;
  };

  const filas = docs.map((d) => `<tr class="doc">
      <td class="m">${esc(d.id)}</td>
      <td class="m">${fechaCorta(d.fecha)}</td>
      <td>${esc(d.origen_label)}</td>
      <td>${esc(d.sucursal_nombre || d.sucursal)}${d.caja != null ? ' · caja ' + d.caja : ''}</td>
      <td>${esc(d.atendio || '—')}</td>
      <td class="m r">${d.descuento > 0 ? money(d.descuento) : '—'}</td>
      <td class="m r${d.total < 0 ? ' neg' : ''}">${money(d.total)}</td>
    </tr>${partidas(d)}`).join('');

  return `
<div class="hoja">
  <div class="cab">
    <div>
      <div class="emisor">MEGA DULCES</div>
      <div class="sub">Distribuidora de dulces</div>
    </div>
    <div class="der">
      <div class="tit">Estado de compras por cliente</div>
      <div class="sub">Emitido el ${hoy()}</div>
    </div>
  </div>

  <div class="cajas">
    <div class="caja">
      <h4>Cliente</h4>
      <div class="v">${esc(c.nombre || c.cliente_code)}</div>
      <div class="sub">Clave <span class="m">${esc(c.cliente_code)}</span>${c.zona ? ' · zona ' + esc(c.zona) : ''}${c.ciudad ? ' · ' + esc(c.ciudad) : ''}</div>
      ${c.clave_ambigua ? '<div class="amb">⚠ Esta clave trae nombres distintos segun la sucursal: el reporte puede estar sumando a mas de un cliente.</div>' : ''}
    </div>
    <div class="caja">
      <h4>Periodo y alcance</h4>
      <div class="v">${esc(periodo(f))}</div>
      <div class="sub">${docs.length} documento${docs.length === 1 ? '' : 's'} en ${plazas} sucursal${plazas === 1 ? '' : 'es'}${fuera > 0 ? ` · ${fuera} fuera del reporte` : ''}</div>
    </div>
  </div>

  <div class="tot">
    <div><span>Documentos</span><b class="m">${docs.length}</b></div>
    <div><span>Descuento</span><b class="m">${money(desc)}</b></div>
    <div><span>Notas de crédito</span><b class="m">${abonos.length}</b></div>
    <div class="fin"><span>Total del periodo</span><b class="m">${money(total)}</b></div>
  </div>

  ${ac.length ? `<p class="acot"><b>Acotado a:</b> ${esc(ac.join(' · '))}.</p>` : ''}

  <table class="det">
    <thead><tr>
      <th>Folio</th><th>Fecha</th><th>Tipo</th><th>Sucursal</th><th>Atendió</th>
      <th class="r">Descuento</th><th class="r">Total</th>
    </tr></thead>
    <tbody>${filas || '<tr><td colspan="7" class="vacio">Sin documentos.</td></tr>'}</tbody>
    <tfoot><tr>
      <td colspan="5"><b>Total del periodo</b></td>
      <td class="m r"><b>${money(desc)}</b></td>
      <td class="m r"><b>${money(total)}</b></td>
    </tr></tfoot>
  </table>

  <p class="pie">
    Documento informativo, no fiscal.
    ${fuera > 0
      ? `Incluye <b>${docs.length} de ${docs.length + fuera}</b> documentos del periodo: ${fuera} quedaron fuera por decisión de quien lo emitió.`
      : 'Incluye todos los documentos del periodo.'}
    ${abonos.length ? 'Las notas de crédito se restan del total.' : ''}
  </p>
</div>`;
}

/** Devuelve `false` si el navegador bloqueó la impresión. */
export function imprimirReporteCliente(
  c: ClienteCandidato, docs: ReporteDocumento[], f: ReporteFiltrosUI, fuera = 0,
): boolean {
  const marco = document.createElement('iframe');
  marco.setAttribute('aria-hidden', 'true');
  marco.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(marco);
  const doc = marco.contentDocument;
  const win = marco.contentWindow;
  if (!doc || !win) { marco.remove(); return false; }

  doc.open();
  doc.write(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Reporte ${esc(c.cliente_code)}</title>
<style>
  @page { size: letter; margin: 14mm 12mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #18181B; font-size: 10pt; }
  .cab { display: flex; justify-content: space-between; align-items: flex-start;
         border-bottom: 2px solid #18181B; padding-bottom: 8px; }
  .emisor { font-size: 15pt; font-weight: 700; }
  .tit { font-size: 11pt; font-weight: 600; }
  .der { text-align: right; }
  .sub { font-size: 8pt; color: #52525B; margin-top: 2px; }
  .cajas { display: flex; gap: 10px; margin: 12px 0; }
  .caja { flex: 1; border: 1px solid #E4E4E7; border-radius: 4px; padding: 8px 10px; }
  .caja h4 { margin: 0 0 4px; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em; color: #71717A; }
  .caja .v { font-size: 10.5pt; font-weight: 600; }
  .tot { display: flex; border: 1px solid #E4E4E7; border-radius: 4px; overflow: hidden; margin-bottom: 10px; }
  .tot > div { flex: 1; padding: 8px 10px; border-right: 1px solid #E4E4E7; }
  .tot > div:last-child { border-right: 0; }
  .tot span { display: block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em; color: #71717A; }
  .tot b { font-size: 12pt; }
  .tot .fin b { font-size: 13pt; }
  .acot { font-size: 8.5pt; color: #52525B; margin: 0 0 8px; }
  table.det { width: 100%; border-collapse: collapse; }
  .det th { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em; color: #71717A;
            text-align: left; padding: 0 6px 5px; border-bottom: 1px solid #18181B; }
  .det td { font-size: 9pt; padding: 5px 6px; border-bottom: 1px solid #F4F4F5; }
  .det tfoot td { border-top: 1.5px solid #18181B; border-bottom: 0; padding-top: 7px; }
  .r { text-align: right; }
  .neg { color: #991B1B; }
  .m { font-family: "Consolas", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  .vacio { text-align: center; color: #A1A1AA; padding: 14px; }
  .amb { margin-top: 4px; font-size: 8pt; color: #92400E; }
  .pie { margin-top: 12px; padding-top: 8px; border-top: 1px solid #E4E4E7;
         font-size: 7.5pt; line-height: 1.5; color: #71717A; }
  tr { break-inside: avoid; }
/* [TK.11] Las partidas van indentadas bajo su compra: mismo peso visual que una nota al pie,
   para que el ojo siga viendo la lista de COMPRAS y el detalle no compita con ella. */
.sub td{font-size:7.5pt;color:#3f3f46;border-bottom:1px solid #f1f1ef;padding-top:2px;padding-bottom:2px}
.subh td{font-size:6.5pt;text-transform:uppercase;letter-spacing:.05em;color:#6b6b6b;font-weight:700}
.ahorro{color:#155e35}
tr.doc td{border-top:1px solid #c9c9c9}
</style></head><body>${cuerpoReporteCliente(c, docs, f, fuera)}</body></html>`);
  doc.close();

  const lanzar = () => {
    try { win.focus(); win.print(); } catch { /* si el navegador lo niega, queda el botón manual */ }
    setTimeout(() => marco.remove(), 1500);
  };
  if (doc.readyState === 'complete') setTimeout(lanzar, 120);
  else marco.onload = () => setTimeout(lanzar, 120);
  return true;
}
