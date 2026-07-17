import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { CommercialOrdersService } from './commercial-orders.service';

/**
 * FE.13 — Cron de contingencia de facturación: reintenta la auto-factura de los
 * pedidos entregados que quedaron sin CFDI (PAC caído, o datos fiscales cargados
 * después de entregar). Idempotente por `cfdi_uuid`, acotado por intentos.
 *
 * DESACTIVADO por defecto — se prende con `ENABLE_INVOICE_RETRY=true`. Mismo criterio
 * que el cron de la factura global (FE.6): no timbrar comprobantes REALES en
 * automático hasta verificar la emisión en vivo. El endpoint manual
 * `POST /commercial/orders/retry-invoices` funciona siempre (corre en request).
 *
 * Corre como postgres user (KNEX_NEW_DB) solo para listar tenants; el reintento de
 * cada tenant se ejecuta dentro de un scope CLS sintético → `TenantKnexService`
 * respeta RLS con `SET LOCAL app.tenant_id`.
 */
@Injectable()
export class InvoiceRetryCronService {
  private readonly logger = new Logger(InvoiceRetryCronService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly orders: CommercialOrdersService,
  ) {}

  @Cron('0 30 * * * *') // cada hora, minuto 30
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_INVOICE_RETRY !== 'true') return;
    if (this.running) { this.logger.warn('Skip: reintento anterior aún corriendo'); return; }
    await this.runAllTenants();
  }

  async runAllTenants(): Promise<{ tenants: number; invoiced: number }> {
    this.running = true;
    let invoiced = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        const r = await this.tenantCtx.run({ tenantId: t.id, roleName: 'system' }, () =>
          this.orders.retryPendingInvoices());
        invoiced += r.invoiced;
      }
      if (invoiced) this.logger.log(`FE.13 cron: ${invoiced} facturados en ${tenants.length} tenants`);
      return { tenants: tenants.length, invoiced };
    } finally {
      this.running = false;
    }
  }
}
