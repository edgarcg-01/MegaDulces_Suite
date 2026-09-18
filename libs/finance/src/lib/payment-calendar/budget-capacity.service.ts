import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export interface CapacityProposalItem { date: string; amount: number; week: string; cobros_week: number }

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

  // ── PR.2 (ADR-074): auto-proponer la capacidad desde el flujo (cobranza esperada) ─────────

  private iso(d: unknown): string { return typeof d === 'string' ? d.slice(0, 10) : new Date(d as string).toISOString().slice(0, 10); }
  private monday(d: string): string { const x = new Date(d + 'T00:00:00Z'); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x.toISOString().slice(0, 10); }

  /**
   * Propone la capacidad DIARIA desde la cobranza esperada (CXC, misma fuente que el flujo de efectivo):
   * la cobranza esperada de cada semana repartida entre sus días hábiles del rango. Read-only, no escribe.
   * «Sin cartera CXC» ⇒ se DECLARA no disponible (ADR-056), no se inventa capacidad. NO incluye el saldo en
   * banco (buffer que el humano puede sumar). El humano confirma/ajusta con `confirmProposed`.
   */
  async propose(from: string, to: string) {
    this.assertDate(from); this.assertDate(to);
    if (to < from) throw new BadRequestException('`to` no puede ser anterior a `from`');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [cxc] = await trx('analytics.customer_receivables').where({ tenant_id: tenantId })
        .select(trx.raw('count(*)::int AS n'), trx.raw('max(computed_at) AS as_of'));
      if (!Number(cxc.n)) {
        return { available: false, from, to, basis: 'cobranza_esperada', reason: 'Sin cartera CXC (analytics.customer_receivables) para este tenant', as_of: null, items: [] as CapacityProposalItem[] };
      }
      const cobros = await trx('analytics.customer_receivables')
        .where({ tenant_id: tenantId }).andWhere('saldo_documento', '>', 0)
        .whereBetween('vencimiento', [from, to])
        .groupByRaw("date_trunc('week', vencimiento)")
        .select(trx.raw("date_trunc('week', vencimiento)::date AS bucket"), trx.raw('coalesce(sum(saldo_documento),0) AS monto'));
      const cobMap = new Map<string, number>((cobros as Array<{ bucket: unknown; monto: unknown }>).map((r) => [this.iso(r.bucket), Number(r.monto)]));

      // días hábiles (lun-vie) del rango, agrupados por su semana (lunes)
      const bizByWeek = new Map<string, string[]>();
      let cur = new Date(from + 'T00:00:00Z');
      const end = new Date(to + 'T00:00:00Z');
      while (cur <= end) {
        const dow = cur.getUTCDay();
        if (dow >= 1 && dow <= 5) { const d = cur.toISOString().slice(0, 10); const wk = this.monday(d); if (!bizByWeek.has(wk)) bizByWeek.set(wk, []); bizByWeek.get(wk)!.push(d); }
        cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + 1);
      }
      const items: CapacityProposalItem[] = [];
      for (const [wk, days] of bizByWeek) {
        const cobrosWeek = round2(cobMap.get(wk) ?? 0);
        const per = days.length ? round2(cobrosWeek / days.length) : 0;
        for (const d of days) items.push({ date: d, amount: per, week: wk, cobros_week: cobrosWeek });
      }
      items.sort((a, b) => (a.date < b.date ? -1 : 1));
      return {
        available: true, from, to, basis: 'cobranza_esperada_repartida_en_dias_habiles', as_of: cxc.as_of,
        note: 'Propuesto = cobranza esperada (CXC) de cada semana ÷ sus días hábiles. NO incluye el saldo en banco; súbelo si querés autorizar contra el saldo disponible.',
        items,
      };
    });
  }

  /** Confirma (escribe) una lista de capacidades diarias propuestas/ajustadas. Cada una queda en el historial. */
  async confirmProposed(items: Array<{ date: string; amount: number }>, reason: string | undefined, username: string) {
    if (!Array.isArray(items) || !items.length) throw new BadRequestException('items vacío');
    for (const it of items) { this.assertDate(it.date); if (!(Number(it.amount) >= 0)) throw new BadRequestException(`monto inválido para ${it.date}`); }
    const tenantId = this.tenantCtx.requireTenantId();
    const note = reason ?? 'Capacidad propuesta desde el flujo';
    return this.tk.run(async (trx) => {
      let written = 0;
      for (const it of items) {
        const prev = await trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: it.date }).first();
        await trx('budget.daily_capacity')
          .insert({ tenant_id: tenantId, capacity_date: it.date, authorized_amount: round2(it.amount), note, created_by: username, updated_by: username })
          .onConflict(['tenant_id', 'capacity_date'])
          .merge({ authorized_amount: round2(it.amount), note, updated_by: username, updated_at: trx.fn.now() });
        await trx('budget.daily_capacity_history').insert({
          tenant_id: tenantId, capacity_date: it.date, previous_amount: prev?.authorized_amount ?? null,
          new_amount: round2(it.amount), reason: note, changed_by: username,
        });
        written++;
      }
      return { written };
    });
  }
}
