import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { Execution360Service } from './execution-360.service';
import { FindingsEngineService } from './findings-engine.service';
import { SupervisorActionsService } from './supervisor-actions.service';
import { OpportunityEngineService } from './opportunity-engine.service';
import { PhotoAuditService } from './photo-audit.service';
import { FraudEngineService } from './fraud-engine.service';
import { ScoringEngineService } from './scoring-engine.service';
import { SalesExecutionService } from './sales-execution.service';
import { RuleCalibrationService } from './rule-calibration.service';

/**
 * Horus — orquestador del refresh del feature store (Sprint Horus.0).
 *
 * Cron nocturno + on-demand. Itera todos los tenants activos y recomputa
 * commercial.execution_360 por cada uno. Usa KNEX_CONNECTION (superuser, bypassa
 * RLS) para leer la lista de tenants y delegar el cómputo cross-tenant — no se
 * necesita scope sintético porque el superuser ve todo y el cómputo filtra
 * tenant_id explícito. Flag isRunning + try/finally para no solapar corridas ni
 * crashear el boot.
 */
@Injectable()
export class ExecutionRefreshService {
  private readonly logger = new Logger(ExecutionRefreshService.name);
  private isRunning = false;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly exec360: Execution360Service,
    private readonly findings: FindingsEngineService,
    private readonly actions: SupervisorActionsService,
    private readonly opportunities: OpportunityEngineService,
    private readonly photoAudit: PhotoAuditService,
    private readonly fraud: FraudEngineService,
    private readonly scoring: ScoringEngineService,
    private readonly salesExec: SalesExecutionService,
    private readonly ruleCalibration: RuleCalibrationService,
  ) {}

  // 08:30 UTC = 02:30 America/Mexico_City (después del refresh de Customer360 a las 08:00 UTC).
  @Cron('0 30 8 * * *')
  async scheduledRefresh(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('execution_360 refresh: corrida previa en curso, skip');
      return;
    }
    await this.refreshAllTenants('cron');
  }

  async refreshAllTenants(source: 'cron' | 'manual'): Promise<{
    tenants: number;
    rows_upserted: number;
    findings_open: number;
    errors: number;
    elapsed_ms: number;
  }> {
    this.isRunning = true;
    const start = Date.now();
    let tenantsProcessed = 0;
    let rowsUpserted = 0;
    let findingsOpen = 0;
    let errors = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          const r = await this.exec360.computeForTenant(t.id);
          rowsUpserted += r.rows_upserted;
          // L2 (ADR-021): recalibra la precisión de las reglas (desde el juicio humano
          // acumulado) ANTES de emitir → el motor suprime/capa las ruidosas en esta corrida.
          await this.ruleCalibration.computeForTenant(t.id);
          // Motor de findings sobre el feature store recién computado (Horus.1).
          const f = await this.findings.generateForTenant(t.id);
          findingsOpen += f.open;
          await this.fraud.generateForTenant(t.id); // determinista, sin LLM
          // Visión acotada nocturna (H2.2): analiza un lote de fotos nuevas y
          // emite findings de visión; el co-piloto los incorpora abajo.
          await this.photoAudit.scanForTenant(t.id, { max: 20 });
          await this.photoAudit.generateVisionFindings(t.id);
          await this.actions.proposeForTenant(t.id);
          await this.opportunities.generateForTenant(t.id);
          await this.scoring.scoreForTenant(t.id); // motor multi-señal (usa findings+fraude)
          await this.salesExec.generateGapFindings(t.id); // venta↔ejecución (gateado por volumen)
          await this.exec360.snapshotForTenant(t.id); // último: snapshot diario append-only (histórico)
          tenantsProcessed++;
        } catch (e: any) {
          errors++;
          this.logger.error(`execution_360 refresh tenant=${t.id} falló: ${e.message}`);
        }
      }
      const elapsed = Date.now() - start;
      this.logger.log(
        `execution_360 refresh (${source}): ${tenantsProcessed} tenants, ${rowsUpserted} rows, ${findingsOpen} findings, ${errors} errores, ${elapsed}ms`,
      );
      return {
        tenants: tenantsProcessed,
        rows_upserted: rowsUpserted,
        findings_open: findingsOpen,
        errors,
        elapsed_ms: elapsed,
      };
    } finally {
      this.isRunning = false;
    }
  }
}
