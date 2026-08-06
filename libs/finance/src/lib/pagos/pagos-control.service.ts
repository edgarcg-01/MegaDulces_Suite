import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * CXP.2 — Tablero maestro de Cuentas por Pagar / Tesorería.
 *
 * Responde "¿qué necesita mi atención en pagos?" en una sola llamada, leyendo lo que
 * el motor de Maat YA computó (`finance.findings`) + las acciones HITL abiertas
 * (`finance.proposed_actions`) + un resumen de reconciliación de descuentos desde los
 * espejos Kepler (`analytics.*`). NO recomputa detectores: agrega la verdad existente.
 *
 * Dominio finance puro (no cruza a commercial): finance.* con RLS vía TenantKnexService;
 * analytics.* sin RLS → filtro tenant_id explícito (mismo patrón que los tools de Maat).
 */

const CXP_RULES = ['descuento_no_capturado', 'pago_duplicado', 'compra_factura_duplicada', 'dpo_largo'] as const;
const OPEN = ['nuevo', 'en_revision', 'confirmado'];
const COMERCIAL_CATS = ['pronto_pago', 'descuento_comercial', 'apoyo_marca'];

interface RuleAgg { rule_key: string; total: number; count: number; criticos: number; top: { titulo: string; importe: number; proveedor: string | null; severity: string }[] }

@Injectable()
export class PagosControlService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async overview(q: { date_from?: string; date_to?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // 1) Hallazgos abiertos de las reglas CxP (pocos cientos) → agregación en JS.
      const findings: any[] = await trx('finance.findings')
        .whereIn('rule_key', CXP_RULES as unknown as string[])
        .whereIn('status', OPEN)
        .select('rule_key', 'titulo', 'importe', 'entity', 'severity')
        .orderBy('importe', 'desc');

      const byRule = new Map<string, RuleAgg>();
      for (const rk of CXP_RULES) byRule.set(rk, { rule_key: rk, total: 0, count: 0, criticos: 0, top: [] });
      for (const f of findings) {
        const a = byRule.get(f.rule_key); if (!a) continue;
        const imp = Number(f.importe) || 0;
        a.total += imp; a.count += 1; if (f.severity === 'critical') a.criticos += 1;
        if (a.top.length < 5) a.top.push({ titulo: f.titulo, importe: imp, proveedor: (f.entity && (f.entity.proveedor_nombre || f.entity.proveedor_code)) || null, severity: f.severity });
      }
      const g = (rk: string) => byRule.get(rk)!;

      // 2) Acciones HITL abiertas.
      const acciones: any[] = await trx('finance.proposed_actions')
        .where('estado', 'pending_approval')
        .select('titulo', trx.raw('importe::numeric AS importe'), 'finding_id', 'created_at')
        .orderBy('importe', 'desc').limit(100);

      // 3) Reconciliación de descuentos (resumen), desde los espejos Kepler. Acotada al
      //    periodo cuando se pide (los KPIs de arriba son estado ACTUAL, no dependen del rango).
      const [pago] = await trx('analytics.erp_supplier_payments').where('tenant_id', tenantId)
        .modify((b: any) => { if (q.date_from) b.where('pago_date', '>=', q.date_from); if (q.date_to) b.where('pago_date', '<=', q.date_to); })
        .sum({ s: 'descuento' });
      const [nota] = await trx('analytics.erp_purchase_adjustments').where('tenant_id', tenantId).whereIn('categoria', COMERCIAL_CATS)
        .modify((b: any) => { if (q.date_from) b.where('adjustment_date', '>=', q.date_from); if (q.date_to) b.where('adjustment_date', '<=', q.date_to); })
        .sum({ s: 'monto' });
      const descPago = Number(pago?.s) || 0;
      const descNota = Number(nota?.s) || 0;

      const hallazgosAbiertos = findings.length;
      return {
        kpis: {
          fuga_descuento: this.kpi(g('descuento_no_capturado')),
          doble_pago: this.kpi(g('pago_duplicado')),
          factura_duplicada: this.kpi(g('compra_factura_duplicada')),
          dpo: this.kpi(g('dpo_largo')),
        },
        acciones: {
          pendientes: acciones.length,
          total_importe: acciones.reduce((s, a) => s + (Number(a.importe) || 0), 0),
          top: acciones.slice(0, 8).map((a) => ({ titulo: a.titulo, importe: Number(a.importe) || 0, finding_id: a.finding_id })),
        },
        reconciliacion: { desc_pago: descPago, desc_nota: descNota, total: descPago + descNota },
        hallazgos_abiertos: hallazgosAbiertos,
      };
    });
  }

  private kpi(a: RuleAgg) {
    return { total: a.total, count: a.count, criticos: a.criticos, top: a.top };
  }

  /**
   * CXP.5 — Conciliación de pagos a proveedor, mes a mes: lo que Kepler dice que
   * pagamos (erp_supplier_payments) vs lo que SALIÓ del banco por compra a proveedor
   * (CB bank_movements, categorías group_key compra/factoraje). Δ + estado.
   *
   * HONESTO: es cuadre AGREGADO por mes, NO por proveedor — ni CB ni ContPAQi guardan
   * el proveedor en el movimiento bancario (solo concepto/categoría), así que atribuir
   * un egreso a un proveedor sería un join débil (se omite). El cuadre banco↔libros
   * (ContPAQi) a nivel cuenta ya vive en Fase CB. `estado`: cuadra (|Δ|≤10%), revisar,
   * sin_banco/sin_kepler (falta el feed de ese mes). finance.* con RLS; analytics sin RLS.
   */
  async conciliacion(q: { date_from?: string; date_to?: string } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const kep: any[] = await trx('analytics.erp_supplier_payments')
        .where('tenant_id', tenantId)
        .modify((b: any) => { if (q.date_from) b.where('pago_date', '>=', q.date_from); if (q.date_to) b.where('pago_date', '<=', q.date_to); })
        .groupByRaw(`to_char(pago_date,'YYYY-MM')`)
        .select(trx.raw(`to_char(pago_date,'YYYY-MM') AS mes`), trx.raw('sum(monto)::numeric AS kepler'), trx.raw('count(*)::int AS n_kepler'));

      const ban: any[] = await trx('finance.bank_movements as bm')
        .join('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
        .where('bm.tenant_id', tenantId).whereIn('mc.group_key', ['compra', 'factoraje']).where('bm.amount_out', '>', 0)
        .modify((b: any) => { if (q.date_from) b.where('bm.movement_date', '>=', q.date_from); if (q.date_to) b.where('bm.movement_date', '<=', q.date_to); })
        .groupByRaw(`to_char(bm.movement_date,'YYYY-MM')`)
        .select(trx.raw(`to_char(bm.movement_date,'YYYY-MM') AS mes`), trx.raw('sum(bm.amount_out)::numeric AS banco'), trx.raw('count(*)::int AS n_banco'));

      const map = new Map<string, any>();
      const get = (mes: string) => { let e = map.get(mes); if (!e) { e = { mes, kepler: 0, banco: 0, n_kepler: 0, n_banco: 0 }; map.set(mes, e); } return e; };
      for (const r of kep) { const e = get(r.mes); e.kepler = Number(r.kepler) || 0; e.n_kepler = Number(r.n_kepler) || 0; }
      for (const r of ban) { const e = get(r.mes); e.banco = Number(r.banco) || 0; e.n_banco = Number(r.n_banco) || 0; }
      // Array.from (NO spread): webpack rompe [...map.values()] en el bundle del API → 1 fila basura. Ver feedback_webpack_set_spread_downlevel.
      const rows = Array.from(map.values()).sort((a, b) => b.mes.localeCompare(a.mes));
      for (const e of rows) {
        e.delta = e.kepler - e.banco;
        const base = Math.max(e.kepler, e.banco);
        e.estado = e.kepler === 0 ? 'sin_kepler' : e.banco === 0 ? 'sin_banco' : (base > 0 && Math.abs(e.delta) / base <= 0.1 ? 'cuadra' : 'revisar');
      }
      const totals = rows.reduce((a, e) => ({ kepler: a.kepler + e.kepler, banco: a.banco + e.banco }), { kepler: 0, banco: 0 });
      const cuadran = rows.filter((e) => e.estado === 'cuadra').length;
      return { rows, totals: { kepler: totals.kepler, banco: totals.banco, delta: totals.kepler - totals.banco }, meses: rows.length, cuadran };
    });
  }
}
