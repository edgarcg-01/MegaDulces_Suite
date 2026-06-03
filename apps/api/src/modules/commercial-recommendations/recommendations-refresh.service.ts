import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { RecommendationsService } from './recommendations.service';

/**
 * Refresh nightly de las canastas estratégicas.
 *
 * Schedule: 3 AM TZ MX (servidor en UTC suma 6h → '0 9 * * *' UTC ~ 3 AM MX
 * en horario estándar; en DST esto se corre 4 AM, aceptable).
 *
 * Itera todos los customers activos del tenant y recomputa cada uno.
 * Si crece la cantidad, dividir en batches o mover a BullMQ job queue.
 */
@Injectable()
export class RecommendationsRefreshService {
  private readonly logger = new Logger(RecommendationsRefreshService.name);
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly recommendations: RecommendationsService,
  ) {}

  @Cron('0 0 9 * * *') // 9 AM UTC = 3 AM MX
  async scheduledRefresh(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skip: previous refresh still running');
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
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      tenantsProcessed = tenants.length;
      for (const t of tenants) {
        // Lista de customers del tenant. Como app_runtime no necesita RLS para
        // SELECT en commercial.customers (filter by tenant_id explícito), usamos
        // query directa con setear app.tenant_id via SET LOCAL en una tx.
        const customers: Array<{ id: string }> = await (this.knex.transaction(async (trx) => {
          await trx.raw(`SET LOCAL app.tenant_id = '${t.id}'`);
          const rows = await trx('commercial.customers')
            .where({ active: true })
            .whereNull('deleted_at')
            .select('id');
          return rows;
        }) as any);
        for (const c of customers) {
          try {
            // El service espera tenant context CLS. Como en cron no hay
            // request handler, abrimos scope ad-hoc via TenantContextService.run().
            await this.computeWithTenantContext(t.id, c.id);
            customersRefreshed++;
          } catch (e: any) {
            errors++;
            this.logger.error(
              `Refresh customer=${c.id} tenant=${t.id} failed: ${e.message}`,
            );
          }
        }
      }
      const elapsedMs = Date.now() - start;
      this.logger.log(
        `Refresh completed: ${customersRefreshed} customers (${errors} errors) en ${elapsedMs}ms`,
      );
      return { tenants: tenantsProcessed, customers_refreshed: customersRefreshed, errors, elapsed_ms: elapsedMs };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Helper que abre scope CLS sintético para que computeForCustomer funcione
   * fuera de un request HTTP.
   */
  private async computeWithTenantContext(tenantId: string, customerId: string): Promise<void> {
    // Acceso al storage del TenantContextService via "any" — soluciona el
    // case del cron donde no hay request handler.
    const ctxSvc: any = (this.recommendations as any).tenantCtx;
    if (!ctxSvc?.run) {
      // Sin TenantContextService disponible — directo
      await this.recommendations.computeForCustomer(customerId);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      ctxSvc.run({ tenantId }, async () => {
        try {
          await this.recommendations.computeForCustomer(customerId);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}
