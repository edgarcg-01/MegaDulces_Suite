import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '../../shared/database/new-database.module';
import { AlertsService } from './alerts.service';
import { ALERT_THRESHOLDS } from './alerts.types';

/**
 * Scanner cron que detecta condiciones de alerta sin trigger inmediato:
 *   - low_stock_critical: productos con available_quantity bajo umbral.
 *   - vip_inactive: customers con credit_limit alto sin compras recientes.
 *
 * Corre cada 5 min. Itera TODOS los tenants activos (no usa RLS porque opera
 * como postgres user). Para cada tenant setea contexto y escanea.
 *
 * Anti-spam: cada (tenant, alert_key) tiene un cooldown de 1 hora — no re-emite
 * la misma alerta más seguido. Implementado in-memory (se pierde al restart;
 * aceptable para beta).
 */
@Injectable()
export class AlertsScannerService {
  private readonly logger = new Logger(AlertsScannerService.name);
  private readonly cooldown = new Map<string, number>(); // key → expires_at ms
  private readonly COOLDOWN_MS = 60 * 60 * 1000; // 1h
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly alerts: AlertsService,
  ) {}

  @Cron('0 */5 * * * *')
  async scheduledScan(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skip: previous scan still running');
      return;
    }
    await this.scanAllTenants();
  }

  async scanAllTenants(): Promise<{ tenants: number; alerts_emitted: number }> {
    this.isRunning = true;
    let alertsEmitted = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id', 'slug');
      for (const t of tenants) {
        alertsEmitted += await this.scanTenant(t.id);
      }
      this.logger.debug(`Scan completed: ${tenants.length} tenants, ${alertsEmitted} alerts emitted`);
      return { tenants: tenants.length, alerts_emitted: alertsEmitted };
    } finally {
      this.isRunning = false;
    }
  }

  async scanTenant(tenantId: string): Promise<number> {
    let count = 0;
    await this.knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);

      // 1. Low stock crítico
      const lowStock = await trx('commercial.stock as s')
        .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 's.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .whereRaw('(s.quantity - s.reserved_quantity) < ?', [ALERT_THRESHOLDS.LOW_STOCK_AVAILABLE])
        .where('w.active', true)
        .where('p.activo', true)
        .select(
          's.product_id',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          'w.code as warehouse_code',
          trx.raw('(s.quantity - s.reserved_quantity)::numeric as available_quantity'),
        );

      for (const item of lowStock) {
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

      // 2. VIP inactive
      const cutoff = `NOW() - INTERVAL '${ALERT_THRESHOLDS.VIP_INACTIVE_DAYS} days'`;
      const vipInactive = await trx
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
          this.on('o.customer_id', '=', 'c.id').andOnIn('o.status', ['confirmed', 'fulfilled']);
        })
        .where('c.active', true)
        .whereNull('c.deleted_at')
        .where('c.credit_limit', '>=', ALERT_THRESHOLDS.VIP_CREDIT_LIMIT_MXN)
        .groupBy('c.id', 'c.code', 'c.name', 'c.credit_limit')
        .havingRaw(`MAX(o.created_at) IS NULL OR MAX(o.created_at) < ${cutoff}`);

      for (const v of vipInactive) {
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

  /** Para tests: reset del cooldown in-memory. */
  resetCooldown(): void {
    this.cooldown.clear();
  }
}
