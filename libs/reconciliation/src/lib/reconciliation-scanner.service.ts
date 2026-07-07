import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { FINANCE_NOTIFIER_PORT, FinanceNotifierPort } from '@megadulces/contracts';
import { MovementReconcileService } from './movement-reconcile.service';

/**
 * SM.5 — Cron nocturno del Supervisor de Movimientos. Corre el motor de cuadre
 * para cada tenant activo (3:15 AM MX = 09:15 UTC, escalonado del scan de Maat),
 * dentro de su scope CLS. Detectores SQL puros (baratos) → seguro por default.
 * Notifica los descuadres críticos NUEVOS (best-effort, reusa el notificador WS).
 */
@Injectable()
export class ReconciliationScannerService {
  private readonly logger = new Logger(ReconciliationScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly engine: MovementReconcileService,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  @Cron('0 15 9 * * *')
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: scan previo aún corriendo'); return; }
    await this.scanAllTenants('cron');
  }

  async scanAllTenants(source = 'cron'): Promise<{ tenants: number; nuevos: number }> {
    this.running = true;
    let nuevos = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        try {
          const r = await this.tenantCtx.run({ tenantId: t.id }, () => this.engine.scanAll(source));
          nuevos += r.total_nuevos;
          if (this.notifier && r.nuevos_criticos?.length) {
            await this.notifier.notifyCritical(t.id, r.nuevos_criticos).catch((e) => this.logger.warn(`notifyCritical falló: ${e?.message || e}`));
          }
        } catch (e: any) {
          this.logger.warn(`scan tenant ${t.id} falló: ${e?.message || e}`);
        }
      }
      this.logger.log(`scan ${source}: ${tenants.length} tenants · ${nuevos} descuadres nuevos.`);
      return { tenants: tenants.length, nuevos };
    } finally {
      this.running = false;
    }
  }
}
