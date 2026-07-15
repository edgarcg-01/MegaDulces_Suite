import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

export interface ConciliacionFilters {
  rol?: string; from?: string; to?: string; emisor_rfc?: string;
  limit?: number; offset?: number;
}

/** Umbral de días tras el cual una PPD sin REP se considera vencida (REP debe
 *  emitirse a más tardar el día 5 del mes siguiente al pago). */
const DIAS_REP_VENCIDO = 40;

/**
 * FISCAL.5.1 — Conciliación PUE/PPD ↔ REP (complementos de pago).
 *
 * Sobre fiscal.cfdis + fiscal.cfdi_payment_links (deterministas, sin LLM):
 *  - saldo insoluto por factura PPD = total − Σ ImpPagado de sus REP.
 *  - PPD sin ningún REP (riesgo de no deducibilidad / IVA no acreditable).
 * Empuja hallazgos a la bandeja de Maat vía FINANCE_FINDINGS_SINK_PORT.
 */
@Injectable()
export class ConciliacionService {
  private readonly logger = new Logger(ConciliacionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  /** Facturas PPD con pagos parciales y saldo pendiente. */
  async saldoInsoluto(f: ConciliacionFilters) {
    const limit = Math.min(Number(f.limit) || 100, 1000);
    return this.tk.run(async (trx) =>
      this.ppdBase(trx, f).havingRaw('c.total - COALESCE(SUM(l.imp_pagado),0) > 0.01')
        .orderByRaw('c.total - COALESCE(SUM(l.imp_pagado),0) DESC').limit(limit).offset(Number(f.offset) || 0));
  }

  /** Facturas PPD sin ningún complemento de pago (REP). */
  async ppdSinRep(f: ConciliacionFilters) {
    const limit = Math.min(Number(f.limit) || 100, 1000);
    return this.tk.run(async (trx) =>
      this.ppdBase(trx, f).havingRaw('COUNT(l.id) = 0')
        .orderBy('c.fecha', 'asc').limit(limit).offset(Number(f.offset) || 0));
  }

  /** Resumen de conciliación del rango. */
  async stats(f: ConciliacionFilters) {
    return this.tk.run(async (trx) => {
      const inner = this.ppdBase(trx, f).as('t');
      const [row] = await trx
        .select(
          trx.raw('COUNT(*)::int as ppd_total'),
          trx.raw('COUNT(*) FILTER (WHERE t.num_pagos = 0)::int as ppd_sin_rep'),
          trx.raw('COUNT(*) FILTER (WHERE t.saldo > 0.01)::int as con_saldo'),
          trx.raw('COALESCE(SUM(t.saldo),0) as saldo_total'),
          trx.raw('COALESCE(SUM(t.total),0) as monto_total'),
        )
        .from(inner);
      return {
        ppd_total: Number(row?.ppd_total ?? 0),
        ppd_sin_rep: Number(row?.ppd_sin_rep ?? 0),
        con_saldo: Number(row?.con_saldo ?? 0),
        saldo_total: Number(row?.saldo_total ?? 0),
        monto_total: Number(row?.monto_total ?? 0),
      };
    });
  }

  /** Escaneo del tenant actual → hallazgos a Maat (PPD sin REP + saldo insoluto vencido). */
  scanCurrent() {
    return this.scanForTenant(this.tenantCtx.requireTenantId());
  }

  async scanForTenant(tenantId: string): Promise<{ pushed: number; inserted: number; skipped: number }> {
    if (!this.sink) { this.logger.debug('FINANCE_FINDINGS_SINK_PORT no ligado — scan no-op.'); return { pushed: 0, inserted: 0, skipped: 0 }; }

    const rows = await this.tk.run(tenantId, async (trx) =>
      this.ppdBase(trx, {})
        .havingRaw(`c.fecha < (now() - interval '${DIAS_REP_VENCIDO} days') AND (COUNT(l.id) = 0 OR c.total - COALESCE(SUM(l.imp_pagado),0) > 0.01)`));

    const findings: FinanceFindingInput[] = [];
    const rules = new Map<string, FinanceRuleInput>();
    const rSinRep: FinanceRuleInput = { rule_key: 'ppd_sin_rep', nombre: 'Factura PPD sin complemento de pago (REP)', descripcion: 'CFDI con MetodoPago=PPD sin ningún REP que lo liquide; el SAT exige el complemento y sin él no procede la deducción/acreditamiento de IVA.', clase: 'riesgo' };
    const rSaldo: FinanceRuleInput = { rule_key: 'ppd_saldo_insoluto', nombre: 'Factura PPD con saldo insoluto', descripcion: 'CFDI PPD con pagos parciales pero saldo pendiente de liquidar/complementar.', clase: 'riesgo' };

    for (const r of rows as any[]) {
      const total = Number(r.total || 0), pagado = Number(r.pagado || 0), saldo = Number(r.saldo || 0);
      const sinRep = Number(r.num_pagos || 0) === 0;
      const rule = sinRep ? rSinRep : rSaldo;
      rules.set(rule.rule_key, rule);
      findings.push({
        rule_key: rule.rule_key,
        clase: 'riesgo',
        severity: sinRep ? 'warn' : 'info',
        score: sinRep ? 0.75 : 0.5,
        titulo: `${sinRep ? 'PPD sin REP' : 'PPD con saldo'} — ${r.emisor_nombre || r.emisor_rfc}`,
        resumen: `CFDI ${r.uuid} (${r.emisor_nombre || r.emisor_rfc}, ${this.money(total)}) PPD ${sinRep ? 'sin ningún complemento de pago' : `con saldo insoluto de ${this.money(saldo)} (pagado ${this.money(pagado)})`}. Emitido ${this.ymd(r.fecha)}.`,
        entity: { uuid: r.uuid, emisor_rfc: r.emisor_rfc, receptor_rfc: r.receptor_rfc, rol: r.rol },
        periodo: this.ym(r.fecha),
        importe: sinRep ? total : saldo,
        evidencia: { total, pagado, saldo, num_pagos: Number(r.num_pagos || 0), fecha: r.fecha, fuente: 'fiscal.cfdi_payment_links' },
        dedup_key: `${rule.rule_key}|${r.uuid}`,
      });
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };
    const res = await this.sink.pushFindings(tenantId, findings, [...rules.values()]);
    this.logger.log(`conciliación tenant ${tenantId}: ${findings.length} hallazgos → Maat (${res.inserted} nuevos, ${res.skipped} omitidos).`);
    return { pushed: findings.length, ...res };
  }

  /** Query base: cada factura PPD (I/E) con su pagado/saldo/num_pagos. */
  private ppdBase(trx: Knex, f: ConciliacionFilters) {
    return trx('fiscal.cfdis as c')
      .leftJoin('fiscal.cfdi_payment_links as l', (j) => {
        j.on('l.tenant_id', 'c.tenant_id').andOn('l.docto_uuid', 'c.uuid');
      })
      .where('c.metodo_pago', 'PPD')
      .whereIn('c.tipo_comprobante', ['I', 'E'])
      .modify((b) => {
        if (f.rol) b.where('c.rol', f.rol);
        if (f.from) b.where('c.fecha', '>=', f.from);
        if (f.to) b.where('c.fecha', '<=', `${f.to} 23:59:59`);
        if (f.emisor_rfc) b.where('c.emisor_rfc', f.emisor_rfc.toUpperCase());
      })
      .groupBy('c.id', 'c.uuid', 'c.emisor_rfc', 'c.emisor_nombre', 'c.receptor_rfc', 'c.rol', 'c.fecha', 'c.total', 'c.moneda')
      .select(
        'c.uuid', 'c.emisor_rfc', 'c.emisor_nombre', 'c.receptor_rfc', 'c.rol', 'c.fecha', 'c.total', 'c.moneda',
        trx.raw('COALESCE(SUM(l.imp_pagado),0) as pagado'),
        trx.raw('c.total - COALESCE(SUM(l.imp_pagado),0) as saldo'),
        trx.raw('COUNT(l.id)::int as num_pagos'),
      );
  }

  private ym(v: unknown): string | null {
    if (v == null) return null;
    if (typeof v === 'string') return v.slice(0, 7);
    if (v instanceof Date && !isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
    return null;
  }
  private ymd(v: unknown): string {
    if (v == null) return '?';
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    return '?';
  }
  private money(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
  }
}
