import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PU.4 — Presupuestos: planeación avanzada (ADR-066, spec §4/§5.2/§5.5/§14).
 *
 *   - copyBudget       — copiar un ejercicio anterior SIN arrastrar autorizaciones (spec §5.2):
 *                        la copia nace en 'borrador', buckets en cero, vigente = original.
 *   - compareVersions  — comparar dos presupuestos línea a línea (por concepto/área/tipo/periodo).
 *   - importLines      — preview (impacto antes de aplicar) + apply IDEMPOTENTE por clave natural
 *                        (spec §5.2/§14 #2: "mostrar impacto" + "sin duplicar al reintentar").
 *   - projectionToClose — proyección de cierre COMPUTADA que NO altera el presupuesto autorizado
 *                        (spec §5.5/§14 #19).
 *
 * El import solo opera sobre presupuestos en borrador/revisión (antes de aprobar): así reescribir
 * original/vigente es seguro (no hay adecuaciones ni ejecución que pisar).
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const LINE_TYPES = ['ingreso', 'costo_ventas', 'gasto', 'compra_inventario', 'inversion', 'flujo'];
const CONTROLS = ['informativo', 'advertencia', 'bloqueo'];

export interface ImportRow {
  concept: string;
  line_type?: string;
  area?: string | null;
  cost_center?: string | null;
  account_code?: string | null;
  responsible?: string | null;
  period_month?: string | null;
  original_amount: number;
  control_level?: string;
}
export interface CopyBudgetDto { name?: string; scenario?: 'base' | 'conservador' | 'expansion'; fiscal_year?: number }

@Injectable()
export class BudgetPlanningService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private key(r: { concept?: string; area?: string | null; line_type?: string; period_month?: string | null }) {
    return [String(r.concept ?? '').trim().toLowerCase(), r.area ?? '', r.line_type ?? 'gasto', this.dOnly(r.period_month)].join('|');
  }
  private dOnly(d: any): string { return d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10)) : ''; }

  // ── Copiar ejercicio (sin arrastrar autorizaciones) ─────────────────────────────────────
  async copyBudget(sourceId: string, dto: CopyBudgetDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const src = await trx('budget.budgets').where({ tenant_id: tenantId, id: sourceId }).first();
      if (!src) throw new NotFoundException('Presupuesto origen no encontrado');
      const name = (dto.name ?? src.name).trim();
      const fiscal_year = dto.fiscal_year ?? src.fiscal_year;
      const scenario = dto.scenario ?? src.scenario;
      const [{ maxv }] = await trx('budget.budgets').where({ tenant_id: tenantId, name, fiscal_year }).max({ maxv: 'version' });
      const version = Number(maxv ?? 0) + 1;
      const [budget] = await trx('budget.budgets').insert({
        tenant_id: tenantId, name, fiscal_year, scenario, version, entity: src.entity, currency: src.currency,
        status: 'borrador', copied_from_id: src.id, notes: src.notes, created_by: username,
      }).returning('*');

      const srcLines = await trx('budget.budget_lines').where({ tenant_id: tenantId, budget_id: sourceId });
      for (const l of srcLines) {
        const [nl] = await trx('budget.budget_lines').insert({
          tenant_id: tenantId, budget_id: budget.id, concept: l.concept, line_type: l.line_type,
          area: l.area, cost_center: l.cost_center, account_code: l.account_code, responsible: l.responsible,
          period_month: l.period_month, original_amount: l.original_amount, vigente_amount: l.original_amount, // reset a original
          control_level: l.control_level, created_by: username,
        }).returning('id');
        if (Number(l.original_amount) > 0) {
          await trx('budget.line_movements').insert({ tenant_id: tenantId, budget_line_id: nl.id, movement_type: 'apertura', amount: l.original_amount, source_kind: 'copia', note: `Copiado de ${src.name} v${src.version}`, created_by: username });
        }
      }
      return { budget, copied_lines: srcLines.length };
    });
  }

  // ── Comparar dos presupuestos (versiones/escenarios) ────────────────────────────────────
  async compareVersions(idA: string, idB: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const a = await this.linesByKey(trx, tenantId, idA);
      const b = await this.linesByKey(trx, tenantId, idB);
      const keys = new Set([...a.keys(), ...b.keys()]);
      const rows = [...keys].map((k) => {
        const la = a.get(k), lb = b.get(k);
        const va = la ? Number(la.vigente_amount) : null, vb = lb ? Number(lb.vigente_amount) : null;
        return {
          concept: (la ?? lb).concept, area: (la ?? lb).area, line_type: (la ?? lb).line_type,
          vigente_a: va, vigente_b: vb, delta: va != null && vb != null ? round2(vb - va) : null,
          estado: !la ? 'solo_b' : !lb ? 'solo_a' : va === vb ? 'igual' : 'cambio',
        };
      });
      const sum = (m: Map<string, any>) => round2([...m.values()].reduce((s, l) => s + Number(l.vigente_amount), 0));
      return { totals: { a: sum(a), b: sum(b), delta: round2(sum(b) - sum(a)) }, rows };
    });
  }
  private async linesByKey(trx: any, tenantId: string, budgetId: string) {
    const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
    if (!b) throw new NotFoundException(`Presupuesto ${budgetId} no encontrado`);
    const lines = await trx('budget.budget_lines').where({ tenant_id: tenantId, budget_id: budgetId });
    return new Map(lines.map((l: any) => [this.key(l), l]));
  }

  // ── Import: preview (impacto) ───────────────────────────────────────────────────────────
  async importPreview(budgetId: string, rows: ImportRow[]) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const existing = await this.linesByKey(trx, tenantId, budgetId);
      let create = 0, update = 0, errors = 0;
      const detail = (rows ?? []).map((r, i) => {
        const err = this.validateRow(r);
        if (err) { errors++; return { i, concept: r.concept, action: 'error', error: err }; }
        const k = this.key({ ...r, line_type: r.line_type ?? 'gasto' });
        const action = existing.has(k) ? 'update' : 'create';
        if (action === 'update') update++; else create++;
        return { i, concept: r.concept, action, key: k };
      });
      return { summary: { total: rows?.length ?? 0, create, update, errors }, rows: detail };
    });
  }

  // ── Import: apply idempotente ───────────────────────────────────────────────────────────
  async importApply(budgetId: string, rows: ImportRow[], username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision'].includes(b.status)) {
        throw new BadRequestException(`Importar solo en borrador/revisión (está '${b.status}'). Usa adecuaciones autorizadas después de aprobar.`);
      }
      const existing = await this.linesByKey(trx, tenantId, budgetId);
      let created = 0, updated = 0, skipped = 0;
      for (const r of rows ?? []) {
        if (this.validateRow(r)) { skipped++; continue; }
        const lineType = r.line_type ?? 'gasto';
        const k = this.key({ ...r, line_type: lineType });
        const orig = round2(r.original_amount);
        const patch = {
          line_type: lineType, area: r.area ?? null, cost_center: r.cost_center ?? null,
          account_code: r.account_code ?? null, responsible: r.responsible ?? null,
          period_month: r.period_month ?? null, original_amount: orig, vigente_amount: orig,
          control_level: r.control_level ?? 'bloqueo',
        };
        const found = existing.get(k);
        if (found) {
          // Idempotente: reimportar la misma fila la deja igual (no duplica).
          await trx('budget.budget_lines').where({ tenant_id: tenantId, id: found.id }).update({ ...patch, updated_by: username, updated_at: trx.fn.now() });
          updated++;
        } else {
          const [nl] = await trx('budget.budget_lines').insert({ tenant_id: tenantId, budget_id: budgetId, concept: r.concept.trim(), ...patch, created_by: username }).returning('id');
          if (orig > 0) await trx('budget.line_movements').insert({ tenant_id: tenantId, budget_line_id: nl.id, movement_type: 'apertura', amount: orig, source_kind: 'import', note: 'Importación de partida', created_by: username });
          existing.set(k, { id: nl.id }); // evita duplicar dentro del mismo lote (dos filas con misma clave)
          created++;
        }
      }
      return { created, updated, skipped };
    });
  }

  private validateRow(r: ImportRow): string | null {
    if (!r || !String(r.concept ?? '').trim()) return 'concept requerido';
    if (!(Number(r.original_amount) > 0)) return 'original_amount debe ser > 0';
    if (r.line_type && !LINE_TYPES.includes(r.line_type)) return `line_type inválido: ${r.line_type}`;
    if (r.control_level && !CONTROLS.includes(r.control_level)) return `control_level inválido: ${r.control_level}`;
    if (r.period_month && !/^\d{4}-\d{2}-\d{2}$/.test(r.period_month)) return 'period_month debe ser YYYY-MM-DD';
    return null;
  }

  // ── Proyección de cierre (computada, NO altera lo autorizado) ───────────────────────────
  async projectionToClose(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      const [agg] = await trx('budget.budget_lines').where({ tenant_id: tenantId, budget_id: budgetId })
        .sum({ vigente: 'vigente_amount', reserved: 'reserved_amount', committed: 'committed_amount', exercised: 'exercised_amount', paid: 'paid_amount' });
      const vigente = round2(Number(agg.vigente ?? 0));
      const exercised = round2(Number(agg.exercised ?? 0));
      const committed = round2(Number(agg.committed ?? 0));
      const reserved = round2(Number(agg.reserved ?? 0));
      return {
        budget_id: budgetId, authorized_vigente: vigente,
        // Firme = lo ya ejercido + lo comprometido (que muy probablemente se ejercerá).
        proyeccion_firme: round2(exercised + committed),
        // Plena = ejecución total del vigente (incluye reservas y disponible).
        proyeccion_plena: vigente,
        actual: { exercised, committed, reserved, disponible: round2(vigente - reserved - committed - exercised) },
        note: 'Proyección COMPUTADA a partir del estado del ledger. No modifica el presupuesto autorizado (spec §5.5/§14 #19).',
      };
    });
  }
}
