import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

export interface CruceFilters { from?: string; to?: string; rfc?: string; limit?: number; offset?: number; }

/** Tolerancias del match heurístico (Kepler no guarda el UUID del CFDI → no hay
 *  JOIN exacto; se casa por RFC + importe ± tolerancia + fecha ± ventana). */
const TOL_IMPORTE = 1.0;   // pesos (redondeo entre CFDI total y póliza importe)
const VENTANA_DIAS = 5;    // fecha CFDI vs fecha contable

/**
 * FISCAL.5.2 — Conciliación CFDI ↔ póliza contable (heurística).
 *
 * Kepler NO almacena el folio fiscal (verificado: kdfecfd/kdcecfdpol/kdfecedocuuid
 * vacías en las 6 sucursales; kdm1 sin UUID). Por eso el cruce es heurístico:
 * casa `fiscal.cfdis` (recibidas, de la descarga masiva) contra
 * `analytics.expense_documents` (pólizas Kepler) por RFC + importe + fecha.
 *
 *  - CFDI sin póliza: tenemos el comprobante pero no está registrado el gasto.
 *  - Póliza sin CFDI: gasto/deducción registrado sin CFDI que lo respalde
 *    (riesgo SAT), SOLO dentro de periodos con cobertura de descarga (si no,
 *    todo gasto se vería sin comprobante hasta correr la descarga masiva).
 *
 * `analytics.expense_documents` NO tiene RLS → filtro de tenant explícito.
 * `fiscal.*` sí (tk.run fija el scope). Empuja hallazgos a Maat.
 */
@Injectable()
export class PolizaCruceService {
  private readonly logger = new Logger(PolizaCruceService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  /** CFDI recibidos (I/E) sin póliza que los registre. Siempre en alcance. */
  async cfdiSinPoliza(f: CruceFilters) {
    const tid = this.tenantCtx.requireTenantId();
    const limit = Math.min(Number(f.limit) || 100, 1000);
    return this.tk.run(async (trx) => {
      const r = await trx.raw(
        `SELECT c.uuid, c.emisor_rfc, c.emisor_nombre, c.fecha, c.total, c.metodo_pago
           FROM fiscal.cfdis c
          WHERE c.rol = 'recibidas' AND c.tipo_comprobante IN ('I','E')
            AND c.estatus_sat <> 'cancelado'
            ${f.from ? 'AND c.fecha >= :from' : ''}
            ${f.to ? 'AND c.fecha <= :toEnd' : ''}
            ${f.rfc ? 'AND c.emisor_rfc = :rfc' : ''}
            AND NOT EXISTS (
              SELECT 1 FROM analytics.expense_documents e
               WHERE e.tenant_id = :tid
                 AND UPPER(e.rfc) = c.emisor_rfc
                 AND abs(COALESCE(e.importe,0) - COALESCE(c.total,0)) <= :tol
                 AND e.fecha BETWEEN (c.fecha::date - :dias) AND (c.fecha::date + :dias)
            )
          ORDER BY c.fecha DESC
          LIMIT :limit OFFSET :offset`,
        { tid, tol: TOL_IMPORTE, dias: VENTANA_DIAS, limit, offset: Number(f.offset) || 0,
          from: f.from ?? null, toEnd: f.to ? `${f.to} 23:59:59` : null, rfc: f.rfc ? f.rfc.toUpperCase() : null },
      );
      return r.rows;
    });
  }

  /** Pólizas de gasto con RFC de proveedor, dentro de cobertura de descarga, sin CFDI. */
  async polizaSinCfdi(f: CruceFilters) {
    const tid = this.tenantCtx.requireTenantId();
    const limit = Math.min(Number(f.limit) || 100, 1000);
    return this.tk.run(async (trx) => {
      const r = await trx.raw(
        `SELECT e.sucursal, e.doc_tipo, e.doc_folio, e.rfc, e.beneficiario, e.fecha, e.importe
           FROM analytics.expense_documents e
          WHERE e.tenant_id = :tid AND e.rfc IS NOT NULL AND e.rfc <> ''
            ${f.from ? 'AND e.fecha >= :from' : ''}
            ${f.to ? 'AND e.fecha <= :to' : ''}
            ${f.rfc ? 'AND UPPER(e.rfc) = :rfc' : ''}
            AND EXISTS (
              SELECT 1 FROM fiscal.download_requests d
               WHERE d.estado = 'descargada' AND d.rol = 'recibidas'
                 AND e.fecha BETWEEN d.fecha_ini AND d.fecha_fin
            )
            AND NOT EXISTS (
              SELECT 1 FROM fiscal.cfdis c
               WHERE c.rol = 'recibidas' AND c.estatus_sat <> 'cancelado'
                 AND c.emisor_rfc = UPPER(e.rfc)
                 AND abs(COALESCE(c.total,0) - COALESCE(e.importe,0)) <= :tol
                 AND c.fecha::date BETWEEN (e.fecha - :dias) AND (e.fecha + :dias)
            )
          ORDER BY e.importe DESC
          LIMIT :limit OFFSET :offset`,
        { tid, tol: TOL_IMPORTE, dias: VENTANA_DIAS, limit, offset: Number(f.offset) || 0,
          from: f.from ?? null, to: f.to ?? null, rfc: f.rfc ? f.rfc.toUpperCase() : null },
      );
      return r.rows;
    });
  }

  async stats(f: CruceFilters) {
    const [sinPol, sinCfdi] = await Promise.all([
      this.cfdiSinPoliza({ ...f, limit: 100000 }),
      this.polizaSinCfdi({ ...f, limit: 100000 }),
    ]);
    const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    return {
      cfdi_sin_poliza: sinPol.length, cfdi_sin_poliza_monto: sum(sinPol, 'total'),
      poliza_sin_cfdi: sinCfdi.length, poliza_sin_cfdi_monto: sum(sinCfdi, 'importe'),
    };
  }

  scanCurrent() { return this.scanForTenant(this.tenantCtx.requireTenantId()); }

  async scanForTenant(tenantId: string): Promise<{ pushed: number; inserted: number; skipped: number }> {
    if (!this.sink) { this.logger.debug('FINANCE_FINDINGS_SINK_PORT no ligado — cruce no-op.'); return { pushed: 0, inserted: 0, skipped: 0 }; }

    // Ejecutar bajo el scope del tenant (las queries usan tenantCtx.requireTenantId()).
    const { sinCfdi, sinPol } = await this.tenantCtx.run({ tenantId }, async () => ({
      sinCfdi: await this.polizaSinCfdi({ limit: 5000 }),
      sinPol: await this.cfdiSinPoliza({ limit: 5000 }),
    }));

    const findings: FinanceFindingInput[] = [];
    const rules = new Map<string, FinanceRuleInput>();
    const rPol: FinanceRuleInput = { rule_key: 'poliza_sin_cfdi', nombre: 'Gasto registrado sin CFDI', descripcion: 'Póliza de gasto/compra con RFC de proveedor, dentro de un periodo con descarga de CFDI, sin comprobante que la respalde: riesgo de deducción sin soporte fiscal.', clase: 'riesgo' };
    const rCfdi: FinanceRuleInput = { rule_key: 'cfdi_sin_poliza', nombre: 'CFDI recibido sin registrar', descripcion: 'CFDI recibido de un proveedor que no aparece registrado como gasto/compra en la contabilidad (posible gasto no contabilizado).', clase: 'error_captura' };

    for (const e of sinCfdi as any[]) {
      rules.set(rPol.rule_key, rPol);
      const importe = Number(e.importe || 0);
      findings.push({
        rule_key: rPol.rule_key, clase: 'riesgo', severity: importe >= 10000 ? 'warn' : 'info', score: 0.7,
        titulo: `Gasto sin CFDI — ${e.beneficiario || e.rfc}`,
        resumen: `Póliza ${e.sucursal}/${e.doc_tipo}/${e.doc_folio} (${e.beneficiario || e.rfc}, ${this.money(importe)}, ${this.ymd(e.fecha)}) sin CFDI que la respalde dentro del periodo descargado.`,
        entity: { rfc: e.rfc, sucursal: e.sucursal, doc_tipo: e.doc_tipo, doc_folio: e.doc_folio },
        periodo: this.ym(e.fecha), importe,
        evidencia: { beneficiario: e.beneficiario, fecha: e.fecha, fuente: 'analytics.expense_documents', match: 'rfc+importe+fecha' },
        dedup_key: `poliza_sin_cfdi|${e.sucursal}|${e.doc_tipo}|${e.doc_folio}`,
      });
    }
    for (const c of sinPol as any[]) {
      rules.set(rCfdi.rule_key, rCfdi);
      const importe = Number(c.total || 0);
      findings.push({
        rule_key: rCfdi.rule_key, clase: 'error_captura', severity: 'info', score: 0.5,
        titulo: `CFDI sin registrar — ${c.emisor_nombre || c.emisor_rfc}`,
        resumen: `CFDI ${c.uuid} (${c.emisor_nombre || c.emisor_rfc}, ${this.money(importe)}, ${this.ymd(c.fecha)}) sin póliza de gasto que lo registre.`,
        entity: { uuid: c.uuid, emisor_rfc: c.emisor_rfc },
        periodo: this.ym(c.fecha), importe,
        evidencia: { fecha: c.fecha, metodo_pago: c.metodo_pago, fuente: 'fiscal.cfdis', match: 'rfc+importe+fecha' },
        dedup_key: `cfdi_sin_poliza|${c.uuid}`,
      });
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };
    const res = await this.sink.pushFindings(tenantId, findings, [...rules.values()]);
    this.logger.log(`cruce póliza tenant ${tenantId}: ${findings.length} hallazgos → Maat (${res.inserted} nuevos).`);
    return { pushed: findings.length, ...res };
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
