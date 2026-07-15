import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { ConciliacionService } from './conciliacion.service';
import { PolizaCruceService } from './poliza-cruce.service';

/**
 * FISCAL.5.1 — Cron nocturno de conciliación. Por cada tenant activo recalcula
 * PPD sin REP / saldo insoluto vencido → bandeja de Maat. 08:00 UTC (~02:00 MX).
 * Guard anti-solape, best-effort por tenant. Sin BullMQ (batch barato).
 */
@Injectable()
export class FiscalConciliacionScannerService {
  private readonly logger = new Logger(FiscalConciliacionScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly conciliacion: ConciliacionService,
    private readonly cruce: PolizaCruceService,
  ) {}

  @Cron('0 0 8 * * *')
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: conciliación previa aún corriendo'); return; }
    this.running = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      let pushed = 0;
      for (const t of tenants) {
        try { pushed += (await this.conciliacion.scanForTenant(t.id)).pushed; }
        catch (e: any) { this.logger.warn(`conciliación REP tenant ${t.id} falló: ${e?.message || e}`); }
        try { pushed += (await this.cruce.scanForTenant(t.id)).pushed; }
        catch (e: any) { this.logger.warn(`cruce póliza tenant ${t.id} falló: ${e?.message || e}`); }
      }
      this.logger.log(`scan conciliación: ${tenants.length} tenants · ${pushed} hallazgos.`);
    } finally {
      this.running = false;
    }
  }
}
