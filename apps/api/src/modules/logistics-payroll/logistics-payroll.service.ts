import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';

export type PeriodStatus = 'abierto' | 'calculado' | 'pagado' | 'cerrado';
export type LiquidationStatus = 'calculado' | 'revisado' | 'pagado' | 'anulado';

export interface CreatePeriodDto {
  number: number;
  year: number;
  start_date: string;
  end_date: string;
  payment_date: string;
  notes?: string;
}
export type UpdatePeriodDto = Partial<CreatePeriodDto> & { status?: PeriodStatus };

export interface UpdateLiquidationDto {
  bonuses?: number;
  deductions?: number;
  status?: LiquidationStatus;
  notes?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LogisticsPayrollService {
  constructor(private readonly tk: TenantKnexService) {}

  // ── Periods ──────────────────────────────────────────────────────────────

  async createPeriod(dto: CreatePeriodDto) {
    this.validatePeriod(dto);
    return this.tk.run(async (trx) => {
      const dup = await trx('logistics.payroll_periods')
        .where({ year: dto.year, number: dto.number })
        .first();
      if (dup) {
        throw new ConflictException(`Ya existe período ${dto.year}/${dto.number}`);
      }
      const [row] = await trx('logistics.payroll_periods')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          number: dto.number,
          year: dto.year,
          start_date: dto.start_date,
          end_date: dto.end_date,
          payment_date: dto.payment_date,
          status: 'abierto',
          notes: dto.notes || null,
        })
        .returning('*');
      return row;
    });
  }

  async listPeriods(year?: number) {
    return this.tk.run(async (trx) => {
      let q = trx('logistics.payroll_periods');
      if (year) q = q.where({ year });
      return q.orderBy('year', 'desc').orderBy('number', 'desc');
    });
  }

  async findPeriod(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.payroll_periods').where({ id }).first();
      if (!row) throw new NotFoundException(`Período ${id} no encontrado`);
      return row;
    });
  }

  async updatePeriod(id: string, dto: UpdatePeriodDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.payroll_periods').where({ id }).first();
      if (!existing) throw new NotFoundException(`Período ${id} no encontrado`);
      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      for (const k of ['number', 'year', 'start_date', 'end_date', 'payment_date', 'status', 'notes'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }
      const [row] = await trx('logistics.payroll_periods')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  // ── Calculate: itera drivers y suma comisiones/cargas/descargas ──────────

  /**
   * Itera todos los drivers activos del tenant y para cada uno calcula
   * sus liquidaciones para el período, sumando:
   *   - Comisiones de guías ENTREGADAS dentro del período
   *   - Tarifas de load_details (shipments con fecha en el período)
   *   - Montos de unload_details (shipments con fecha en el período)
   *   - Viáticos: per_diem_total se asigna 100% al chofer en beta (decisión
   *     intencional para simplicidad). El campo `per_diem_breakdown` JSONB
   *     existe en delivery_guides para futuro refinement (split por persona
   *     desayuno/comida/cena), pero hasta que haya volumen de operación que
   *     justifique el ruido, lo dejamos así. (Deferred, no bug.)
   *
   * Idempotente: si ya existe liquidación para el (driver, period), UPDATEa
   * los montos calculados pero respeta bonuses/deductions/notes manuales que
   * el usuario haya editado. Cambia status a 'calculado' siempre.
   *
   * El período no se marca 'calculado' acá — eso queda como acción manual.
   */
  async calculatePeriod(periodId: string) {
    if (!UUID_REGEX.test(periodId)) throw new BadRequestException('periodId inválido');

    return this.tk.run(async (trx) => {
      const period = await trx('logistics.payroll_periods').where({ id: periodId }).first();
      if (!period) throw new NotFoundException(`Período ${periodId} no encontrado`);
      if (['pagado', 'cerrado'].includes(period.status)) {
        throw new ConflictException(`Período ${period.year}/${period.number} está ${period.status}, no recalcular.`);
      }

      const drivers = await trx('logistics.drivers')
        .whereNull('deleted_at')
        .where({ active: true });

      const results: any[] = [];

      for (const d of drivers) {
        // 1. Comisiones de guías entregadas en el rango (driver + helper1 + helper2)
        const [commRow] = await trx.raw(
          `
          SELECT
            COALESCE(SUM(CASE WHEN driver_id = ? THEN driver_commission ELSE 0 END), 0)::numeric AS as_driver,
            COALESCE(SUM(CASE WHEN helper1_id = ? THEN helper1_commission ELSE 0 END), 0)::numeric AS as_helper1,
            COALESCE(SUM(CASE WHEN helper2_id = ? THEN helper2_commission ELSE 0 END), 0)::numeric AS as_helper2,
            COALESCE(SUM(CASE WHEN driver_id = ? AND overnight THEN per_diem_total ELSE 0 END), 0)::numeric AS per_diem
          FROM logistics.delivery_guides g
          JOIN logistics.shipments s ON s.id = g.shipment_id
          WHERE g.status = 'entregada'
            AND s.shipment_date >= ?
            AND s.shipment_date <= ?
            AND g.deleted_at IS NULL
            AND s.deleted_at IS NULL
          `,
          [d.id, d.id, d.id, d.id, period.start_date, period.end_date],
        ).then((r: any) => r.rows);

        const commissions =
          Number(commRow.as_driver) +
          Number(commRow.as_helper1) +
          Number(commRow.as_helper2);
        const per_diem = Number(commRow.per_diem);

        // 2. Load + unload details en el rango
        const [loadRow] = await trx.raw(
          `
          SELECT COALESCE(SUM(rate), 0)::numeric AS total
          FROM logistics.load_details ld
          JOIN logistics.shipments s ON s.id = ld.shipment_id
          WHERE ld.driver_id = ?
            AND s.shipment_date >= ?
            AND s.shipment_date <= ?
            AND s.deleted_at IS NULL
          `,
          [d.id, period.start_date, period.end_date],
        ).then((r: any) => r.rows);

        const [unloadRow] = await trx.raw(
          `
          SELECT COALESCE(SUM(amount), 0)::numeric AS total
          FROM logistics.unload_details ud
          JOIN logistics.shipments s ON s.id = ud.shipment_id
          WHERE ud.driver_id = ?
            AND s.shipment_date >= ?
            AND s.shipment_date <= ?
            AND s.deleted_at IS NULL
          `,
          [d.id, period.start_date, period.end_date],
        ).then((r: any) => r.rows);

        const load_unload = Number(loadRow.total) + Number(unloadRow.total);
        const computed_subtotal = commissions + per_diem + load_unload;

        // 3. UPSERT — respeta bonuses/deductions/notes existentes
        const existing = await trx('logistics.liquidations')
          .where({ driver_id: d.id, period_id: periodId })
          .first();

        const bonuses = existing ? Number(existing.bonuses) : 0;
        const deductions = existing ? Number(existing.deductions) : 0;
        const net_amount = computed_subtotal + bonuses - deductions;

        if (existing) {
          if (['pagado', 'anulado'].includes(existing.status)) {
            // No tocar liquidaciones pagadas o anuladas
            continue;
          }
          await trx('logistics.liquidations')
            .where({ id: existing.id })
            .update({
              per_diem_amount: per_diem,
              commissions_amount: commissions,
              load_unload_amount: load_unload,
              subtotal: computed_subtotal,
              net_amount,
              status: 'calculado',
              updated_at: trx.fn.now(),
            });
          results.push({ driver_id: d.id, full_name: d.full_name, subtotal: computed_subtotal, net_amount, action: 'updated' });
        } else if (computed_subtotal > 0) {
          // Solo crear liquidación si tiene algo que cobrar
          await trx('logistics.liquidations')
            .insert({
              tenant_id: trx.raw('public.current_tenant_id()'),
              driver_id: d.id,
              period_id: periodId,
              per_diem_amount: per_diem,
              commissions_amount: commissions,
              load_unload_amount: load_unload,
              bonuses: 0,
              deductions: 0,
              subtotal: computed_subtotal,
              net_amount,
              status: 'calculado',
            });
          results.push({ driver_id: d.id, full_name: d.full_name, subtotal: computed_subtotal, net_amount, action: 'created' });
        }
      }

      return {
        period_id: periodId,
        period: `${period.year}/${period.number}`,
        liquidations_processed: results.length,
        results,
      };
    });
  }

  // ── Liquidations CRUD ────────────────────────────────────────────────────

  async listLiquidations(periodId: string) {
    if (!UUID_REGEX.test(periodId)) throw new BadRequestException('periodId inválido');
    return this.tk.run(async (trx) => {
      return trx('logistics.liquidations as l')
        .leftJoin('logistics.drivers as d', 'd.id', 'l.driver_id')
        .where('l.period_id', periodId)
        .select(
          'l.*',
          'd.full_name as driver_name',
          'd.employee_type',
        )
        .orderBy('d.full_name', 'asc');
    });
  }

  async updateLiquidation(id: string, dto: UpdateLiquidationDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.liquidations').where({ id }).first();
      if (!existing) throw new NotFoundException(`Liquidación ${id} no encontrada`);
      if (['pagado', 'anulado'].includes(existing.status) && dto.status !== 'anulado') {
        throw new ConflictException(`Liquidación está ${existing.status}, no editable.`);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.bonuses !== undefined) patch.bonuses = dto.bonuses;
      if (dto.deductions !== undefined) patch.deductions = dto.deductions;
      if (dto.notes !== undefined) patch.notes = dto.notes;
      if (dto.status !== undefined) patch.status = dto.status;

      // Recalcular net si cambian bonuses/deductions
      if (dto.bonuses !== undefined || dto.deductions !== undefined) {
        const bonuses = dto.bonuses !== undefined ? dto.bonuses : Number(existing.bonuses);
        const deductions = dto.deductions !== undefined ? dto.deductions : Number(existing.deductions);
        patch.net_amount = Number(existing.subtotal) + bonuses - deductions;
      }

      if (dto.status === 'pagado') patch.paid_at = trx.fn.now();

      const [row] = await trx('logistics.liquidations')
        .where({ id })
        .update(patch)
        .returning('*');
      return row;
    });
  }

  private validatePeriod(dto: CreatePeriodDto): void {
    if (!Number.isInteger(dto.number) || dto.number < 1 || dto.number > 27) {
      throw new BadRequestException('number debe ser entero 1-27 (catorcenas del año)');
    }
    if (!Number.isInteger(dto.year) || dto.year < 2000 || dto.year > 2100) {
      throw new BadRequestException('year fuera de rango');
    }
    if (!dto.start_date || !dto.end_date || !dto.payment_date) {
      throw new BadRequestException('start_date, end_date, payment_date requeridos');
    }
    if (new Date(dto.end_date) < new Date(dto.start_date)) {
      throw new BadRequestException('end_date debe ser ≥ start_date');
    }
    if (new Date(dto.payment_date) < new Date(dto.end_date)) {
      throw new BadRequestException('payment_date debe ser ≥ end_date');
    }
  }
}
