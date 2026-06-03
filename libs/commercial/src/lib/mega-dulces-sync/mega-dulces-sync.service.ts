import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';

/**
 * Sprint M.5 — sync nightly de Mega_Dulces ERP (.245) → postgres_platform.
 *
 * Envuelve el script CLI `database/importers/mega_dulces_sync.js` ejecutándolo
 * como subprocess. Usar el script ya probado (en lugar de re-implementar) evita
 * divergencia entre el run manual y el cron.
 *
 * Schedule: 03:00 AM hora MX (= 09:00 UTC). Hora baja en producción —
 * el ERP en .245 está libre, la app B2B no tiene tráfico, y los analytics
 * de la mañana ya tienen data fresca.
 *
 * Guards:
 *   - `isRunning` flag anti-overlap: si la corrida anterior tarda > 1h, el
 *     siguiente schedule pasa de largo (skip + log warn).
 *   - Tenant Mega Dulces hardcoded (single-tenant por ahora). Cuando se agregue
 *     un 2do tenant con ERP propio, este service se generaliza.
 *   - Run manual disponible vía endpoint admin para forzar sync ad-hoc.
 *
 * NO incluye: ventas históricas (esas viven en el FDW `analytics_external.ventas_legacy`
 * → no requieren sync, son live).
 */

const SCRIPT_PATH = 'database/importers/mega_dulces_sync.js';
const TARGET_TENANT_SLUG = 'mega_dulces';
const MAX_DRIFT_PCT = 10; // alertar si delta > 10% (puede indicar problema de fuente)

interface SyncSummary {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  ms: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  alert?: string;
}

@Injectable()
export class MegaDulcesSyncService {
  private readonly logger = new Logger(MegaDulcesSyncService.name);
  private isRunning = false;
  private lastSummary: SyncSummary | null = null;

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly adminKnex: Knex | null,
  ) {}

  /**
   * Schedule fijo: 03:00 AM hora MX cada noche.
   * `0 0 9 * * *` = 09:00 UTC = 03:00 MX (sin DST en la mayoría del país).
   */
  @Cron('0 0 9 * * *')
  async scheduledSync(): Promise<void> {
    if (!this.adminKnex) {
      this.logger.debug('Skip: KNEX_NEW_DB_ADMIN no disponible (DATABASE_URL_NEW no seteado)');
      return;
    }
    if (this.isRunning) {
      this.logger.warn('Skip: corrida anterior aún activa (>1h?)');
      return;
    }
    await this.runSync('cron');
  }

  /** Run manual disparado por endpoint admin. Bloquea concurrencia con el cron. */
  async runManual(): Promise<SyncSummary> {
    if (this.isRunning) {
      throw new Error('Sync ya está corriendo (cron o manual previo). Esperar o ver getLastSummary().');
    }
    return this.runSync('manual');
  }

  getLastSummary(): SyncSummary | null {
    return this.lastSummary;
  }

  isInProgress(): boolean {
    return this.isRunning;
  }

  private async runSync(source: 'cron' | 'manual'): Promise<SyncSummary> {
    this.isRunning = true;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    this.logger.log(`[${source}] sync Mega_Dulces arrancando…`);

    let summary: SyncSummary = {
      ok: false,
      startedAt,
      finishedAt: startedAt,
      ms: 0,
    };
    try {
      const { stdout, stderr, alert } = await this.runImporterScript();
      const ms = Date.now() - t0;
      summary = {
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        ms,
        stdout: stdout.slice(-2000),
        stderr: stderr ? stderr.slice(-2000) : undefined,
        alert,
      };
      this.logger.log(`[${source}] sync OK en ${ms}ms${alert ? ` (ALERT: ${alert})` : ''}`);
    } catch (e: any) {
      const ms = Date.now() - t0;
      summary = {
        ok: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        ms,
        error: e?.message || String(e),
        stdout: e?.stdout?.slice(-2000),
        stderr: e?.stderr?.slice(-2000),
      };
      this.logger.error(`[${source}] sync FAILED en ${ms}ms: ${summary.error}`);
    } finally {
      this.isRunning = false;
      this.lastSummary = summary;
    }
    return summary;
  }

  /**
   * Ejecuta el CLI script como subprocess para no acoplar el servicio a la
   * implementación del importer. spawn captura stdout+stderr; timeout 1h.
   */
  private async runImporterScript(): Promise<{ stdout: string; stderr: string; alert?: string }> {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn('node', [SCRIPT_PATH, `--tenant-slug=${TARGET_TENANT_SLUG}`], {
        cwd: process.cwd(),
        env: { ...process.env },
        timeout: 3600_000, // 1h hard cap
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => reject(Object.assign(err, { stdout, stderr })));
      proc.on('close', (code) => {
        if (code !== 0) {
          const err = new Error(`Importer exit code ${code}`);
          return reject(Object.assign(err, { stdout, stderr }));
        }
        // Parse del summary para detectar drift sospechoso.
        const alert = this.detectDrift(stdout);
        resolve({ stdout, stderr, alert });
      });
    });
  }

  /**
   * Detecta drift sospechoso comparando el último summary con éste.
   * Si productos upserted cae > MAX_DRIFT_PCT vs el run anterior, alerta —
   * puede indicar que la fuente quedó vacía o que algo se rompió en el ERP.
   */
  private detectDrift(stdout: string): string | undefined {
    const productsMatch = stdout.match(/products\s+:\s+(\d+)\s+upserted/);
    if (!productsMatch) return undefined;
    const currentProducts = Number(productsMatch[1]);
    const prevProducts = this.lastSummary?.stdout
      ? Number((this.lastSummary.stdout.match(/products\s+:\s+(\d+)\s+upserted/) || [, '0'])[1])
      : 0;
    if (prevProducts === 0) return undefined;
    const dropPct = ((prevProducts - currentProducts) / prevProducts) * 100;
    if (dropPct > MAX_DRIFT_PCT) {
      return `productos cayeron ${dropPct.toFixed(1)}% vs run previo (${prevProducts} → ${currentProducts})`;
    }
    return undefined;
  }
}
