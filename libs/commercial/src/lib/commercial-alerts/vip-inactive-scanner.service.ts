import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { AlertsService } from './alerts.service';
import { ALERT_THRESHOLDS } from './alerts.types';

/**
 * Detecta customers con `credit_limit >= VIP_CREDIT_LIMIT_MXN` que no compraron
 * en `VIP_INACTIVE_DAYS` y emite `emitVipInactive` (WS). Itera todos los
 * tenants activos cada 5 min (desfasado +30s respecto a low-stock).
 *
 * Cooldown 1h por `(tenant, customer)` para evitar re-emitir — in-memory
 * (se pierde al restart, aceptable en beta).
 *
 * Split fuera de `AlertsScannerService` en Fase L.7 para single-responsibility.
 */
@Injectable()
export class VipInactiveScannerService {
  private readonly logger = new Logger(VipInactiveScannerService.name);
  private readonly cooldown = new Map<string, number>();
  private readonly COOLDOWN_MS = 60 * 60 * 1000;
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly alerts: AlertsService,
  ) {}

  @Cron('30 */5 * * * *')
  async scheduledScan(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skip vip-inactive: previous scan still running');
      return;
    }
    await this.scanAllTenants();
  }

  async scanAllTenants(): Promise<{ tenants: number; alerts_emitted: number }> {
    this.isRunning = true;
    let alertsEmitted = 0;
    try {
      const tenants = await this.knex('identity.tenants')
        .where({ activo: true })
        .select('id');
      for (const t of tenants) {
        alertsEmitted += await this.scanTenant(t.id);
      }
      this.logger.debug(
        `VipInactive scan: ${tenants.length} tenants, ${alertsEmitted} emitted`,
      );
      return { tenants: tenants.length, alerts_emitted: alertsEmitted };
    } finally {
      this.isRunning = false;
    }
  }

  async scanTenant(tenantId: string): Promise<number> {
    let count = 0;
    await this.knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const cutoff = `NOW() - INTERVAL '${ALERT_THRESHOLDS.VIP_INACTIVE_DAYS} days'`;
      const rows = await trx
        .select(
          'c.id as customer_id',
          'c.code',
          'c.name',
          'c.credit_limit',
          trx.raw('MAX(o.created_at) as last_order_at'),
          trx.raw(`CASE WHEN MAX(o.created_at) IS NULL THEN NULL
                        ELSE EXTRACT(DAY FROM (NOW() - MAX(o.created_at)))::int
                   END as days_inactive`),
        )
        .from('commercial.customers as c')
        .leftJoin('commercial.orders as o', function () {
          this.on('o.customer_id', '=', 'c.id').andOnIn('o.status', [
            'confirmed',
            'fulfilled',
          ]);
        })
        .where('c.active', true)
        .whereNull('c.deleted_at')
        .where('c.credit_limit', '>=', ALERT_THRESHOLDS.VIP_CREDIT_LIMIT_MXN)
        .groupBy('c.id', 'c.code', 'c.name', 'c.credit_limit')
        .havingRaw(
          `MAX(o.created_at) IS NULL OR MAX(o.created_at) < ${cutoff}`,
        );

      for (const v of rows) {
        const key = `${tenantId}:vip_inactive:${v.customer_id}`;
        if (this.onCooldown(key)) continue;
        this.alerts.emitVipInactive(tenantId, {
          customer_id: v.customer_id,
          customer_code: v.code,
          customer_name: v.name,
          credit_limit: Number(v.credit_limit),
          days_inactive: v.days_inactive,
        });
        this.markEmitted(key);
        count++;
      }
    });
    return count;
  }

  private onCooldown(key: string): boolean {
    const exp = this.cooldown.get(key);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.cooldown.delete(key);
      return false;
    }
    return true;
  }

  private markEmitted(key: string): void {
    this.cooldown.set(key, Date.now() + this.COOLDOWN_MS);
  }

  resetCooldown(): void {
    this.cooldown.clear();
  }
}
