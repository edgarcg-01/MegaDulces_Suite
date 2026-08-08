import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { ContactTrustEngineService } from './contact-trust-engine.service';

/**
 * FIQ.7 (ADR-037) — Refresh nocturno del trust-score de contactos.
 *
 * 2:30 AM MX (8:30 UTC), después del refresh de customer_360 (2 AM). Itera
 * tenants activos y, en scope CLS sintético (tenantCtx.run) para que RLS +
 * current_tenant_id() funcionen fuera de un request, recomputa el feature store
 * de todos los contactos que han chateado con el bot — enciende la señal
 * "solo juega" para quien nunca compra (no pasa por el gate de confirmar).
 *
 * No exponer por HTTP. Mismo patrón multi-tenant que Customer360RefreshService.
 */
@Injectable()
export class ContactTrustCronService {
  private readonly logger = new Logger(ContactTrustCronService.name);
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly engine: ContactTrustEngineService,
  ) {}

  @Cron('0 30 2 * * *', { timeZone: 'America/Mexico_City' }) // 2:30 AM MX
  async scheduledScan(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skip: previous contact-trust scan still running');
      return;
    }
    this.isRunning = true;
    const start = Date.now();
    let scanned = 0;
    let tenants = 0;
    let errors = 0;
    try {
      const rows = await this.knex('public.tenants').where({ activo: true }).select('id');
      tenants = rows.length;
      for (const t of rows) {
        try {
          const r = await new Promise<{ scanned: number }>((resolve, reject) => {
            this.tenantCtx.run({ tenantId: t.id }, async () => {
              try {
                resolve(await this.engine.scanTenant());
              } catch (e) {
                reject(e);
              }
            });
          });
          scanned += r.scanned;
        } catch (e: any) {
          errors++;
          this.logger.error(`contact-trust scan tenant=${t.id} falló: ${e.message}`);
        }
      }
      this.logger.log(`contact-trust scan: ${scanned} contactos en ${tenants} tenants (${errors} errores) ${Date.now() - start}ms`);
    } finally {
      this.isRunning = false;
    }
  }
}
