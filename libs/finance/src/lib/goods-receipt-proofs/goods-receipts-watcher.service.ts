import { Injectable, Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB, PgListenService } from '@megadulces/platform-core';
import { CANAL_FUENTE_KEPLER, MiradaAlAviso, esperaAvisoMs, firmaEntradas } from './entradas-por-aviso';
import { GoodsReceiptsGateway } from './goods-receipts.gateway';
import { GoodsReceiptTwinsService } from './goods-receipt-twins.service';

/**
 * RE.10 — Watcher near-real-time de nuevas órdenes de entrada. `[RE.69]` Ya no por reloj (era `@Cron`
 * cada 5 min): al aviso `caja_fuente` de Kepler, y sólo si cambió la firma de las entradas
 * (`entradas-por-aviso.ts`), compara las claves canónicas (sucursal|folio, `dup_of_folio IS NULL`) del
 * espejo con las conocidas por tenant (en memoria). Clave nueva = orden nueva → push WS
 * `new_receipts` a `/compras/entradas`. La 1ª pasada por tenant es BASELINE (no emite, así
 * el restart no dispara un aluvión). No toca el box de feeds: dispara cuando el importer ya
 * pobló → la latencia real la marca la cadencia del importer. analytics.* sin RLS (postgres user).
 * Killable con DISABLE_RECEIPT_WATCH=true.
 */
@Injectable()
export class GoodsReceiptsWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GoodsReceiptsWatcherService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private readonly known = new Map<string, Set<string>>(); // tenant → set de claves conocidas
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly gateway: GoodsReceiptsGateway,
    private readonly twins: GoodsReceiptTwinsService,
    private readonly listen: PgListenService,
  ) {}

  /**
   * `[RE.69]` Se engancha al aviso de Kepler en los pods de `api`, que es donde están los clientes del WS. En el
   * worker no hay a quién avisar: lo dice y no escucha (ahí aparea `GoodsReceiptTwinsService`). La primera
   * mirada, al arrancar, es la BASELINE (no emite).
   */
  onModuleInit(): void {
    if (process.env.DISABLE_RECEIPT_WATCH === 'true') { this.logger.log('aviso de entradas nuevas APAGADO (DISABLE_RECEIPT_WATCH)'); return; }
    if (process.env.WORKER === 'true') { this.logger.log(`no escucho ${CANAL_FUENTE_KEPLER}: el aviso a pantalla vive en los pods de api`); return; }
    this.mirada = new MiradaAlAviso(
      esperaAvisoMs(),
      () => firmaEntradas(this.knex, this.twins.ventanaDias),
      async (cambio) => { if (cambio) await this.scan(); },
      (e) => this.logger.warn(`aviso de entradas falló: ${(e as Error)?.message}`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_FUENTE_KEPLER, () => this.mirada?.avisar());
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_FUENTE_KEPLER}: ${(e as Error)?.message} — las entradas nuevas NO se van a anunciar`);
    }
    this.mirada.avisar();
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.mirada?.detener();
  }

  async scan(): Promise<void> {
    if (process.env.DISABLE_RECEIPT_WATCH === 'true') return;
    if (this.running) return;
    this.running = true;
    try {
      // RE.14.6 — aparear ANTES de anunciar. La copia de oficinas de una recepción ya capturada
      // por la sucursal no es una orden nueva: si se anuncia, el capturista recibe un aviso y una
      // fila pidiéndole evidencia de algo que ya cubrió. `[RE.69]` `aparearPorAviso` y no `ensureFresh`:
      // las entradas cambiaron, y la ventana de 90 s de `ensureFresh` podría saltarse justo ese cambio.
      await this.twins.aparearPorAviso();
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) await this.scanTenant(t.id);
    } catch (e: any) {
      this.logger.warn(`scan: ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  private async scanTenant(tenantId: string): Promise<void> {
    const rows: { sucursal: string; folio: string; proveedor_nombre: string | null }[] =
      await this.knex('analytics.erp_goods_receipts')
        .where('tenant_id', tenantId)
        .whereRaw('dup_of_folio IS NULL') // solo canónicas (no la copia CEDIS)
        .select('sucursal', 'folio', 'proveedor_nombre');

    const seen = this.known.get(tenantId);
    const current = new Set<string>();
    const fresh: { sucursal: string; folio: string; proveedor_nombre: string | null }[] = [];
    for (const r of rows) {
      const k = `${r.sucursal}|${r.folio}`;
      current.add(k);
      if (seen && !seen.has(k)) fresh.push(r);
    }
    this.known.set(tenantId, current);

    if (!seen) return; // baseline (1er tick del tenant) — no emite
    if (!fresh.length || !this.gateway.hasClients(tenantId)) return;
    this.gateway.emitNewReceipts(tenantId, {
      count: fresh.length,
      sample: fresh.slice(0, 5).map((r) => ({ sucursal: r.sucursal, folio: r.folio, proveedor: r.proveedor_nombre })),
      emitted_at: new Date().toISOString(),
    });
    this.logger.log(`tenant ${tenantId}: ${fresh.length} orden(es) de entrada nueva(s) → WS`);
  }
}
