import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { AlertsService } from './alerts.service';
import { ALERT_THRESHOLDS } from './alerts.types';

/**
 * Detecta productos con `available_quantity < LOW_STOCK_AVAILABLE` y emite
 * `emitLowStock` (WS). Itera todos los tenants activos cada 5 min.
 *
 * Cooldown 1h por `(tenant, product, warehouse)` para evitar re-emitir la
 * misma alerta — in-memory (se pierde al restart, aceptable en beta).
 *
 * Split fuera de `AlertsScannerService` en Fase L.7 para single-responsibility.
 */
@Injectable()
export class LowStockScannerService {
  private readonly logger = new Logger(LowStockScannerService.name);
  private readonly cooldown = new Map<string, number>();
  private readonly COOLDOWN_MS = 60 * 60 * 1000;
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly alerts: AlertsService,
  ) {}

  @Cron('0 */5 * * * *')
  async scheduledScan(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skip low-stock: previous scan still running');
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
        `LowStock scan: ${tenants.length} tenants, ${alertsEmitted} emitted`,
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
      const rows = await trx('commercial.stock as s')
        .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .leftJoin('catalog.products as p', 'p.id', 's.product_id')
        .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
        .whereRaw('(s.quantity - s.reserved_quantity) < ?', [
          ALERT_THRESHOLDS.LOW_STOCK_AVAILABLE,
        ])
        .where('w.active', true)
        .where('p.activo', true)
        .select(
          's.product_id',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          'w.code as warehouse_code',
          trx.raw(
            '(s.quantity - s.reserved_quantity)::numeric as available_quantity',
          ),
        );

      for (const item of rows) {
        const key = `${tenantId}:low_stock:${item.product_id}:${item.warehouse_code}`;
        if (this.onCooldown(key)) continue;
        this.alerts.emitLowStock(tenantId, {
          product_id: item.product_id,
          product_name: item.product_name,
          brand_name: item.brand_name,
          warehouse_code: item.warehouse_code,
          available_quantity: Number(item.available_quantity),
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
