import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, applySmartSearch } from '@megadulces/platform-core';

/**
 * AX.1 — Documentos de venta al cliente (factura telemarketing / venta a crédito).
 *
 * Lee las VISTAS EN VIVO `analytics.erp_sales_invoices` / `_lines` (mig 20260822140000),
 * derivadas de `kepler_ods` por el CDC → frescura de segundos, sin feed ni tabla copiada.
 * No hay estado propio que guardar: este service es 100% lectura.
 *
 * `analytics.*` no tiene RLS → filtro `tenant_id` EXPLÍCITO, todo dentro de `tk.run()`.
 */

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_TIPOS = ['telemarketing', 'credito'] as const;
const MAX_PAGE = 200;

export interface SalesDocsQuery {
  from?: string;
  to?: string;
  warehouse_ids?: string;  // CSV de uuid
  doc_tipo?: string;       // telemarketing | credito
  cliente_code?: string;
  vendedor_code?: string;
  search?: string;         // cliente / RFC / folio / monto
  vencidas?: string;       // 'true' → sólo las que ya vencieron
  min?: string;            // importe mínimo
  page?: number;
  pageSize?: number;
}

@Injectable()
export class CommercialSalesDocumentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Ventana por defecto: últimos 30 días (la pantalla arranca acotada, no con todo). */
  private range(q: SalesDocsQuery) {
    const to = q.to || new Date().toISOString().slice(0, 10);
    const from = q.from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return { from, to };
  }

  /** '06UD0801-0000087' → {sucursal:'06', docPrefix:'UD0801', folio:'0000087'}; null si no calza. */
  private partes(folioDigital: string): { sucursal: string; docPrefix: string; folio: string } | null {
    const m = /^(\d{2})(UD\d{4})-(.+)$/.exec(String(folioDigital || '').trim());
    return m ? { sucursal: m[1], docPrefix: m[2], folio: m[3] } : null;
  }

  private whIds(q: SalesDocsQuery): string[] {
    return (q.warehouse_ids || '').split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
  }

  /** WHERE base compartido por list() y kpis() — si divergen, los KPIs mienten sobre la tabla. */
  private base(trx: any, tenantId: string, q: SalesDocsQuery) {
    const { from, to } = this.range(q);
    const b = trx('analytics.erp_sales_invoices as i')
      .where('i.tenant_id', tenantId)
      .andWhere('i.fecha', '>=', from)
      .andWhere('i.fecha', '<=', to);

    const whs = this.whIds(q);
    if (whs.length) b.whereIn('i.warehouse_id', whs);
    if (q.doc_tipo && (DOC_TIPOS as readonly string[]).includes(q.doc_tipo)) b.andWhere('i.doc_tipo', q.doc_tipo);
    if (q.cliente_code) b.andWhere('i.cliente_code', q.cliente_code.trim());
    if (q.vendedor_code) b.andWhere('i.vendedor_code', q.vendedor_code.trim());
    if (q.min && Number.isFinite(Number(q.min))) b.andWhere('i.total', '>=', Number(q.min));
    if (q.vencidas === 'true') b.andWhere('i.vencimiento', '<', trx.raw('current_date'));

    applySmartSearch(b, q.search, {
      columns: ['i.cliente_nombre', 'i.cliente_code', 'i.cliente_rfc', 'i.folio', 'i.folio_digital', 'i.vendedor_nombre'],
      numeric: ['i.total'],
    });
    return b;
  }

  /** Listado paginado + KPIs de la MISMA selección. */
  async list(q: SalesDocsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(q.pageSize) || 50));

    return this.tk.run(async (trx) => {
      const [rows, kpis] = await Promise.all([
        this.base(trx, tenantId, q)
          .select(
            'i.folio_digital', 'i.sucursal', 'i.warehouse_id', 'i.doc_prefix', 'i.doc_tipo', 'i.doc_label',
            'i.folio', 'i.fecha', 'i.vencimiento', 'i.dias_credito', 'i.limite_credito',
            'i.cliente_code', 'i.cliente_nombre', 'i.cliente_rfc',
            'i.vendedor_code', 'i.vendedor_nombre', 'i.canal', 'i.referencia',
            'i.total', 'i.ieps', 'i.descuento', 'i.descuento_pct', 'i.subtotal',
            trx.raw('(i.vencimiento < current_date) AS vencida'),
            trx.raw('(current_date - i.vencimiento) AS dias_vencida'),
          )
          .orderBy([{ column: 'i.fecha', order: 'desc' }, { column: 'i.folio', order: 'desc' }])
          .limit(pageSize).offset((page - 1) * pageSize),
        this.base(trx, tenantId, q)
          .select(
            trx.raw('count(*)::int AS documentos'),
            trx.raw('count(DISTINCT i.cliente_code)::int AS clientes'),
            trx.raw('coalesce(sum(i.total),0)::numeric AS importe'),
            trx.raw('coalesce(sum(i.descuento),0)::numeric AS descuento'),
            trx.raw('count(*) FILTER (WHERE i.vencimiento < current_date)::int AS vencidas'),
          ).first(),
      ]);
      return { rows, kpis, page, pageSize, range: this.range(q) };
    });
  }

  /**
   * Documento completo (cabecera + renglones) — lo que consume el anexo imprimible.
   *
   * OJO con el filtro: `folio_digital` es una expresión compuesta dentro de la vista
   * (`sucursal || doc_prefix || '-' || folio`) y el planner NO la puede empujar al índice →
   * medido en prod, filtrar por él costaba **3,031 ms**; por (sucursal, doc_prefix, folio),
   * **162 ms**. Se descompone acá y se filtra por las columnas simples.
   */
  async detail(folioDigital: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const p = this.partes(folioDigital);
    return this.tk.run(async (trx) => {
      const donde = p
        ? { tenant_id: tenantId, sucursal: p.sucursal, doc_prefix: p.docPrefix, folio: p.folio }
        : { tenant_id: tenantId, folio_digital: folioDigital }; // formato inesperado: lento pero correcto

      const doc = await trx('analytics.erp_sales_invoices').where(donde).first();
      if (!doc) throw new NotFoundException(`Documento ${folioDigital} no encontrado`);

      const lineas = await trx('analytics.erp_sales_invoice_lines')
        .where(donde)
        .select('linea', 'sku', 'descripcion', 'unidad', 'cantidad', 'precio_unitario',
                'importe', 'factor_caja', 'product_id')
        .orderBy('linea');

      // derivar() devuelve `lineas` ya enriquecidas (descuento/neto/precios por unidad) → esas mandan.
      return { ...doc, ...this.derivar(doc, lineas) };
    });
  }

  /**
   * Derivados del anexo. El descuento por renglón se reparte por MAYOR RESIDUO para que
   * las columnas sumen EXACTO el descuento del documento: redondear cada línea por separado
   * daba $1,357.89 contra $1,357.87 reales, y el cliente que sumara no cuadraba.
   */
  private derivar(doc: any, lineas: any[]) {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const importes = lineas.map((l) => Number(l.importe));
    const bruto = r2(importes.reduce((a, b) => a + b, 0));
    const pct = Number(doc.descuento_pct) || 0;

    // Objetivo = lo que realmente se descontó (bruto − total), no un % recalculado.
    const objetivo = Math.round((bruto - Number(doc.total)) * 100);
    const piso = importes.map((v) => Math.floor((v * pct) / 100 * 100));
    const resto = importes
      .map((v, i) => ({ i, f: (v * pct) / 100 * 100 - piso[i] }))
      .sort((a, b) => b.f - a.f);
    const cents = [...piso];
    for (let k = 0; k < Math.max(0, objetivo - piso.reduce((a, b) => a + b, 0)); k++) {
      if (resto[k]) cents[resto[k].i] += 1;
    }

    const detalle = lineas.map((l, i) => {
      const d = (cents[i] || 0) / 100;
      const precio = Number(l.precio_unitario);
      const factor = l.factor_caja ? Number(l.factor_caja) : null;
      const cant = Number(l.cantidad);
      // equivalencia en cajas sólo si hay factor real y la compra llega a una caja entera
      const cajas = factor && factor > 1 && cant / factor >= 1 ? cant / factor : null;
      return {
        ...l,
        descuento: d,
        neto: r2(Number(l.importe) - d),
        precio_con_descuento: r2(precio * (1 - pct / 100)),
        precio_caja: factor && factor > 1 ? r2(precio * factor) : null,
        precio_caja_con_descuento: factor && factor > 1 ? r2(precio * factor * (1 - pct / 100)) : null,
        cajas_equivalentes: cajas,
      };
    });
    return { importe_bruto: bruto, lineas: detalle };
  }

  /** Catálogos para poblar los filtros de la pantalla (de la misma ventana consultada). */
  async filtros(q: SalesDocsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    return this.tk.run(async (trx) => {
      const [vendedores, sucursales] = await Promise.all([
        trx('analytics.erp_sales_invoices').where('tenant_id', tenantId)
          .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
          .whereNotNull('vendedor_code')
          .distinct('vendedor_code', 'vendedor_nombre').orderBy('vendedor_nombre'),
        trx('analytics.erp_sales_invoices').where('tenant_id', tenantId)
          .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
          .whereNotNull('warehouse_id')
          .distinct('warehouse_id', 'sucursal').orderBy('sucursal'),
      ]);
      return { vendedores, sucursales, doc_tipos: DOC_TIPOS };
    });
  }
}
