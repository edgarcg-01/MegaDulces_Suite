import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import type { FinanceFindingsSinkPort } from '@megadulces/contracts';
import { FINANCE_FINDINGS_SINK_PORT } from '@megadulces/contracts';
import { KNEX_NEW_DB, todayMx } from '@megadulces/platform-core';
import { perfilAcumulado, evaluarRitmo, llaveDePartida, type PlanRow, type LedgerRow } from './budget-phasing';
import {
  hallazgosDePresupuesto, BUDGET_RULES,
  type EjercicioMedido, type PartidaMedida,
} from './budget-findings.rules';

/**
 * `[PU.VG.8]` **El presupuesto deja de hablar solo.**
 *
 * Medido contra prod el 2026-10-09: `finance.findings` tiene **157,262 filas y 41 reglas, y
 * ninguna de presupuesto**. Este carril lleva seis declaraciones medidas y las seis viven en una
 * pantalla. Esto las manda a la bandeja que la gente ya abre.
 *
 * ⭐ **No se inventa bandeja.** `FINANCE_FINDINGS_SINK_PORT` existe desde Maat y tiene 5
 * consumidores; el sink ya trae dedup por `dedup_key`, registro idempotente de reglas y respeta
 * la auto-supresión por feedback. Construir otra habría sido la octava bandeja del repo (ADR-056).
 *
 * ── Lo que este servicio NO decide ───────────────────────────────────────────
 * La lógica de qué es hallazgo vive en `budget-findings.rules.ts`, que es PURO y se prueba sin
 * Postgres (23 aserciones). Acá sólo se MIDE y se entrega. Si esto creciera a decidir, la decisión
 * quedaría fuera del alcance de cualquier unitaria.
 *
 * ── Por qué el tenant se abre a mano ────────────────────────────────────────
 * Igual que el autopiloto: un `@Cron` no tiene request, y `budget.budgets` tiene **RLS forzado**.
 * Sin `app.tenant_id` la consulta NO falla — devuelve **cero filas**, y un escaneo que no encuentra
 * nada se ve idéntico a uno que corrió bien. Ya costó una corrida que reportó «0/0 ejercicios»
 * con 2 en la tabla y el latido en `ok`.
 */
@Injectable()
export class BudgetFindingsService {
  private readonly logger = new Logger(BudgetFindingsService.name);

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  /**
   * Mide el estado del presupuesto y empuja lo que haya que mirar.
   *
   * Devuelve `medido: false` cuando no hay sink cableado, en vez de `0 hallazgos` — que es la
   * misma cifra que «todo bien» y se lee al revés.
   */
  async scan(tenantId: string): Promise<{ medido: boolean; motivo: string | null; hallazgos: number; insertados: number }> {
    if (!this.sink) {
      return { medido: false, motivo: 'FINANCE_FINDINGS_SINK_PORT no está cableado en este módulo', hallazgos: 0, insertados: 0 };
    }

    const mesEnCurso = todayMx().slice(0, 7);
    const { ejercicios, partidas } = await this.knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);

      const budgets = await trx('budget.budgets')
        .where({ tenant_id: tenantId })
        .select('id', 'name', 'fiscal_year', 'is_test');

      const ejs: EjercicioMedido[] = [];
      const pas: PartidaMedida[] = [];

      for (const b of budgets as Array<Record<string, unknown>>) {
        const budgetId = String(b.id);

        // La firma es el HECHO de que una persona tocó los supuestos, no un valor: un 0 % es una
        // decisión legítima y se ve igual que no haber decidido. `created_by` del autopiloto no
        // cuenta — la máquina no firma.
        const st = await trx('budget.expense_plan_settings')
          .where({ tenant_id: tenantId, budget_id: budgetId })
          .first('created_by') as Record<string, unknown> | undefined;
        const autor = String(st?.created_by ?? '').trim().toLowerCase();
        const firmado = !!st && !!autor && autor !== 'autopilot';

        const planRows = await trx('budget.expense_plan_lines')
          .where({ tenant_id: tenantId, budget_id: budgetId })
          .select('account_code', 'sucursal', 'year_month', 'monto');

        // Sin renglones de plan no hay total que publicar: va `null`, no 0 (ADR-056).
        const total = planRows.length
          ? Math.round(planRows.reduce((a: number, r: Record<string, unknown>) => a + Number(r.monto ?? 0), 0) * 100) / 100
          : null;

        ejs.push({
          budget_id: budgetId,
          fiscal_year: Number(b.fiscal_year),
          nombre: String(b.name ?? `Ejercicio ${b.fiscal_year}`),
          is_test: b.is_test === true,
          supuesto_firmado: firmado,
          plan_total: total,
        });

        const lineas = await trx('budget.budget_lines')
          .where({ tenant_id: tenantId, budget_id: budgetId, line_type: 'gasto' })
          .select('id', 'account_code', 'cost_center', 'concept', 'original_amount',
            'reserved_amount', 'committed_amount', 'exercised_amount', 'control_level');

        const perfiles = perfilAcumulado(planRows as PlanRow[], mesEnCurso);
        for (const l of lineas as Array<Record<string, unknown>>) {
          // El doble salto por `unknown` no es ceremonia: `LedgerRow` declara sus campos como
          // `unknown` a propósito (el módulo puro no confía en el tipo de la fila, lo valida), y
          // TS se niega al cast directo desde `Record<string, unknown>` porque no se solapan.
          const fila = l as unknown as LedgerRow;
          const r = evaluarRitmo(fila, perfiles.get(llaveDePartida(fila)));
          pas.push({
            budget_id: budgetId,
            fiscal_year: Number(b.fiscal_year),
            is_test: b.is_test === true,
            line_id: String(l.id),
            account_code: String(l.account_code ?? ''),
            concept: l.concept == null ? null : String(l.concept),
            estado: r.estado,
            deberia: r.deberia,
            consumido: r.consumido,
            brecha: r.brecha,
            control_level: l.control_level == null ? null : String(l.control_level),
            original_amount: l.original_amount == null ? null : Number(l.original_amount),
          });
        }
      }
      return { ejercicios: ejs, partidas: pas };
    });

    const findings = hallazgosDePresupuesto(ejercicios, partidas);
    if (!findings.length) return { medido: true, motivo: null, hallazgos: 0, insertados: 0 };

    const res = await this.sink.pushFindings(tenantId, findings, BUDGET_RULES);
    this.logger.log(`presupuesto: ${findings.length} hallazgo(s), ${res.inserted} insertado(s)`);
    return { medido: true, motivo: null, hallazgos: findings.length, insertados: res.inserted };
  }
}
