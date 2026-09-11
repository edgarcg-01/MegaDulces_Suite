import { BadRequestException, Injectable } from '@nestjs/common';
import { AnexoVentaService } from './anexo-venta.service';
import { CommercialSalesDocumentsService, FacturaGuiaRow } from './commercial-sales-documents.service';

/**
 * GT.2 — Guía de Cobranza: el papel que sale con el cobrador.
 *
 * Es el documento que hoy se imprime desde Kepler, con dos diferencias deliberadas:
 *  - **sin sección de Ruta** (decisión Edgar 2026-09-11): acá la selección la hace una persona
 *    en pantalla, factura por factura, y no está atada a una ruta del ERP. Inventar una columna
 *    "Ruta" a partir de la sucursal sería dibujar un dato que nadie capturó.
 *  - la guía es de **UN SOLO VENDEDOR** (regla Edgar 2026-09-11): lleva las facturas que ESE
 *    vendedor generó y nada más. Una selección que mezcla vendedores se rechaza; no se imprime
 *    una guía "de varios" ni se elige uno por mayoría.
 *  - el importe es el **saldo pendiente** de la cartera (`kdue`), no el total del CFDI: lo que
 *    el cobrador va a cobrar. Cuando el documento no aparece en la cartera no se puede saber
 *    cuánto debe — se imprime el total marcado con `~` y se declara al pie, en vez de afirmar
 *    un saldo que nadie midió (ADR-056).
 *
 * Render por el navegador COMPARTIDO de `AnexoVentaService` (mismo lib, un solo Chromium).
 */

const MAX_FOLIOS = 500;

export interface GuiaCobranzaOpts {
  /** Quién recibe la guía. Va impreso sobre la línea de firma del responsable. */
  responsable?: string;
  /** Nota del emisor (una línea) — opcional. */
  nota?: string;
  /** Alcance de sucursal YA resuelto (ver el controller). `null`/ausente = sin recorte. */
  warehouse_codes?: string[] | null;
}

interface MovImpreso { folio: string; fecha: string; descuento: number; importe: number; derivado: boolean }
interface ClienteImpreso {
  cliente_id: string; nombre: string; direccion: string;
  descuento: number; total: number; derivado: boolean; movimientos: MovImpreso[];
}

@Injectable()
export class GuiaCobranzaService {
  constructor(
    private readonly docs: CommercialSalesDocumentsService,
    private readonly pdf: AnexoVentaService,
  ) {}

  async pdfDeFolios(folios: string[], opts: GuiaCobranzaOpts = {}): Promise<Buffer> {
    if (!Array.isArray(folios) || !folios.length) {
      throw new BadRequestException('Selecciona al menos una factura para generar la guía.');
    }
    if (folios.length > MAX_FOLIOS) {
      throw new BadRequestException(
        `La guía admite hasta ${MAX_FOLIOS} facturas por documento (se pidieron ${folios.length}).`);
    }

    const { rows, faltantes } = await this.docs.paraGuia(folios, { warehouse_codes: opts.warehouse_codes });
    // Una guía a la que le faltan facturas se ve igual de bien que una completa: el cobrador
    // saldría de menos sin enterarse. Se niega a imprimir y dice cuáles.
    if (faltantes.length) {
      throw new BadRequestException(
        `No se encontraron estas facturas: ${faltantes.slice(0, 10).join(', ')}`
        + (faltantes.length > 10 ? ` (+${faltantes.length - 10} más)` : ''));
    }
    const canceladas = rows.filter((r) => r.cancelada);
    if (canceladas.length) {
      throw new BadRequestException(
        'Hay facturas canceladas en Kepler dentro de la selección, y ésas no se cobran: '
        + canceladas.map((r) => r.folio_digital).join(', '));
    }

    // UN SOLO VENDEDOR por guía (Edgar 2026-09-11). La identidad es el CÓDIGO, no el nombre:
    // dos vendedores pueden llamarse igual y el mismo puede estar escrito de dos formas. Se
    // rechaza acá y no sólo en la pantalla, porque el endpoint recibe folios sueltos y nadie
    // garantiza que el que llama sea nuestra pantalla.
    const porVendedor = new Map<string, string>();
    for (const r of rows) {
      const code = String(r.vendedor_code ?? '').trim() || '(sin vendedor)';
      if (!porVendedor.has(code)) porVendedor.set(code, String(r.vendedor_nombre ?? '').trim() || code);
    }
    if (porVendedor.size > 1) {
      throw new BadRequestException(
        'La guía es de un solo vendedor y la selección tiene '
        + `${porVendedor.size}: ${[...porVendedor.values()].join(', ')}. `
        + 'Filtrá por vendedor y generá una guía por cada uno.');
    }

    const emisor = await this.docs.emisorFiscal();
    const clientes = this.agrupar(rows);
    const total = clientes.reduce((a, c) => a + c.total, 0);
    const [vendedorCode, vendedorNombre] = [...porVendedor.entries()][0] ?? ['', ''];
    const ahora = new Date();
    return this.pdf.renderPdf(
      this.html(clientes, {
        empresa: emisor.nombre,
        numero: this.sello(ahora, 'YMD'),
        fecha: this.sello(ahora, 'dmy'),
        total,
        vendedor: vendedorCode === '(sin vendedor)' ? null : vendedorNombre,
        documentos: rows.length,
        derivados: rows.filter((r) => r.estatus_cobro === 'sin_cartera' || r.saldo === null).length,
        responsable: (opts.responsable || '').trim(),
        nota: (opts.nota || '').trim(),
      }),
      this.pie(this.sello(ahora, 'dmyhm')),
    );
  }

  // ── armado ─────────────────────────────────────────────────────────────
  /**
   * Agrupa por cliente, como el documento de Kepler: el cobrador visita CLIENTES, no folios.
   * Dentro de cada cliente los movimientos van por fecha (lo más viejo primero: es lo que más
   * urge cobrar) — el orden lo fija la consulta.
   */
  private agrupar(rows: FacturaGuiaRow[]): ClienteImpreso[] {
    const mapa = new Map<string, ClienteImpreso>();
    for (const r of rows) {
      const code = String(r.cliente_code ?? '').trim() || '—';
      let c = mapa.get(code);
      if (!c) {
        c = {
          cliente_id: code,
          nombre: String(r.cliente_nombre ?? '').trim() || 'Sin nombre',
          direccion: this.direccion(r),
          descuento: 0, total: 0, derivado: false, movimientos: [],
        };
        mapa.set(code, c);
      }
      // Sin cartera ⇒ no hay saldo medido. Se imprime el total y queda marcado.
      const derivado = r.estatus_cobro === 'sin_cartera' || r.saldo === null;
      const importe = derivado ? Number(r.total) || 0 : Number(r.saldo) || 0;
      const desc = Number(r.descuento_efectivo) || 0;
      c.movimientos.push({
        folio: String(r.folio ?? '').trim(),
        fecha: this.fechaCorta(r.fecha),
        descuento: desc, importe, derivado,
      });
      c.descuento += desc;
      c.total += importe;
      c.derivado = c.derivado || derivado;
    }
    return [...mapa.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  /** Domicilio VERBATIM del ERP. Sin número de ruta al final: la guía ya no la trae. */
  private direccion(r: FacturaGuiaRow): string {
    return [r.cliente_domicilio, r.cliente_colonia, r.cliente_estado, r.cliente_cp ? `C.P. ${r.cliente_cp}` : '']
      .map((x) => String(x ?? '').trim()).filter(Boolean).join(', ') || '—';
  }

  // ── formato ────────────────────────────────────────────────────────────
  private m(n: number | string | null | undefined): string {
    return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  private esc(s: unknown): string {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  }
  /** `fecha` viene como DATE de Postgres: se lee en UTC o el día se corre uno para atrás (LC.16). */
  private fechaCorta(d: string | Date | null | undefined): string {
    if (!d) return '—';
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return String(d).slice(0, 10);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(x.getUTCDate())}/${p(x.getUTCMonth() + 1)}/${String(x.getUTCFullYear()).slice(2)}`;
  }
  /** Sello de impresión en hora de México (el documento se firma acá, no en UTC). */
  private sello(d: Date, forma: 'YMD' | 'dmy' | 'dmyhm'): string {
    const f = new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).reduce((a, p) => { a[p.type] = p.value; return a; }, {} as Record<string, string>);
    if (forma === 'YMD') return `${f.year}/${f.month}/${f.day} ${f.hour}:${f.minute}:${f.second}`;
    if (forma === 'dmy') return `${f.day}/${f.month}/${String(f.year).slice(2)}`;
    return `${f.day}-${f.month}-${f.year} ${f.hour}:${f.minute}`;
  }

  private pie(sello: string): string {
    return `<div style="width:100%;font-family:'Segoe UI',sans-serif;font-size:7.5pt;color:#8a8078;
      padding:0 9mm;display:flex;justify-content:space-between;align-items:center;">
      <span>Guía de Cobranza · impresa ${this.esc(sello)} · Mega Dulces</span>
      <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
  }

  // ── documento ──────────────────────────────────────────────────────────
  private html(clientes: ClienteImpreso[], h: {
    empresa: string; numero: string; fecha: string; total: number;
    vendedor: string | null;
    documentos: number; derivados: number; responsable: string; nota: string;
  }): string {
    const bloques = clientes.map((c) => {
      const movs = c.movimientos.map((mv) => `<tr>
        <td class="mono">${this.esc(mv.folio)}</td>
        <td class="mono">${this.esc(mv.fecha)}</td>
        <td class="r mono">${this.m(mv.descuento)}</td>
        <td class="r mono">${this.m(mv.importe)}${mv.derivado ? '<i class="mk">~</i>' : ''}</td>
      </tr>`).join('\n');
      return `<section class="cli">
        <div class="cli-head">
          <div class="cli-id">
            <span class="cod">${this.esc(c.cliente_id)}</span>
            <span class="nom">${this.esc(c.nombre)}</span>
            <div class="dir">${this.esc(c.direccion)}</div>
          </div>
          <div class="cli-res">
            <span><b>Concepto</b> Mercancía</span>
            <span><b>Tipo</b> Cobranza</span>
            <span><b>Descuento</b> ${this.m(c.descuento)}</span>
          </div>
        </div>
        <table class="movs">
          <thead><tr><th>Folio</th><th>Fecha</th><th class="r">Descuento</th><th class="r">Importe</th></tr></thead>
          <tbody>${movs}</tbody>
          <tfoot><tr>
            <td colspan="3" class="r">Total del cliente${c.derivado ? ' ~' : ''}</td>
            <td class="r mono tot">${this.m(c.total)}</td>
          </tr></tfoot>
        </table>
      </section>`;
    }).join('\n');

    const notaSaldo = h.derivados > 0
      ? `~ ${h.derivados} documento${h.derivados === 1 ? '' : 's'} no ${h.derivados === 1 ? 'aparece' : 'aparecen'} en la cartera del ERP: no se puede saber cuánto ${h.derivados === 1 ? 'debe' : 'deben'} y se imprime el total de la factura. El resto es el saldo pendiente al momento de imprimir.`
      : 'El importe es el saldo pendiente en la cartera al momento de imprimir.';

    return `<meta charset="utf-8"><title>Guía de Cobranza</title>
<style>
:root{--ink:#1b1b1b;--muted:#5f5f5f;--line:#c9c9c9;--line-2:#e4e4e4;--soft:#f6f5f3;--accent:#8a3c06}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#fff;color:var(--ink);font-family:"Segoe UI",Arial,Helvetica,sans-serif;font-size:9.5pt;line-height:1.25}
.mono{font-family:Consolas,"Courier New",monospace;font-variant-numeric:tabular-nums}
.r{text-align:right}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
  border-bottom:2px solid var(--ink);padding-bottom:6px}
.head .emp{font-size:13pt;font-weight:700;letter-spacing:.01em}
.head .sub{font-size:8.5pt;color:var(--muted);margin-top:2px}
.head .doc{text-align:right}
.head .doc .tit{font-size:12pt;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent)}
.head .doc .kv{font-size:8.5pt;color:var(--muted);margin-top:3px}
.head .doc .kv b{color:var(--ink);font-weight:600}
.head .doc .kv.vend{font-size:10pt;color:var(--ink);margin-top:4px}
.head .doc .kv.vend b{color:var(--muted);font-weight:600;font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em}
.tot-gen{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
  background:var(--soft);border:1px solid var(--line-2);padding:6px 10px;margin:8px 0 10px}
.tot-gen .lbl{font-size:8.5pt;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.tot-gen .val{font-size:14pt;font-weight:700;font-family:Consolas,"Courier New",monospace}
.cli{break-inside:avoid;page-break-inside:avoid;margin-bottom:9px;border:1px solid var(--line-2)}
.cli-head{display:flex;justify-content:space-between;gap:12px;background:var(--soft);
  border-bottom:1px solid var(--line-2);padding:4px 8px}
.cli-id .cod{font-family:Consolas,"Courier New",monospace;font-weight:700;margin-right:6px}
.cli-id .nom{font-weight:700}
.cli-id .dir{font-size:8pt;color:var(--muted);margin-top:1px}
.cli-res{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-size:8pt;color:var(--muted);white-space:nowrap}
.cli-res b{color:var(--ink);font-weight:600;margin-right:3px}
.movs{width:100%;border-collapse:collapse}
.movs th{font-size:7.5pt;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);
  font-weight:700;text-align:left;padding:3px 8px;border-bottom:1px solid var(--line-2)}
.movs th.r{text-align:right}
.movs td{padding:3px 8px;border-bottom:1px solid #f0efed}
.movs tfoot td{border-bottom:0;border-top:1px solid var(--line);font-weight:700;padding-top:4px}
.movs .tot{font-size:10.5pt}
.mk{font-style:normal;color:var(--accent);margin-left:2px}
.nota{font-size:8pt;color:var(--muted);margin:6px 0 0}
.legal{margin-top:14px;border-top:1px solid var(--line);padding-top:8px;
  font-size:7.5pt;line-height:1.35;color:#3d3d3d;text-align:justify}
.firmas{display:flex;gap:40px;margin-top:26px}
.firmas div{flex:1;text-align:center;border-top:1px solid var(--ink);padding-top:4px;font-size:8pt}
.firmas .quien{display:block;font-weight:700;font-size:9pt;min-height:12px}
</style>
<div class="head">
  <div>
    <div class="emp">${this.esc(h.empresa)}</div>
    <div class="sub">Documento interno de cobranza · no es comprobante fiscal</div>
  </div>
  <div class="doc">
    <div class="tit">Guía de Cobranza</div>
    ${h.vendedor ? `<div class="kv vend"><b>Vendedor</b> ${this.esc(h.vendedor)}</div>` : ''}
    <div class="kv"><b>Número</b> ${this.esc(h.numero)}</div>
    <div class="kv"><b>Fecha</b> ${this.esc(h.fecha)} · <b>${h.documentos}</b> documento${h.documentos === 1 ? '' : 's'} · <b>${clientes.length}</b> cliente${clientes.length === 1 ? '' : 's'}</div>
  </div>
</div>

<div class="tot-gen">
  <span class="lbl">Total general a cobrar</span>
  <span class="val">$${this.m(h.total)}</span>
</div>

${bloques}

<p class="nota">${notaSaldo}</p>
${h.nota ? `<p class="nota">${this.esc(h.nota)}</p>` : ''}

<p class="legal">Reconozco la firma que imprimo en este documento de mi persona y me hago totalmente responsable
en todo tiempo y lugar sobre la carga y/o documentos para cobro que ampara el valor de la mercancía según lo
establecido en el Art 201 Código Penal Estado de Guanajuato y sus demás correlativos de los demás Estados de la
República Mexicana, que a la letra dice: A quien mediante el engaño o el aprovechamiento del error en que alguien
se encuentre, obtenga ilícitamente alguna cosa ajena o alcance un lucro indebido para sí o para otro.</p>

<div class="firmas">
  <div><span class="quien">${this.esc(h.responsable)}</span>Nombre y Firma Del Responsable</div>
  <div><span class="quien"></span>Nombre y Firma De Encargado</div>
</div>`;
  }
}
