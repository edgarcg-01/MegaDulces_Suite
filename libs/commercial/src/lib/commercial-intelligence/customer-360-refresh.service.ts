import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { Customer360Service } from './customer-360.service';
import { CommercialFindingsService } from './commercial-findings.service';
import { CommercialDiagnosisService } from './commercial-diagnosis.service';
import { CommercialActionsService } from './commercial-actions.service';
import { CommercialCalibrationService } from './commercial-calibration.service';

/**
 * Refresh nightly del feature store customer_360 (Fase M, Sprint M.0).
 *
 * Schedule: 2 AM MX (8 UTC), antes del arranque de ruta y del refresh de
 * canastas (3 AM MX). Itera tenants activos y recomputa cada uno con UN
 * solo UPSERT batch (no loop per-customer). Mismo patrón de scope CLS que
 * RecommendationsRefreshService.
 */
@Injectable()
export class Customer360RefreshService {
  private readonly logger = new Logger(Customer360RefreshService.name);
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly c360: Customer360Service,
    private readonly findings: CommercialFindingsService,
    private readonly diagnosis: CommercialDiagnosisService,
    private readonly actions: CommercialActionsService,
    private readonly calibration: CommercialCalibrationService,
  ) {}

  @Cron('0 0 8 * * *') // 8 AM UTC = 2 AM MX
  async scheduledRefresh(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skip: previous customer_360 refresh still running');
      return;
    }
    await this.refreshAllTenants();
  }

  async refreshAllTenants(): Promise<{
    tenants: number;
    customers_refreshed: number;
    errors: number;
    elapsed_ms: number;
  }> {
    this.isRunning = true;
    const start = Date.now();
    let customersRefreshed = 0;
    let errors = 0;
    let tenantsProcessed = 0;
    try {
      const tenants = await this.knex('public.tenants')
        .where({ activo: true })
        .select('id');
      tenantsProcessed = tenants.length;
      for (const t of tenants) {
        try {
          const r = await this.computeWithTenantContext(t.id);
          customersRefreshed += r.customers;
        } catch (e: any) {
          errors++;
          this.logger.error(
            `Refresh customer_360 tenant=${t.id} failed: ${e.message}`,
          );
        }
      }
      const elapsedMs = Date.now() - start;
      this.logger.log(
        `customer_360 refresh: ${customersRefreshed} customers en ${tenantsProcessed} tenants (${errors} errores) ${elapsedMs}ms`,
      );
      return {
        tenants: tenantsProcessed,
        customers_refreshed: customersRefreshed,
        errors,
        elapsed_ms: elapsedMs,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /** Abre scope CLS sintético para que computeForTenant() funcione fuera de un request. */
  private async computeWithTenantContext(
    tenantId: string,
  ): Promise<{ customers: number }> {
    const ctxSvc: any = (this.c360 as any).tenantCtx;
    if (!ctxSvc?.run) {
      return this.c360.computeForTenant();
    }
    return new Promise((resolve, reject) => {
      ctxSvc.run({ tenantId }, async () => {
        try {
          const r = await this.c360.computeForTenant();
          // T.R0/T.R1: findings comerciales + diagnóstico de causa raíz tras refrescar
          // customer_360. Best-effort: un fallo no debe romper el refresh del 360.
          try {
            await this.calibration.computeForTenant(); // T.L2: recalibra ANTES de emitir
            await this.findings.generateForTenant();
            await this.diagnosis.generateForTenant();
            await this.actions.proposeForTenant();
            await this.actions.runAutonomy(); // ADR-022: auto-ejecuta lo que el dial habilite (default OFF → no-op)
          } catch (e: any) {
            this.logger.warn(`commercial calib/findings/diagnoses/actions/autonomy tenant=${tenantId} falló: ${e.message}`);
          }
          resolve(r);
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}
