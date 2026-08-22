import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

/**
 * CXC.7 (ADR-048/028) — Detector de riesgo de cartera. Empuja hallazgos a la bandeja
 * unificada de Maat (`finance.findings`, vía FINANCE_FINDINGS_SINK_PORT) → se ven en
 * /finanzas/hallazgos. El motor detecta / el humano cobra (ADR-016). Read-only.
 *
 *   cxc_cliente_vencido = cliente con saldo VENCIDO material (aging por vencimiento kdue)
 *   cxc_sobre_limite     = saldo > límite de crédito (kdud.c15)
 *
 * Corre como postgres (KNEX_NEW_DB) con SET LOCAL app.tenant_id por tenant. Idempotente
 * (dedup_key por cliente). Toggle ENABLE_CXC_SCAN=false; endpoint /scan-now manual.
 */
const RULES: FinanceRuleInput[] = [
  { rule_key: 'cxc_cliente_vencido', nombre: 'Cliente con saldo vencido', descripcion: 'Cartera vencida material por cliente (aging kdue).', clase: 'riesgo', params: { min_vencido: 2000 } },
  { rule_key: 'cxc_sobre_limite', nombre: 'Cliente sobre su línea de crédito', descripcion: 'Saldo supera el límite de crédito de Kepler (kdud.c15).', clase: 'riesgo', params: {} },
];
const MIN_VENCIDO = 2000;    // pesos: piso para no ahogar la bandeja
const CRIT_VENCIDO = 20000;  // pesos: vencido crítico
const CRIT_DIAS = 60;        // días vencido crítico

@Injectable()
export class CustomerReceivablesScannerService {
  private readonly logger = new Logger(CustomerReceivablesScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  @Cron('0 30 8 * * *', { timeZone: 'America/Mexico_City' }) // 08:30 MX
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_CXC_SCAN === 'false') return;
    if (this.running) { this.logger.warn('Skip: scan en curso'); return; }
    await this.scanAll(); // snapshot siempre; findings solo si hay sink
  }

  async scanAll(): Promise<{ tenants: number; findings: number }> {
    this.running = true;
    let total = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        await this.snapshotTenant(t.id).catch((e) => this.logger.warn(`snapshot ${t.id}: ${e.message}`));
        if (this.sink) total += await this.scanTenant(t.id);
      }
      this.logger.log(`CxC scan: ${tenants.length} tenants, ${total} hallazgos + snapshots`);
      return { tenants: tenants.length, findings: total };
    } finally { this.running = false; }
  }

  /** CXC.12 — captura el agregado de HOY (tenant × sucursal) para la tendencia. Idempotente por día. */
  async snapshotTenant(tenantId: string): Promise<number> {
    return this.knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const res = await trx.raw(
        `INSERT INTO analytics.customer_receivable_snapshots
           (tenant_id, snapshot_date, sucursal, saldo_total, vencido_total, n_clientes, por_vencer, d0_30, d31_60, d61_90, d90_plus, computed_at)
         SELECT ?::uuid, h.d, r.sucursal,
           COALESCE(round(sum(r.saldo_documento), 2), 0),
           COALESCE(round(sum(r.saldo_documento) FILTER (WHERE r.vencimiento < h.d), 2), 0),
           count(DISTINCT r.cliente_code),
           COALESCE(round(sum(r.saldo_documento) FILTER (WHERE r.vencimiento IS NULL OR r.vencimiento >= h.d), 2), 0),
           COALESCE(round(sum(r.saldo_documento) FILTER (WHERE r.vencimiento < h.d AND h.d - r.vencimiento <= 30), 2), 0),
           COALESCE(round(sum(r.saldo_documento) FILTER (WHERE h.d - r.vencimiento BETWEEN 31 AND 60), 2), 0),
           COALESCE(round(sum(r.saldo_documento) FILTER (WHERE h.d - r.vencimiento BETWEEN 61 AND 90), 2), 0),
           COALESCE(round(sum(r.saldo_documento) FILTER (WHERE h.d - r.vencimiento > 90), 2), 0),
           now()
         FROM analytics.customer_receivables r
         CROSS JOIN (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date d) h
         WHERE r.tenant_id = ?::uuid AND r.cargo_abono = 'C' AND r.saldo_documento > 0.005
         GROUP BY h.d, r.sucursal
         ON CONFLICT (tenant_id, snapshot_date, sucursal) DO UPDATE SET
           saldo_total=EXCLUDED.saldo_total, vencido_total=EXCLUDED.vencido_total, n_clientes=EXCLUDED.n_clientes,
           por_vencer=EXCLUDED.por_vencer, d0_30=EXCLUDED.d0_30, d31_60=EXCLUDED.d31_60, d61_90=EXCLUDED.d61_90,
           d90_plus=EXCLUDED.d90_plus, computed_at=now()`,
        [tenantId, tenantId]);
      return res.rowCount ?? 0;
    });
  }

  async scanTenant(tenantId: string): Promise<number> {
    if (!this.sink) return 0;
    const rows = await this.knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const hoy = (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text d`)).rows[0].d;
      const r = await trx.raw(
        `SELECT r.sucursal, r.cliente_code, max(c.name) AS nombre, max(r.telefono) AS tel,
                max(r.limite_credito) AS limite, max(r.vendedor) AS vendedor, max(r.zona) AS zona,
                round(sum(r.saldo_documento), 2) AS saldo,
                round(sum(r.saldo_documento) FILTER (WHERE r.vencimiento < ?::date), 2) AS vencido,
                (min(r.vencimiento) FILTER (WHERE r.saldo_documento > 0.005 AND r.vencimiento < ?::date))::text AS oldest
           FROM analytics.customer_receivables r
           LEFT JOIN analytics.erp_customers c ON c.tenant_id = r.tenant_id AND c.erp_code = r.cliente_code
          WHERE r.tenant_id = ? AND r.cargo_abono = 'C'
            AND r.cliente_code NOT ILIKE '%CONTADO%'
            AND COALESCE(c.name, '') NOT ILIKE '%CONTADO%'
          GROUP BY r.sucursal, r.cliente_code
         HAVING sum(r.saldo_documento) > 0.005`,
        [hoy, hoy, tenantId]);
      return { hoy, data: r.rows };
    });

    const findings: FinanceFindingInput[] = [];
    for (const x of rows.data) {
      const saldo = Number(x.saldo) || 0;
      const vencido = Number(x.vencido) || 0;
      const limite = x.limite != null ? Number(x.limite) : 0;
      const nombre = x.nombre || x.cliente_code;
      const ent = { sucursal: x.sucursal, cliente_code: x.cliente_code, nombre, vendedor: x.vendedor, zona: x.zona, telefono: x.tel };
      // Regla 1: vencido material.
      if (vencido >= MIN_VENCIDO) {
        const dias = x.oldest ? Math.floor((Date.parse(rows.hoy) - Date.parse(String(x.oldest).slice(0, 10))) / 86400000) : 0;
        const crit = vencido >= CRIT_VENCIDO || dias >= CRIT_DIAS;
        findings.push({
          rule_key: 'cxc_cliente_vencido', clase: 'riesgo', severity: crit ? 'critical' : 'warn',
          score: Math.min(1, vencido / 100000),
          titulo: `${nombre}: ${this.mx(vencido)} vencido${dias ? ` (${dias}d)` : ''}`,
          resumen: `Sucursal ${x.sucursal}. Saldo ${this.mx(saldo)}, de los cuales ${this.mx(vencido)} está vencido${dias ? ` (la más vieja tiene ${dias} días)` : ''}.` + (x.tel ? ` Tel ${x.tel}.` : ''),
          entity: ent, periodo: null, importe: vencido,
          evidencia: { saldo, vencido, dias_max: dias, vendedor: x.vendedor },
          dedup_key: `cxc_vencido:${x.sucursal}:${x.cliente_code}`,
        });
      }
      // Regla 2: sobre su línea de crédito.
      if (limite > 0 && saldo > limite + 0.005) {
        const exceso = Math.round((saldo - limite) * 100) / 100;
        findings.push({
          rule_key: 'cxc_sobre_limite', clase: 'riesgo', severity: exceso > limite * 0.5 ? 'critical' : 'warn',
          score: Math.min(1, exceso / Math.max(limite, 1)),
          titulo: `${nombre}: sobre su línea (${this.mx(exceso)} de exceso)`,
          resumen: `Sucursal ${x.sucursal}. Saldo ${this.mx(saldo)} supera el límite de ${this.mx(limite)} en ${this.mx(exceso)}. Revisar antes de vender más a crédito.`,
          entity: ent, periodo: null, importe: exceso,
          evidencia: { saldo, limite, exceso, vendedor: x.vendedor },
          dedup_key: `cxc_sobrelimite:${x.sucursal}:${x.cliente_code}`,
        });
      }
    }
    if (!findings.length) return 0;
    const res = await this.sink.pushFindings(tenantId, findings, RULES);
    return res.inserted;
  }

  private mx(v: number) { return `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`; }
}
