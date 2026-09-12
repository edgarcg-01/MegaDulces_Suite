import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
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
 * GT.12 — cada guía emitida se ARCHIVA (`commercial.collection_guides`): el expediente es el
 * historial por vendedor de lo que salió a cobrar. Se guarda el **snapshot de lo impreso**, no
 * sólo los folios: el importe es el saldo del momento y ese saldo se mueve; reconstruir la
 * reimpresión desde la cartera de hoy haría que el papel archivado y su copia dijeran cosas
 * distintas del mismo folio.
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

/** Lo impreso, tal cual salió: es lo que la reimpresión vuelve a dibujar. */
export interface SnapshotGuia {
  empresa: string;
  numero: string;
  fecha: string;
  sello: string;
  derivados: number;
  nota: string;
  clientes: ClienteImpreso[];
}

/** Un expediente archivado (`commercial.collection_guides`). */
export interface ExpedienteGuia {
  id: string;
  folio: string;
  vendedor_code: string | null;
  vendedor_nombre: string | null;
  responsable: string | null;
  sucursales: string[];
  documentos: number;
  clientes: number;
  total: string;
  folios: string[];
  created_at: string;
  created_by_username: string | null;
  snapshot: SnapshotGuia;
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
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async pdfDeFolios(folios: string[], opts: GuiaCobranzaOpts = {}): Promise<{ pdf: Buffer; expediente: ExpedienteGuia }> {
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
    const sinVendedor = vendedorCode === '(sin vendedor)';
    const ahora = new Date();

    // El expediente se archiva ANTES de imprimir: si el PDF falla, no queda un papel en la
    // calle sin registro; y si el archivado falla, no se imprime algo que nadie va a poder
    // reimprimir ni auditar. El folio del expediente va impreso en la guía.
    const expediente = await this.archivar({
      vendedorCode: sinVendedor ? null : vendedorCode,
      vendedorNombre: sinVendedor ? null : vendedorNombre,
      responsable: (opts.responsable || '').trim() || null,
      sucursales: [...new Set(rows.map((r) => String(r.sucursal)))],
      documentos: rows.length,
      clientes,
      total,
      folios: rows.map((r) => String(r.folio_digital)),
      derivados: rows.filter((r) => r.estatus_cobro === 'sin_cartera' || r.saldo === null).length,
      emisor: emisor.nombre,
      nota: (opts.nota || '').trim(),
      ahora,
    });

    return { pdf: await this.imprimir(expediente), expediente };
  }

  /**
   * Reimprime un expediente archivado — **desde su snapshot**, nunca reconstruyéndolo de la
   * cartera de hoy: la copia tiene que decir exactamente lo que decía el papel que se firmó.
   */
  async reimprimir(id: string): Promise<{ pdf: Buffer; expediente: ExpedienteGuia }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const row = await this.tk.run(async (trx) =>
      trx('commercial.collection_guides').where({ tenant_id: tenantId, id }).first());
    if (!row) throw new NotFoundException('Expediente no encontrado');
    const exp = this.aExpediente(row);
    return { pdf: await this.imprimir(exp), expediente: exp };
  }

  /** El PDF de un expediente (recién creado o archivado): un solo camino para los dos. */
  private async imprimir(exp: ExpedienteGuia): Promise<Buffer> {
    const s = exp.snapshot;
    return this.pdf.renderPdf(
      this.html(s.clientes, {
        empresa: s.empresa,
        folio: exp.folio,
        numero: s.numero,
        fecha: s.fecha,
        total: Number(exp.total) || 0,
        vendedor: exp.vendedor_nombre,
        documentos: exp.documentos,
        derivados: s.derivados,
        responsable: exp.responsable || '',
        nota: s.nota || '',
      }),
      this.pie(s.sello),
    );
  }

  /** Guarda el expediente con folio propio (`GC-YYYY-NNNNN`) y devuelve lo archivado. */
  private async archivar(d: {
    vendedorCode: string | null; vendedorNombre: string | null; responsable: string | null;
    sucursales: string[]; documentos: number; clientes: ClienteImpreso[]; total: number;
    folios: string[]; derivados: number; emisor: string; nota: string; ahora: Date;
  }): Promise<ExpedienteGuia> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();
    const snapshot: SnapshotGuia = {
      empresa: d.emisor,
      numero: this.sello(d.ahora, 'YMD'),
      fecha: this.sello(d.ahora, 'dmy'),
      sello: this.sello(d.ahora, 'dmyhm'),
      derivados: d.derivados,
      nota: d.nota,
      clientes: d.clientes,
    };
    return this.tk.run(async (trx) => {
      const year = Number(this.sello(d.ahora, 'YMD').slice(0, 4));
      const { rows: seq } = await trx.raw(
        `INSERT INTO commercial.collection_guide_sequences (tenant_id, year, current_value)
         VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.collection_guide_sequences.current_value + 1,
               updated_at = now()
         RETURNING current_value`,
        [tenantId, year],
      );
      const folio = `GC-${year}-${String(seq[0].current_value).padStart(5, '0')}`;
      const [row] = await trx('commercial.collection_guides')
        .insert({
          tenant_id: tenantId,
          folio,
          vendedor_code: d.vendedorCode,
          vendedor_nombre: d.vendedorNombre,
          responsable: d.responsable,
          sucursales: d.sucursales,
          documentos: d.documentos,
          clientes: d.clientes.length,
          total: d.total.toFixed(2),
          folios: d.folios,
          snapshot: JSON.stringify(snapshot),
          created_by: ctx?.userId ?? null,
          created_by_username: ctx?.username ?? null,
        })
        .returning('*');
      return this.aExpediente(row);
    });
  }

  /**
   * Historial de expedientes. Por default los del mes en curso: la pantalla es un archivo de
   * trabajo (¿qué salió a cobrar esta semana?), no un reporte anual.
   */
  async listar(q: { vendedor_code?: string; from?: string; to?: string; limit?: number }): Promise<ExpedienteGuia[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const limite = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('commercial.collection_guides').where('tenant_id', tenantId);
      if (q.vendedor_code) b.andWhere('vendedor_code', q.vendedor_code.trim());
      if (q.from) b.andWhere('created_at', '>=', `${q.from} 00:00:00`);
      if (q.to) b.andWhere('created_at', '<=', `${q.to} 23:59:59.999`);
      const rows = await b.orderBy('created_at', 'desc').limit(limite);
      return rows.map((r: Record<string, unknown>) => this.aExpediente(r));
    });
  }

  private aExpediente(row: Record<string, unknown>): ExpedienteGuia {
    const snap = row['snapshot'];
    return {
      id: String(row['id']),
      folio: String(row['folio']),
      vendedor_code: (row['vendedor_code'] as string) ?? null,
      vendedor_nombre: (row['vendedor_nombre'] as string) ?? null,
      responsable: (row['responsable'] as string) ?? null,
      sucursales: (row['sucursales'] as string[]) ?? [],
      documentos: Number(row['documentos']) || 0,
      clientes: Number(row['clientes']) || 0,
      total: String(row['total'] ?? '0'),
      folios: (row['folios'] as string[]) ?? [],
      created_at: String(row['created_at']),
      created_by_username: (row['created_by_username'] as string) ?? null,
      snapshot: (typeof snap === 'string' ? JSON.parse(snap) : snap) as SnapshotGuia,
    };
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
    empresa: string; folio: string; numero: string; fecha: string; total: number;
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
/* UNA firma, la del vendedor, centrada al pie (decisión Edgar 2026-09-11). El bloque del
   encargado se retiró: quien responde por la carga es quien sale a cobrar. */
.firmas{margin:30px auto 0;width:58%}
.firmas div{text-align:center;border-top:1px solid var(--ink);padding-top:4px;font-size:8pt}
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
    <div class="kv"><b>Expediente</b> ${this.esc(h.folio)}</div>
    <div class="kv"><b>Emitida</b> ${this.esc(h.numero)}</div>
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
  <div><span class="quien">${this.esc(h.responsable || h.vendedor || '')}</span>Nombre y Firma del Vendedor</div>
</div>`;
  }
}
