import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { MaatDetectorService } from './maat-detector.service';

/**
 * MAAT.2 — Cron nocturno del motor de patrones. Corre los detectores para cada
 * tenant activo (3 AM MX = 09 UTC), dentro de su scope CLS. Los detectores son
 * SQL puro (baratos, sin LLM) → seguro correr por default. Guard anti-solape.
 */
@Injectable()
export class MaatScannerService {
  private readonly logger = new Logger(MaatScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly detector: MaatDetectorService,
  ) {}

  @Cron('0 0 9 * * *')
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
          const r = await this.tenantCtx.run({ tenantId: t.id }, () => this.detector.scanAll(source));
          nuevos += r.nuevos;
        } catch (e: any) {
          this.logger.warn(`scan tenant ${t.id} falló: ${e?.message || e}`);
        }
      }
      this.logger.log(`scan ${source}: ${tenants.length} tenants · ${nuevos} hallazgos nuevos.`);
      return { tenants: tenants.length, nuevos };
    } finally {
      this.running = false;
    }
  }
}
