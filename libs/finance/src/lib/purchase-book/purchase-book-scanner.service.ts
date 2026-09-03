import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { PurchaseBookService } from './purchase-book.service';

/**
 * `[LC.7]` — **El lazo que cierra el trámite.** Compara lo entregado contra la póliza que
 * de verdad quedó en ContPAQi, y lo que no cuadra va a la bandeja de hallazgos de Maat.
 *
 * Existe por un modo de falla vivido: julio y agosto de 2026 **se cayeron sin que nadie lo
 * notara**. El TXT se genera, se entrega, y ahí terminaba la historia; que la póliza haya
 * llegado o no era una pregunta que nadie hacía hasta mirar la balanza meses después.
 *
 * El empuje de hallazgos vive acá y NO dentro del GET del cuadre: un GET que escribe se
 * dispara dos veces con cualquier refresh de la pantalla.
 *
 * Read-only sobre ContPAQi (ADR-040). Toggle `ENABLE_PURCHASE_BOOK_SCAN=false`; endpoint
 * manual `POST /no-asociados/:mes/cuadre/sync-findings`.
 */
@Injectable()
export class PurchaseBookScannerService {
  private readonly logger = new Logger(PurchaseBookScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly svc: PurchaseBookService,
    @Optional() private readonly ctx?: TenantContextService,
  ) {}

  /** 03:45 MX — después del scanner de Maat (03:00) y antes del de cartera (08:30). */
  @Cron('0 45 3 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env['ENABLE_PURCHASE_BOOK_SCAN'] === 'false') return;
    if (this.running) { this.logger.warn('Skip: cuadre en curso'); return; }
    await this.scanAll();
  }

  /**
   * Barre las corridas entregadas o aplicadas de los últimos 120 días. La ventana existe
   * para no resucitar meses viejos que ya se conciliaron a mano.
   */
  async scanAll(): Promise<{ tenants: number; corridas: number; hallazgos: number }> {
    this.running = true;
    let corridas = 0, hallazgos = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        const pendientes = await this.knex('finance.purchase_book_runs')
          .where('tenant_id', t.id)
          .whereIn('estado', ['entregado', 'aplicado'])
          .whereNull('deleted_at')
          .whereNotNull('archivo_contenido')
          .whereRaw("coalesce(entregado_at, generado_at) >= now() - interval '120 days'")
          .select('anio_mes', 'tipo');

        for (const run of pendientes) {
          corridas++;
          try {
            // `sincronizarHallazgos` va por TenantKnexService, que toma el tenant del
            // contexto: acá no hay request, así que se pone uno sintético.
            const r = await this.conTenant(t.id, () => this.svc.sincronizarHallazgos(run.anio_mes, run.tipo));
            hallazgos += r?.pushed ?? 0;
          } catch (e) {
            this.logger.warn(`cuadre ${run.anio_mes}/${run.tipo} de ${t.id}: ${(e as Error).message}`);
          }
        }
      }
      this.logger.log(`Cuadre del libro: ${tenants.length} tenants · ${corridas} corridas · ${hallazgos} hallazgos`);
      return { tenants: tenants.length, corridas, hallazgos };
    } finally { this.running = false; }
  }

  /** Corre `fn` con un contexto de tenant sintético (no hay request en el cron). */
  private async conTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ctx) return fn();
    return this.ctx.run({ tenantId }, fn);
  }
}
