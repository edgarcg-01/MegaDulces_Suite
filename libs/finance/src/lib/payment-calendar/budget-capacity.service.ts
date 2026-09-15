import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fase TP.1 — Presupuestos: capacidad de pago por fecha (ADR-064).
 *
 * Sin fila en `budget.daily_capacity` la capacidad está NO DEFINIDA (distinto de cero) — el
 * día no puede liberar pagos (lo exige `PaymentCalendarService.releaseLot`). Cada cambio de
 * monto queda en `budget.daily_capacity_history` con motivo + quién + cuándo.
 */
@Injectable()
export class BudgetCapacityService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private assertDate(d: string) {
    if (!DATE_RX.test(d)) throw new BadRequestException('Fecha inválida (YYYY-MM-DD)');
  }

  /** Capacidad de una fecha, o null si no está definida. */
  async getForDate(date: string) {
    this.assertDate(date);
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const row = await trx('budget.daily_capacity').where({ capacity_date: date }).first();
      return row ?? null;
    });
  }

  /** Rango de fechas (para pintar el calendario sin 1 request por día). */
  async listRange(from: string, to: string) {
    this.assertDate(from); this.assertDate(to);
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) =>
      trx('budget.daily_capacity').whereBetween('capacity_date', [from, to]).orderBy('capacity_date'));
  }

  /** Fija/edita la capacidad autorizada de un día. SIEMPRE deja rastro en el historial. */
  async setForDate(date: string, amount: number, reason: string | undefined, username: string) {
    this.assertDate(date);
    if (!(amount >= 0)) throw new BadRequestException('El monto autorizado debe ser >= 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const prev = await trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: date }).first();
      await trx('budget.daily_capacity')
        .insert({ tenant_id: tenantId, capacity_date: date, authorized_amount: amount, note: reason ?? null, created_by: username, updated_by: username })
        .onConflict(['tenant_id', 'capacity_date'])
        .merge({ authorized_amount: amount, note: reason ?? null, updated_by: username, updated_at: trx.fn.now() });
      await trx('budget.daily_capacity_history').insert({
        tenant_id: tenantId, capacity_date: date,
        previous_amount: prev?.authorized_amount ?? null, new_amount: amount,
        reason: reason ?? null, changed_by: username,
      });
      return trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: date }).first();
    });
  }

  async history(date: string) {
    this.assertDate(date);
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) =>
      trx('budget.daily_capacity_history').where({ capacity_date: date }).orderBy('changed_at', 'desc'));
  }
}
