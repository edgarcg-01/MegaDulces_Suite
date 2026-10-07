import { Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * `[VE.5]` — **Folio, procedencia y completitud del presupuesto.** Opciones A, D y F del pedido de
 * Edgar (2026-10-07): *«todo valor manual es posible error, cada que se genere uno se le puede
 * asignar un folio»*.
 *
 * Tres piezas que van juntas porque resuelven el mismo problema desde ángulos distintos:
 *
 *   **A — el ejercicio nace solo, con folio.** `presupesto` (sic) es el nombre real del ejercicio
 *   FY2027 en prod: texto libre tecleado una vez que quedó para siempre como el identificador que
 *   todos ven. Un folio no se teclea.
 *
 *   **D — cada generación deja con qué se calculó.** ⭐ Es la pieza que contesta la objeción que el
 *   propio pedido tiene adentro: *«todo valor manual es posible error»* es cierto, **pero un valor
 *   derivado también puede estar mal, y es peor, porque nadie lo revisa**. Sin saber con qué
 *   supuestos se calculó una meta, automatizarla sólo cambia quién se equivoca (ADR-056).
 *
 *   **F — no se firma lo que está vacío.** En prod hay un ejercicio (`prueba`, FY2026) en estado
 *   `pendiente` —o sea esperando autorización— con **0 planes, 0 partidas y 0 supuestos**. Si
 *   alguien le da Aprobar, aprueba nada, y el ejercicio queda `aprobado` y fuera del alcance del
 *   piloto para siempre.
 */

/** Lo que le falta a un ejercicio para poder ir a firma. Vacío = está listo. */
export interface BudgetCompleteness {
  budget_id: string;
  folio: string | null;
  listo: boolean;
  /** Lo que IMPIDE firmar. Si hay algo acá, `submit` rechaza. */
  bloqueos: string[];
  /** Lo que conviene mirar y no impide firmar — se declara, no se esconde. */
  avisos: string[];
  conteos: {
    supuestos: number; plan_ventas: number; plan_gastos: number; partidas: number;
    periodos_con_meta: number; periodos_totales: number;
  };
}

@Injectable()
export class BudgetGenerationService {
  private readonly logger = new Logger(BudgetGenerationService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Folio consecutivo, atómico.
   *
   * ⚠️ NO se calcula con `max()+1`: dos corridas simultáneas sacarían el mismo número. El
   * `INSERT … ON CONFLICT DO UPDATE … RETURNING` lo resuelve en una sola sentencia — mismo patrón
   * que `commercial.expiry_folio_sequences` y `commercial.order_sequences` ya usan acá.
   */
  async nextFolio(
    trx: Knex.Transaction, tenantId: string, kind: 'ejercicio' | 'generacion', period: string,
  ): Promise<number> {
    const { rows } = await trx.raw(
      `INSERT INTO budget.folio_sequences (tenant_id, kind, period, current_value)
            VALUES (?, ?, ?, 1)
       ON CONFLICT (tenant_id, kind, period) DO UPDATE
            SET current_value = budget.folio_sequences.current_value + 1, updated_at = now()
         RETURNING current_value`,
      [tenantId, kind, period]);
    return Number((rows as Array<{ current_value: number }>)[0].current_value);
  }

  /**
   * `[A]` Se asegura de que exista el ejercicio del año fiscal pedido. Si ya hay uno —en el estado
   * que sea— **no crea otro**: el objetivo es que nunca falte, no multiplicarlos.
   *
   * Nace en `borrador`, escenario `base`, con nombre derivado y folio generado. Nadie firma nada
   * acá: el ciclo de vida sigue siendo humano de `submit` en adelante.
   */
  async ensureBudgetForYear(
    tenantId: string, fiscalYear: number, username: string,
  ): Promise<{ created: boolean; id: string; folio: string | null; name: string }> {
    return this.tk.run(async (trx) => {
      const ya = await trx('budget.budgets')
        .where({ tenant_id: tenantId, fiscal_year: fiscalYear })
        .orderBy('created_at', 'asc')
        .first();
      if (ya) {
        return { created: false, id: String(ya.id), folio: ya.folio ?? null, name: String(ya.name) };
      }

      const n = await this.nextFolio(trx, tenantId, 'ejercicio', String(fiscalYear));
      const folio = `PRE-${fiscalYear}-${String(n).padStart(3, '0')}`;
      const [row] = await trx('budget.budgets')
        .insert({
          tenant_id: tenantId,
          folio,
          // El nombre se deriva y deja de ser la identidad: el folio lo es. Si alguien quiere
          // ponerle otro nombre, puede — ya no rompe nada.
          name: `Presupuesto ${fiscalYear}`,
          fiscal_year: fiscalYear,
          currency: 'MXN',
          status: 'borrador',
          scenario: 'base',
          version: 1,
          created_by: username, updated_by: username,
        })
        .returning(['id', 'folio', 'name']);
      this.logger.log(`[VE.5] ejercicio ${folio} creado para FY${fiscalYear}`);
      return { created: true, id: String(row.id), folio: String(row.folio), name: String(row.name) };
    });
  }

  /**
   * `[VE.9.2]` Los ejercicios de un tenant, leídos **por `TenantKnexService`**.
   *
   * ⛔ Existe porque los dos pilotos listaban con el knex CRUDO (`KNEX_NEW_DB`) desde adentro de
   * su helper de contexto, y eso **no alcanza**: abrir el contexto CLS no aplica `app.tenant_id`
   * — lo aplica `tk.run()`, que es quien emite el `set_config`. Con RLS **forzado** en
   * `budget.*`, el knex crudo no falla: devuelve **cero filas**.
   *
   * Medido en la primera pasada real (2026-10-07): `ensureBudgetForYear` creó `PRE-2027-002`
   * —usa `tk.run`— y acto seguido la lista devolvió 0, así que la pasada recorrió «0/0
   * ejercicios» sobre un ejercicio que acababa de crear ella misma.
   *
   * ⚠️ Es la SEGUNDA vez que el mismo bug se cobra esta pasada. `[VE.4]` ya lo había arreglado
   * moviendo la consulta adentro del contexto — y el contexto nunca fue lo que faltaba.
   */
  async listBudgets(): Promise<Array<{ id: string; name: string; fiscal_year: number; status: string }>> {
    return this.tk.run(async (trx) => trx('budget.budgets')
      .select('id', 'name', 'fiscal_year', 'status')
      .orderBy('fiscal_year', 'asc')) as unknown as Array<{ id: string; name: string; fiscal_year: number; status: string }>;
  }

  /** `[D]` Abre el registro de una generación y devuelve su folio. */
  async openRun(
    tenantId: string, kind: string, trigger: 'cron' | 'manual',
    budgetId: string | null, assumptions: unknown, username: string,
  ): Promise<{ id: string; folio: string }> {
    return this.tk.run(async (trx) => {
      const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const n = await this.nextFolio(trx, tenantId, 'generacion', hoy);
      const folio = `GEN-${hoy}-${String(n).padStart(3, '0')}`;
      const [row] = await trx('budget.generation_runs')
        .insert({
          tenant_id: tenantId, folio, budget_id: budgetId, kind, trigger,
          status: 'running',
          assumptions: assumptions == null ? null : JSON.stringify(assumptions),
          created_by: username,
        })
        .returning(['id', 'folio']);
      return { id: String(row.id), folio: String(row.folio) };
    });
  }

  /** `[D]` Cierra el registro con lo que entregó. Un `output` vacío con `ok` sería una mentira. */
  async closeRun(
    tenantId: string, runId: string, output: unknown, error: string | null,
  ): Promise<void> {
    await this.tk.run(async (trx) => {
      await trx('budget.generation_runs')
        .where({ tenant_id: tenantId, id: runId })
        .update({
          finished_at: trx.fn.now(),
          status: error ? 'error' : 'ok',
          output: output == null ? null : JSON.stringify(output),
          error: error ? error.slice(0, 2000) : null,
        });
    });
  }

  /**
   * `[F]` Qué le falta a un ejercicio. Separa **bloqueos** (impiden firmar) de **avisos** (se
   * declaran y no frenan), porque fundirlos haría una de dos cosas malas: o frena por algo que no
   * es grave, o deja pasar algo que sí lo es.
   */
  async completeness(budgetId: string): Promise<BudgetCompleteness> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new Error('Presupuesto no encontrado');

      const uno = async (tabla: string) => {
        const [r] = await trx(tabla).where({ tenant_id: tenantId, budget_id: budgetId }).count({ n: '*' });
        return Number((r as { n: string }).n);
      };
      const supuestos = await uno('budget.sales_plan_settings');
      const planVentas = await uno('budget.sales_plan_lines');
      const planGastos = await uno('budget.expense_plan_lines');
      const partidas = await uno('budget.budget_lines');

      const [per] = await trx('budget.sales_plan_lines')
        .where({ tenant_id: tenantId, budget_id: budgetId })
        .countDistinct({ n: 'period_no' });
      const periodosConMeta = Number((per as { n: string }).n);

      const bloqueos: string[] = [];
      const avisos: string[] = [];

      // ⛔ EL CASO MEDIDO: `prueba` FY2026 está en `pendiente` con todo en cero. Un ejercicio sin
      // un solo renglón no puede ir a firma — aprobar eso es aprobar nada.
      if (planVentas === 0 && planGastos === 0) {
        bloqueos.push('No tiene ni un renglón: ni plan de ventas ni plan de gastos. '
          + 'El piloto los propone solo (03:30 MX) sobre ejercicios en borrador.');
      }
      // Los 13 periodos: con menos, el cumplimiento anual sale inflado porque el divisor no existe
      // en los que faltan — medido en FY2027, que cubre 10 de 13 y deja fuera la temporada alta.
      if (planVentas > 0 && periodosConMeta < 13) {
        bloqueos.push(`El plan de ventas cubre ${periodosConMeta} de 13 periodos. `
          + 'Comparar el real contra un plan incompleto infla el cumplimiento en los que faltan.');
      }
      if (supuestos === 0) {
        avisos.push('Sin supuestos guardados: el plan se armó con los valores por default.');
      }
      if (planGastos === 0) {
        avisos.push('Sin plan de gastos: el estado de resultados queda sin el sustraendo.');
      }
      if (partidas === 0) {
        avisos.push('Sin partidas materializadas: el ledger de 5 estados no tiene sobre qué moverse.');
      }

      return {
        budget_id: budgetId,
        folio: b.folio ?? null,
        listo: bloqueos.length === 0,
        bloqueos,
        avisos,
        conteos: {
          supuestos, plan_ventas: planVentas, plan_gastos: planGastos, partidas,
          periodos_con_meta: periodosConMeta, periodos_totales: 13,
        },
      };
    });
  }
}
