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
const TOP_SELLERS_SCRIPT = 'database/importers/kepler/import-top-sellers-from-consolidado.js';
const MARGIN_SCRIPT = 'database/importers/kepler/import-margin.js';
const SALES_FACT_SCRIPT = 'database/importers/kepler/import-sales-fact.js';
const SALES_STATS_SCRIPT = 'database/importers/kepler/import-sales-stats.js';
const INV_HEALTH_SCRIPT = 'database/importers/kepler/import-inventory-health.js';
const CUSTOMER_SALES_SCRIPT = 'database/importers/kepler/import-customer-sales.js';
const LOGISTICS_DIMS_SCRIPT = 'database/importers/kepler/import-logistics-dims.js';

@Injectable()
export class KeplerConsolidadoService {
  private readonly logger = new Logger(KeplerConsolidadoService.name);
  private running = false;
  private rotationRunning = false;
  private topSellersRunning = false;
  private marginRunning = false;
  private salesFactRunning = false;
  private salesStatsRunning = false;
  private invHealthRunning = false;
  private custSalesRunning = false;
  private logDimsRunning = false;

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
  // RETIRADO 2026-08-26: duplicaba exacto el paso 1 import-rotation-from-consolidado del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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

  // RETIRADO 2026-09-02 (ADR-052): `phStockFeed` (@1min) hacía spawn de
  // `import-branch-stock-live.js`, el MISMO importer que PM2 ya corre en loop
  // (`ecosystem.sync.config.js` → `sync-stock --apply --watch=15`) y que el runner on-prem
  // dispara en su grupo `stock` (`run-prod-feeds.js`). Era TRIPLE ejecución del mismo feed
  // sobre `commercial.stock`, compitiendo por el snapshot en disco compartido
  // (`.stock-live-snapshot.json`) — el mismo snapshot cuya desincronización dejaba valores
  // fantasma. Su doc también mentía: decía "PH (md_01) → MD-10" cuando el importer cubre 01-06.
  // La existencia además ya no se lee de esa copia: el fact deriva de
  // `analytics.v_erp_stock_on_hand` (vista sobre kepler_ods). PM2 queda como único ejecutor
  // hasta que el paso 4/5 de ADR-052 retire el importer entero.

  /**
   * Best-sellers VIVOS de la red → catalog.top_sellers_live (portal home/catálogo).
   * Nightly (ventana 90d cambia lento). 04:15, tras la rotación.
   */
  // RETIRADO 2026-08-26: duplicaba exacto el paso 2 import-top-sellers-from-consolidado del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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
  // RETIRADO 2026-08-26: duplicaba exacto el paso 3 import-margin del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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
  // RETIRADO 2026-08-26: duplicaba exacto el paso 4 import-sales-fact del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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
  // RETIRADO 2026-08-26: duplicaba exacto el paso 5 import-sales-stats del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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
  // RETIRADO 2026-08-26: duplicaba exacto el paso 9 import-inventory-health del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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
   * RETIRADO 2026-08-20 (mig 20260820160000): `analytics.erp_promotions` es ahora VISTA
   * derive-no-copy sobre kepler_ods.kdpv_* → se deriva EN VIVO (fresco vía CDC), sin importer
   * (correrlo pegaría TRUNCATE/INSERT contra la vista → error). No-op sin @Cron.
   */
  async promosFeed(): Promise<void> {
    this.logger.log('promosFeed: no-op — erp_promotions es VISTA derive-no-copy (mig 20260820160000).');
  }

  /**
   * RETIRADO 2026-08-20 (mig 20260820150000): `analytics.erp_customers` es ahora VISTA
   * derive-no-copy sobre kepler_ods.kdud → se deriva EN VIVO del ODS (fresco vía CDC), sin
   * importer que se atrase (y correrlo pegaría INSERT contra una vista → error). Se deja el
   * método como no-op (sin @Cron) por si algo lo referencia; el script queda como fallback.
   */
  async customersFeed(): Promise<void> {
    this.logger.log('customersFeed: no-op — erp_customers es VISTA derive-no-copy (mig 20260820150000).');
  }

  /**
   * Historial de compra por cliente → analytics.customer_product_sales (KV.3).
   * Nightly 05:10. Base de Customer 360 (vendedor/televenta/portal).
   */
  // RETIRADO 2026-08-26: duplicaba exacto el paso 17 import-customer-sales del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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
  // RETIRADO 2026-08-26: duplicaba exacto el paso 18 import-logistics-dims del runner on-prem
  // (run-prod-feeds.js modo nightly), que ES el camino de producción. Ademas en prod
  // era INERTE: DATABASE_URL_KEPLER_CONSOLIDADO no está seteado en el servicio (y no
  // puede estarlo: el consolidado vive en la LAN, que Railway no alcanza) → el @Cron
  // disparaba cada noche y caía en el `if (!this.db) return`. Corriendo el API on-prem
  // sí escribía, o sea doble-escritura contra el mismo destino. El método queda
  // invocable a mano (mismo criterio que promosFeed/customersFeed más abajo).
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
   * RETIRADO 2026-08-20 (mig 20260820170000): `analytics.erp_shipments` es ahora VISTA derive-no-copy
   * sobre kepler_ods.kdpord con anti-réplica c19=sucursal (corrige el doble conteo de réplicas
   * cross-branch del importer). Se deriva EN VIVO; correrlo pegaría INSERT contra la vista → error.
   */
  async shipmentsFeed(): Promise<void> {
    this.logger.log('shipmentsFeed: no-op — erp_shipments es VISTA derive-no-copy (mig 20260820170000).');
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
