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

@Injectable()
export class KeplerConsolidadoService {
  private readonly logger = new Logger(KeplerConsolidadoService.name);
  private running = false;
  private rotationRunning = false;
  private phStockRunning = false;
  private topSellersRunning = false;

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
