import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';
import { SAT_ESTATUS_PORT, SatEstatusPort } from './sat-estatus.port';

/** Revisa de nuevo un CFDI ya consultado tras estos días (el emisor puede cancelar después). */
const REVISAR_TRAS_DIAS = 30;

/**
 * FISCAL.6 — Validación de estatus de CFDI ante el SAT (vigente/cancelado).
 *
 * Consulta ConsultaCFDIService por lote y actualiza fiscal.cfdis.estatus_sat +
 * estatus_checked_at. Un CFDI recibido CANCELADO que sigue deducido/acreditado es
 * un riesgo SAT → hallazgo a Maat. Throttle entre llamadas. RLS vía tk.run.
 */
@Injectable()
export class EstatusService {
  private readonly logger = new Logger(EstatusService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(SAT_ESTATUS_PORT) private readonly sat?: SatEstatusPort,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  checkCurrent(limit = 200) { return this.checkForTenant(this.tenantCtx.requireTenantId(), limit); }

  /** Consulta el estatus de los CFDI pendientes/vencidos de un tenant. */
  async checkForTenant(tenantId: string, limit = 200): Promise<{ checked: number; cancelados: number; vigentes: number }> {
    if (!this.sat) { this.logger.debug('SAT_ESTATUS_PORT no ligado — no-op.'); return { checked: 0, cancelados: 0, vigentes: 0 }; }

    const rows = await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis')
        .where((w) => w.where('estatus_sat', 'desconocido')
          .orWhere('estatus_checked_at', '<', new Date(Date.now() - REVISAR_TRAS_DIAS * 86_400_000).toISOString()))
        .whereNotNull('emisor_rfc').whereNotNull('receptor_rfc').whereNotNull('total')
        .orderBy('fecha', 'desc').limit(Math.min(limit, 1000))
        .select('uuid', 'emisor_rfc', 'receptor_rfc', 'emisor_nombre', 'total', 'fecha', 'rol', 'estatus_sat'));

    let cancelados = 0, vigentes = 0;
    const cancelledNew: any[] = [];
    for (const c of rows) {
      let estado: string;
      try {
        const r = await this.sat.consulta({ re: c.emisor_rfc, rr: c.receptor_rfc, tt: this.fmtTotal(c.total), id: c.uuid });
        estado = this.mapEstado(r.estado);
      } catch (e: any) {
        this.logger.warn(`consulta estatus ${c.uuid} falló: ${e?.message || e}`);
        continue;
      }
      await this.tk.run(tenantId, async (trx) =>
        trx('fiscal.cfdis').where({ uuid: c.uuid }).update({ estatus_sat: estado, estatus_checked_at: trx.fn.now(), updated_at: trx.fn.now() }));
      if (estado === 'cancelado') { cancelados++; if (c.estatus_sat !== 'cancelado' && c.rol === 'recibidas') cancelledNew.push(c); }
      else if (estado === 'vigente') vigentes++;
      await this.sleep(150); // cortesía con el WS del SAT
    }

    if (cancelledNew.length) await this.pushCancelledFindings(tenantId, cancelledNew);
    this.logger.log(`estatus tenant ${tenantId}: ${rows.length} consultados · ${cancelados} cancelados · ${vigentes} vigentes.`);
    return { checked: rows.length, cancelados, vigentes };
  }

  private async pushCancelledFindings(tenantId: string, rows: any[]) {
    if (!this.sink) return;
    const rule: FinanceRuleInput = { rule_key: 'cfdi_cancelado', nombre: 'CFDI recibido cancelado ante el SAT', descripcion: 'CFDI de proveedor que el SAT reporta como CANCELADO; si se dedujo/acreditó, debe revertirse (riesgo de deducción improcedente).', clase: 'riesgo' };
    const findings: FinanceFindingInput[] = rows.map((c) => ({
      rule_key: 'cfdi_cancelado', clase: 'riesgo', severity: 'critical', score: 0.9,
      titulo: `CFDI cancelado — ${c.emisor_nombre || c.emisor_rfc}`,
      resumen: `El CFDI ${c.uuid} (${c.emisor_nombre || c.emisor_rfc}, ${this.money(Number(c.total || 0))}) está CANCELADO ante el SAT. Si se dedujo/acreditó IVA, revertir.`,
      entity: { uuid: c.uuid, emisor_rfc: c.emisor_rfc },
      periodo: this.ym(c.fecha), importe: Number(c.total || 0),
      evidencia: { fecha: c.fecha, fuente: 'SAT ConsultaCFDIService' },
      dedup_key: `cfdi_cancelado|${c.uuid}`,
    }));
    const res = await this.sink.pushFindings(tenantId, findings, [rule]);
    this.logger.log(`estatus tenant ${tenantId}: ${findings.length} CFDI cancelados → Maat (${res.inserted} nuevos).`);
  }

  private mapEstado(e: string): string {
    const s = (e || '').toLowerCase();
    if (s.includes('cancel')) return 'cancelado';
    if (s.includes('vigente')) return 'vigente';
    return 'desconocido';
  }
  private fmtTotal(t: unknown): string {
    const n = Number(t); return Number.isFinite(n) ? n.toFixed(6) : String(t ?? '');
  }
  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
  private ym(v: unknown): string | null {
    if (v == null) return null;
    if (typeof v === 'string') return v.slice(0, 7);
    if (v instanceof Date && !isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
    return null;
  }
  private money(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
  }
}
