import { Injectable } from '@nestjs/common';
import { AnexoVentaService } from '../commercial-sales-documents/anexo-venta.service';
import { CommercialSalesDocumentsService } from '../commercial-sales-documents/commercial-sales-documents.service';
import type { DesgloseMonto, TicketDesglose, TicketDetalle, TicketLinea } from './commercial-tickets.service';

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

/**
 * `[TK.13]` Qué columnas opcionales lleva ESTE documento. Se decide una vez, por documento:
 *   · `lista` — si algún renglón tiene contra qué comparar (antes del 2026-08-13 Kepler no la
 *     guarda y, sin descuento de cliente, la columna entera sería guiones);
 *   · `desc` — si hay algún descuento (el 70% de los tickets de mostrador no trae ninguno);
 *   · `imp`/`iva`/`ieps` — sólo si el impuesto de los renglones reproduce la cabecera del ERP, y
 *     cada impuesto sólo si el documento lo causa. Columnas que no suman lo declarado son peores
 *     que no tenerlas (ADR-056).
 */
export interface Cols { lista: boolean; desc: boolean; imp: boolean; iva: boolean; ieps: boolean }

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * `[TK.13]` El desglose de una partida. `armar()` siempre lo llena; si no viene (un documento
 * armado a mano, o de antes de este cambio) se deriva de los campos que ya existían. El derivado
 * NO reparte el descuento de cliente: para eso hace falta el documento entero, y lo hace `armar()`.
 */
export function desgloseLinea(l: TicketLinea, desglosado: boolean): TicketDesglose {
  if (l.desglose) return l.desglose;
  const q = l.cantidad > 0 ? l.cantidad : 1;
  const sin = desglosado ? r2(l.importe - l.iva - l.ieps) : null;
  const partida: DesgloseMonto = {
    lista: l.lista_conocida ? r2(l.precio_lista * l.cantidad) : null,
    descuento: l.lista_conocida ? l.descuento_linea : 0,
    con_descuento: l.importe, sin_impuestos: sin,
    iva: desglosado ? l.iva : null, ieps: desglosado ? l.ieps : null, neto: l.importe,
  };
  const netoU = r2(l.importe / q);
  const sinU = sin != null ? r2(sin / q) : null;
  const impU = sinU != null ? r2(netoU - sinU) : null;
  return {
    partida,
    unitario: {
      lista: l.lista_conocida ? l.precio_lista : null,
      descuento: l.lista_conocida ? l.descuento_unitario : 0,
      con_descuento: netoU, sin_impuestos: sinU,
      iva: impU == null ? null : (l.impuesto_tipo === 'iva' ? impU : 0),
      ieps: impU == null ? null : (l.impuesto_tipo === 'ieps' ? impU : 0),
      neto: netoU,
    },
    descuento_cliente: 0,
  };
}

/** `[TK.13]` La fila de totales: la de `armar()`, o la suma de las partidas si no vino. */
export function desgloseTotal(doc: TicketDetalle): DesgloseMonto {
  if (doc.cascada.desglose_total) return doc.cascada.desglose_total;
  const ps = doc.lineas.map((l) => desgloseLinea(l, doc.cascada.impuesto_desglosado).partida);
  const suma = (k: 'sin_impuestos' | 'iva' | 'ieps') =>
    ps.some((x) => x[k] == null) ? null : r2(ps.reduce((a, x) => a + (x[k] as number), 0));
  return {
    lista: ps.some((x) => x.lista != null) ? doc.cascada.importe_lista : null,
    descuento: r2(ps.reduce((a, x) => a + x.descuento, 0)),
    con_descuento: r2(ps.reduce((a, x) => a + x.con_descuento, 0)),
    sin_impuestos: suma('sin_impuestos'), iva: suma('iva'), ieps: suma('ieps'),
    neto: r2(ps.reduce((a, x) => a + x.neto, 0)),
  };
}

/** `dd/MM/yy HH:mm` en hora de México: el momento de la REIMPRESIÓN (Kepler no guarda la de la venta). */
export function reimpresionMx(d: Date): string {
  const p = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`;
}

export function columnasDe(doc: TicketDetalle): Cols {
  const t = desgloseTotal(doc);
  const imp = doc.cascada.impuesto_desglosado && t.sin_impuestos != null;
  return {
    lista: t.lista != null && t.descuento > 0,
    desc: t.descuento > 0,
    imp,
    iva: imp && (t.iva ?? 0) > 0,
    ieps: imp && (t.ieps ?? 0) > 0,
  };
}

/** Columnas de dinero: c/desc y neto siempre, más las opcionales. */
const nCols = (c: Cols) => 2 + [c.lista, c.desc, c.imp, c.iva, c.ieps].filter(Boolean).length;

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
      <span>${esc(doc.origen_label)} ${esc(doc.id)} &middot; documento informativo</span>
      <span>Pagina <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
  }

  /**
   * `[TK.13]` Las celdas de dinero de UN juego de valores (unitario, partida o total), en el
   * orden en que se lee la cuenta:  lista − descuento = c/desc → sin imp. + IVA + IEPS = neto.
   *
   * Las columnas opcionales se deciden por DOCUMENTO (`Cols`), no por renglón: una columna que
   * aparece en unas filas y en otras no desalinea la tabla.
   */
  private celdas(m: DesgloseMonto, cols: Cols, l?: TicketLinea, conNeto = true): string {
    // Guion y no $0.00: un producto que no causa IEPS no es uno al que se le cobró cero.
    const imp = (v: number | null, tasa?: number) => v == null
      ? '<i>sin dato</i>'
      : v > 0 ? `${money(v)}${tasa ? ` <i>${Math.round(tasa * 100)}%</i>` : ''}` : '<i>&ndash;</i>';
    return `
      ${cols.lista ? `<td class="r ${m.descuento > 0 ? 'tachado' : ''}">${m.lista != null ? money(m.lista) : '<i>&ndash;</i>'}</td>` : ''}
      ${cols.desc ? `<td class="r ahorro">${m.descuento > 0 ? '-' + money(m.descuento) : ''}</td>` : ''}
      <td class="r fuerte">${money(m.con_descuento)}</td>
      ${cols.imp ? `<td class="r neto">${m.sin_impuestos != null ? money(m.sin_impuestos) : '<i>sin dato</i>'}</td>` : ''}
      ${cols.iva ? `<td class="r">${imp(m.iva, l?.iva_tasa)}</td>` : ''}
      ${cols.ieps ? `<td class="r">${imp(m.ieps, l?.ieps_tasa)}</td>` : ''}
      <td class="r fuerte">${conNeto ? money(m.neto) : ''}</td>`;
  }

  /**
   * `[TK.13]` Una partida, con el acomodo que el usuario marcó sobre el PDF:
   *
   *   · renglón del producto: la cantidad dice «VALOR UNITARIO» y el NETO va vacío — los valores
   *     son por pieza, y un neto por pieza al lado del de la partida se lee como dos cobros;
   *   · renglón «Total partida»: la cantidad dice «PZA × 4» y aquí sí va el neto, que es lo que
   *     suma al total del documento.
   *
   * Con UNA pieza el unitario ES la partida: va un solo renglón, con «PZA × 1» y su neto, para
   * que la columna de neto siga trayendo el importe de cada partida.
   */
  private fila(l: TicketLinea, cols: Cols, desglosado: boolean): string {
    const d = desgloseLinea(l, desglosado);
    const unidad = l.unidad ? `${esc(l.unidad)} ` : '';
    /**
     * `[TK.15]` **El código va en la MISMA línea que el nombre.** Pedido del usuario
     * (2026-10-01), con su propósito dicho: *«optimice el interlineado para no gastar tanto
     * papel»*.
     *
     * Antes eran dos bloques: el nombre y, debajo, «Código 83243». O sea **un renglón de
     * texto garantizado por producto**, aunque el nombre entrara en una sola línea.
     *
     * ⚠️ Medido sobre el PDF real que mandó el usuario (30 renglones, 2 páginas): con las 9
     * columnas de ese documento la celda de producto queda en ~24.5% del ancho, que a 8.5pt
     * son **~27 caracteres por línea** — no los 41 que decía el comentario de TK.13, que se
     * escribió para un documento con menos columnas. Con nombres de 25 a 44 caracteres, el
     * código entra al final de la última línea del nombre en vez de estrenar la suya.
     *
     * ⛔ Se quitó la palabra «Código». Es ambiguo a propósito declararlo: el número queda sin
     * rótulo, apoyado en que vive dentro de la columna «Producto» y pegado al nombre. Se
     * midió antes de decidirlo y la palabra costaba ~0 líneas (7 caracteres rara vez empujan
     * un salto), así que esto es preferencia de limpieza, no ahorro: si se prefiere el
     * rótulo, vuelve con una palabra.
     */
    const codigo = `<span class="p-sku">&middot; ${esc(l.sku || 's/c')}</span>`;
    // El espacio ANTES del span es obligatorio: sin él la equivalencia se pega al código
    // («20606· equivale a 1 PAQ»). Se vio en la maqueta renderizada, no en el código.
    const equiv = l.equivalencia ? ` <span class="p-eq">&middot; equivale a ${esc(l.equivalencia)}</span>` : '';
    const producto = `<td class="p-td"><span class="p-name">${esc(l.descripcion || l.sku || '')}</span> ${codigo}${equiv}</td>`;
    const cuantas = `<td class="r">${unidad}<i>&times;</i> ${cant(l.cantidad)}</td>`;
    if (l.cantidad === 1) {
      return `<tr class="u uno">${producto}${cuantas}${this.celdas(d.partida, cols, l)}</tr>`;
    }
    return `<tr class="u">${producto}
      <td class="r vu">Valor unitario</td>
      ${this.celdas(d.unitario, cols, l, false)}
    </tr><tr class="pt">
      <td class="pt-l">Total partida</td>
      ${cuantas}
      ${this.celdas(d.partida, cols, l)}
    </tr>`;
  }

  private html(doc: TicketDetalle, emisor: { rfc: string; nombre: string; cp: string }, ahora: Date = new Date()): string {
    const c = doc.cascada;
    const t = desgloseTotal(doc);
    const cols = columnasDe(doc);
    const filas = doc.lineas.map((l) => this.fila(l, cols, c.impuesto_desglosado)).join('\n');
    const logo = this.anexo.logo();

    // ── Resumen. Sale del MISMO desglose que la fila de totales de la tabla: si saliera de la
    // cabecera del ERP, el papel podría decir dos IVA distintos por un centavo.
    // Un "- $0.00" invita a buscar un descuento que no existe: las filas en cero no van.
    const resumen: string[] = [];
    if (t.descuento > 0 && t.lista != null) {
      resumen.push(`<tr><td>Precio de lista</td><td class="r">${money(t.lista)}</td></tr>`);
    }
    if (c.descuento_precio > 0) {
      resumen.push(`<tr class="desc"><td>Descuento en precio</td><td class="r">-${money(c.descuento_precio)}</td></tr>`);
    }
    // `[TK.d2]` «Descuento de cliente» con su porcentaje pelado. El importe es el MEDIDO por
    // armar() (Σ renglones − total), nunca `kdm1.c13`, que viaja sin impuesto (TK.d3b).
    if (c.descuento_documento > 0) {
      const pct = c.descuento_documento_pct_erp ? ` <i>(${c.descuento_documento_pct_erp}%)</i>` : '';
      resumen.push(`<tr class="desc"><td>Descuento de cliente${pct}</td><td class="r">-${money(c.descuento_documento)}</td></tr>`);
    }
    // Medido en el anexo: hay documentos donde el total es MAYOR que la suma de renglones
    // (redondeo a favor del cliente). Llamarlo "descuento negativo" confundiria; se nombra.
    if (c.descuento_documento < 0) {
      resumen.push(`<tr><td>Ajuste de redondeo</td><td class="r">${money(-c.descuento_documento)}</td></tr>`);
    }
    if (t.sin_impuestos != null) {
      resumen.push(`<tr class="neto"><td>Subtotal sin impuestos</td><td class="r">${money(t.sin_impuestos)}</td></tr>`);
      if (t.iva) resumen.push(`<tr><td>IVA</td><td class="r">${money(t.iva)}</td></tr>`);
      if (t.ieps) resumen.push(`<tr><td>IEPS</td><td class="r">${money(t.ieps)}</td></tr>`);
    }
    resumen.push(`<tr class="total"><td>Total pagado</td><td class="r">${money(c.total)}</td></tr>`);

    // Cuando el desglose fiscal no cuadra con la cabecera, se DICE por qué faltan las columnas.
    const impuestos = !cols.imp
      ? '<p class="nota">No se desglosan impuestos: la suma por producto no reproduce la que declara el documento en el ERP.</p>'
      : doc.impuestos_incluidos
        ? '<p class="nota">Cada partida: precio de lista &minus; descuento = precio con descuento, que ya incluye impuestos. Sin impuestos + IVA/IEPS = neto a pagar.</p>'
        : '<p class="nota">Los precios se muestran sin impuestos; el IVA se suma en el neto.</p>';

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
/* [TK.13] El nombre es lo unico elastico: toma lo que dejan las columnas de dinero (auto).
   Con las 9 columnas quedan ~26% (~51mm), arriba del p95 de 41 caracteres a 8.5pt. */
col.c-prod{width:auto}col.c-cant{width:9%}col.c-n{width:9.5%}
table.det tbody tr.u td{border-bottom:none}
/* El renglon de partida se lee como el total de la de arriba: mas chico, gris, sin nombre. */
table.det tbody tr.pt td{font-size:7.8pt;color:var(--ink-2);background:var(--soft);padding-top:1px;padding-bottom:2px}
table.det tbody tr.pt td.pt-l{text-align:right;font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700}
table.det tbody tr:not(.u) td{border-bottom:1px solid var(--line-2)}
table.det tbody tr.u:last-child td{border-bottom:1px solid var(--line-2)}
/* [TK.13] La marca de reimpresion y el rotulo del renglon unitario. */
.hd-title .reimp{margin-top:3px;font-size:8pt;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:700}
table.det td.vu{font-size:6.8pt;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;white-space:nowrap}
table.det tfoot tr.tot td{border-top:1.5px solid var(--ink);font-weight:800;padding:4px 5px;text-align:right}
table.det tfoot tr.tot td:first-child{text-align:left;font-size:7pt;letter-spacing:.08em;text-transform:uppercase}
/* El neto se tinta para que se lea como un bloque y no se confunda con el precio cobrado:
   son la misma magnitud en otra unidad (sin impuesto), y mezclarlas es el error caro. */
table.det td.neto,table.det thead th.neto{background:var(--accent-soft)}
table.det td.neto{color:var(--accent)}
table.det thead th.neto{color:var(--accent)}
table.det thead{display:table-header-group}
table.det thead th{font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;
  text-align:right;padding:3px 5px;border-bottom:1.5px solid var(--ink)}
table.det thead th.l{text-align:left}
table.det tbody tr{break-inside:avoid}
table.det tbody td{padding:2px 5px;border-bottom:1px solid var(--line-2);vertical-align:top}
table.det td.r{text-align:right}
/* [TK.15] Producto y codigo en el MISMO flujo de texto: el codigo deja de ocupar un renglon
   propio y se acomoda al final del nombre. La celda fija el interlineado para los dos, porque
   con dos line-height distintos en la misma linea manda el mayor y el ahorro se diluye.
   nowrap en el codigo: partido en dos lineas no se puede leer ni dictar. */
td.p-td{line-height:1.14}
.p-name{font-weight:700;font-size:8.5pt}
.p-sku{font-size:7pt;color:var(--muted);font-weight:700;white-space:nowrap}
.p-eq{font-size:7pt;color:var(--muted);font-weight:600}
td i{font-style:normal;color:var(--muted);font-size:7pt;font-weight:600}
/* El tachado es lo que hace legible la promesa "antes costaba X, pagaste Y" sin leer la
   columna de descuento: se ve de un vistazo y sobrevive a una fotocopia en blanco y negro. */
.tachado{text-decoration:line-through;color:var(--muted)}
.fuerte{font-weight:700}
.ahorro{color:var(--save);font-weight:700}
.cierre{display:flex;gap:10px;margin-top:9px;break-inside:avoid;align-items:flex-start}
.cierre .hueco{flex:1 1 auto}
table.res{border-collapse:collapse;flex:0 0 78mm;font-size:9.5pt}
table.res td{padding:3px 8px;border-bottom:1px solid var(--line-2);white-space:nowrap}
table.res td.r{text-align:right;font-weight:700;white-space:nowrap}
table.res tr.desc td{color:var(--save)}
table.res tr.total td{border-top:1.5px solid var(--ink);border-bottom:none;font-size:11.5pt;font-weight:800;padding-top:5px}
.ahorraste{margin-top:6px;padding:6px 10px;background:var(--save-soft);border:1.5px solid var(--save);border-radius:4px;
  color:#0f4527;font-size:10pt;font-weight:800;text-align:center;break-inside:avoid}
.ahorraste i{display:block;font-style:normal;font-size:7.5pt;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.nota{font-size:7.5pt;color:var(--muted);margin:5px 0 0;line-height:1.3}
</style>
<div class="head">
  ${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
  <div class="hd-title">
    <div class="sub">${esc(doc.origen_label)}</div>
    <h1>Detalle de tu compra</h1>
    <div class="reimp">Reimpresión ${esc(reimpresionMx(ahora))}</div>
  </div>
  <div class="emisor">
    <b>${esc(emisor.nombre)}</b>
    RFC ${esc(emisor.rfc)} &middot; C.P. ${esc(emisor.cp)}
    <div class="fl">Folio</div><div class="fv">${esc(doc.id)}</div>
  </div>
</div>
<div class="rule"></div>

<!-- El banderín "NO FISCAL" se retiró a pedido de Edgar (2026-09-18), y la leyenda «no fiscal»
     del pie también (TK.14, pedido del usuario 2026-09-30). El pie dice «documento informativo», que es
     donde la llevan los demás papeles de la suite. Lo que se quitó es el bloque grande que se
     comía el ancho arriba del contenido, no la declaración. -->
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

<!-- El recuadro del aviso de procedencia se retiro del PAPEL a pedido del usuario (TK.5), igual
     que en el ticket. ⚠️ El aviso NO desaparecio: lo sigue mostrando /comercial/tickets, que es
     quien reimprime. Lo que declara —en un documento anterior al 2026-08-13 un descuento en
     $0.00 significa "no se sabe", no "no hubo"— le sirve al operador, no al cliente. Si algun
     dia se quita tambien de la pantalla, esa distincion deja de ser visible para nadie. -->

<div class="sec-h"><h2>Productos</h2>
  <span>${doc.lineas.length} renglon${doc.lineas.length === 1 ? '' : 'es'}</span></div>
<table class="det">
  <colgroup><col class="c-prod"><col class="c-cant">${'<col class="c-n">'.repeat(nCols(cols))}</colgroup>
  <thead><tr>
    <th class="l">Producto</th><th>Cantidad</th>
    ${cols.lista ? '<th>Precio lista</th>' : ''}${cols.desc ? '<th>Descuento</th>' : ''}
    <th>Precio c/desc</th>${cols.imp ? '<th class="neto">Sin impuestos</th>' : ''}
    ${cols.iva ? '<th>IVA</th>' : ''}${cols.ieps ? '<th>IEPS</th>' : ''}<th>Neto</th>
  </tr></thead>
  <tbody>${filas}</tbody>
  <tfoot><tr class="tot"><td>Totales</td><td></td>${this.celdas(t, cols)}</tr></tfoot>
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
