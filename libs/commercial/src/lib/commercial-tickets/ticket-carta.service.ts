import { Injectable } from '@nestjs/common';
import { AnexoVentaService } from '../commercial-sales-documents/anexo-venta.service';
import { CommercialSalesDocumentsService } from '../commercial-sales-documents/commercial-sales-documents.service';
import type { TicketDetalle, TicketLinea } from './commercial-tickets.service';

/**
 * Fase TK.3 — El MISMO ticket, en tamaño carta.
 *
 * Se pidió explícitamente que no hubiera "muchos diseños de los mismos documentos", así que
 * este servicio **no estrena maqueta**: hereda la del anexo de venta (Fase AX) —membrete con
 * logo, franja del emisor, sello de "no fiscal", cajas de contexto, tabla de renglones— y sólo
 * cambia el cuerpo, que acá es la cascada de descuento en vez del pagaré.
 *
 * Y tampoco estrena navegador: llama a `AnexoVentaService.renderPdf()`, que mantiene UNA
 * instancia de Chromium compartida con timer de inactividad. Lanzar la propia costaría los
 * ~150 MB que ese timer existe para no pagar (ADR-043, OOM).
 *
 * La identidad fiscal del emisor sale de `fiscal.issuer_config`, nunca de una constante:
 * reusa `CommercialSalesDocumentsService.emisorFiscal()`.
 *
 * ⚠️ **NO ES COMPROBANTE FISCAL** y el papel lo dice en su propio sello. Es un desglose
 * informativo de una venta que ya ocurrió; el CFDI lo emite el ERP.
 */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (n: unknown) =>
  '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Cantidades: enteras se ven enteras; a granel conservan sus decimales (0.6 KG es una venta real). */
const cant = (n: number) => Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));

@Injectable()
export class TicketCartaService {
  constructor(
    private readonly anexo: AnexoVentaService,
    private readonly docs: CommercialSalesDocumentsService,
  ) {}

  async pdf(doc: TicketDetalle): Promise<Buffer> {
    const emisor = await this.docs.emisorFiscal();
    return this.anexo.renderPdf(this.html(doc, emisor), this.pie(doc));
  }

  private fechaLarga(iso: string | null): string {
    if (!iso) return 'sin fecha';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    // Se parte el string en vez de `new Date(iso)`: un `date` de Postgres interpretado como UTC
    // y renderizado en hora de México sale con el día ANTERIOR. Ya pasó en la Fase LC (LC.16),
    // donde el día equivocado llegó al TXT entregado a la contadora.
    return `${d} de ${MESES[m - 1]} de ${y}`;
  }

  private pie(doc: TicketDetalle): string {
    return `<div style="width:100%;font-family:'Segoe UI',sans-serif;font-size:7.5pt;color:#8a8078;
      padding:0 9mm;display:flex;justify-content:space-between">
      <span>${esc(doc.origen_label)} ${esc(doc.id)} &middot; documento informativo, no fiscal</span>
      <span>Pagina <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
  }

  /**
   * Un renglón de la tabla. Dos columnas son condicionales:
   *   · la de descuento existe sólo si el documento trae alguno (el 70% no);
   *   · la de precio de lista desaparece ENTERA cuando ningún renglón lo tiene — es lo que
   *     pasa en todo documento anterior al 2026-08-13, cuando Kepler empezó a guardarlo.
   *     Dejarla con guiones o en $0.00 le daría al cliente un "antes costaba nada".
   */
  private fila(l: TicketLinea, conDesc: boolean, conLista: boolean): string {
    const rebaja = l.descuento_linea > 0;
    return `<tr>
      <td><div class="p-name">${esc(l.descripcion || l.sku || '')}</div>
        <div class="p-sku">${esc(l.sku || '')}${l.equivalencia ? ` &middot; equivale a ${esc(l.equivalencia)}` : ''}</div></td>
      <td class="r">${cant(l.cantidad)}${l.unidad ? ` <i>${esc(l.unidad)}</i>` : ''}</td>
      ${conLista ? `<td class="r ${rebaja ? 'tachado' : ''}">${l.lista_conocida ? money(l.precio_lista) : '<i>sin dato</i>'}</td>` : ''}
      <td class="r fuerte">${money(l.precio_pagado)}</td>
      ${conDesc ? `<td class="r ahorro">${rebaja ? '-' + money(l.descuento_linea) : ''}</td>` : ''}
      <td class="r fuerte">${money(l.importe)}</td>
    </tr>`;
  }

  private html(doc: TicketDetalle, emisor: { rfc: string; nombre: string; cp: string }): string {
    const c = doc.cascada;
    // La columna de descuento se imprime sólo si hay alguno: en el mostrador, 70 de cada 100
    // tickets no traen ninguno y una columna de guiones sólo gasta ancho del nombre del producto.
    const conDesc = c.descuento_precio > 0;
    // Cobertura del precio de lista, DECLARADA. Sin ella la columna "Precio de lista" no se
    // imprime en blanco ni en cero: no se imprime, y el aviso dice por que.
    const conLista = c.lineas_con_lista > 0;
    const filas = doc.lineas.map((l) => this.fila(l, conDesc, conLista)).join('\n');
    const logo = this.anexo.logo();

    // Los renglones del resumen se arman como lista y se filtran: un "- $0.00" invita a
    // buscar un descuento que no existe.
    // "Precio de lista" solo si hay algo que restarle: sin descuento es el total repetido con
    // otro nombre, y dos cifras iguales con etiquetas distintas se leen como una correccion.
    const hayQueRestar = c.descuento_precio > 0 || c.descuento_documento !== 0;
    const resumen: string[] = hayQueRestar
      ? [`<tr><td>Precio de lista</td><td class="r">${money(c.importe_lista)}</td></tr>`]
      : [];
    if (c.descuento_precio > 0) {
      resumen.push(`<tr class="desc"><td>Descuento en precio</td><td class="r">-${money(c.descuento_precio)}</td></tr>`);
    }
    if (c.descuento_documento > 0) {
      const pct = c.descuento_documento_pct_erp ? ` <i>(${c.descuento_documento_pct_erp}% del ERP)</i>` : '';
      resumen.push(`<tr class="desc"><td>Descuento del documento${pct}</td><td class="r">-${money(c.descuento_documento)}</td></tr>`);
    } else if (c.descuento_documento < 0) {
      // Medido en el anexo: hay documentos donde el total es MAYOR que la suma de renglones
      // (redondeo a favor del cliente). Llamarlo "descuento negativo" confundiria; se nombra.
      resumen.push(`<tr><td>Ajuste de redondeo</td><td class="r">${money(-c.descuento_documento)}</td></tr>`);
    }
    if (!doc.impuestos_incluidos && c.iva != null && c.iva > 0) {
      resumen.push(`<tr><td>IVA</td><td class="r">${money(c.iva)}</td></tr>`);
    }
    resumen.push(`<tr class="total"><td>Total pagado</td><td class="r">${money(c.total)}</td></tr>`);

    const impuestos = doc.impuestos_incluidos
      ? `<p class="nota">Los precios ya incluyen impuestos${c.iva ? ` &middot; IVA ${money(c.iva)}` : ''}${c.ieps ? ` &middot; IEPS ${money(c.ieps)}` : ''}.</p>`
      : '<p class="nota">Los precios se muestran sin impuestos; el IVA se suma en el resumen.</p>';

    return `<meta charset="utf-8"><title>Ticket de venta ${esc(doc.id)}</title>
<style>
:root{--ink:#1b1b1b;--ink-2:#454545;--muted:#5f5f5f;--line:#c9c9c9;--line-2:#e2e2e2;--soft:#f5f5f3;
  --accent:#8a3c06;--accent-soft:#fbf1e6;--save:#155e35;--save-soft:#eaf5ee}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;padding:0;background:#fff;color:var(--ink);font-family:"Segoe UI",Arial,Helvetica,sans-serif;font-size:10.5pt;line-height:1.25}
.head{display:flex;justify-content:space-between;align-items:center;gap:16px}
.logo{height:62px;width:auto;flex:0 0 auto}
.hd-title{flex:1 1 auto}
.hd-title .sub{font-size:7pt;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);font-weight:700}
.hd-title h1{font-family:Georgia,"Times New Roman",serif;font-weight:700;font-size:15pt;margin:0;line-height:1.05}
.emisor{text-align:right;font-size:7.5pt;color:var(--ink-2);line-height:1.3;flex:0 0 auto;max-width:104mm}
.emisor b{display:block;color:var(--ink);font-size:9pt;font-weight:700}
.emisor .fl{font-size:7pt;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:700}
.emisor .fv{font-size:10.5pt;font-weight:700;color:var(--ink)}
.rule{height:2px;background:var(--accent);margin:4px 0 0}
.nofiscal{display:flex;align-items:center;gap:8px;margin-top:5px;padding:2px 9px;background:var(--accent-soft);
  border:1.5px solid var(--accent);border-radius:4px;color:#6d2f04;font-size:7.5pt;font-weight:600;line-height:1.25;break-inside:avoid}
.nofiscal .badge{flex:0 0 auto;font-size:7pt;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  background:var(--accent);color:#fff;padding:2px 7px;border-radius:3px}
.info{display:flex;gap:8px;margin-top:7px}
.box{flex:1 1 0;background:var(--soft);border:1px solid var(--line-2);border-radius:4px;padding:4px 8px;break-inside:avoid}
.info>.box:first-child{flex:1.35 1 0}
.box h4{margin:0 0 2px;font-size:7pt;letter-spacing:.11em;text-transform:uppercase;color:var(--accent);font-weight:700}
.kv{display:grid;grid-template-columns:auto 1fr;gap:0 9px;font-size:8pt;margin:0;line-height:1.18}
.kv dt{color:var(--muted);font-weight:600;white-space:nowrap}
.kv dd{margin:0;text-align:right;font-weight:600}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:8px 0 3px;break-after:avoid}
.sec-h h2{font-size:11pt;font-weight:700;margin:0}
.sec-h span{font-size:8pt;color:var(--muted)}
table.det{border-collapse:collapse;width:100%;table-layout:fixed;font-size:8.5pt}
col.c-prod{width:41%}col.c-cant{width:11%}col.c-pl{width:12%}col.c-pp{width:12%}col.c-ds{width:12%}col.c-imp{width:12%}
table.det.sin-desc col.c-prod{width:47%}
table.det thead{display:table-header-group}
table.det thead th{font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;
  text-align:right;padding:3px 5px;border-bottom:1.5px solid var(--ink)}
table.det thead th.l{text-align:left}
table.det tbody tr{break-inside:avoid}
table.det tbody td{padding:2px 5px;border-bottom:1px solid var(--line-2);vertical-align:top}
table.det td.r{text-align:right}
.p-name{font-weight:700;font-size:8.5pt;line-height:1.18}
.p-sku{font-size:7pt;color:var(--muted);font-weight:600;margin-top:1px;line-height:1.2}
td i{font-style:normal;color:var(--muted);font-size:7pt;font-weight:600}
/* El tachado es lo que hace legible la promesa "antes costaba X, pagaste Y" sin leer la
   columna de descuento: se ve de un vistazo y sobrevive a una fotocopia en blanco y negro. */
.tachado{text-decoration:line-through;color:var(--muted)}
.fuerte{font-weight:700}
.ahorro{color:var(--save);font-weight:700}
.cierre{display:flex;gap:10px;margin-top:9px;break-inside:avoid;align-items:flex-start}
.cierre .hueco{flex:1 1 auto}
table.res{border-collapse:collapse;flex:0 0 78mm;font-size:9.5pt}
table.res td{padding:3px 8px;border-bottom:1px solid var(--line-2)}
table.res td.r{text-align:right;font-weight:700;white-space:nowrap}
table.res tr.desc td{color:var(--save)}
table.res tr.total td{border-top:1.5px solid var(--ink);border-bottom:none;font-size:11.5pt;font-weight:800;padding-top:5px}
.ahorraste{margin-top:6px;padding:6px 10px;background:var(--save-soft);border:1.5px solid var(--save);border-radius:4px;
  color:#0f4527;font-size:10pt;font-weight:800;text-align:center;break-inside:avoid}
.ahorraste i{display:block;font-style:normal;font-size:7.5pt;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.nota{font-size:7.5pt;color:var(--muted);margin:5px 0 0;line-height:1.3}
.aviso{margin-top:7px;padding:5px 9px;border:1.5px solid #8a6d06;background:#fdf6e3;border-radius:4px;
  font-size:8pt;font-weight:600;color:#5c4803;break-inside:avoid}
</style>
<div class="head">
  ${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
  <div class="hd-title">
    <div class="sub">${esc(doc.origen_label)}</div>
    <h1>Detalle de tu compra</h1>
  </div>
  <div class="emisor">
    <b>${esc(emisor.nombre)}</b>
    RFC ${esc(emisor.rfc)} &middot; C.P. ${esc(emisor.cp)}
    <div class="fl">Folio</div><div class="fv">${esc(doc.id)}</div>
  </div>
</div>
<div class="rule"></div>
<div class="nofiscal"><span class="badge">No fiscal</span>
  <span>Este documento desglosa lo que se cobro y el descuento que se aplico. <b>No sustituye al CFDI</b>,
  que lo emite el ERP.</span></div>

<div class="info">
  <div class="box"><h4>Cliente</h4>
    <dl class="kv">
      <dt>Nombre</dt><dd>${esc(doc.cliente_nombre || 'Publico en general')}</dd>
      <dt>RFC</dt><dd>${esc(doc.cliente_rfc || 'sin RFC')}</dd>
    </dl></div>
  <div class="box"><h4>Documento</h4>
    <dl class="kv">
      <dt>Tipo</dt><dd>${esc(doc.doc_label || doc.origen_label)}</dd>
      <dt>Fecha</dt><dd>${esc(this.fechaLarga(doc.fecha))}</dd>
      ${doc.caja != null ? `<dt>Caja</dt><dd>${doc.caja}</dd>` : ''}
    </dl></div>
  <div class="box"><h4>Sucursal</h4>
    <dl class="kv">
      <dt>Plaza</dt><dd>${esc(doc.sucursal_nombre || doc.sucursal || 'sin asignar')}</dd>
      ${doc.atendio ? `<dt>${esc(doc.atendio_rol || 'Atendio')}</dt><dd>${esc(doc.atendio)}</dd>` : ''}
    </dl></div>
</div>

${doc.aviso ? `<div class="aviso">${esc(doc.aviso)}</div>` : ''}

<div class="sec-h"><h2>Productos</h2>
  <span>${doc.lineas.length} renglon${doc.lineas.length === 1 ? '' : 'es'}</span></div>
<table class="det ${conDesc ? '' : 'sin-desc'}">
  <colgroup><col class="c-prod"><col class="c-cant">${conLista ? '<col class="c-pl">' : ''}<col class="c-pp">${conDesc ? '<col class="c-ds">' : ''}<col class="c-imp"></colgroup>
  <thead><tr>
    <th class="l">Producto</th><th>Cantidad</th>${conLista ? '<th>Precio de lista</th>' : ''}<th>${conLista ? 'Precio pagado' : 'Precio'}</th>
    ${conDesc ? '<th>Descuento</th>' : ''}<th>Importe</th>
  </tr></thead>
  <tbody>${filas}</tbody>
</table>

<div class="cierre">
  <div class="hueco">${impuestos}</div>
  <div>
    <table class="res"><tbody>${resumen.join('\n')}</tbody></table>
    ${c.descuento_total > 0
      ? `<div class="ahorraste"><i>En esta compra ahorraste</i>${money(c.descuento_total)} (${c.descuento_total_pct}%)</div>`
      : ''}
  </div>
</div>`;
  }
}
