import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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

  /**
   * DRILL: folios de una rama, ENGLOBADOS — una fila por documento (folio×tipo×almacén),
   * no por línea. `lineas` dice cuántos productos trae; el detalle lo da document().
   */
  async lines(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 100));
    return this.tk.run(async (trx) => {
      const grouped = () => this.base(trx, tenantId, q)
        .groupBy('m.warehouse_id', 'm.folio', 'm.doc_code', 'm.doc_serie', 'm.movement_label', 'm.movement_kind', 'm.source_branch');
      const countRows: any[] = await trx.count('* as count').from(grouped().select('m.folio').as('g'));
      const count = countRows[0]?.count ?? 0;
      const rows = await grouped()
        .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        // DM.4 — marca humana "auditado" (identidad doc = warehouse+doc_code+serie+folio)
        .leftJoin('commercial.stock_movement_audits as a', function (this: any) {
          this.on('a.tenant_id', 'm.tenant_id').andOn('a.warehouse_id', 'm.warehouse_id')
            .andOn('a.doc_code', 'm.doc_code').andOn('a.folio', 'm.folio')
            .andOn(trx.raw(`a.doc_serie = coalesce(m.doc_serie,'')`));
        })
        .groupBy('w.code')
        .select(
          'm.warehouse_id', 'm.folio', 'm.doc_code', 'm.doc_serie', 'm.movement_label', 'm.movement_kind',
          'm.source_branch', 'w.code as warehouse_code',
        )
        .select(
          trx.raw(`MIN(m.doc_date) AS doc_date`),
          trx.raw(`COUNT(*)::int AS lineas`),
          trx.raw(`SUM(m.signed_qty) AS signed_qty`),
          trx.raw(`SUM(m.qty) AS qty`),
          trx.raw(`SUM(m.amount) AS amount`),
          trx.raw(`MAX(m.parent_group) AS parent_group`),
          trx.raw(`MAX(m.parent_folio) AS parent_folio`),
          trx.raw(`COUNT(a.id) > 0 AS audited`),
          trx.raw(`MAX(a.audited_by) AS audited_by`),
          trx.raw(`MAX(a.created_at) AS audited_at`),
        )
        .orderByRaw('MIN(m.doc_date) DESC, m.folio DESC')
        .limit(pageSize).offset((page - 1) * pageSize);
      return { page, pageSize, total: Number(count), rows };
    });
  }

  /** DM.4 — marca/desmarca un documento como auditado. Identidad = wh+doc_code+serie+folio. */
  async setAudit(dto: { warehouse_id: string; doc_code: string; doc_serie?: string | null; folio: string; audited: boolean; note?: string | null }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const username = this.tenantCtx.get()?.username || null;
    if (!dto?.warehouse_id || !UUID_RX.test(dto.warehouse_id) || !dto.doc_code || !dto.folio) {
      throw new BadRequestException('warehouse_id, doc_code y folio son requeridos');
    }
    const serie = dto.doc_serie ?? '';
    return this.tk.run(async (trx) => {
      if (dto.audited === false) {
        const n = await trx('commercial.stock_movement_audits')
          .where({ tenant_id: tenantId, warehouse_id: dto.warehouse_id, doc_code: dto.doc_code, doc_serie: serie, folio: dto.folio })
          .delete();
        return { audited: false, removed: n };
      }
      await trx.raw(`
        INSERT INTO commercial.stock_movement_audits (tenant_id, warehouse_id, doc_code, doc_serie, folio, audited_by, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, warehouse_id, doc_code, doc_serie, folio)
        DO UPDATE SET audited_by = EXCLUDED.audited_by, note = EXCLUDED.note, updated_at = now()`,
        [tenantId, dto.warehouse_id, dto.doc_code, serie, dto.folio, username, dto.note ?? null]);
      return { audited: true, audited_by: username };
    });
  }

  /** DRILL 3: documento completo — TODAS las líneas de un folio (sin filtrar por producto). */
  async document(p: { folio: string; warehouse_id: string; doc_code?: string; doc_serie?: string }) {
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
      if (p.doc_serie != null && p.doc_serie !== '') q.whereRaw(`coalesce(m.doc_serie,'') = ?`, [p.doc_serie]);
      const lines = await q.select(
        'm.warehouse_id', 'm.doc_date', 'm.folio', 'm.doc_code', 'm.movement_label', 'm.movement_kind',
        'm.genero', 'm.naturaleza', 'm.doc_type', 'm.doc_serie', 'm.signed_qty', 'm.qty',
        'm.unit_cost', 'm.amount', 'm.parent_group', 'm.parent_serie', 'm.parent_folio', 'm.source_branch',
        'p.nombre as product_name', 'p.sku', 'w.code as warehouse_code',
      ).orderBy('p.nombre');
      if (!lines.length) return { header: null, lines: [], totals: { qty: 0, amount: 0, lineas: 0 }, counterpart: null };
      const h = lines[0];
      // DM.4 — estado de auditoría humana del documento
      const auditRow = await trx('commercial.stock_movement_audits')
        .where({ tenant_id: tenantId, warehouse_id: h.warehouse_id, doc_code: h.doc_code, folio: h.folio })
        .andWhereRaw(`doc_serie = coalesce(?, '')`, [h.doc_serie])
        .first('audited_by', 'note', 'created_at');
      const header = {
        folio: h.folio, doc_code: h.doc_code, doc_serie: h.doc_serie, movement_label: h.movement_label, movement_kind: h.movement_kind,
        doc_date: h.doc_date, genero: h.genero, naturaleza: h.naturaleza, doc_type: h.doc_type,
        warehouse_id: h.warehouse_id, warehouse_code: h.warehouse_code, source_branch: h.source_branch,
        parent_group: h.parent_group, parent_folio: h.parent_folio,
        audited: !!auditRow, audited_by: auditRow?.audited_by ?? null, audited_at: auditRow?.created_at ?? null,
      };
      const totals = {
        qty: lines.reduce((s: number, l: any) => s + Number(l.signed_qty || 0), 0),
        amount: lines.reduce((s: number, l: any) => s + Number(l.amount || 0), 0),
        lineas: lines.length,
      };
      // Contraparte de traspaso (salida↔recepción por tipo41+serie+folio, distinta sucursal).
      let counterpart: any = null;
      const sentQty = lines.reduce((s: number, l: any) => s + Number(l.qty || 0), 0);
      const findCp = async (docCode: string, folioCol: string, folioVal: string, serieCol: string, serieVal: string | null) => {
        if (!folioVal) return null;
        const cp = await trx('analytics.stock_movements as m')
          .where('m.tenant_id', tenantId).andWhere('m.doc_code', docCode)
          .andWhere(`m.${folioCol}`, folioVal)
          .andWhereRaw(`coalesce(m.${serieCol},'') = coalesce(?, '')`, [serieVal])
          .whereNot('m.warehouse_id', h.warehouse_id ?? p.warehouse_id)
          .leftJoin('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
          .groupBy('m.folio', 'm.warehouse_id', 'w.code')
          .select('m.folio', 'w.code as warehouse_code')
          .select(trx.raw(`MIN(m.doc_date) AS doc_date`), trx.raw(`SUM(m.qty) AS qty`), trx.raw(`COUNT(*)::int AS lineas`));
        if (!cp.length) return null;
        const cpQty = cp.reduce((s: number, r: any) => s + Number(r.qty || 0), 0);
        return { docs: cp, qty: cpQty, delta: cpQty - sentQty, status: Math.abs(cpQty - sentQty) < 0.01 ? 'ok' : 'diferencia' };
      };
      if (h.doc_code === 'TrsfShip') {
        counterpart = { kind: 'recepcion', ...(await findCp('TrsfRcv', 'parent_folio', h.folio, 'parent_serie', h.doc_serie) || { docs: [], qty: 0, delta: -sentQty, status: 'sin_recepcion' }) };
      } else if (h.doc_code === 'TrsfRcv' && h.parent_group === '41') {
        counterpart = { kind: 'origen', ...(await findCp('TrsfShip', 'folio', h.parent_folio, 'doc_serie', h.parent_serie) || { docs: [], qty: 0, delta: sentQty, status: 'sin_origen' }) };
      }
      return { header, lines, totals, counterpart };
    });
  }

  /**
   * DM.3 — Validación de traspasos: parea cada salida (TrsfShip, UD41) con su recepción
   * (TrsfRcv, UA50) vía el back-pointer de Kepler (parent = tipo 41 + SERIE + folio; la
   * serie desambigua folios repetidos entre sucursales). Estados:
   *   ok            → recepción existe y las piezas cuadran
   *   diferencia    → recepción existe pero las piezas NO cuadran (merma/sobrante en tránsito)
   *   sin_recepcion → salió y nadie lo ha recibido (en tránsito o perdido)
   *   sin_origen    → recepción sin salida visible (origen fuera de ventana o no registrado)
   */
  async transfersCheck(q: MovementsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    const whs = this.whIds(q);
    return this.tk.run(async (trx) => {
      const rows = (await trx.raw(`
        WITH shp AS (
          SELECT m.warehouse_id, w.code AS wh_code, m.folio, m.doc_serie,
                 MIN(m.doc_date) AS doc_date, SUM(m.qty) AS qty, SUM(m.amount) AS amount, COUNT(*)::int AS lineas
          FROM analytics.stock_movements m
          LEFT JOIN commercial.warehouses w ON w.id = m.warehouse_id
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfShip' AND m.doc_date BETWEEN ? AND ?
          GROUP BY m.warehouse_id, w.code, m.folio, m.doc_serie
        ), rcv AS (
          SELECT m.warehouse_id, w.code AS wh_code, m.folio, m.parent_serie, m.parent_folio,
                 MIN(m.doc_date) AS doc_date, SUM(m.qty) AS qty, COUNT(*)::int AS lineas
          FROM analytics.stock_movements m
          LEFT JOIN commercial.warehouses w ON w.id = m.warehouse_id
          WHERE m.tenant_id = ? AND m.doc_code = 'TrsfRcv' AND m.parent_group = '41' AND m.doc_date BETWEEN ? AND ?
          GROUP BY m.warehouse_id, w.code, m.folio, m.parent_serie, m.parent_folio
        )
        SELECT s.warehouse_id AS origin_wh_id, s.wh_code AS origin_wh, s.folio AS origin_folio,
               s.doc_serie, s.doc_date AS ship_date, s.qty AS qty_sent, s.amount, s.lineas AS ship_lines,
               r.warehouse_id AS dest_wh_id, r.wh_code AS dest_wh, r.folio AS rcv_folio,
               r.doc_date AS rcv_date, r.qty AS qty_received, r.lineas AS rcv_lines,
               CASE
                 WHEN s.folio IS NULL THEN 'sin_origen'
                 WHEN r.folio IS NULL THEN 'sin_recepcion'
                 WHEN abs(coalesce(s.qty,0) - coalesce(r.qty,0)) < 0.01 THEN 'ok'
                 ELSE 'diferencia'
               END AS status,
               coalesce(r.qty,0) - coalesce(s.qty,0) AS delta
        FROM shp s
        FULL OUTER JOIN rcv r
          ON r.parent_folio = s.folio
         AND coalesce(r.parent_serie,'') = coalesce(s.doc_serie,'')
         AND r.warehouse_id <> s.warehouse_id
        WHERE 1=1 ${whs.length ? `AND (s.warehouse_id = ANY(?) OR r.warehouse_id = ANY(?))` : ''}
        ORDER BY CASE
            WHEN s.folio IS NULL THEN 2
            WHEN r.folio IS NULL THEN 1
            WHEN abs(coalesce(s.qty,0) - coalesce(r.qty,0)) < 0.01 THEN 4
            ELSE 0 END,
          coalesce(s.doc_date, r.doc_date) DESC
        LIMIT 500
      `, whs.length ? [tenantId, from, to, tenantId, from, to, whs, whs] : [tenantId, from, to, tenantId, from, to])).rows;
      const totals = { ok: 0, diferencia: 0, sin_recepcion: 0, sin_origen: 0 };
      for (const r of rows) totals[r.status as keyof typeof totals]++;
      return { range: { from, to }, totals, rows };
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
