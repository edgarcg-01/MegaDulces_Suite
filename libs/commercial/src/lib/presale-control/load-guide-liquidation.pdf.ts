/**
 * `[MCP.7]` HTML del comprobante de liquidación de guías de carga (Fase MCP, ADR-089, D9/D11).
 *
 * Sustituye la tira de ingresos de la caja que se reimprimía y se firmaba a mano. Puro, sin base de
 * datos: se imprime desde la foto (`snapshot`) que se guardó al liquidar, así la reimpresión dice lo
 * mismo que el papel que se firmó. El PDF lo hace `AnexoVentaService.renderPdf`.
 */

export interface LiquidationSnapshotOrder {
  guia: string;
  code: string;
  cliente: string | null;
  folio_digital: string | null;
  estado: 'entregado' | 'no_entregado' | 'regreso';
  resultado: 'completo' | 'con_diferencia' | null;
  document_total: number | null;
  efectivo: number | null;
  transferencia: number | null;
  referencia: string | null;
  /** La nota de la diferencia, o el motivo de por qué volvió. */
  nota: string | null;
}

export interface LiquidationSnapshot {
  version: 1;
  empresa: string;
  folio: string;
  sucursal: string;
  sucursal_nombre: string | null;
  repartidor: string | null;
  liquidada_por: string | null;
  liquidada_en: string;
  fecha: string;
  guias: Array<{ folio: string; ruta: string }>;
  pedidos: LiquidationSnapshotOrder[];
  documents_total: number;
  documentos_sin_total: number;
  declared_cash: number;
  declared_transfer: number;
  counted_cash: number;
  cash_difference: number;
  /** Documentos entregados − lo declarado (donde el documento trae total). */
  por_cobrar: number;
  /** La parte de `por_cobrar` en pedidos "completo": lo que nadie explicó por pedido. */
  sin_explicar: number;
  conteo: Array<{ label: string; piezas: number; importe: number }>;
  notas: string | null;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const m = (n: number | null | undefined): string =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dmy = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [y, mo, d] = v.slice(0, 10).split('-');
  return `${d}/${mo}/${y}`;
};

const ESTADO: Record<LiquidationSnapshotOrder['estado'], string> = {
  entregado: 'Entregado',
  no_entregado: 'No se entregó',
  regreso: 'Regresó a caja',
};

export function pieLiquidacion(folio: string, sello: string): string {
  return `<div style="width:100%;font-family:'Segoe UI',sans-serif;font-size:7.5pt;color:#8a8078;
    padding:0 9mm;display:flex;justify-content:space-between;align-items:center;">
    <span>Liquidación ${esc(folio)} · ${esc(sello)} · Mega Dulces</span>
    <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
}

export function htmlLiquidacion(s: LiquidationSnapshot, opts: { reimpresion: boolean; reimpresa_en?: string }): string {
  const filas = s.pedidos
    .map((p) => {
      const entregado = p.estado === 'entregado';
      const estado = entregado && p.resultado === 'con_diferencia' ? 'Con diferencia' : ESTADO[p.estado];
      return `<tr${entregado ? '' : ' class="vuelta"'}>
        <td class="mono">${esc(p.guia)}</td>
        <td class="mono">${esc(p.code)}</td>
        <td>${esc(p.cliente || '—')}</td>
        <td class="mono">${p.folio_digital ? esc(p.folio_digital) : '—'}</td>
        <td>${esc(estado)}${p.nota ? `<div class="nd">${esc(p.nota)}</div>` : ''}</td>
        <td class="r mono">${p.document_total == null ? '—' : '$' + m(p.document_total)}</td>
        <td class="r mono">${entregado ? '$' + m(p.efectivo) : '—'}</td>
        <td class="r mono">${entregado ? '$' + m(p.transferencia) : '—'}${p.referencia ? `<div class="nd">ref. ${esc(p.referencia)}</div>` : ''}</td>
      </tr>`;
    })
    .join('');

  const conteo = s.conteo
    .filter((c) => c.piezas > 0)
    .map((c) => `<tr><td>${esc(c.label)}</td><td class="r mono">${c.piezas}</td><td class="r mono">$${m(c.importe)}</td></tr>`)
    .join('');

  const dif = s.cash_difference;
  const difTxt = dif === 0 ? 'Cuadra' : dif < 0 ? `Faltante $${m(-dif)}` : `Sobrante $${m(dif)}`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(s.folio)}</title>
<style>
:root{--ink:#1b1b1b;--muted:#5f5f5f;--line:#c9c9c9;--line-2:#e4e4e4;--soft:#f6f5f3;--accent:#8a3c06}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:var(--ink);font-family:"Segoe UI",Arial,Helvetica,sans-serif;font-size:9pt;line-height:1.25}
.mono{font-family:Consolas,"Courier New",monospace;font-variant-numeric:tabular-nums}
.r{text-align:right}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:8px}
.emp{font-size:13pt;font-weight:700}
.sub{color:var(--muted);font-size:8.5pt}
.tit{font-size:12pt;font-weight:700;text-align:right}
.kv{font-size:8.5pt;text-align:right}
.reimp{display:inline-block;margin-top:4px;padding:1px 6px;border:1px solid var(--accent);color:var(--accent);font-weight:700;font-size:8pt}
table{width:100%;border-collapse:collapse;margin-top:10px}
th{background:var(--soft);color:var(--muted);font-weight:600;text-align:left;font-size:7.5pt;padding:4px 5px;border-bottom:1px solid var(--line)}
td{padding:4px 5px;border-bottom:1px solid var(--line-2);vertical-align:top}
.vuelta td{color:var(--muted)}
td.mono{white-space:nowrap}
.nd{color:var(--muted);font-size:7.5pt}
.cuadre{display:flex;gap:24px;margin-top:14px;align-items:flex-start}
.cuadre table{margin-top:0}
.res td{padding:5px 6px}
.res .tot td{font-weight:700;border-top:2px solid var(--ink);border-bottom:0}
.notas{margin-top:10px;font-size:8.5pt;border:1px solid var(--line);padding:6px 8px}
.legal{margin-top:14px;border-top:1px solid var(--line);padding-top:8px;font-size:7.5pt;line-height:1.35;color:#3d3d3d;text-align:justify}
.firmas{display:flex;gap:40px;margin:34px auto 0;width:86%}
.firmas div{flex:1;text-align:center;border-top:1px solid var(--ink);padding-top:4px;font-size:8pt}
.firmas .quien{display:block;font-weight:700;font-size:9pt;min-height:12px}
</style></head><body>
<div class="head">
  <div>
    <div class="emp">${esc(s.empresa)}</div>
    <div class="sub">Liquidación de guías de carga de preventa · documento interno</div>
  </div>
  <div>
    <div class="tit">Liquidación</div>
    <div class="kv"><b>Folio</b> <span class="mono">${esc(s.folio)}</span></div>
    <div class="kv"><b>Sucursal</b> ${esc(s.sucursal)} ${esc(s.sucursal_nombre || '')} · <b>Fecha</b> ${esc(dmy(s.fecha))}</div>
    <div class="kv"><b>Guías</b> ${s.guias.map((g) => `<span class="mono">${esc(g.folio)}</span> (${esc(g.ruta)})`).join(', ')}</div>
    <div class="kv"><b>Entregó</b> ${esc(s.repartidor || '—')}</div>
    ${opts.reimpresion ? `<div class="kv"><span class="reimp">REIMPRESIÓN${opts.reimpresa_en ? ' · ' + esc(opts.reimpresa_en) : ''}</span></div>` : ''}
  </div>
</div>

<table>
  <thead><tr><th>Guía</th><th>Pedido</th><th>Cliente</th><th>Documento Kepler</th><th>Resultado</th><th class="r">Documento</th><th class="r">Efectivo</th><th class="r">Transferencia</th></tr></thead>
  <tbody>${filas}</tbody>
</table>

<div class="cuadre">
  <table class="res" style="flex:1.2">
    <tbody>
      <tr><td>Documentos de Kepler entregados</td><td class="r mono">$${m(s.documents_total)}</td></tr>
      ${s.documentos_sin_total ? `<tr><td colspan="2" class="nd">${s.documentos_sin_total} documento(s) sin total en el sistema: no se suman.</td></tr>` : ''}
      <tr><td>Transferencias declaradas</td><td class="r mono">$${m(s.declared_transfer)}</td></tr>
      <tr><td>Efectivo declarado al entregar</td><td class="r mono">$${m(s.declared_cash)}</td></tr>
      <tr><td>Documentos − lo declarado</td><td class="r mono">$${m(s.por_cobrar)}</td></tr>
      ${s.sin_explicar ? `<tr><td colspan="2"><b>Sin explicar por pedido: $${m(Math.abs(s.sin_explicar))}</b> (pedidos entregados "completo" cuyo cobro no cuadra con su documento; ver notas).</td></tr>` : ''}
      <tr><td>Efectivo contado en caja</td><td class="r mono">$${m(s.counted_cash)}</td></tr>
      <tr class="tot"><td>Efectivo: ${esc(difTxt)}</td><td class="r mono">${dif === 0 ? '—' : '$' + m(Math.abs(dif))}</td></tr>
    </tbody>
  </table>
  <table style="flex:1">
    <thead><tr><th>Denominación</th><th class="r">Piezas</th><th class="r">Importe</th></tr></thead>
    <tbody>${conteo || '<tr><td colspan="3" class="nd">Sin efectivo.</td></tr>'}</tbody>
  </table>
</div>
${s.notas ? `<div class="notas"><b>Notas:</b> ${esc(s.notas)}</div>` : ''}

<p class="legal">Entrego a la caja el efectivo contado y las referencias de transferencia de los pedidos entregados que aquí se listan, y la mercancía de los que no se entregaron. Lo que no se entregó sale en otra guía o se devuelve en Kepler. Ambas partes reconocen las cifras de este comprobante.</p>

<div class="firmas">
  <div><span class="quien">${esc(s.repartidor || '')}</span>Nombre y firma de quien entregó</div>
  <div><span class="quien">${esc(s.liquidada_por || '')}</span>Nombre y firma de quien recibe (caja)</div>
</div>
</body></html>`;
}
