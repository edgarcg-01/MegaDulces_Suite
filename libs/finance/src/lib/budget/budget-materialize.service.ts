import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PR.1 — Materialización plan → ledger de 5 estados (ADR-074).
 *
 * Con la captura manual RETIRADA, las partidas de `budget.budget_lines` dejan de teclearse: se
 * MATERIALIZAN de los planes automáticos —`budget.sales_plan_lines` (ingreso, por entidad) y
 * `budget.expense_plan_lines` (gasto, por cuenta mayor × sucursal)— agregando a la partida (año).
 *
 * Reglas (invariantes del ledger):
 *   · Sólo toca partidas `source='plan'`; una partida `source='manual'` (legado/excepción) NUNCA se pisa.
 *   · Idempotente por `source_ref` (clave natural de la línea de plan).
 *   · Partida SIN consumo (reserva/compromiso/ejercido/pagado = 0) → insert/update directo de original+vigente.
 *   · Partida CON consumo (ejercicio ya aprobado y en operación) → se AJUSTA el vigente con un movimiento
 *     `ampliacion`/`reduccion` (rastreado, respeta lo consumido), nunca un UPDATE ciego.
 *   · «Sin datos» ≠ cero: una cuenta/entidad en 0 no fabrica partida; una partida de plan que ya no está en
 *     el plan y no tiene consumo se cierra (status='cerrada'); con consumo se deja y se declara.
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * `[PU.VA]` La familia contable de Kepler decide el **tipo de partida**. Hasta acá TODA línea del
 * plan de gastos se materializaba como `'gasto'`, sin mirar de qué familia venía — y eso bastaba
 * sólo porque el plan presupuestaba **una** familia (la 6).
 *
 * ⛔ El día que alguien agregue otra familia a la política, sin este mapa la compra de mercancía
 * entraría al presupuesto **como gasto operativo**: en 2026 eso son $463.0 M cayendo encima de los
 * $56.9 M de gasto real, y el renglón quedaría sin poder leerse. Los tipos ya existen en el CHECK
 * de `budget_lines` (mig `20260917140000`) y hasta hoy **nada los producía**.
 *
 * Medido el 2026-10-07 sobre `analytics.expense_entries`: en 2025 y 2026 la familia 5 tiene **una
 * sola cuenta**, `511 COMPRAS DE MERCANCIA A PROVEEDORES`. ⚠️ Eso **corrige** lo que dice el
 * comentario de `budget-result.service.ts` —que la familia 5 es *«la construcción contable completa
 * del costo de ventas: inventario inicial + compras − descuentos − inventario final»*—: en estos
 * dos años no hay tal construcción, sólo compra. Por eso el tipo es `compra_inventario` y **no**
 * `costo_ventas`: comprar no es vender, y el costo de lo vendido sigue sin fuente (§22.12).
 *
 * ⚠️ Esto habilita el mecanismo, **no cambia el alcance**: `proposal_families` sigue en `['6']`.
 * Qué familias se presupuestan es una decisión de Finanzas, y se toma desde la pantalla.
 */
const TIPO_POR_FAMILIA: Record<string, Desired['line_type']> = {
  '5': 'compra_inventario',
  '6': 'gasto',
  '7': 'gasto',        // financieros: salen del mismo bolsillo operativo, sin tipo propio en el CHECK
  '1': 'inversion',
};

interface Desired {
  source_ref: string;
  concept: string;
  line_type: 'ingreso' | 'gasto' | 'costo_ventas' | 'compra_inventario' | 'inversion' | 'flujo';
  account_code: string | null;
  cost_center: string | null;
  original: number;
  control_level: 'informativo' | 'advertencia' | 'bloqueo';
  expense_class: 'fijo' | 'variable' | null;
  recurrence: 'recurrente' | 'no_recurrente' | null;
}

@Injectable()
export class BudgetMaterializeService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Materializa (re-sincroniza) las partidas de plan del ejercicio. Devuelve el resumen. */
  async materialize(budgetId: string, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).forUpdate().first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision', 'aprobado'].includes(b.status)) {
        throw new BadRequestException(`No se materializa un presupuesto '${b.status}' (borrador/revisión/aprobado).`);
      }

      const desired = new Map<string, Desired>();

      // ── GASTOS: agrupar expense_plan_lines por cuenta × sucursal ──
      const expControl = (await trx('budget.expense_plan_settings').where({ tenant_id: tenantId, budget_id: budgetId }).first())?.control_level || 'advertencia';
      const expRows = await trx('budget.expense_plan_lines').where({ tenant_id: tenantId, budget_id: budgetId })
        .select('account_code', 'account_name', 'sucursal', 'monto', 'familia');
      const gmap = new Map<string, { name: string | null; sucursal: string; monto: number; months: number; familia: string }>();
      for (const r of expRows) {
        const key = `${r.account_code}|${r.sucursal || ''}`;
        if (!gmap.has(key)) gmap.set(key, { name: r.account_name, sucursal: r.sucursal || '', monto: 0, months: 0, familia: String(r.familia ?? '') });
        const g = gmap.get(key)!;
        g.monto = round2(g.monto + Number(r.monto || 0));
        if (Number(r.monto) > 0) g.months++;
      }
      for (const [key, g] of gmap) {
        const accountCode = key.slice(0, key.indexOf('|'));
        const tipo = TIPO_POR_FAMILIA[g.familia] ?? 'gasto';
        // `[PU.VA]` ⚠️ El prefijo del `source_ref` se conserva en `gasto:` para la familia 6. Es la
        // clave natural con la que se reconcilia: cambiarla para las líneas que YA existen las
        // borraría y recrearía, perdiendo su historial de movimientos. Sólo las familias nuevas
        // estrenan prefijo.
        const sref = tipo === 'gasto' ? `gasto:${accountCode}:${g.sucursal}` : `${tipo}:${accountCode}:${g.sucursal}`;
        desired.set(sref, {
          source_ref: sref,
          concept: g.name || accountCode,
          line_type: tipo,
          account_code: accountCode,
          cost_center: g.sucursal || null,
          original: g.monto,
          control_level: expControl,
          expense_class: null,
          recurrence: g.months >= 6 ? 'recurrente' : 'no_recurrente',
        });
      }

      // ── VENTAS: agrupar sales_plan_lines por entidad ──
      const salRows = await trx('budget.sales_plan_lines').where({ tenant_id: tenantId, budget_id: budgetId })
        .select('entity_key', 'meta_amount');
      const smap = new Map<string, number>();
      for (const r of salRows) smap.set(r.entity_key, round2((smap.get(r.entity_key) || 0) + Number(r.meta_amount || 0)));
      for (const [entityKey, sum] of smap) {
        const sep = entityKey.indexOf(':');
        const channel = sep >= 0 ? entityKey.slice(0, sep) : entityKey;
        const warehouse = sep >= 0 ? entityKey.slice(sep + 1) : '';
        desired.set(`ingreso:${entityKey}`, {
          source_ref: `ingreso:${entityKey}`,
          concept: `Ventas ${channel}${warehouse ? ' · ' + warehouse : ''}`,
          line_type: 'ingreso',
          account_code: null,
          cost_center: entityKey,
          original: sum,
          control_level: 'informativo', // los ingresos son meta, no tope de gasto
          expense_class: null,
          recurrence: null,
        });
      }

      const summary = { created: 0, updated: 0, adjusted: 0, closed: 0, skipped: 0, gasto: 0, ingreso: 0 };
      const seen = new Set<string>();

      for (const [sref, d] of desired) {
        seen.add(sref);
        const existing = await trx('budget.budget_lines')
          .where({ tenant_id: tenantId, budget_id: budgetId, source_ref: sref }).first();

        if (!existing) {
          if (!(d.original > 0)) { summary.skipped++; continue; } // «sin datos» ≠ cero
          const [line] = await trx('budget.budget_lines').insert({
            tenant_id: tenantId, budget_id: budgetId, concept: d.concept, line_type: d.line_type,
            cost_center: d.cost_center, account_code: d.account_code,
            original_amount: d.original, vigente_amount: d.original,
            control_level: d.control_level, expense_class: d.expense_class, recurrence: d.recurrence,
            source: 'plan', source_ref: sref, created_by: username, updated_by: username,
          }).returning('*');
          await trx('budget.line_movements').insert({
            tenant_id: tenantId, budget_line_id: line.id, movement_type: 'apertura', amount: d.original,
            // `[PU.VA]` ⛔ Acá iba `sref` pelado, y el índice de idempotencia es
            // `(tenant_id, source_kind, source_ref, movement_type)` — **sin el ejercicio**. Como
            // `sref` es `gasto:<cuenta>:<sucursal>`, el SEGUNDO ejercicio del tenant choca contra
            // el primero en la misma cuenta: `duplicate key value violates unique constraint
            // "ux_budget_mov_idem"`. O sea que sólo se podía materializar **un ejercicio por
            // tenant, para siempre**.
            //
            // ⭐ Nunca se vio porque nunca hubo dos: hasta el 2026-10-07 la tabla tenía un solo
            // ejercicio. Apareció en el primer minuto en que existieron dos.
            //
            // El `budget_id` va en el `source_ref` del MOVIMIENTO y no en el de `budget_lines`:
            // allá la unicidad ya es por `(budget_id, source_ref)` y tocarlo recrearía las
            // partidas que ya existen. Acá la idempotencia correcta es «este movimiento, de esta
            // línea, de ESTE ejercicio».
            source_kind: 'materializacion', source_ref: `${budgetId}|${sref}`,
            note: 'Materialización del plan', created_by: username,
          });
          summary.created++; summary[d.line_type]++;
          continue;
        }

        const consumed = round2(Number(existing.reserved_amount) + Number(existing.committed_amount) + Number(existing.exercised_amount) + Number(existing.paid_amount)) > 0;
        if (!consumed) {
          if (round2(Number(existing.original_amount)) === d.original && round2(Number(existing.vigente_amount)) === d.original
            && existing.concept === d.concept && existing.control_level === d.control_level) { summary.skipped++; continue; }
          await trx('budget.budget_lines').where({ tenant_id: tenantId, id: existing.id }).update({
            concept: d.concept, original_amount: d.original, vigente_amount: d.original,
            control_level: d.control_level, expense_class: d.expense_class, recurrence: d.recurrence,
            status: 'activa', updated_by: username, updated_at: trx.fn.now(),
          });
          summary.updated++;
          continue;
        }

        // con consumo → ajustar vigente por movimiento (respeta lo consumido)
        const r = await this.adjustVigente(trx, tenantId, existing, d.original, sref, username);
        if (r === 'adjusted') summary.adjusted++; else summary.skipped++;
      }

      // partidas de plan que ya no están en el plan
      const orphans = await trx('budget.budget_lines')
        .where({ tenant_id: tenantId, budget_id: budgetId, source: 'plan' })
        .whereNotNull('source_ref')
        .whereNotIn('source_ref', [...seen]);
      for (const o of orphans) {
        const consumed = round2(Number(o.reserved_amount) + Number(o.committed_amount) + Number(o.exercised_amount) + Number(o.paid_amount)) > 0;
        if (!consumed && o.status !== 'cerrada') {
          await trx('budget.budget_lines').where({ tenant_id: tenantId, id: o.id })
            .update({ status: 'cerrada', vigente_amount: 0, updated_by: username, updated_at: trx.fn.now() });
          summary.closed++;
        } else {
          summary.skipped++; // con consumo: se deja y se declara
        }
      }

      return { budget_status: b.status, ...summary, total_desired: desired.size };
    });
  }

  /** Ajusta el vigente de una partida con consumo hacia `target` vía ampliacion/reduccion (inline, atómico). */
  private async adjustVigente(
    trx: import('knex').Knex, tenantId: string, line: Record<string, unknown>, target: number, sref: string, username: string,
  ): Promise<'adjusted' | 'skip'> {
    const cur = Number(line.vigente_amount);
    const consumed = round2(Number(line.reserved_amount) + Number(line.committed_amount) + Number(line.exercised_amount));
    let tgt = target;
    if (tgt < consumed) tgt = consumed; // no bajar de lo ya comprometido/ejercido
    const delta = round2(tgt - cur);
    if (Math.abs(delta) < 0.01) return 'skip';
    const movType = delta > 0 ? 'ampliacion' : 'reduccion';
    try {
      await trx('budget.line_movements').insert({
        tenant_id: tenantId, budget_line_id: line.id, movement_type: movType, amount: Math.abs(delta),
        source_kind: 'materializacion', source_ref: `mat:${sref}:v${tgt}`,
        note: 'Ajuste por re-materialización del plan', created_by: username,
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === '23505') return 'skip'; // ya aplicado (idempotente)
      throw e;
    }
    await trx('budget.budget_lines').where({ tenant_id: tenantId, id: line.id })
      .update({ vigente_amount: round2(cur + delta), updated_by: username, updated_at: trx.fn.now() });
    return 'adjusted';
  }
}
