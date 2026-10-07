import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { BudgetExpenseObligationsService } from './budget-expense-obligations.service';

/**
 * `[VE.4]` — **Las obligaciones de gasto se proponen solas.** Segunda mitad del pedido de Edgar
 * (2026-10-06/07): *«todo presupuestos debe funcionar en automático»*.
 *
 * ── Por qué vive ACÁ y no en el piloto de Presupuestos ──────────────────────────────────────
 *
 * `[VE.3]` automatizó los cuatro motores que viven en `FinanceBudgetModule`. El quinto —generar
 * las obligaciones recurrentes desde el plan de gastos— **no se podía meter en ese mismo cron**:
 * `FinancePaymentCalendarModule` ya **importa** `FinanceBudgetModule`, así que inyectar al revés
 * cerraría un ciclo de módulos. Y el puerto que existe en esa frontera (`BUDGET_LEDGER_PORT`) va
 * en la dirección contraria —TP consume de PU—, de modo que proveerlo al revés habría dejado al
 * piloto con una dependencia que **nunca** se resuelve: un paso que se salta en silencio todas
 * las noches y un tablero que igual sale verde.
 *
 * El corte también es el correcto por dominio: ADR-064 separa a propósito **Presupuestos**
 * (que autoriza el gasto y fija el tope) de **Tesorería** (que programa el pago). La obligación
 * es la pieza de este lado.
 *
 * Corre a las **03:50 MX**, veinte minutos después del piloto de Presupuestos, porque lee
 * `budget.expense_plan_lines` — que es justo lo que aquél acaba de escribir.
 *
 * ── Por qué es seguro, verificado antes de escribirlo ───────────────────────────────────────
 *
 * ⭐ **Lo que genera NO es un compromiso de pago: nace en estado `propuesta`.** El paso de
 * `propuesta → pending` es un acto humano explícito (`authorize`, HITL) y **recién ahí entra al
 * Calendario**. O sea que el automático prepara la lista y la persona firma — que es la línea que
 * `[VE.3]` ya trazó: *automatizar una decisión no es quitar un botón innecesario, es quitarle la
 * firma a quien responde por ella*.
 *
 * Además, verificado en el servicio: una propuesta existente se **actualiza en monto**, una ya
 * **autorizada NO se toca**, las cuentas esporádicas **no se generan** (no son compromisos
 * predecibles) y un presupuesto `cerrado` lo rechaza el propio servicio.
 */

/** El tenant al que se le escribe el latido. `analytics.cron_runs` es tabla de plataforma. */
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const AUTOR = 'autopilot';

export interface ObligationsAutopilotResult {
  ejercicios: number;
  generadas: number;
  actualizadas: number;
  sin_cambio: number;
  errores: string[];
  ms: number;
}

@Injectable()
export class ObligationsAutopilotService {
  private readonly logger = new Logger(ObligationsAutopilotService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly obligaciones: BudgetExpenseObligationsService,
    private readonly tk: TenantKnexService,
    @Optional() private readonly tenantCtx?: TenantContextService,
  ) {}

  /** 03:50 MX — después de que `[VE.3]` escribió el plan de gastos del que esto deriva. */
  @Cron('0 50 3 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_BUDGET_AUTOPILOT === 'false') return;
    if (this.running) { this.logger.warn('Skip: una pasada sigue en curso'); return; }
    await this.run().catch((e) => this.logger.error(`obligations autopilot: ${e?.message ?? e}`));
  }

  async run(): Promise<ObligationsAutopilotResult> {
    this.running = true;
    const t0 = Date.now();
    const errores: string[] = [];
    let generadas = 0, actualizadas = 0, sinCambio = 0, ejercicios = 0;

    try {
      // ⛔⛔ La lista va DENTRO del contexto de tenant. `budget.budgets` tiene RLS **forzado**, así
      // que leerla sin `app.tenant_id` no falla: devuelve CERO FILAS y la pasada reporta «ok»
      // sobre nada. Medido en vivo con el piloto hermano el 2026-10-07 (`[VE.3]`): recorrió
      // «0/0 ejercicios» con 2 en la tabla. `public.tenants` NO tiene RLS, y de ahí sale la lista.
      const tenants = await this.knex('public.tenants').select('id').orderBy('created_at', 'asc');
      let vistos = 0;

      for (const t of tenants) {
        const tid = String(t.id);
        // `cerrado` lo rechaza el servicio; se filtra acá para no provocar un error por cada uno.
        const { abiertos, totales } = await this.conTenant(tid, async () => {
          // ⛔ `[VE.9.2]` Por `tk.run()`, no por el knex crudo: abrir el contexto CLS no aplica
          // `app.tenant_id`, y con RLS forzado el crudo devuelve CERO FILAS sin fallar. Mismo
          // bug que se midió en el piloto hermano en su primera pasada real.
          const rows = await this.tk.run(async (trx) => trx('budget.budgets')
            .select('id', 'name', 'fiscal_year', 'status')
            .orderBy('fiscal_year', 'asc')) as unknown as Array<{ id: string; name: string; fiscal_year: number; status: string }>;
          return { abiertos: rows.filter((r) => String(r.status) !== 'cerrado'), totales: rows.length };
        });
        vistos += totales;

        for (const b of abiertos) {
          ejercicios++;
          try {
            const r = await this.conTenant(tid, () =>
              this.obligaciones.generateFromPlan(String(b.id), AUTOR)) as unknown as
              { generated?: number; updated?: number; skipped?: number };
            generadas += r?.generated ?? 0;
            actualizadas += r?.updated ?? 0;
            sinCambio += r?.skipped ?? 0;
          } catch (e) {
            // La falla viaja con el nombre del ejercicio: un `continue` mudo deja la pasada
            // entregando cero mientras reporta que terminó bien (la lección de `[OBS.1]`).
            errores.push(`${b.name} (FY${b.fiscal_year}): ${(e as Error)?.message ?? e}`);
          }
        }
      }

      // «No vi ni una fila» ≠ «no hay ejercicios»: con RLS son indistinguibles desde afuera.
      if (tenants.length > 0 && vistos === 0) {
        errores.push('no se vio ni un ejercicio en ninguna tabla: ¿contexto de tenant / RLS?');
      }

      const res: ObligationsAutopilotResult = {
        ejercicios, generadas, actualizadas, sin_cambio: sinCambio, errores, ms: Date.now() - t0,
      };
      await this.latir(res);
      return res;
    } finally {
      this.running = false;
    }
  }

  /**
   * ⚠️ Sin contexto de tenant, `TenantKnexService.run()` no fija `app.tenant_id` y el RLS forzado
   * de `budget.*` devuelve CERO filas — que se lee como «no había nada que proponer». Misma
   * trampa que documenta `caja-fecha-futura-scanner` y que `[VE.3]` ya resolvió de este modo.
   */
  private async conTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const ctx = this.tenantCtx as unknown as { run?: (s: unknown, f: () => Promise<T>) => Promise<T> } | undefined;
    if (!ctx?.run) return fn();
    return ctx.run({ tenantId, userId: null, username: AUTOR }, fn);
  }

  /**
   * Latido de ENTREGA (ADR-053). ⚠️ Su umbral va en `CRON_JOBS` (`obligations_autopilot`) o
   * `db-health` lo clasifica con el `cfg ? classify : 'ok'` que la Fase VP midió dando verde
   * incondicional.
   */
  private async latir(r: ObligationsAutopilotResult): Promise<void> {
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'obligations_autopilot',
          label: 'Obligaciones de gasto propuestas solas',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          status: r.errores.length ? 'error' : 'ok',
          rows_affected: r.generadas + r.actualizadas,
          duration_ms: r.ms,
          // Lo accionable: cuántas ESPERAN FIRMA, que es lo que hay que ir a mirar por la mañana.
          note: `${r.ejercicios} ejercicios · ${r.generadas} nuevas en propuesta · `
            + `${r.actualizadas} actualizadas · ${r.sin_cambio} sin cambio`,
          error: r.errores.length ? r.errores.join(' | ').slice(0, 500) : null,
          host: 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch { /* el latido nunca rompe al que late */ }
  }
}
