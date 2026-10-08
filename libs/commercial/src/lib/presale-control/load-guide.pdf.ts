/**
 * `[MCP.5]` HTML de la guía de carga de preventa (Fase MCP, ADR-089), puro y sin base de datos.
 *
 * El PDF lo hace `AnexoVentaService.renderPdf` (el Chromium compartido). Mismo estilo de la Guía de
 * Cobranza (GT.2): documento interno, tamaño carta, firma al pie. Se imprime SIEMPRE desde la foto
 * (`snapshot`) que se congeló al imprimirse la primera vez, así la reimpresión dice lo mismo que el
 * papel que firmó el repartidor.
 */

export interface LoadGuideSnapshotOrder {
  code: string;
  cliente: string | null;
  cliente_code: string | null;
  entrega: string;
  folio_digital: string | null;
  document_total: number | null;
  total: number;
}

export interface LoadGuideSnapshot {
  version: 1;
  empresa: string;
  folio: string;
  sucursal: string;
  sucursal_nombre: string | null;
  ruta: string;
  repartidor: string | null;
  fecha: string;
  impresa_en: string;
  impresa_por: string | null;
  pedidos: LoadGuideSnapshotOrder[];
  total: number;
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

/** Pie de página del PDF (lo pinta Chromium en cada hoja). */
export function pieGuiaCarga(folio: string, sello: string): string {
  return `<div style="width:100%;font-family:'Segoe UI',sans-serif;font-size:7.5pt;color:#8a8078;
    padding:0 9mm;display:flex;justify-content:space-between;align-items:center;">
    <span>Guía de carga ${esc(folio)} · ${esc(sello)} · Mega Dulces</span>
    <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
}

/**
 * La guía. `reimpresion` agrega la marca REIMPRESIÓN para que la copia no se confunda con la que
 * firmó el repartidor.
 */
export function htmlGuiaCarga(s: LoadGuideSnapshot, opts: { reimpresion: boolean; reimpresa_en?: string }): string {
  const filas = s.pedidos
    .map(
      (p, i) => `<tr>
        <td class="r mono">${i + 1}</td>
        <td class="mono">${esc(p.code)}</td>
        <td>${esc(p.cliente || '—')}${p.cliente_code ? `<span class="nd mono"> · ${esc(p.cliente_code)}</span>` : ''}</td>
        <td class="mono">${esc(dmy(p.entrega))}</td>
        <td class="mono">${p.folio_digital ? esc(p.folio_digital) : '<span class="nd">se elige al entregar</span>'}</td>
        <td class="r mono">$${m(p.document_total ?? p.total)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(s.folio)}</title>
<style>
:root{--ink:#1b1b1b;--muted:#5f5f5f;--line:#c9c9c9;--line-2:#e4e4e4;--soft:#f6f5f3;--accent:#8a3c06}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:var(--ink);font-family:"Segoe UI",Arial,Helvetica,sans-serif;font-size:9.5pt;line-height:1.25}
.mono{font-family:Consolas,"Courier New",monospace;font-variant-numeric:tabular-nums}
.r{text-align:right}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:8px}
.emp{font-size:13pt;font-weight:700}
.sub{color:var(--muted);font-size:8.5pt}
.tit{font-size:12pt;font-weight:700;text-align:right}
.kv{font-size:8.5pt;text-align:right}
.reimp{display:inline-block;margin-top:4px;padding:1px 6px;border:1px solid var(--accent);color:var(--accent);font-weight:700;font-size:8pt}
table{width:100%;border-collapse:collapse;margin-top:12px}
th{background:var(--soft);color:var(--muted);font-weight:600;text-align:left;font-size:8pt;padding:5px 6px;border-bottom:1px solid var(--line)}
td{padding:5px 6px;border-bottom:1px solid var(--line-2);vertical-align:top}
.tot td{font-weight:700;border-top:2px solid var(--ink);border-bottom:0}
.nd{color:var(--muted)}
.nota{font-size:8pt;color:var(--muted);margin:8px 0 0}
.legal{margin-top:14px;border-top:1px solid var(--line);padding-top:8px;font-size:7.5pt;line-height:1.35;color:#3d3d3d;text-align:justify}
.firmas{display:flex;gap:40px;margin:34px auto 0;width:86%}
.firmas div{flex:1;text-align:center;border-top:1px solid var(--ink);padding-top:4px;font-size:8pt}
.firmas .quien{display:block;font-weight:700;font-size:9pt;min-height:12px}
</style></head><body>
<div class="head">
  <div>
    <div class="emp">${esc(s.empresa)}</div>
    <div class="sub">Guía de carga de preventa · documento interno</div>
  </div>
  <div>
    <div class="tit">Guía de carga</div>
    <div class="kv"><b>Folio</b> <span class="mono">${esc(s.folio)}</span></div>
    <div class="kv"><b>Ruta</b> ${esc(s.ruta)} · <b>Sucursal</b> ${esc(s.sucursal)} ${esc(s.sucursal_nombre || '')}</div>
    <div class="kv"><b>Fecha</b> ${esc(dmy(s.fecha))} · <b>${s.pedidos.length}</b> pedido${s.pedidos.length === 1 ? '' : 's'}</div>
    <div class="kv"><b>Repartidor</b> ${esc(s.repartidor || '—')}</div>
    ${opts.reimpresion ? `<div class="kv"><span class="reimp">REIMPRESIÓN${opts.reimpresa_en ? ' · ' + esc(opts.reimpresa_en) : ''}</span></div>` : ''}
  </div>
</div>

<table>
  <thead><tr><th class="r">#</th><th>Pedido</th><th>Cliente</th><th>Entrega</th><th>Documento Kepler</th><th class="r">Importe</th></tr></thead>
  <tbody>
    ${filas}
    <tr class="tot"><td colspan="5">Total a liquidar</td><td class="r mono">$${m(s.total)}</td></tr>
  </tbody>
</table>
<p class="nota">El importe es el del documento de Kepler cuando ya está ligado; si no, el del pedido. Lo que no se entregue regresa a la sucursal y sale en otra guía.</p>

<p class="legal">Recibo la mercancía de los pedidos aquí listados y me comprometo a entregar al cajero el importe cobrado a los clientes o a devolver la mercancía que no se entregue. Reconozco la firma que imprimo en este documento y me hago responsable de la carga que ampara.</p>

<div class="firmas">
  <div><span class="quien">${esc(s.repartidor || '')}</span>Nombre y firma de quien recibe la carga</div>
  <div><span class="quien">${esc(s.impresa_por || '')}</span>Nombre y firma de quien entrega (caja)</div>
</div>
</body></html>`;
}
