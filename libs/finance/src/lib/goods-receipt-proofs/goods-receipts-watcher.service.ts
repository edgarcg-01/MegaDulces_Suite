import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { GoodsReceiptsGateway } from './goods-receipts.gateway';

/**
 * RE.10 — Watcher near-real-time de nuevas órdenes de entrada. Kepler no emite webhooks:
 * cada 5 min compara las claves canónicas (sucursal|folio, `dup_of_folio IS NULL`) del
 * espejo con las conocidas por tenant (en memoria). Clave nueva = orden nueva → push WS
 * `new_receipts` a `/compras/entradas`. La 1ª pasada por tenant es BASELINE (no emite, así
 * el restart no dispara un aluvión). No toca el box de feeds: dispara cuando el importer ya
 * pobló → la latencia real la marca la cadencia del importer. analytics.* sin RLS (postgres user).
 * Killable con DISABLE_RECEIPT_WATCH=true.
 */
@Injectable()
export class GoodsReceiptsWatcherService {
  private readonly logger = new Logger(GoodsReceiptsWatcherService.name);
  private readonly known = new Map<string, Set<string>>(); // tenant → set de claves conocidas
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly gateway: GoodsReceiptsGateway,
  ) {}

  @Cron('0 */5 * * * *')
  async scan(): Promise<void> {
    if (process.env.DISABLE_RECEIPT_WATCH === 'true') return;
    if (this.running) return;
    this.running = true;
    try {
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
