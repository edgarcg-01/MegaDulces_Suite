import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';
import { SAT_ESTATUS_PORT, SatEstatusPort } from './sat-estatus.port';

/** Revisa de nuevo un CFDI ya consultado tras estos días (el emisor puede cancelar después). */
const REVISAR_TRAS_DIAS = 30;
/** Tope por corrida: a ~0.25 s por CFDI (WS ~0.1 s + 150 ms de cortesía), 5,000 son ~21 min. */
const MAX_POR_CORRIDA = 5000;

export interface VerificacionUuids {
  consultados: number;
  vigentes: number;
  cancelados: number;
  /** El SAT no lo encontró: queda `desconocido`, que NO es vigente. */
  no_encontrados: number;
  /** El WS falló o no respondió: tampoco se sabe nada. */
  fallidos: number;
  /** false = el puerto del SAT no está ligado; nada se consultó. */
  disponible: boolean;
}

interface CfdiPorConsultar {
  uuid: string; emisor_rfc: string; receptor_rfc: string; emisor_nombre: string | null;
  total: string | number; fecha: string | Date | null; rol: string | null; estatus_sat: string | null;
}

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

  /**
   * Consulta el estatus de los CFDI pendientes/vencidos de un tenant.
   *
   * [LC.19.1] Orden: primero lo que nunca se supo (`desconocido`), y de eso los RECIBIDOS —son
   * los que se acreditan; un emitido cancelado lo cancelamos nosotros y ya lo sabemos—. Antes
   * era sólo `fecha desc` con 300 por noche: medido el 2026-10-21, 8,498 recibidos de los
   * últimos 6 meses sin verificar, o sea que la cola no se vaciaba nunca.
   */
  async checkForTenant(tenantId: string, limit = 200): Promise<{ checked: number; cancelados: number; vigentes: number }> {
    if (!this.sat) { this.logger.debug('SAT_ESTATUS_PORT no ligado — no-op.'); return { checked: 0, cancelados: 0, vigentes: 0 }; }

    const rows = await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis')
        .where((w) => w.where('estatus_sat', 'desconocido')
          .orWhere('estatus_checked_at', '<', new Date(Date.now() - REVISAR_TRAS_DIAS * 86_400_000).toISOString()))
        .whereNotNull('emisor_rfc').whereNotNull('receptor_rfc').whereNotNull('total')
        .orderByRaw(`(estatus_sat = 'desconocido') DESC, (rol = 'recibidas') DESC, fecha DESC`)
        .limit(Math.min(limit, MAX_POR_CORRIDA))
        .select('uuid', 'emisor_rfc', 'receptor_rfc', 'emisor_nombre', 'total', 'fecha', 'rol', 'estatus_sat'));

    const r = await this.consultarFilas(tenantId, rows, this.sat);
    this.logger.log(`estatus tenant ${tenantId}: ${rows.length} consultados · ${r.cancelados} cancelados · ${r.vigentes} vigentes.`);
    return { checked: rows.length, cancelados: r.cancelados, vigentes: r.vigentes };
  }

  /**
   * [LC.19.1] Verifica AHORA una lista concreta de CFDI (los que van a una póliza). Lo usa el
   * libro de compras antes de generar: no espera al cron de la madrugada para las facturas que
   * llegaron en el día. `no_encontrados` y `fallidos` se cuentan aparte — ninguno de los dos
   * es «vigente», y confundirlos con eso es justo el defecto que esto cierra.
   */
  async verificarUuids(tenantId: string, uuids: string[]): Promise<VerificacionUuids> {
    const vacio: VerificacionUuids = { consultados: 0, vigentes: 0, cancelados: 0, no_encontrados: 0, fallidos: 0, disponible: !!this.sat };
    if (!this.sat || !uuids.length) return vacio;
    const rows = await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis')
        .whereIn('uuid', uuids.slice(0, MAX_POR_CORRIDA))
        .whereNotNull('emisor_rfc').whereNotNull('receptor_rfc').whereNotNull('total')
        .select('uuid', 'emisor_rfc', 'receptor_rfc', 'emisor_nombre', 'total', 'fecha', 'rol', 'estatus_sat'));
    return { ...(await this.consultarFilas(tenantId, rows, this.sat)), consultados: rows.length, disponible: true };
  }

  private async consultarFilas(tenantId: string, rows: CfdiPorConsultar[], sat: SatEstatusPort): Promise<Omit<VerificacionUuids, 'consultados' | 'disponible'>> {
    let cancelados = 0, vigentes = 0, no_encontrados = 0, fallidos = 0;
    const cancelledNew: CfdiPorConsultar[] = [];
    for (const c of rows) {
      let estado: string;
      try {
        const r = await sat.consulta({ re: c.emisor_rfc, rr: c.receptor_rfc, tt: this.fmtTotal(c.total), id: c.uuid });
        estado = this.mapEstado(r.estado);
      } catch (e: unknown) {
        this.logger.warn(`consulta estatus ${c.uuid} falló: ${e instanceof Error ? e.message : String(e)}`);
        fallidos++;
        continue;
      }
      await this.tk.run(tenantId, async (trx) =>
        trx('fiscal.cfdis').where({ uuid: c.uuid }).update({ estatus_sat: estado, estatus_checked_at: trx.fn.now(), updated_at: trx.fn.now() }));
      if (estado === 'cancelado') { cancelados++; if (c.estatus_sat !== 'cancelado' && c.rol === 'recibidas') cancelledNew.push(c); }
      else if (estado === 'vigente') vigentes++;
      else no_encontrados++;
      await this.sleep(150); // cortesía con el WS del SAT
    }
    if (cancelledNew.length) await this.pushCancelledFindings(tenantId, cancelledNew);
    return { cancelados, vigentes, no_encontrados, fallidos };
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
