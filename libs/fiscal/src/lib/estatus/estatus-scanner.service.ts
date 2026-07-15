import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { EstatusService } from './estatus.service';

/**
 * FISCAL.6 — Cron de validación de estatus CFDI. Por tenant activo consulta un
 * lote de CFDI pendientes/vencidos ante el SAT. 09:00 UTC (~03:00 MX). Guard
 * anti-solape, best-effort. Lote acotado por corrida (el WS del SAT limita).
 */
@Injectable()
export class EstatusScannerService {
  private readonly logger = new Logger(EstatusScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly estatus: EstatusService,
  ) {}

  @Cron('0 0 9 * * *')
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: validación de estatus previa aún corriendo'); return; }
    this.running = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      let cancelados = 0;
      for (const t of tenants) {
        try { cancelados += (await this.estatus.checkForTenant(t.id, 300)).cancelados; }
        catch (e: any) { this.logger.warn(`estatus tenant ${t.id} falló: ${e?.message || e}`); }
      }
      this.logger.log(`scan estatus: ${tenants.length} tenants · ${cancelados} cancelados.`);
    } finally {
      this.running = false;
    }
  }
}
