import { Injectable, Logger, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PA.1 — gestión del LAYOUT de pasillos (permanente) + mapeo SKU→pasillo.
 * Ver ADR-024 / FASE_PASILLOS_EQUIPOS.md. Gate COMMERCIAL_INVENTORY_ASIGNAR.
 *
 * Setear `commercial.stock.aisle_id` NO dispara el trigger FEFO (es sobre UPDATE OF
 * quantity); la asignación de pasillo es inerte al order flow.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateAisleDto {
  warehouse_id: string; code: string; name?: string;
  grid_row?: number; grid_col?: number; span_rows?: number; span_cols?: number;
}
export interface UpdateAisleDto {
  code?: string; name?: string;
  grid_row?: number; grid_col?: number; span_rows?: number; span_cols?: number; active?: boolean;
}
export interface AssignSkusDto {
  warehouse_id: string;
  aisle_id?: string | null; // null = des-asignar ("Sin pasillo")
  filter: {
    product_ids?: string[]; brand_id?: string; abc_class?: string;
    sku_from?: string; sku_to?: string; only_unassigned?: boolean;
  };
}

@Injectable()
export class WarehouseAislesService {
  private readonly logger = new Logger(WarehouseAislesService.name);
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}
  private userId(): string | null { return this.tenantCtx.get()?.userId || null; }

  /** Pasillos del almacén con su carga (unidades + #SKUs) + el bucket "Sin pasillo". */
  async listAisles(warehouseId: string) {
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      const aisles = await trx('commercial.warehouse_aisles as a')
        .leftJoin('commercial.stock as s', 's.aisle_id', 'a.id')
        .where('a.warehouse_id', warehouseId)
        .groupBy('a.id')
        .select('a.id', 'a.code', 'a.name', 'a.grid_row', 'a.grid_col', 'a.span_rows', 'a.span_cols', 'a.active')
        .select(trx.raw('COUNT(DISTINCT s.product_id)::int as sku_count'))
        .select(trx.raw('COALESCE(SUM(s.quantity), 0)::numeric as units'))
        .orderBy('a.grid_row', 'asc')
        .orderBy('a.grid_col', 'asc');
      const un = await trx('commercial.stock')
        .where({ warehouse_id: warehouseId })
        .whereNull('aisle_id')
        .select(trx.raw('COUNT(DISTINCT product_id)::int as sku_count'))
        .select(trx.raw('COALESCE(SUM(quantity), 0)::numeric as units'))
        .first();
      return {
        aisles,
        unassigned: { sku_count: Number(un?.sku_count || 0), units: Number(un?.units || 0) },
      };
    });
  }

  /** Marcas CON stock en el almacén (para el dropdown de asignación bulk). */
  async brandsInWarehouse(warehouseId: string) {
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      return trx('commercial.stock as s')
        .join('public.products as p', 'p.id', 's.product_id')
        .join('public.brands as b', 'b.id', 'p.brand_id')
        .where('s.warehouse_id', warehouseId)
        .groupBy('b.id', 'b.nombre')
        .select('b.id', 'b.nombre')
        .select(trx.raw('COUNT(DISTINCT s.product_id)::int as sku_count'))
        .orderBy('b.nombre', 'asc');
    });
  }

  async createAisle(dto: CreateAisleDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (!dto.code?.trim()) throw new BadRequestException('code requerido');
    return this.tk.run(async (trx) => {
      const wh = await trx('commercial.warehouses').where({ id: dto.warehouse_id }).first();
      if (!wh) throw new NotFoundException('Almacén no encontrado');
      try {
        const [row] = await trx('commercial.warehouse_aisles')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            warehouse_id: dto.warehouse_id,
            code: dto.code.trim(),
            name: dto.name?.trim() || null,
            grid_row: Number.isFinite(dto.grid_row) ? dto.grid_row : 0,
            grid_col: Number.isFinite(dto.grid_col) ? dto.grid_col : 0,
            span_rows: Math.max(1, Number(dto.span_rows) || 1),
            span_cols: Math.max(1, Number(dto.span_cols) || 1),
            updated_by: this.userId(),
          })
          .returning('*');
        return row;
      } catch (e: any) {
        if (e?.code === '23505')
          throw new ConflictException(`Ya existe un pasillo con código "${dto.code}" en este almacén.`);
        throw e;
      }
    });
  }

  async updateAisle(id: string, dto: UpdateAisleDto) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    const patch: any = { updated_at: new Date(), updated_by: this.userId() };
    if (dto.code !== undefined) patch.code = dto.code.trim();
    if (dto.name !== undefined) patch.name = dto.name?.trim() || null;
    if (dto.grid_row !== undefined) patch.grid_row = dto.grid_row;
    if (dto.grid_col !== undefined) patch.grid_col = dto.grid_col;
    if (dto.span_rows !== undefined) patch.span_rows = Math.max(1, Number(dto.span_rows) || 1);
    if (dto.span_cols !== undefined) patch.span_cols = Math.max(1, Number(dto.span_cols) || 1);
    if (dto.active !== undefined) patch.active = !!dto.active;
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.warehouse_aisles').where({ id }).update(patch).returning('*');
      if (!row) throw new NotFoundException('Pasillo no encontrado');
      return row;
    });
  }

  async deleteAisle(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      // No borrar si un folio ABIERTO lo referencia (reshufflearía el conteo en curso).
      const inUse = await trx('commercial.inventory_count_items as i')
        .join('commercial.inventory_counts as c', function () {
          this.on('c.id', '=', 'i.count_id').andOn('c.tenant_id', '=', 'i.tenant_id');
        })
        .where('i.aisle_id', id)
        .whereNotIn('c.status', ['reconciled', 'cancelled'])
        .first();
      if (inUse)
        throw new ConflictException('No se puede borrar: un folio de conteo abierto usa este pasillo. Cerralo o cancelalo primero.');
      const n = await trx('commercial.warehouse_aisles').where({ id }).del();
      if (!n) throw new NotFoundException('Pasillo no encontrado');
      return { ok: true };
    });
  }

  /**
   * PA.2 — genera el PLAN de equipos (no persiste; eso es PA.3): 1 supervisor por
   * pasillo (o clusters balanceados si hay menos supervisores que pasillos) +
   * contadores proporcionales a las unidades de cada pasillo. Pool = supervisor_ids /
   * counter_ids del día (si no se pasan, usa todos los asignables por permiso).
   */
  async generateTeamPlan(dto: { warehouse_id: string; supervisor_ids?: string[]; counter_ids?: string[]; min_counters?: number }) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const minC = Math.max(1, Number(dto.min_counters) || 1);
    return this.tk.run(async (trx) => {
      // pasillos a contar (con SKUs) + carga en unidades, de mayor a menor
      const aisles: any[] = await trx('commercial.warehouse_aisles as a')
        .join('commercial.stock as s', 's.aisle_id', 'a.id')
        .where('a.warehouse_id', dto.warehouse_id)
        .groupBy('a.id', 'a.code', 'a.name')
        .havingRaw('COUNT(s.product_id) > 0')
        .select('a.id', 'a.code', 'a.name')
        .select(trx.raw('COUNT(DISTINCT s.product_id)::int as sku_count'))
        .select(trx.raw('COALESCE(SUM(s.quantity), 0)::numeric as units'))
        .orderByRaw('SUM(s.quantity) DESC NULLS LAST');

      let supIds = (dto.supervisor_ids || []).filter((id) => UUID.test(id));
      let cntIds = (dto.counter_ids || []).filter((id) => UUID.test(id));
      if (!supIds.length) supIds = (await this.assignableIds(trx, 'COMMERCIAL_INVENTORY_SUPERVISAR'));
      if (!cntIds.length) cntIds = (await this.assignableIds(trx, 'COMMERCIAL_INVENTORY_CONTAR'));
      const ids = [...new Set([...supIds, ...cntIds])];
      const users = ids.length ? await trx('identity.users').whereIn('id', ids).select('id', 'nombre', 'username') : [];
      const nameOf = new Map<string, string>(users.map((u: any) => [u.id, u.nombre || u.username]));

      const n = aisles.length;
      const warnings: string[] = [];
      const S = supIds.length, C = cntIds.length;
      const W = aisles.reduce((s, a) => s + Number(a.units), 0);
      if (n === 0)
        return { warehouse_id: dto.warehouse_id, basis: 'units', totals: { aisles: 0, supervisors: S, counters: C, units: 0 }, plan: [], warnings: ['No hay pasillos con SKUs en este almacén. Mapeá SKUs primero (Pasillos → Asignar).'] };

      // ── supervisor: 1 por pasillo, o clusters balanceados por carga (LPT) ──
      const supByAisle: (string | null)[] = new Array(n).fill(null);
      if (S === 0) {
        warnings.push('No hay supervisores en el pool — los pasillos quedan sin supervisor.');
      } else if (S >= n) {
        for (let i = 0; i < n; i++) supByAisle[i] = supIds[i];
      } else {
        const clusters = supIds.map((sid) => ({ sid, load: 0 }));
        for (let i = 0; i < n; i++) {
          let lc = clusters[0];
          for (const c of clusters) if (c.load < lc.load) lc = c;
          supByAisle[i] = lc.sid;
          lc.load += Number(aisles[i].units);
        }
        warnings.push(`Menos supervisores (${S}) que pasillos (${n}): se agruparon en ${S} clusters balanceados por carga.`);
      }

      // ── contadores: proporcional a unidades, mínimo por pasillo ──
      const counts = aisles.map((a) => Math.max(minC, Math.round(W > 0 ? (C * Number(a.units) / W) : (C / n))));
      const byUnitsDesc = aisles.map((_, i) => i); // ya viene ordenado desc por units
      let sum = counts.reduce((a, b) => a + b, 0);
      let guard = 0;
      while (sum !== C && guard++ < 100000) {
        if (sum > C) {
          let idx = -1;
          for (let k = byUnitsDesc.length - 1; k >= 0; k--) if (counts[byUnitsDesc[k]] > minC) { idx = byUnitsDesc[k]; break; }
          if (idx < 0) break; // no se puede bajar del mínimo
          counts[idx]--; sum--;
        } else {
          counts[byUnitsDesc[0]]++; sum++;
        }
      }
      if (C < n * minC)
        warnings.push(`Faltan contadores: ${n} pasillos × mín ${minC} = ${n * minC} y hay ${C}. Algunos pasillos quedan sin equipo completo.`);

      // asignar contadores concretos secuencialmente
      let ci = 0;
      const plan = aisles.map((a, i) => {
        const take = Math.max(0, Math.min(counts[i], C - ci));
        const cids = cntIds.slice(ci, ci + take); ci += take;
        return {
          aisle_id: a.id, code: a.code, name: a.name,
          units: Number(a.units), sku_count: Number(a.sku_count),
          supervisor_id: supByAisle[i], supervisor_name: supByAisle[i] ? (nameOf.get(supByAisle[i]!) || null) : null,
          counter_ids: cids, counter_count: cids.length,
          counter_names: cids.map((id) => nameOf.get(id) || null),
        };
      });
      return { warehouse_id: dto.warehouse_id, basis: 'units', totals: { aisles: n, supervisors: S, counters: C, units: W }, plan, warnings };
    });
  }

  private async assignableIds(trx: any, perm: string): Promise<string[]> {
    const rows = await trx('identity.users as u')
      .join('public.role_permissions as rp', function (this: any) {
        this.on('rp.role_name', '=', 'u.role_name').andOn('rp.tenant_id', '=', 'u.tenant_id');
      })
      .where('u.activo', true)
      .whereRaw(`(rp.permissions ->> ?)::bool = true`, [perm])
      .select('u.id');
    return rows.map((r: any) => r.id);
  }

  /** Bulk: mapea SKUs a un pasillo (o los des-asigna si aisle_id=null) por filtro. */
  async assignSkus(dto: AssignSkusDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (dto.aisle_id && !UUID.test(dto.aisle_id)) throw new BadRequestException('aisle_id inválido');
    const f = dto.filter || {};
    const hasFilter = (Array.isArray(f.product_ids) && f.product_ids.length) || f.brand_id || f.abc_class
      || (f.sku_from && f.sku_to) || f.only_unassigned;
    if (!hasFilter)
      throw new BadRequestException('Especificá un filtro (product_ids / brand_id / abc_class / rango SKU / only_unassigned).');
    return this.tk.run(async (trx) => {
      if (dto.aisle_id) {
        const aisle = await trx('commercial.warehouse_aisles')
          .where({ id: dto.aisle_id, warehouse_id: dto.warehouse_id }).first();
        if (!aisle) throw new BadRequestException('El pasillo no pertenece a este almacén.');
      }
      let q = trx('commercial.stock').where({ warehouse_id: dto.warehouse_id });
      if (Array.isArray(f.product_ids) && f.product_ids.length) q = q.whereIn('product_id', f.product_ids);
      if (f.brand_id) q = q.whereIn('product_id', trx('public.products').where({ brand_id: f.brand_id }).select('id'));
      if (f.abc_class)
        q = q.whereIn('product_id', trx('commercial.abc_classification')
          .where({ warehouse_id: dto.warehouse_id, abc_class: String(f.abc_class).toUpperCase() }).select('product_id'));
      if (f.sku_from && f.sku_to)
        q = q.whereIn('product_id', trx('public.products').whereBetween('sku', [f.sku_from, f.sku_to]).select('id'));
      if (f.only_unassigned) q = q.whereNull('aisle_id');
      const updated = await q.update({ aisle_id: dto.aisle_id || null, updated_at: trx.fn.now(), updated_by: this.userId() });
      this.logger.log(`assignSkus: ${updated} SKUs → aisle=${dto.aisle_id || 'NULL'} (wh ${dto.warehouse_id})`);
      return { updated };
    });
  }
}
