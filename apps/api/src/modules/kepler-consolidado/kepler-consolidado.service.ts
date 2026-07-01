import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_KEPLER_CONSOLIDADO } from './kepler-consolidado.constants';

/**
 * Polling inteligente de la consolidación de ventas Kepler.
 *
 * Cada 2 min llama `mart.refresh_si_cambio(7)` en la DB `kepler_consolidado`,
 * que chequea un marcador barato por sucursal (count de cabeceras U/D vía
 * dblink, READ-ONLY) y solo refresca las que cambiaron.
 *
 * Gated por env: si `DATABASE_URL_KEPLER_CONSOLIDADO` no está seteado, la
 * conexión es null y el cron es no-op (seguro en Railway/prod donde esa DB
 * no existe). Solo corre donde la consolidación local está montada.
 */
const ROTATION_SCRIPT = 'database/importers/kepler/import-rotation-from-consolidado.js';
const PH_STOCK_SCRIPT = 'database/importers/kepler/import-branch-stock-live.js';
const TOP_SELLERS_SCRIPT = 'database/importers/kepler/import-top-sellers-from-consolidado.js';
const MARGIN_SCRIPT = 'database/importers/kepler/import-margin.js';
const SALES_FACT_SCRIPT = 'database/importers/kepler/import-sales-fact.js';
const SALES_STATS_SCRIPT = 'database/importers/kepler/import-sales-stats.js';
const INV_HEALTH_SCRIPT = 'database/importers/kepler/import-inventory-health.js';
const ERP_PROMOS_SCRIPT = 'database/importers/kepler/import-erp-promos.js';
const ERP_CUSTOMERS_SCRIPT = 'database/importers/kepler/import-erp-customers.js';
const CUSTOMER_SALES_SCRIPT = 'database/importers/kepler/import-customer-sales.js';
const LOGISTICS_DIMS_SCRIPT = 'database/importers/kepler/import-logistics-dims.js';
const ERP_SHIPMENTS_SCRIPT = 'database/importers/kepler/import-erp-shipments.js';

@Injectable()
export class KeplerConsolidadoService {
  private readonly logger = new Logger(KeplerConsolidadoService.name);
  private running = false;
  private rotationRunning = false;
  private phStockRunning = false;
  private topSellersRunning = false;
  private marginRunning = false;
  private salesFactRunning = false;
  private salesStatsRunning = false;
  private invHealthRunning = false;
  private promosRunning = false;
  private custRunning = false;
  private custSalesRunning = false;
  private logDimsRunning = false;
  private shipmentsRunning = false;

  constructor(
    @Inject(KNEX_KEPLER_CONSOLIDADO) private readonly db: Knex | null,
  ) {}

  // Cada 2 min en el segundo :30 (desfasado para no chocar con otros crons en :00).
  @Cron('30 */2 * * * *')
  async poll(): Promise<void> {
    if (!this.db) return; // env no seteado → inerte
    if (this.running) {
      this.logger.warn('Skip poll: corrida anterior aún activa');
      return;
    }
    await this.refresh('cron');
  }

  /** Refresh manual/programado. Devuelve las sucursales refrescadas. */
  async refresh(source: 'cron' | 'manual' = 'manual', days = 7): Promise<
    Array<{ sucursal: string; accion: string; filas: number }>
  > {
    if (!this.db) {
      throw new Error(
        'DATABASE_URL_KEPLER_CONSOLIDADO no seteado — consolidación Kepler no disponible.',
      );
    }
    this.running = true;
    try {
      const res = await this.db.raw('SELECT * FROM mart.refresh_si_cambio(?)', [days]);
      const rows = res.rows as Array<{ sucursal: string; accion: string; filas: number }>;
      const refreshed = rows.filter((r) => r.accion === 'REFRESCADO');
      if (refreshed.length) {
        this.logger.log(
          `Consolidación Kepler (${source}): ${refreshed.length} sucursal(es) refrescada(s) — ` +
            refreshed.map((r) => `${r.sucursal}(${r.filas})`).join(', '),
        );
      }
      return rows;
    } catch (e: any) {
      this.logger.error(`Polling consolidación Kepler falló: ${e.message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  /**
   * Feed de ROTACIÓN de red → catalog.products (Thot + dead-stock). Nightly
   * porque la ventana 30/90d cambia lento. Ejecuta el importer como subprocess
   * (single source of truth = el script; mismo patrón que mega-dulces-sync).
   * El script lee DATABASE_URL_KEPLER_CONSOLIDADO + DATABASE_URL_NEW del env.
   */
  @Cron('0 0 4 * * *') // 04:00 todos los días
  async rotationFeed(): Promise<void> {
    if (!this.db) return; // env no seteado → inerte
    if (this.rotationRunning) {
      this.logger.warn('Skip rotationFeed: corrida anterior aún activa');
      return;
    }
    this.rotationRunning = true;
    try {
      await this.runScript(ROTATION_SCRIPT, 'Rotación de red', /Actualizados|Distribución|ERROR/);
    } finally {
      this.rotationRunning = false;
    }
  }

  /**
   * Stock VIVO de PH (md_01) → commercial.stock MD-10. Los vendedores se surten
   * de PH; cada 30 min para reflejar cargas/ventas del día. Subprocess del
   * importer (single source of truth). El nightly mega_dulces_sync ya NO pisa MD-10.
   */
  @Cron('0 */30 * * * *') // cada 30 min
  async phStockFeed(): Promise<void> {
    if (!this.db) return;
    if (this.phStockRunning) {
      this.logger.warn('Skip phStockFeed: corrida anterior aún activa');
      return;
    }
    this.phStockRunning = true;
    try {
      await this.runScript(PH_STOCK_SCRIPT, 'Stock sucursales (01/02/03)', /upserted|COMMIT|ERROR/);
    } finally {
      this.phStockRunning = false;
    }
  }

  /**
   * Best-sellers VIVOS de la red → catalog.top_sellers_live (portal home/catálogo).
   * Nightly (ventana 90d cambia lento). 04:15, tras la rotación.
   */
  @Cron('0 15 4 * * *')
  async topSellersFeed(): Promise<void> {
    if (!this.db) return;
    if (this.topSellersRunning) {
      this.logger.warn('Skip topSellersFeed: corrida anterior aún activa');
      return;
    }
    this.topSellersRunning = true;
    try {
      await this.runScript(TOP_SELLERS_SCRIPT, 'Best-sellers portal', /Best-sellers|match catálogo|ERROR/);
    } finally {
      this.topSellersRunning = false;
    }
  }

  /**
   * Markup % por producto → catalog.products.markup_pct (KV.4). Nightly 04:40,
   * ANTES del fact (el fact usa markup para el costo). Lee una sucursal Kepler.
   */
  @Cron('0 40 4 * * *')
  async marginFeed(): Promise<void> {
    if (!this.db) return;
    if (this.marginRunning) {
      this.logger.warn('Skip marginFeed: corrida anterior aún activa');
      return;
    }
    this.marginRunning = true;
    try {
      await this.runScript(MARGIN_SCRIPT, 'Markup de productos', /markup_pct|COMMIT|ERROR/);
    } finally {
      this.marginRunning = false;
    }
  }

  /**
   * Fact de venta real de la red → analytics.sales_daily (KV.1). Base de
   * command-center / ABC / margen / demanda. Nightly 04:45, tras top-sellers.
   * Ventana 13 meses, bulk staging+merge.
   */
  @Cron('0 45 4 * * *')
  async salesFactFeed(): Promise<void> {
    if (!this.db) return;
    if (this.salesFactRunning) {
      this.logger.warn('Skip salesFactFeed: corrida anterior aún activa');
      return;
    }
    this.salesFactRunning = true;
    try {
      await this.runScript(SALES_FACT_SCRIPT, 'Fact de ventas', /sales_daily|COMMIT|ERROR/);
    } finally {
      this.salesFactRunning = false;
    }
  }

  /**
   * Stats por producto (ABC/share/rolling) → analytics.product_sales_stats (KV.2).
   * Server-side desde sales_daily. Nightly 04:50, tras el fact.
   */
  @Cron('0 50 4 * * *')
  async statsFeed(): Promise<void> {
    if (!this.db) return;
    if (this.salesStatsRunning) {
      this.logger.warn('Skip statsFeed: corrida anterior aún activa');
      return;
    }
    this.salesStatsRunning = true;
    try {
      await this.runScript(SALES_STATS_SCRIPT, 'Stats de producto (ABC)', /upserted|COMMIT|ERROR/);
    } finally {
      this.salesStatsRunning = false;
    }
  }

  /**
   * Salud de inventario → analytics.inventory_health (KV.5): stock × velocidad =
   * días de cobertura + status. Nightly 04:55, tras stats (necesita sales_daily).
   */
  @Cron('0 55 4 * * *')
  async healthFeed(): Promise<void> {
    if (!this.db) return;
    if (this.invHealthRunning) {
      this.logger.warn('Skip healthFeed: corrida anterior aún activa');
      return;
    }
    this.invHealthRunning = true;
    try {
      await this.runScript(INV_HEALTH_SCRIPT, 'Salud de inventario', /upserted|COMMIT|ERROR/);
    } finally {
      this.invHealthRunning = false;
    }
  }

  /**
   * Promos vigentes del ERP → analytics.erp_promotions (KV.6). Nightly 05:00.
   * Señal para Thot / portal.
   */
  @Cron('0 0 5 * * *')
  async promosFeed(): Promise<void> {
    if (!this.db) return;
    if (this.promosRunning) {
      this.logger.warn('Skip promosFeed: corrida anterior aún activa');
      return;
    }
    this.promosRunning = true;
    try {
      await this.runScript(ERP_PROMOS_SCRIPT, 'Promos ERP', /vigentes|COMMIT|ERROR/);
    } finally {
      this.promosRunning = false;
    }
  }

  /**
   * Dim de clientes Kepler → analytics.erp_customers (KV.3). Nightly 05:05.
   * Lee kdud de las 6 sucursales (no toca commercial.customers).
   */
  @Cron('0 5 5 * * *')
  async customersFeed(): Promise<void> {
    if (!this.db) return;
    if (this.custRunning) { this.logger.warn('Skip customersFeed: corrida anterior aún activa'); return; }
    this.custRunning = true;
    try {
      await this.runScript(ERP_CUSTOMERS_SCRIPT, 'Dim clientes ERP', /clientes en erp_customers|COMMIT|ERROR/);
    } finally {
      this.custRunning = false;
    }
  }

  /**
   * Historial de compra por cliente → analytics.customer_product_sales (KV.3).
   * Nightly 05:10. Base de Customer 360 (vendedor/televenta/portal).
   */
  @Cron('0 10 5 * * *')
  async customerSalesFeed(): Promise<void> {
    if (!this.db) return;
    if (this.custSalesRunning) { this.logger.warn('Skip customerSalesFeed: corrida anterior aún activa'); return; }
    this.custSalesRunning = true;
    try {
      await this.runScript(CUSTOMER_SALES_SCRIPT, 'Historial por cliente', /cliente.producto|COMMIT|ERROR/);
    } finally {
      this.custSalesRunning = false;
    }
  }

  /**
   * KV.8 — Dims de logística (rutas/choferes/flota) → logistics.*. Nightly 05:15.
   */
  @Cron('0 15 5 * * *')
  async logisticsDimsFeed(): Promise<void> {
    if (!this.db) return;
    if (this.logDimsRunning) { this.logger.warn('Skip logisticsDimsFeed: corrida anterior aún activa'); return; }
    this.logDimsRunning = true;
    try {
      await this.runScript(LOGISTICS_DIMS_SCRIPT, 'Dims logística', /drivers:|vehicles:|routes:|COMMIT|ERROR/);
    } finally {
      this.logDimsRunning = false;
    }
  }

  /**
   * KV.8 — Embarques reales del ERP (kdpord) → analytics.erp_shipments. Nightly 05:20.
   */
  @Cron('0 20 5 * * *')
  async shipmentsFeed(): Promise<void> {
    if (!this.db) return;
    if (this.shipmentsRunning) { this.logger.warn('Skip shipmentsFeed: corrida anterior aún activa'); return; }
    this.shipmentsRunning = true;
    try {
      await this.runScript(ERP_SHIPMENTS_SCRIPT, 'Embarques ERP', /erp_shipments|COMMIT|ERROR/);
    } finally {
      this.shipmentsRunning = false;
    }
  }

  /** Ejecuta un importer como subprocess y loguea el resumen de sus líneas clave. */
  private async runScript(script: string, label: string, lineRe: RegExp): Promise<void> {
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve) => {
      const proc = spawn('node', [script, '--apply'], { cwd: process.cwd() });
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.stderr.on('data', (d) => (out += d.toString()));
      proc.on('close', (code) => {
        const summary = out.split('\n').filter((l) => lineRe.test(l)).join(' | ');
        if (code === 0) this.logger.log(`${label} actualizado — ${summary}`);
        else this.logger.error(`${label} exit ${code} — ${summary}`);
        resolve();
      });
      proc.on('error', (e) => {
        this.logger.error(`${label} no pudo ejecutarse: ${e.message}`);
        resolve();
      });
    });
  }
}
