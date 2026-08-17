import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PREV.2 — Monitoreo intensivo + ventanas de pérdida (Apéndice B §10-13).
 *
 * Un SKU bajo monitoreo recibe varios conteos rápidos al día. Cada conteo compara el
 * físico contra el teórico del sistema y registra la VENTANA (entre el conteo previo y
 * éste): si aparece un nuevo faltante, la pérdida ocurrió en esa ventana → acota la
 * investigación. No acusa personas; reporta recurrencia bajo condiciones.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StartMonitoringDto {
  warehouse_id: string;
  product_id: string;
  source_investigation_id?: string;
  reason?: string;
  counts_per_day?: number;
}

@Injectable()
export class InventoryMonitoringService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Pone un SKU en monitoreo intensivo (1 activo por almacén×producto). */
  async start(dto: StartMonitoringDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
    if (dto.source_investigation_id && !UUID.test(dto.source_investigation_id))
      throw new BadRequestException('source_investigation_id inválido');
    const perDay = Number(dto.counts_per_day) > 0 ? Math.floor(Number(dto.counts_per_day)) : 2;
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const active = await trx('commercial.inventory_monitoring')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id, status: 'active' })
        .first('id');
      if (active) throw new ConflictException('Ya existe un monitoreo activo para este producto en el almacén');

      const [row] = await trx('commercial.inventory_monitoring')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          product_id: dto.product_id,
          source_investigation_id: dto.source_investigation_id || null,
          reason: dto.reason || null,
          counts_per_day: perDay,
          status: 'active',
          started_by: userId,
        })
        .returning('*');

      // Enlaza el expediente PNI → estado monitoring.
      if (dto.source_investigation_id) {
        await trx('commercial.inventory_investigations')
          .where({ id: dto.source_investigation_id })
          .update({ status: 'monitoring', updated_at: trx.fn.now() });
      }
      return row;
    });
  }

  /** Registra un conteo rápido: expected = stock del sistema; ventana = desde el conteo previo. */
  async recordCount(monitoringId: string, dto: { physical_qty: number; notes?: string }) {
    if (!UUID.test(monitoringId)) throw new BadRequestException('monitoring_id inválido');
    if (typeof dto.physical_qty !== 'number' || dto.physical_qty < 0)
      throw new BadRequestException('physical_qty debe ser un número >= 0');
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const mon = await trx('commercial.inventory_monitoring').where({ id: monitoringId }).first();
      if (!mon) throw new NotFoundException('Monitoreo no encontrado');
      if (mon.status !== 'active') throw new ConflictException('El monitoreo está cerrado');

      const stock = await trx('commercial.stock')
        .where({ warehouse_id: mon.warehouse_id, product_id: mon.product_id })
        .first('quantity');
      const expected = stock ? Number(stock.quantity) : 0;
      const diff = dto.physical_qty - expected;

      const prev = await trx('commercial.inventory_monitoring_counts')
        .where({ monitoring_id: monitoringId })
        .orderBy('counted_at', 'desc')
        .first('counted_at');
      const windowFrom = prev ? prev.counted_at : mon.started_at;

      const [row] = await trx('commercial.inventory_monitoring_counts')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          monitoring_id: monitoringId,
          expected_qty: expected,
          physical_qty: dto.physical_qty,
          difference: diff,
          window_from: windowFrom,
          window_to: trx.fn.now(),
          counted_at: trx.fn.now(),
          counted_by: userId,
          notes: dto.notes || null,
        })
        .returning('*');
      await trx('commercial.inventory_monitoring').where({ id: monitoringId }).update({ updated_at: trx.fn.now() });
      return row;
    });
  }

  async list(query: { status?: string; warehouse_id?: string; limit?: number }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));
    const status = query.status || 'active';
    return this.tk.run(async (trx) => {
      let q = trx('commercial.inventory_monitoring as m')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'm.product_id');
      if (status !== 'all') q = q.where('m.status', status);
      if (query.warehouse_id) q = q.where('m.warehouse_id', query.warehouse_id);
      return q
        .select(
          'm.id', 'm.warehouse_id', 'w.code as warehouse_code',
          'm.product_id', 'p.sku', 'p.nombre as product_name',
          'm.status', 'm.counts_per_day', 'm.reason', 'm.started_at', 'm.source_investigation_id',
          trx.raw(`(SELECT COUNT(*) FROM commercial.inventory_monitoring_counts c
                     WHERE c.monitoring_id = m.id AND c.counted_at::date = CURRENT_DATE) AS counts_today`),
          trx.raw(`(SELECT c.difference FROM commercial.inventory_monitoring_counts c
                     WHERE c.monitoring_id = m.id ORDER BY c.counted_at DESC LIMIT 1) AS last_difference`),
          trx.raw(`(SELECT MAX(c.counted_at) FROM commercial.inventory_monitoring_counts c
                     WHERE c.monitoring_id = m.id) AS last_count_at`),
        )
        .orderBy('m.started_at', 'desc')
        .limit(limit);
    });
  }

  async detail(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const mon = await trx('commercial.inventory_monitoring as m')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'm.product_id')
        .where('m.id', id)
        .select('m.*', 'w.code as warehouse_code', 'w.name as warehouse_name', 'p.sku', 'p.nombre as product_name')
        .first();
      if (!mon) throw new NotFoundException('Monitoreo no encontrado');
      const counts = await trx('commercial.inventory_monitoring_counts')
        .where({ monitoring_id: id })
        .select('id', 'expected_qty', 'physical_qty', 'difference', 'window_from', 'window_to', 'counted_at', 'counted_by', 'notes')
        .orderBy('counted_at', 'desc');
      return { ...mon, counts };
    });
  }

  async close(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const mon = await trx('commercial.inventory_monitoring').where({ id }).first();
      if (!mon) throw new NotFoundException('Monitoreo no encontrado');
      if (mon.status === 'closed') throw new ConflictException('El monitoreo ya está cerrado');
      await trx('commercial.inventory_monitoring').where({ id }).update({
        status: 'closed', closed_at: trx.fn.now(), closed_by: userId, updated_at: trx.fn.now(),
      });
      return this.detail(id);
    });
  }
}
