/**
 * `[LE.6.38]` El **papel** del estado de cuenta de Caja General, tamaño carta.
 *
 * Mismo patrón que `comercial/reporte-cliente-papel.ts`: se arma en el navegador con el MISMO
 * dato que está en pantalla y se imprime desde un iframe oculto con su propio `@page` (guardar
 * como PDF sale del diálogo del navegador). `window.print()` sobre la página imprimiría la app.
 *
 * ⚠️ El papel DECLARA lo que no pudo medir, igual que la pantalla: un estado de cuenta que viaja
 * a Dirección sin sus huecos se lee como completo (ADR-056).
 */
import { warehouseName } from '@megadulces/contracts';
import type { DiaEstado, EstadoDeCuenta } from './estado-cuenta-caja.util';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (v: number | null): string =>
  v == null ? 'no medido' : (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
const signo = (v: number | null): string => (v == null ? 'no medido' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v))}`);
const dmy = (iso: string): string => { const [y, m, d] = iso.split('-'); return y && m && d ? `${d}/${m}/${y}` : iso; };
const hoy = () => new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' });

/** Lo que el estado de cuenta no puede afirmar, en palabras. Lo usa también la pantalla. */
export function avisosDelEstado(e: EstadoDeCuenta): string[] {
  const r = e.resumen;
  const a: string[] = [];
  if (r.dias_sin_medir) a.push(`${r.dias_sin_medir} ${r.dias_sin_medir === 1 ? 'día no tiene' : 'días no tienen'} conteo o fondo: sus cifras no se suman como cero.`);
  if (r.dias_sin_cuadre_de_movimientos) a.push(`En ${r.dias_sin_cuadre_de_movimientos} ${r.dias_sin_cuadre_de_movimientos === 1 ? 'día' : 'días'} los movimientos listados no suman lo que selló el corte: ahí no se publica el saldo por movimiento.`);
  if (r.sin_corte) a.push(`${r.sin_corte} ${r.sin_corte === 1 ? 'movimiento del periodo no entró' : 'movimientos del periodo no entraron'} a ningún corte todavía: no están en estos saldos.`);
  if (r.residuo != null && Math.abs(r.residuo) >= 0.01) a.push(`El estado de cuenta no cuadra consigo mismo por ${signo(r.residuo)}.`);
  return a;
}

function dia(d: DiaEstado): string {
  const filas = d.movimientos.map((l) => `<tr>
    <td class="m">${esc(dmy(l.fecha))}</td><td class="m">${esc(l.folio)}</td>
    <td>${esc(l.concepto)}${l.beneficiario ? `<div class="sub">${esc(l.beneficiario)}</div>` : ''}</td>
    <td>${esc(warehouseName(l.sucursal))}</td>
    <td class="r m">${l.entrada ? money(l.entrada) : ''}</td><td class="r m">${l.salida ? money(l.salida) : ''}</td>
    <td class="r m">${l.saldo == null ? '' : money(l.saldo)}</td></tr>`).join('');
  const extra = (t: string, v: number | null) => (v ? `<tr class="pie-dia"><td colspan="6">${t}</td><td class="r m">${signo(v)}</td></tr>` : '');
  return `<tbody class="dia">
    <tr class="cab-dia"><td colspan="6">Corte ${esc(d.folio)} · ${esc(dmy(d.fecha))}${d.salto ? ` · el fondo no arranca del cierre anterior (${signo(d.salto)})` : ''}</td>
      <td class="r m">${money(d.saldo_inicial)}</td></tr>
    ${filas || '<tr><td colspan="7" class="vacio">Sin movimientos capturados</td></tr>'}
    ${extra('Caja fuerte (dejó en el cajón menos lo que se llevó)', d.caja_fuerte)}
    ${extra('Depósitos', d.depositos == null ? null : -d.depositos)}
    ${extra('Otros ajustes del corte (custodia, documentos)', d.otros)}
    <tr class="pie-dia"><td colspan="6">Esperado · contado · diferencia${d.sin_medir ? ` — ${esc(d.sin_medir)}` : ''}</td>
      <td class="r m">${money(d.esperado)} · <b>${money(d.contado)}</b> · ${signo(d.diferencia)}</td></tr>
  </tbody>`;
}

export function cuerpoEstadoCuenta(e: EstadoDeCuenta, periodo: { desde: string; hasta: string }): string {
  const r = e.resumen;
  const avisos = avisosDelEstado(e);
  const renglon = (t: string, v: string, fuerte = false) => `<tr${fuerte ? ' class="fuerte"' : ''}><td>${t}</td><td class="r m">${v}</td></tr>`;
  return `<div class="cab"><div><div class="emisor">Mega Dulces</div><div class="tit">Estado de cuenta · Caja General</div></div>
    <div class="der"><div class="tit">${esc(dmy(periodo.desde))} – ${esc(dmy(periodo.hasta))}</div>
    <div class="sub">Emitido ${esc(hoy())} · ${r.dias} cortes · ${r.movimientos} movimientos</div></div></div>
  <table class="res">
    ${renglon('Saldo inicial (fondo del primer corte)', money(r.saldo_inicial))}
    ${renglon('+ Entradas', money(r.entradas))}
    ${renglon('− Salidas', money(r.salidas))}
    ${r.depositos ? renglon('− Depósitos', money(r.depositos)) : ''}
    ${renglon('± Caja fuerte (neto)', signo(r.caja_fuerte))}
    ${r.otros ? renglon('± Otros ajustes de los cortes', signo(r.otros)) : ''}
    ${renglon('± Diferencias de arqueo', signo(r.diferencias))}
    ${r.saltos ? renglon('± Fondos que no arrancaron del cierre anterior', signo(r.saltos)) : ''}
    ${renglon('Saldo final (contado en el último corte)', money(r.saldo_final), true)}
  </table>
  ${avisos.length ? `<div class="avisos">${avisos.map((a) => `<div>${esc(a)}</div>`).join('')}</div>` : ''}
  <table class="det"><thead><tr><th>Fecha</th><th>Folio</th><th>Concepto</th><th>Sucursal</th>
    <th class="r">Entrada</th><th class="r">Salida</th><th class="r">Saldo</th></tr></thead>
    ${e.dias.map(dia).join('')}</table>
  <div class="pie">Fuente: Captura de Caja General y sus cortes sellados. Cada corte arranca con su fondo y cierra con lo contado;
  la diferencia es lo contado menos lo esperado. La fecha de cada movimiento es la de su documento: puede ser anterior a su corte.</div>`;
}

/** Devuelve `false` si el navegador no dejó armar la hoja. */
export function imprimirEstadoCuenta(e: EstadoDeCuenta, periodo: { desde: string; hasta: string }): boolean {
  const marco = document.createElement('iframe');
  marco.setAttribute('aria-hidden', 'true');
  marco.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(marco);
  const doc = marco.contentDocument;
  const win = marco.contentWindow;
  if (!doc || !win) { marco.remove(); return false; }
  doc.open();
  doc.write(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Estado de cuenta Caja General ${esc(periodo.desde)} a ${esc(periodo.hasta)}</title>
<style>
  @page { size: letter; margin: 12mm 10mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #18181B; font-size: 9pt; }
  .cab { display: flex; justify-content: space-between; border-bottom: 2px solid #18181B; padding-bottom: 6px; margin-bottom: 10px; }
  .emisor { font-size: 14pt; font-weight: 700; } .tit { font-size: 10.5pt; font-weight: 600; }
  .der { text-align: right; } .sub { font-size: 7.5pt; color: #52525B; margin-top: 2px; }
  table.res { width: 55%; border-collapse: collapse; margin-bottom: 8px; }
  .res td { padding: 2px 6px; border-bottom: 1px solid #F4F4F5; } .res .fuerte td { font-weight: 700; border-top: 1.5px solid #18181B; }
  .avisos { font-size: 8pt; color: #92400E; margin: 0 0 8px; }
  table.det { width: 100%; border-collapse: collapse; }
  .det th { font-size: 7pt; text-transform: uppercase; letter-spacing: .05em; color: #71717A; text-align: left; padding: 0 5px 4px; border-bottom: 1px solid #18181B; }
  .det td { font-size: 8pt; padding: 3px 5px; border-bottom: 1px solid #F4F4F5; vertical-align: top; }
  .cab-dia td { font-weight: 700; background: #F4F4F5; border-top: 1px solid #A1A1AA; }
  .pie-dia td { color: #3F3F46; font-size: 7.5pt; }
  .r { text-align: right; } .m { font-family: "Consolas", ui-monospace, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .vacio { color: #A1A1AA; text-align: center; }
  .pie { margin-top: 10px; padding-top: 6px; border-top: 1px solid #E4E4E7; font-size: 7pt; color: #71717A; }
  tr { break-inside: avoid; }
</style></head><body>${cuerpoEstadoCuenta(e, periodo)}</body></html>`);
  doc.close();
  const lanzar = () => {
    try { win.focus(); win.print(); } catch { /* si el navegador lo niega, queda el botón */ }
    setTimeout(() => marco.remove(), 1500);
  };
  if (doc.readyState === 'complete') setTimeout(lanzar, 120);
  else marco.onload = () => setTimeout(lanzar, 120);
  return true;
}
