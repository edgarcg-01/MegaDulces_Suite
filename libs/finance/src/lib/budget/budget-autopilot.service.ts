import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { BudgetSalesPlanService, type ProcedenciaCrec } from './budget-sales-plan.service';
import { BudgetExpensePlanService } from './budget-expense-plan.service';
import { BudgetMaterializeService } from './budget-materialize.service';
import { BudgetGenerationService } from './budget-generation.service';
import { SelloutRollupService } from './sellout-rollup.service';

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

/**
 * Horas máximas de antigüedad del rollup del sell-out para que el piloto se atreva a proponer.
 * Es el MISMO umbral que `CRON_JOBS` registra para `analytics_refresh_sellout_budget`.
 */
const ROLLUP_MAX_H = 26;

export interface AutopilotBudgetResult {
  budget_id: string;
  name: string;
  fiscal_year: number;
  ventas: { escritas: number; manual_kept: number } | null;
  gastos: { escritas: number; manual_kept: number } | null;
  targets: { filas: number } | null;
  partidas: { creadas: number; ajustadas: number; sin_cambio: number } | null;
  /** [VE.7] Supuestos derivados por el sistema vs respetados porque alguien los fijo. */
  /** `[PVI.3]` `sin_medir` = canales cuyo YoY NO se pudo calcular y cayeron al `default`. Se
   *  declara en el resultado de la pasada porque es lo único que distingue un supuesto medido de
   *  uno de relleno — y el de relleno fue el que puso +26.67 % sobre un canal que cae −9.36 %. */
  supuestos?: { derivados: number; respetados: number; sin_medir: number };
  /** [VE.5-D] El folio de la generacion que produjo estos numeros. */
  run_folio?: string;
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
    private readonly generation: BudgetGenerationService,
    private readonly rollup: SelloutRollupService,
    @Optional() private readonly tenantCtx?: TenantContextService,
  ) {}

  /**
   * 07:30 MX. **Después** del refresco nocturno de analytics, que es de donde sale el real con el
   * que se propone, y antes de que alguien abra la pantalla por la mañana.
   *
   * ⛔ Acá decía `03:30` y el comentario afirmaba «después del refresco nocturno». **Era falso, y
   * se midió**: `AnalyticsRefreshService` corre a las **06:20** y su lote cierra cerca de las
   * **06:50** (`analytics_refresh_erp_margin` 06:49 el 2026-10-07). O sea que el piloto planeaba
   * con el rollup de la mañana ANTERIOR, y el comentario decía lo contrario — una premisa escrita
   * como ley que nadie había medido.
   *
   * ⚠️ Mover la hora NO alcanza: **ordenar no es depender** (ADR-056). Si el refresco falla, a las
   * 07:30 el rollup sigue ahí, viejo, y planear sobre él produce metas que se ven perfectas. Por
   * eso `baseServible()` comprueba la frescura y, si no está, **declara y no escribe**.
   */
  @Cron('0 30 7 * * *', { timeZone: 'America/Mexico_City' })
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
      // ⛔⛔ ESTA LISTA TIENE QUE SALIR DE ADENTRO DEL CONTEXTO DE TENANT, y la primera versión
      // la sacaba de afuera. `budget.budgets` tiene **RLS forzado** (verificado en prod:
      // `relforcerowsecurity = true`), así que sin `app.tenant_id` la consulta no falla: devuelve
      // CERO FILAS. Medido en la primera corrida real, 2026-10-07 03:30:00 — el cron recorrió
      // «0/0 ejercicios» con 2 en la tabla (uno en borrador) y el latido dijo **ok**.
      //
      // ⭐ Es la falla canónica de este repo y la razón de ser de ADR-056: *el cero se lee como
      // «no había nada que hacer»*. El comentario de `conTenant` ya advertía exactamente esto
      // para las consultas de adentro — y la de afuera se escribió igual.
      //
      // `public.tenants` NO tiene RLS (verificado), así que de ahí sale la lista de a quién
      // mirar, y los budgets de cada uno se leen con su contexto abierto.
      const tenants = await this.knex('public.tenants').select('id').orderBy('created_at', 'asc');
      let vistos = 0;

      for (const t of tenants) {
        const tid = String(t.id);

        // `[VE.5-A]` Que NUNCA falte el ejercicio del año que viene. Si ya existe —en el estado que
        // sea— no crea otro; si no, nace en `borrador` con folio `PRE-AAAA-NNN` y nombre derivado.
        // ⭐ Esto mata dos errores medidos en prod a la vez: el ejercicio que se llama `presupesto`
        // (texto libre tecleado una vez, que quedó como el identificador que todos ven) y el
        // «nadie se acordó de crearlo». Nadie firma nada acá: el ciclo sigue siendo humano.
        const fySiguiente = new Date().getFullYear() + 1;
        try {
          const e = await this.conTenant(tid, () =>
            this.generation.ensureBudgetForYear(tid, fySiguiente, AUTOR));
          if (e.created) this.logger.log(`[VE.5] ejercicio ${e.folio} creado (FY${fySiguiente})`);
        } catch (e) {
          errores.push(`crear ejercicio FY${fySiguiente}: ${(e as Error)?.message ?? e}`);
        }

        // ⛔ `[VE.9.2]` POR `TenantKnexService`, no por el knex crudo. Abrir el contexto CLS NO
        // aplica `app.tenant_id` — lo aplica `tk.run()`, y con RLS forzado el knex crudo no
        // falla: devuelve CERO FILAS. Medido en la primera pasada real: `ensureBudgetForYear`
        // creó `PRE-2027-002` y la línea de abajo devolvió 0, así que la pasada recorrió «0/0
        // ejercicios» sobre uno que acababa de crear ella misma.
        const { abiertos, totales } = await this.conTenant(tid, async () => {
          const rows = await this.generation.listBudgets();
          return {
            // Si un día alguien agrega un estado nuevo, este filtro se queda corto y el ejercicio
            // no entra — que es el lado seguro de equivocarse.
            abiertos: rows.filter((r) => ['borrador', 'en_revision'].includes(String(r.status))),
            totales: rows.length,
          };
        });
        vistos += totales;

        for (const b of abiertos) {
          const r = await this.unEjercicio(tid, String(b.id), String(b.name), Number(b.fiscal_year));
          detalle.push(r);
          celdas += (r.ventas?.escritas ?? 0) + (r.gastos?.escritas ?? 0)
            + (r.targets?.filas ?? 0) + (r.partidas?.creadas ?? 0) + (r.partidas?.ajustadas ?? 0);
          // La falla de un ejercicio viaja hacia arriba con su nombre: `continue` mudo no.
          for (const e of r.errores) errores.push(`${r.name} (FY${r.fiscal_year}): ${e}`);
        }
      }

      // ⚠️ «No vi ni una fila de presupuesto» NO es lo mismo que «no hay ejercicios abiertos», y
      // con RLS de por medio son indistinguibles desde afuera. Si el universo entero salió vacío
      // se DECLARA como falla: es el síntoma exacto del bug de arriba volviendo.
      if (tenants.length > 0 && vistos === 0) {
        errores.push('no se vio ni un ejercicio en ninguna tabla: ¿contexto de tenant / RLS?');
      }

      const res: AutopilotResult = {
        ejercicios: detalle.length,
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

  /**
   * ¿La base con la que se propone está SERVIBLE? Devuelve el motivo cuando no.
   *
   * ⭐ Existe por una falla real, con recibo en `analytics.cron_runs`: el 2026-10-08 a las 03:30 la
   * pasada cerró en `error` con **`0/2 ejercicios`** y el mensaje *«El histórico de ventas se está
   * generando (primera vez)»* — el 503 del Parquet que vivía en el `/tmp` del pod y que cada
   * despliegue borraba. El plan de GASTOS sí se escribía (838 celdas), el de VENTAS no, y eso dejó
   * el mayoreo congelado sobre una base vieja durante semanas sin que nadie lo mirara.
   *
   * Ese modo de falla ya no existe (el rollup vive en Postgres), pero el que lo reemplaza es peor
   * de ver: una matvista **rancia** no tira excepción, devuelve filas. Planear sobre ella escribe
   * metas que se ven perfectas. Por eso acá no se pregunta «¿hay datos?» sino «¿de cuándo son?».
   *
   * El umbral es el MISMO que `CRON_JOBS` registra para `analytics_refresh_sellout_budget` (26 h):
   * dos sitios con el mismo número, y si alguien mueve uno, el otro queda mintiendo — queda dicho.
   */
  private async baseServible(tenantId: string): Promise<{ ok: boolean; motivo?: string; asOf: string | null }> {
    const asOf = await this.rollup.dataAsOf(tenantId).catch(() => null);
    if (!asOf) {
      return { ok: false, asOf: null, motivo: 'el rollup del sell-out no tiene filas para este tenant (¿falta el refresco nocturno?)' };
    }
    const horas = (Date.now() - new Date(asOf).getTime()) / 36e5;
    if (horas > ROLLUP_MAX_H) {
      return { ok: false, asOf, motivo: `el rollup del sell-out se construyó hace ${horas.toFixed(1)} h (umbral ${ROLLUP_MAX_H} h): no se planea sobre una base rancia` };
    }
    return { ok: true, asOf };
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
      // `[VE.5-D]` La procedencia: con QUÉ supuestos se calculó esta pasada. Se lee ANTES de
      // tocar nada, porque es lo que explica el número que queda. Sin esto, «la meta de P7 cambió
      // entre ayer y hoy» no tiene respuesta — y un valor derivado que nadie puede auditar es
      // peor que uno capturado, porque nadie lo revisa (ADR-056).
      let run: { id: string; folio: string } | null = null;
      // `[VE.7]` Los supuestos se DERIVAN y se GUARDAN, no se capturan. Hasta acá el sistema los
      // sugería y había que apretar «Guardar», o sea que el número que gobierna todo el plan
      // dependía de que alguien se acordara. Edgar: *«todo valor manual es posible error»*.
      //
      // ⛔ Sólo se escriben los canales que NO tienen un valor guardado. Si alguien ajustó uno a
      // mano, ese se respeta — misma regla que `method='manual'` en las celdas del plan. Lo que
      // desaparece es la obligación de capturar, no la posibilidad de corregir.
      // ⭐ La base ANTES que nada: los supuestos y el plan de ventas leen los dos el mismo rollup,
      // así que se pregunta UNA vez. Si no está servible, ninguno de los dos escribe — y el motivo
      // viaja al latido. «Sin datos» ≠ cero, y «base vieja» ≠ base (ADR-056).
      const base = await this.baseServible(tenantId);
      if (!base.ok) {
        out.errores.push(`base del sell-out: ${base.motivo}`);
      }

      if (base.ok) try {
        const g = await this.salesPlan.proposeGrowth(budgetId);
        const actual = await this.salesPlan.getSettings(budgetId).catch(() => null);
        const yaGuardado = (actual?.growth_by_channel ?? {}) as Record<string, number>;
        const derivado: Record<string, number> = {};
        // `[PVI.3]` ⛔ Acá moría la procedencia: esta línea leía `.growth_pct` y tiraba `basis`,
        // `paired_periods`, `years_used` y la cobertura del pareo. Por eso nadie podía saber que
        // el 0.2667 de `mayoreo` era el `default` —su YoY no se pudo calcular— y no una medición;
        // el canal mide **−9.36 %** y el plan le puso **+26.67 %** sobre $169,970,622 de meta.
        // Un número sin procedencia no se puede auditar sin recomputarlo. `VERDAD_ABSOLUTA` §24.7.
        const procedencia: Record<string, ProcedenciaCrec> = {};
        const at = new Date().toISOString();
        for (const [canal, v] of Object.entries(g.by_channel ?? {})) {
          const c = v as { growth_pct: number; basis?: string; paired_periods?: number; years_used?: number[]; cobertura?: ProcedenciaCrec['cobertura'] };
          if (yaGuardado[canal] == null) {
            derivado[canal] = Number(c.growth_pct);
            procedencia[canal] = {
              basis: (c.basis ?? 'default') as ProcedenciaCrec['basis'],
              paired_periods: c.paired_periods,
              years_used: c.years_used,
              cobertura: c.cobertura,
              at,
            };
          } else {
            // ⭐ Lo puso una persona y el autopilot lo respeta: eso TAMBIÉN es procedencia, y es la
            // que faltaba — sin ella un supuesto humano y uno derivado se ven idénticos en la tabla.
            procedencia[canal] = { basis: 'manual', at };
          }
        }
        if (Object.keys(derivado).length) {
          await this.salesPlan.upsertSettings(budgetId, {
            default_growth_pct: Number(g.global?.growth_pct ?? 0),
            growth_by_channel: { ...yaGuardado, ...derivado },
            growth_provenance: procedencia,
          }, AUTOR);
          out.supuestos = {
            derivados: Object.keys(derivado).length,
            respetados: Object.keys(yaGuardado).length,
            sin_medir: Object.values(procedencia).filter((p) => p.basis === 'default').length,
          };
        }
      } catch (e) { out.errores.push(`supuestos: ${(e as Error)?.message ?? e}`); }

      try {
        const sup = await this.salesPlan.getSettings(budgetId).catch(() => null);
        run = await this.generation.openRun(tenantId, 'pasada', 'cron', budgetId, sup, AUTOR);
        out.run_folio = run.folio;
      } catch (e) {
        // Que falle el registro NO puede impedir la generación, pero tampoco se calla: una pasada
        // sin procedencia es exactamente lo que esto vino a evitar.
        out.errores.push(`registro de procedencia: ${(e as Error)?.message ?? e}`);
      }

      if (base.ok) try {
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

      // `[VE.5-D]` Cierra el registro con lo que entregó, POR PASO. Un total («escribió 418
      // celdas») no dice si el plan de gastos corrió; el objeto sí.
      if (run) {
        await this.generation.closeRun(tenantId, run.id, {
          ventas: out.ventas, gastos: out.gastos, targets: out.targets, partidas: out.partidas,
        }, out.errores.length ? out.errores.join(' | ') : null).catch(() => undefined);
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
