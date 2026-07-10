import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * DM.1 — Diario de movimientos (mejora del reporte Kepler homónimo).
 *
 * Lee analytics.stock_movements (feed line-level de import-stock-movements.js).
 * Diseño: **agregación primero, folio a folio bajo demanda** (ver ERP_KEPLER_SCHEMA
 * §"Reporte Diario de movimientos" #7):
 *   - summary()   → KPIs por dirección + desglose por tipo de documento.
 *   - aggregate() → vista DEFAULT: totales agrupados (producto|tipo|día|almacén),
 *                   con entradas/salidas/neto/valorizado. Re-agrupable con group_by.
 *   - lines()     → DRILL: folios individuales de una rama (producto/tipo/fecha).
 *
 * analytics.* sin RLS → filtro tenant_id EXPLÍCITO. Todo dentro de tk.run().
 */

const GROUPS = ['product', 'doc_code', 'day', 'warehouse'] as const;
type GroupBy = (typeof GROUPS)[number];
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MovementsQuery {
  warehouse_id?: string;
  warehouse_ids?: string; // CSV multi-almacén
  from?: string;
  to?: string;
  doc_code?: string;      // filtra por tipo de documento (Sale1/Purchas1…)
  movement_kind?: string; // 'entrada' | 'salida'
  product_id?: string;
  search?: string;        // nombre/sku producto
  folio?: string;         // filtra un folio exacto (drill al documento)
  group_by?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class CommercialMovementsService {
  private readonly logger = new Logger(CommercialMovementsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private group(v?: string): GroupBy {
    return (GROUPS as readonly string[]).includes(v || '') ? (v as GroupBy) : 'product';
  }

  private whIds(q: MovementsQuery): string[] {
    return (q.warehouse_ids || q.warehouse_id || '')
      .split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
  }

  /** Rango por default: últimos 30 días. */
  private range(q: MovementsQuery): { from: string; to: string } {
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : new Date().toISOString().slice(0, 10);
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)
      ? q.from
      : new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return { from, to };
  }

  /** WHERE base reutilizable (tenant + rango + filtros). */
  private base(trx: any, tenantId: string, q: MovementsQuery) {
    const { from, to } = this.range(q);
    const b = trx('analytics.stock_movements as m')
      .where('m.tenant_id', tenantId)
      .andWhere('m.doc_date', '>=', from)
      .andWhere('m.doc_date', '<=', to);
    const whs = this.whIds(q);
    if (whs.length) b.whereIn('m.warehouse_id', whs);
    if (q.doc_code) b.where('m.doc_code', q.doc_code);
    if (q.movement_kind === 'entrada' || q.movement_kind === 'salida') b.where('m.movement_kind', q.movement_kind);
    if (q.product_id && UUID_RX.test(q.product_id)) b.where('m.product_id', q.product_id);
    if (q.folio) b.where('m.folio', q.folio);
    if (q.search) {
      b.whereIn('m.product_id',
        trx('public.products').select('id').where('tenant_id', tenantId)
          .andWhere((w: any) => w.whereILike('nombre', `%${q.search}%`).orWhereILike('sku', `%${q.search}%`)));
    }
    return b;
  }

  private entradas = `SUM(CASE WHEN m.signed_qty > 0 THEN m.qty ELSE 0 END)`;
  private salidas = `SUM(CASE WHEN m.signed_qty < 0 THEN m.qty ELSE 0 END)`;

  /** KPIs de cabecera + desglose por tipo de documento. */
  async summary(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [tot] = await this.base(trx, tenantId, q).select(
        trx.raw(`${this.entradas} AS entradas`),
        trx.raw(`${this.salidas} AS salidas`),
        trx.raw(`SUM(m.signed_qty) AS neto`),
        trx.raw(`SUM(m.amount) AS valor`),
        trx.raw(`COUNT(*)::int AS lineas`),
        trx.raw(`COUNT(DISTINCT m.folio)::int AS documentos`),
      );
      const byType = await this.base(trx, tenantId, q)
        .select('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .select(
          trx.raw(`SUM(m.qty) AS piezas`),
          trx.raw(`SUM(m.amount) AS valor`),
          trx.raw(`COUNT(*)::int AS lineas`),
        )
        .groupBy('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .orderBy('lineas', 'desc');
      const { from, to } = this.range(q);
      return { range: { from, to }, totals: tot, by_type: byType };
    });
  }

  /** Vista DEFAULT agregada. group_by = product | doc_code | day | warehouse. */
  async aggregate(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const g = this.group(q.group_by);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));

    return this.tk.run(async (trx) => {
      const build = () => {
        const b = this.base(trx, tenantId, q);
        if (g === 'product') {
          b.leftJoin('public.products as p', function (this: any) {
            this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
          }).groupBy('m.product_id', 'p.nombre', 'p.sku')
            .select('m.product_id as key', 'p.nombre as label', 'p.sku as sku');
        } else if (g === 'doc_code') {
          b.groupBy('m.doc_code', 'm.movement_label', 'm.movement_kind')
            .select('m.doc_code as key', 'm.movement_label as label', 'm.movement_kind');
        } else if (g === 'day') {
          b.groupBy('m.doc_date').select('m.doc_date as key', 'm.doc_date as label');
        } else {
          b.leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
            .groupBy('m.warehouse_id', 'w.name', 'w.code')
            .select('m.warehouse_id as key', 'w.name as label', 'w.code as code');
        }
        return b.select(
          trx.raw(`${this.entradas} AS entradas`),
          trx.raw(`${this.salidas} AS salidas`),
          trx.raw(`SUM(m.signed_qty) AS neto`),
          trx.raw(`SUM(m.amount) AS valor`),
          trx.raw(`COUNT(*)::int AS lineas`),
          trx.raw(`COUNT(DISTINCT m.folio)::int AS documentos`),
        );
      };

      const totalRows = (await build()).length;
      const rows = await build()
        .orderByRaw('SUM(m.amount) DESC NULLS LAST')
        .limit(pageSize).offset((page - 1) * pageSize);

      return { group_by: g, page, pageSize, total: totalRows, rows };
    });
  }

  /** DRILL: folios individuales (line-level) de una rama. */
  async lines(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 100));
    return this.tk.run(async (trx) => {
      const build = () => this.base(trx, tenantId, q)
        .leftJoin('public.products as p', function (this: any) {
          this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id');
      const [{ count }] = await build().count('* as count');
      const rows = await build()
        .select(
          'm.warehouse_id', 'm.doc_date', 'm.folio', 'm.doc_code', 'm.movement_label', 'm.movement_kind',
          'm.genero', 'm.naturaleza', 'm.doc_type', 'm.signed_qty', 'm.qty',
          'm.unit_cost', 'm.amount', 'm.parent_group', 'm.parent_folio', 'm.source_branch',
          'p.nombre as product_name', 'p.sku', 'w.code as warehouse_code',
        )
        .orderBy([{ column: 'm.doc_date', order: 'desc' }, { column: 'm.folio', order: 'desc' }])
        .limit(pageSize).offset((page - 1) * pageSize);
      return { page, pageSize, total: Number(count), rows };
    });
  }

  /** DRILL 3: documento completo — TODAS las líneas de un folio (sin filtrar por producto). */
  async document(p: { folio: string; warehouse_id: string; doc_code?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const q = trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .andWhere('m.folio', p.folio)
        .leftJoin('public.products as p', function (this: any) {
          this.on('p.id', 'm.product_id').andOn('p.tenant_id', 'm.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id');
      if (p.warehouse_id && UUID_RX.test(p.warehouse_id)) q.where('m.warehouse_id', p.warehouse_id);
      if (p.doc_code) q.where('m.doc_code', p.doc_code);
      const lines = await q.select(
        'm.doc_date', 'm.folio', 'm.doc_code', 'm.movement_label', 'm.movement_kind',
        'm.genero', 'm.naturaleza', 'm.doc_type', 'm.signed_qty', 'm.qty',
        'm.unit_cost', 'm.amount', 'm.parent_group', 'm.parent_folio', 'm.source_branch',
        'p.nombre as product_name', 'p.sku', 'w.code as warehouse_code',
      ).orderBy('p.nombre');
      if (!lines.length) return { header: null, lines: [], totals: { qty: 0, amount: 0, lineas: 0 } };
      const h = lines[0];
      const header = {
        folio: h.folio, doc_code: h.doc_code, movement_label: h.movement_label, movement_kind: h.movement_kind,
        doc_date: h.doc_date, genero: h.genero, naturaleza: h.naturaleza, doc_type: h.doc_type,
        warehouse_code: h.warehouse_code, source_branch: h.source_branch,
        parent_group: h.parent_group, parent_folio: h.parent_folio,
      };
      const totals = {
        qty: lines.reduce((s: number, l: any) => s + Number(l.signed_qty || 0), 0),
        amount: lines.reduce((s: number, l: any) => s + Number(l.amount || 0), 0),
        lineas: lines.length,
      };
      return { header, lines, totals };
    });
  }

  /** Almacenes + tipos de documento presentes (para los selects del frontend). */
  async filters() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const warehouses = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .distinct('m.warehouse_id as id', 'w.code', 'w.name')
        .orderBy('w.code');
      const doc_types = await trx('analytics.stock_movements as m')
        .where('m.tenant_id', tenantId)
        .distinct('m.doc_code', 'm.movement_label', 'm.movement_kind')
        .orderBy('m.movement_label');
      return { warehouses, doc_types };
    });
  }
}
