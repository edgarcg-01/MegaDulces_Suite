import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { BudgetSalesPlanService } from './budget-sales-plan.service';
import { BudgetExpensePlanService } from './budget-expense-plan.service';
import { BudgetMaterializeService } from './budget-materialize.service';

/**
 * `[VE.3]` — **El presupuesto se mantiene solo.** Pedido de Edgar, 2026-10-06: *«todo presupuestos
 * debe funcionar en automático. Botones innecesarios o métricas de inicio que se piden son
 * innecesarias»*.
 *
 * ── Lo que estaba pasando, medido ───────────────────────────────────────────────────────────
 *
 * El módulo tiene **cuatro motores que producen el presupuesto solos** —plan de ventas desde el
 * histórico, plan de gastos desde Kepler, proyección 13×4 → mes, y materialización a partidas— y
 * **ninguno tenía un `@Cron`**: los cuatro se disparaban únicamente apretando un botón. Medido en
 * prod el 2026-10-06: `expense_plan_lines` **0 filas**, `budget_lines` **0**, `line_movements`
 * **0**, `commercial.sales_targets` **0**, y la materialización nunca corrió ni una vez.
 *
 * ⭐ El diagnóstico que circulaba era *«falta que alguien le dé al botón de proponer»*. Esa frase
 * describe el síntoma y **acepta la causa**: un número que sólo existe si alguien se acuerda de
 * pedirlo no es un presupuesto, es un reporte a demanda.
 *
 * ── Por qué es seguro automatizarlo (verificado antes de escribir una línea) ────────────────
 *
 * Los tres pasos que este servicio dispara ya nacieron idempotentes y **respetan la mano humana**:
 *
 *   · `proposePlan` y `proposeExpensePlan` saltan toda celda con `method='manual'` y las cuentan
 *     en `coverage.manual_kept`. Sólo las pisan con `overwrite_manual`, que acá **nunca** se manda.
 *   · `materialize` sólo toca partidas `source='plan'` —una `source='manual'` no se pisa nunca— y
 *     para las que ya tienen saldo consumido ajusta el vigente en vez de reescribirlas.
 *   · Los tres exigen que el ejercicio esté en `borrador`/`en_revision`. **Un presupuesto aprobado
 *     o cerrado no lo toca nadie**, y eso lo garantiza el servicio, no este cron.
 *
 * ⛔ **Lo que este servicio NO hace, a propósito:** no aprueba, no cierra, no fija la capacidad de
 * pago y no crea ejercicios. Eso no son métricas, son decisiones — y `PRESUPUESTOS_GESTIONAR` las
 * reparte a personas (`[VE.2]`). Automatizar una decisión no es quitar un botón innecesario: es
 * quitarle la firma a quien responde por ella.
 *
 * ── Cómo falla ──────────────────────────────────────────────────────────────────────────────
 *
 * Cada ejercicio se intenta por separado: uno que truena no frena a los demás, y la falla se
 * **acumula** en el latido en vez de perderse en un `catch` mudo (la lección de `[OBS.1]`, donde
 * una rama caída era un `continue` silencioso y la pasada podía entregar cero diciendo «hecho»).
 * El latido mide **entrega** —ejercicios tocados y celdas escritas—, no «el proceso corrió»
 * (ADR-053), y su umbral va registrado en `CRON_JOBS` o `db-health` lo da por verde incondicional.
 */

/** El tenant al que se le escribe el latido. `analytics.cron_runs` es tabla de plataforma. */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

/** Quién queda como autor de lo que escribe el piloto. Se distingue de una persona a propósito. */
const AUTOR = 'autopilot';

export interface AutopilotBudgetResult {
  budget_id: string;
  name: string;
  fiscal_year: number;
  ventas: { escritas: number; manual_kept: number } | null;
  gastos: { escritas: number; manual_kept: number } | null;
  targets: { filas: number } | null;
  partidas: { creadas: number; ajustadas: number; sin_cambio: number } | null;
  errores: string[];
}

export interface AutopilotResult {
  ejercicios: number;
  tocados: number;
  celdas: number;
  errores: string[];
  detalle: AutopilotBudgetResult[];
  ms: number;
}

@Injectable()
export class BudgetAutopilotService {
  private readonly logger = new Logger(BudgetAutopilotService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly salesPlan: BudgetSalesPlanService,
    private readonly expensePlan: BudgetExpensePlanService,
    private readonly materialize: BudgetMaterializeService,
    @Optional() private readonly tenantCtx?: TenantContextService,
  ) {}

  /**
   * 03:30 MX. Después del refresco nocturno de analytics (que es de donde sale el real con el que
   * se propone) y antes de que alguien abra la pantalla por la mañana.
   */
  @Cron('0 30 3 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_BUDGET_AUTOPILOT === 'false') return;
    if (this.running) { this.logger.warn('Skip: una pasada sigue en curso'); return; }
    await this.run().catch((e) => this.logger.error(`autopilot: ${e?.message ?? e}`));
  }

  /**
   * Una pasada. Pública porque el botón de la pantalla la sigue llamando: el automático no quita
   * la posibilidad de pedirla ahora, quita la OBLIGACIÓN de pedirla para que exista el número.
   */
  async run(): Promise<AutopilotResult> {
    this.running = true;
    const t0 = Date.now();
    const errores: string[] = [];
    const detalle: AutopilotBudgetResult[] = [];
    let celdas = 0;

    try {
      // Sólo los ejercicios que los motores aceptan tocar. Si un día alguien agrega un estado
      // nuevo, este filtro se queda corto y el ejercicio simplemente no entra — que es el lado
      // seguro de equivocarse.
      const abiertos = await this.knex('budget.budgets')
        .select('id', 'name', 'fiscal_year', 'tenant_id')
        .whereIn('status', ['borrador', 'en_revision'])
        .orderBy('fiscal_year', 'asc');

      for (const b of abiertos) {
        const r = await this.unEjercicio(String(b.tenant_id), String(b.id), String(b.name), Number(b.fiscal_year));
        detalle.push(r);
        celdas += (r.ventas?.escritas ?? 0) + (r.gastos?.escritas ?? 0)
          + (r.targets?.filas ?? 0) + (r.partidas?.creadas ?? 0) + (r.partidas?.ajustadas ?? 0);
        // La falla de un ejercicio viaja hacia arriba con su nombre: `continue` mudo no.
        for (const e of r.errores) errores.push(`${r.name} (FY${r.fiscal_year}): ${e}`);
      }

      const res: AutopilotResult = {
        ejercicios: abiertos.length,
        tocados: detalle.filter((d) => d.errores.length === 0).length,
        celdas, errores, detalle, ms: Date.now() - t0,
      };
      await this.latir(res);
      return res;
    } finally {
      this.running = false;
    }
  }

  /**
   * ⚠️ Los servicios resuelven el tenant por `TenantContextService` (CLS) y corren bajo
   * `TenantKnexService.run()`, que fija `app.tenant_id` para el RLS **forzado** de `budget.*`.
   * Un `@Cron` no tiene request, así que no hay contexto: sin abrirlo a mano, cada consulta ve
   * CERO filas — y el cero se lee como «no había nada que proponer». Mismo patrón que
   * `RecommendationsService` (Fase D.4) y la trampa que `caja-fecha-futura-scanner` documenta.
   */
  private async conTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const ctx = this.tenantCtx as unknown as { run?: (s: unknown, f: () => Promise<T>) => Promise<T> } | undefined;
    if (!ctx?.run) return fn();
    return ctx.run({ tenantId, userId: null, username: AUTOR }, fn);
  }

  private async unEjercicio(
    tenantId: string, budgetId: string, name: string, fy: number,
  ): Promise<AutopilotBudgetResult> {
    const out: AutopilotBudgetResult = {
      budget_id: budgetId, name, fiscal_year: fy,
      ventas: null, gastos: null, targets: null, partidas: null, errores: [],
    };

    // Cada paso aislado: que no haya plan de gastos no puede impedir que se proyecten los targets.
    // Los cuatro son independientes salvo `materialize`, que necesita el plan ya escrito — por eso
    // va al final, y por eso se salta si los dos planes fallaron.
    await this.conTenant(tenantId, async () => {
      try {
        const r = await this.salesPlan.proposePlan(budgetId, {}, AUTOR);
        const c = r.coverage as Record<string, number>;
        out.ventas = {
          escritas: (c.historico_ajustado ?? 0) + (c.estacional ?? 0) + (c.proxy_canal ?? 0) + (c.sin_base_declarado ?? 0),
          manual_kept: c.manual_kept ?? 0,
        };
      } catch (e) { out.errores.push(`plan de ventas: ${(e as Error)?.message ?? e}`); }

      try {
        const r = await this.expensePlan.proposeExpensePlan(budgetId, {}, AUTOR);
        const c = r.coverage as Record<string, number>;
        out.gastos = {
          escritas: (c.historico_ajustado ?? 0) + (c.estacional ?? 0),
          manual_kept: c.manual_kept ?? 0,
        };
      } catch (e) { out.errores.push(`plan de gastos: ${(e as Error)?.message ?? e}`); }

      try {
        const r = await this.salesPlan.projectToSalesTargets(budgetId, AUTOR);
        out.targets = { filas: Number((r as { projected?: number }).projected ?? 0) };
      } catch (e) { out.errores.push(`proyección a sales_targets: ${(e as Error)?.message ?? e}`); }

      if (out.ventas || out.gastos) {
        try {
          const s = await this.materialize.materialize(budgetId, AUTOR) as unknown as
            { created?: number; updated?: number; adjusted?: number; skipped?: number };
          out.partidas = {
            creadas: s.created ?? 0,
            // `updated` y `adjusted` son dos caminos distintos del mismo servicio: reescribir una
            // partida intacta y ajustar el vigente de una que ya tiene saldo consumido. Las dos
            // son trabajo entregado, así que las dos cuentan.
            ajustadas: (s.updated ?? 0) + (s.adjusted ?? 0),
            sin_cambio: s.skipped ?? 0,
          };
        } catch (e) { out.errores.push(`materialización: ${(e as Error)?.message ?? e}`); }
      }
      return null;
    });

    return out;
  }

  /**
   * Latido de ENTREGA (ADR-053): cuántos ejercicios quedaron sanos y cuántas celdas se escribieron,
   * no «la pasada terminó». Una corrida que recorre 2 ejercicios y escribe 0 celdas con 2 errores
   * reporta `error`, no `ok` — que es justo lo que `run-prod-feeds` hacía mal al declarar `ok`
   * mientras 6 de sus 53 pasos fallaban.
   *
   * ⚠️ Su umbral tiene que estar en `CRON_JOBS` (`budget_autopilot`) o `db-health` lo clasifica con
   * el `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional.
   */
  private async latir(r: AutopilotResult): Promise<void> {
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'budget_autopilot',
          label: 'Presupuesto que se mantiene solo',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          status: r.errores.length ? 'error' : 'ok',
          rows_affected: r.celdas,
          duration_ms: r.ms,
          note: `${r.tocados}/${r.ejercicios} ejercicios · ${r.celdas} celdas escritas`,
          error: r.errores.length ? r.errores.join(' | ').slice(0, 500) : null,
          host: 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch { /* el latido nunca rompe al que late */ }
  }
}
