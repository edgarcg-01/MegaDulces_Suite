import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { LogisticsConfigService } from '../logistics-config/logistics-config.service';

/** Campos del costeo operativo (todos opcionales, default 0). */
const COST_FIELDS = [
  'fuel',
  'tolls',
  'lodging',
  'parking',
  'permits',
  'repairs',
  'external_helpers',
  'handling',
  'driver_per_diem',
  'other',
] as const;

type CostField = (typeof COST_FIELDS)[number];

export type UpsertExpenseDto = Partial<Record<CostField, number>> & {
  extras?: Array<{ label: string; amount: number }>;
  notes?: string;
  /**
   * Si true, lee `config_finance.costo_km_estandar` para el fixed_cost_per_km
   * usado en el cálculo de total_cost (= operating_subtotal + actual_km * costo_km).
   * Si false o ausente, usa el último fixed_cost_per_km guardado (o 0 si nunca).
   */
  apply_config_km?: boolean;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LogisticsExpensesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly config: LogisticsConfigService,
  ) {}

  /**
   * Crea o actualiza el expense del shipment (1:1). Recalcula
   * `operating_subtotal` y `total_cost` automáticamente.
   */
  async upsert(shipmentId: string, dto: UpsertExpenseDto) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipmentId inválido');

    return this.tk.run(async (trx) => {
      const shipment = await trx('logistics.shipments')
        .where({ id: shipmentId })
        .whereNull('deleted_at')
        .first();
      if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} no encontrado`);

      const existing = await trx('logistics.shipment_expenses')
        .where({ shipment_id: shipmentId })
        .first();

      // Merge: nuevo dto sobre existente, default 0 para los que no vengan
      const merged: Record<CostField, number> = {} as any;
      for (const f of COST_FIELDS) {
        merged[f] =
          dto[f] !== undefined
            ? Number(dto[f])
            : existing
              ? Number(existing[f])
              : 0;
      }

      // Validar negativos
      for (const f of COST_FIELDS) {
        if (Number.isNaN(merged[f]) || merged[f] < 0) {
          throw new BadRequestException(`${f} debe ser número ≥ 0`);
        }
      }

      // Sumar extras
      const extras = dto.extras ?? (existing?.extras || null);
      const extrasSum = Array.isArray(extras)
        ? extras.reduce((acc, e) => acc + Number(e.amount || 0), 0)
        : 0;

      const operating_subtotal =
        Object.values(merged).reduce((a, b) => a + b, 0) + extrasSum;

      // Fixed cost per km: configurable o último valor
      let fixed_cost_per_km = existing ? Number(existing.fixed_cost_per_km) : 0;
      if (dto.apply_config_km) {
        const v = await this.config.getValueByKey('costo_km_estandar');
        if (v !== null) fixed_cost_per_km = v;
      }

      const km_cost =
        Number(shipment.actual_km || 0) * fixed_cost_per_km;
      const total_cost = operating_subtotal + km_cost;

      if (existing) {
        const [row] = await trx('logistics.shipment_expenses')
          .where({ shipment_id: shipmentId })
          .update({
            ...merged,
            extras: extras ? JSON.stringify(extras) : null,
            notes: dto.notes !== undefined ? dto.notes : existing.notes,
            operating_subtotal,
            fixed_cost_per_km,
            total_cost,
            updated_at: trx.fn.now(),
          })
          .returning('*');
        return row;
      } else {
        const [row] = await trx('logistics.shipment_expenses')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            shipment_id: shipmentId,
            ...merged,
            extras: extras ? JSON.stringify(extras) : null,
            notes: dto.notes || null,
            operating_subtotal,
            fixed_cost_per_km,
            total_cost,
          })
          .returning('*');
        return row;
      }
    });
  }

  async findByShipment(shipmentId: string) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipmentId inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.shipment_expenses')
        .where({ shipment_id: shipmentId })
        .first();
      if (!row) throw new NotFoundException(`No hay expense para shipment ${shipmentId}`);
      return row;
    });
  }

  /**
   * J.9.4 — Lista todos los expenses con info del shipment.
   * Útil para la página de Costs (listado global).
   */
  async findAll(opts: { from?: string; to?: string; limit?: number } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.shipment_expenses as e')
        .innerJoin('logistics.shipments as s', 's.id', 'e.shipment_id')
        .leftJoin('logistics.vehicles as v', 'v.id', 's.vehicle_id')
        .whereNull('s.deleted_at')
        .select(
          'e.*',
          's.folio as shipment_folio',
          's.shipment_date',
          's.destination',
          's.actual_km',
          's.status as shipment_status',
          'v.plate as vehicle_plate',
        )
        .orderBy('s.shipment_date', 'desc');
      if (opts.from) q = q.where('s.shipment_date', '>=', opts.from);
      if (opts.to) q = q.where('s.shipment_date', '<=', opts.to);
      if (opts.limit) q = q.limit(opts.limit);
      return q;
    });
  }

  /**
   * Resumen agregado por rango de fechas. Útil para reports.
   * Devuelve totales por categoría + count de embarques.
   */
  async summary(from?: string, to?: string) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.shipment_expenses as e')
        .join('logistics.shipments as s', 's.id', 'e.shipment_id')
        .whereNull('s.deleted_at');
      if (from) q = q.where('s.shipment_date', '>=', from);
      if (to) q = q.where('s.shipment_date', '<=', to);

      const cols = COST_FIELDS.map((f) => trx.raw(`COALESCE(SUM(e.${f}), 0)::numeric AS ${f}`));
      const [agg] = await q
        .select([
          ...cols,
          trx.raw('COALESCE(SUM(e.operating_subtotal), 0)::numeric AS operating_subtotal_sum'),
          trx.raw('COALESCE(SUM(e.total_cost), 0)::numeric AS total_cost_sum'),
          trx.raw('COUNT(*)::int AS shipments_count'),
        ]);

      // Cast a number para evitar strings que vengan de pg numeric
      const out: Record<string, number> = {};
      for (const k of Object.keys(agg)) out[k] = Number(agg[k]) || 0;
      return out;
    });
  }
}
