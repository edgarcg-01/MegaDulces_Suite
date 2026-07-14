import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { SatListIngestService } from './sat-list-ingest.service';
import { SatListCrossService } from './sat-list-cross.service';
import { RfcValidationService } from './rfc-validation.service';
import { SAT_LISTS } from './sat-lists.config';

/**
 * FISCAL — Cron nocturno. Refresca cada lista SAT (global) y luego, por cada
 * tenant activo, cruza todas las listas + valida RFCs. 07:00 UTC (~01:00 MX).
 * Guard anti-solape. Best-effort por lista/tenant. Sin BullMQ (batch barato).
 */
@Injectable()
export class FiscalListasScannerService {
  private readonly logger = new Logger(FiscalListasScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly ingest: SatListIngestService,
    private readonly cross: SatListCrossService,
    private readonly rfc: RfcValidationService,
  ) {}

  @Cron('0 0 7 * * *')
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: scan fiscal previo aún corriendo'); return; }
    await this.runFullScan('cron');
  }

  async runFullScan(source = 'cron') {
    this.running = true;
    try {
      // 1. Refrescar cada lista (best-effort: si una falla, seguimos con la última cargada).
      const hashes: Record<string, string | undefined> = {};
      for (const lista of Object.keys(SAT_LISTS)) {
        try {
          const r = await this.ingest.refreshFromSat(lista);
          hashes[lista] = r.listHash;
          this.logger.log(`Lista ${lista}: ${r.total} RFCs (${r.altas} altas, ${r.cambios} cambios)${r.skipped ? ' [sin cambios]' : ''}.`);
        } catch (e: any) {
          this.logger.warn(`No se pudo refrescar lista ${lista} (${e?.message || e}).`);
        }
      }

      // 2. Cruce + validación RFC por tenant.
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      let matched = 0, issues = 0;
      for (const t of tenants) {
        for (const lista of Object.keys(SAT_LISTS)) {
          try { matched += (await this.cross.crossCheckForTenant(t.id, lista, hashes[lista])).matched; }
          catch (e: any) { this.logger.warn(`cruce ${lista} tenant ${t.id} falló: ${e?.message || e}`); }
        }
        try { issues += (await this.rfc.validateForTenant(t.id)).issues; }
        catch (e: any) { this.logger.warn(`validación RFC tenant ${t.id} falló: ${e?.message || e}`); }
      }
      this.logger.log(`scan fiscal ${source}: ${tenants.length} tenants · ${matched} matches · ${issues} RFC issues.`);
      return { tenants: tenants.length, matched, issues };
    } finally {
      this.running = false;
    }
  }
}
