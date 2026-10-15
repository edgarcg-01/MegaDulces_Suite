import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { cobranzaPrevista } from '../customer-ledger/cobranza-prevista';
import { ingresoPorDia, inhabilesDe, realHasta, versionVigente } from '../budget/income-forecast.sql';
import { capacidadDesdeIngreso } from './capacity-from-income';
import type { CapacityConfirmResult, CapacityProposal, CapacityProposalItem } from '@megadulces/contracts';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * `[PU.14]` Un lote en estos estados ya pasó a Pagos: su capacidad NO se toca. Los mismos que
 * `PaymentCalendarService` usa para cerrar el alcance de un lote (`LOCKED_LOT_STATUSES`).
 */
const LOTE_YA_EN_PAGOS = ['released', 'executing', 'closed'];


export type { CapacityProposalItem };

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

  /**
   * `[PU.14]` Estado del lote de cada fecha que YA pasó a Pagos (liberado, en ejecución o cerrado).
   * Regla de Francisco (2026-10-14): el ajuste de la capacidad se hace el día anterior, antes de
   * pasar a Pagos. Antes de esto la capacidad de un día ya liberado se podía cambiar igual.
   */
  private async lotesEnPagos(trx: Knex.Transaction, tenantId: string, fechas: string[], bloquear = false): Promise<Map<string, string>> {
    if (!fechas.length) return new Map();
    // Cuando se va a ESCRIBIR, los lotes de esas fechas se leen con FOR SHARE y SIN filtrar por estado:
    // así una liberación simultánea (`releaseLot` hace UPDATE del lote) espera a que esta escritura
    // termine, en vez de liberar contra una capacidad que se está cambiando. Filtrar por estado en SQL
    // dejaría sin bloquear justo los lotes que todavía se pueden liberar.
    let q = trx('finance.payment_calendar_lots')
      .where({ tenant_id: tenantId })
      .whereIn('lot_date', fechas)
      .select(trx.raw(`to_char(lot_date, 'YYYY-MM-DD') AS fecha`), 'status');
    if (bloquear) q = q.forShare();
    const rows = (await q) as Array<{ fecha: string; status: string }>;
    return new Map(rows.filter((r) => LOTE_YA_EN_PAGOS.includes(r.status)).map((r) => [r.fecha, r.status]));
  }

  private mensajeEnPagos(date: string, status: string): string {
    return `El ${date} ya pasó a Pagos (lote ${status}): su capacidad no se puede cambiar. El ajuste se hace el día anterior, antes de liberar el día.`;
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
      const enPagos = (await this.lotesEnPagos(trx, tenantId, [date], true)).get(date);
      if (enPagos) throw new ConflictException(this.mensajeEnPagos(date, enPagos));
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
  /**
   * `[PU.14]` La propuesta de capacidad. **Por default desde el estimado de ingresos** (decisión de
   * Francisco, 2026-10-14); la cartera (CXC) queda como respaldo cuando no hay estimado vigente que
   * cubra el rango, o si se pide explícita (`basis=cartera`). Cada día viaja con `bloqueado` si ya
   * pasó a Pagos, para que la pantalla lo diga antes de confirmar.
   */
  async propose(from: string, to: string, basis?: string): Promise<CapacityProposal> {
    this.assertDate(from); this.assertDate(to);
    if (to < from) throw new BadRequestException('`to` no puede ser anterior a `from`');
    if (basis && basis !== 'ingreso_estimado' && basis !== 'cartera') {
      throw new BadRequestException('basis debe ser ingreso_estimado o cartera');
    }
    const tenantId = this.tenantCtx.requireTenantId();
    let respaldo: string | null = null;
    if (basis !== 'cartera') {
      try {
        const porIngreso = await this.proposeFromIncome(from, to);
        if (porIngreso.available) return this.marcarEnPagos(tenantId, porIngreso);
        respaldo = porIngreso.reason ?? 'Sin estimado de ingresos para el rango';
      } catch (e) {
        // ⛔ Si el código llega antes que la migración de [PU.13], la tabla no existe (42P01). Sin
        // esto la propuesta entera —también la de cartera, que funcionaba— respondería 500.
        if ((e as { code?: string })?.code !== '42P01') throw e;
        respaldo = 'la tabla del estimado de ingresos todavía no existe en esta base (falta aplicar la migración de PU.13)';
      }
    }
    const porCartera = await this.proposeFromCartera(from, to);
    return this.marcarEnPagos(tenantId, respaldo ? { ...porCartera, respaldo_de: respaldo } : porCartera);
  }

  private async marcarEnPagos(tenantId: string, r: CapacityProposal): Promise<CapacityProposal> {
    if (!r.items.length) return r;
    const enPagos = await this.tk.run((trx) => this.lotesEnPagos(trx, tenantId, r.items.map((i) => i.date)));
    return { ...r, items: r.items.map((i) => ({ ...i, bloqueado: enPagos.get(i.date) ?? null })) };
  }

  /**
   * `[PU.14]` Capacidad = ingreso del día (real si ya está cargado, si no el estimado vigente; bancos +
   * caja general) + lo que entró en los días inhábiles anteriores. Regla en `capacity-from-income.ts`.
   * Lee el ingreso con la MISMA consulta que la pantalla `/presupuesto/ingresos`.
   */
  async proposeFromIncome(from: string, to: string): Promise<CapacityProposal> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const version = await versionVigente(trx, tenantId);
      if (!version) {
        return { available: false, from, to, basis: 'ingreso_estimado',
          reason: 'No hay estimado de ingresos vigente (budget.income_forecasts).', items: [] as CapacityProposalItem[] };
      }
      const tope = await realHasta(trx, tenantId);
      // Una semana antes: el arrastre del fin de semana previo al primer día del rango.
      const desde = new Date(from + 'T00:00:00Z');
      desde.setUTCDate(desde.getUTCDate() - 7);
      const rows = await ingresoPorDia(trx, tenantId, version.id, desde.toISOString().slice(0, 10), to, tope);
      const r = capacidadDesdeIngreso(rows, inhabilesDe(version), from, to);
      if (!r.items.length) {
        return { available: false, from, to, basis: 'ingreso_estimado',
          reason: `El estimado vigente «${version.nombre}» no cubre ningún día hábil entre ${from} y ${to}.`,
          items: [] as CapacityProposalItem[] };
      }
      const items: CapacityProposalItem[] = r.items.map((i) => ({
        date: i.date, amount: i.amount, week: this.monday(i.date), cobros_week: null,
        ingreso_dia: i.ingreso_dia, arrastre: i.arrastre, arrastre_de: i.arrastre_de, origen: i.origen,
      }));
      return {
        available: true, from, to, basis: 'ingreso_estimado',
        version: version.nombre,
        real_hasta: tope,
        note: 'Propuesto = lo que entra cada día hábil (real si ya está cargado, si no el estimado de ingresos) ' +
          'más lo que entró en los fines de semana y feriados anteriores. Ajústalo a mano el día anterior, antes de pasar a Pagos.',
        sin_estimado: r.sin_estimado,
        items,
      };
    });
  }

  /** La propuesta original (PR.2): cobranza esperada de la cartera, repartida en días hábiles. */
  async proposeFromCartera(from: string, to: string): Promise<CapacityProposal> {
    this.assertDate(from); this.assertDate(to);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [cxc] = await trx('analytics.customer_receivables').where({ tenant_id: tenantId })
        .select(trx.raw('count(*)::int AS n'), trx.raw('max(computed_at) AS as_of'));
      if (!Number(cxc.n)) {
        return { available: false, from, to, basis: 'cobranza_esperada', reason: 'Sin cartera CXC (analytics.customer_receivables) para este tenant', as_of: null, items: [] as CapacityProposalItem[] };
      }
      // [CXC.22] Mismo resolvedor que `budget-cashflow`: esta consulta estaba COPIADA a mano
      // en los dos servicios. Suma `saldo_ajustado` y trae la cobertura de la ventana.
      const prevista = await cobranzaPrevista(trx, tenantId, from, to);
      const cobMap = new Map<string, number>(prevista.porSemana.map((r) => [r.bucket, r.monto]));

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
        // [CXC.22] La propuesta se arma con lo que vence DENTRO del rango. Lo ya vencido es
        // exigible hoy y no tiene fecha comprometida: viaja declarado para que quien autoriza
        // sepa que la propuesta es conservadora, no que no haya más por cobrar.
        cobranza_cobertura: prevista.cobertura,
        base: prevista.base,
        items,
      };
    });
  }

  /** Confirma (escribe) una lista de capacidades diarias propuestas/ajustadas. Cada una queda en el historial. */
  async confirmProposed(items: Array<{ date: string; amount: number }>, reason: string | undefined, username: string): Promise<CapacityConfirmResult> {
    if (!Array.isArray(items) || !items.length) throw new BadRequestException('items vacío');
    for (const it of items) { this.assertDate(it.date); if (!(Number(it.amount) >= 0)) throw new BadRequestException(`monto inválido para ${it.date}`); }
    const tenantId = this.tenantCtx.requireTenantId();
    const note = reason ?? 'Capacidad propuesta desde el flujo';
    return this.tk.run(async (trx) => {
      let written = 0;
      // [PU.14] Los días que ya pasaron a Pagos se SALTAN y se dicen; el resto se escribe.
      const enPagos = await this.lotesEnPagos(trx, tenantId, items.map((i) => i.date), true);
      const omitidos: Array<{ date: string; status: string; motivo: string }> = [];
      for (const it of items) {
        const st = enPagos.get(it.date);
        if (st) { omitidos.push({ date: it.date, status: st, motivo: this.mensajeEnPagos(it.date, st) }); continue; }
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
      return { written, omitidos };
    });
  }
}
