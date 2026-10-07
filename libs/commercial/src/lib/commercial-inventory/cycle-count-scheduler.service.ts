import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { InventoryAbcService } from './inventory-abc.service';
import { InventoryCountService } from './inventory-count.service';

/**
 * Fase ABC.3 — scheduler de conteo cíclico. Ver FASE_ABC_CYCLE_COUNT.md.
 *
 * Diario, por almacén: toma lo que está "due" (ABC.1, prioriza A) y abre un folio
 * cíclico acotado (ABC.2) — del "inventario anual que congela todo" a control continuo.
 *
 * Como en un cron NO hay request → no hay CLS tenant: cada tenant se procesa dentro
 * de `tenantCtx.run({tenantId})` para que `cycleDue`/`openCycleCount` (que leen el
 * AsyncLocalStorage) funcionen. Anti-duplicado: si el almacén ya tiene folio abierto,
 * `openCycleCount` rebota y acá se cuenta como `skipped`.
 *
 * Gateado por `ENABLE_CYCLE_COUNT_CRON=true` (auto-crear folios es opt-in). El
 * endpoint manual (scoped al tenant del JWT) corre siempre, para disparo/QA.
 */
@Injectable()
export class CycleCountSchedulerService {
  private readonly logger = new Logger(CycleCountSchedulerService.name);
  private isRunning = false;
  private isRecomputingAbc = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly tk: TenantKnexService,
    private readonly abc: InventoryAbcService,
    private readonly counts: InventoryCountService,
  ) {}

  @Cron('0 0 2 * * *', { timeZone: 'America/Mexico_City' }) // 2 AM MX
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_CYCLE_COUNT_CRON !== 'true') return;
    if (this.isRunning) {
      this.logger.warn('Skip: cycle-count scheduler ya corriendo');
      return;
    }
    await this.generateAll();
  }

  /**
   * AUDIT 2026-08-20 — recompute NIGHTLY de la clasificación ABC. Antes NINGÚN cron la escribía
   * (solo el endpoint manual `computeAbc`) → quedó CONGELADA desde 2026-06-20 (~2 meses), invisible.
   * Corre SIEMPRE (no gateado: recalcular la clase no es intrusivo, a diferencia de auto-crear folios).
   * Por tenant en su CLS — `computeAbc` usa `tk.run` RLS-scoped. 3:30 AM MX (tras el nightly de ventas).
   */
  @Cron('0 30 3 * * *', { timeZone: 'America/Mexico_City' })
  async recomputeAbcAll(): Promise<void> {
    if (this.isRecomputingAbc) { this.logger.warn('Skip: recompute ABC ya corriendo'); return; }
    this.isRecomputingAbc = true;
    let tenants = 0, ok = 0, errors = 0;
    try {
      const ts = await this.knex('public.tenants').where({ activo: true }).select('id');
      tenants = ts.length;
      for (const t of ts) {
        try {
          await this.tenantCtx.run({ tenantId: t.id }, () => this.abc.computeAbc());
          ok++;
        } catch (e: any) {
          errors++;
          this.logger.error(`ABC recompute tenant=${t.id}: ${e?.message}`);
        }
      }
      this.logger.log(`ABC recompute nightly: ${ok}/${tenants} tenants OK (${errors} err)`);
    } finally {
      this.isRecomputingAbc = false;
    }
  }

  async generateAll(opts: { maxItemsPerFolio?: number } = {}) {
    this.isRunning = true;
    let tenants = 0, warehousesDue = 0, foliosCreated = 0, skipped = 0, errors = 0;
    try {
      const ts = await this.knex('public.tenants').where({ activo: true }).select('id');
      tenants = ts.length;
      for (const t of ts) {
        const r = await this.generateForTenant(t.id, opts);
        warehousesDue += r.warehouses_due;
        foliosCreated += r.folios_created;
        skipped += r.skipped;
        errors += r.errors;
      }
      this.logger.log(
        `Cycle-count scheduler: ${foliosCreated} folios creados (${warehousesDue} almacenes due, ${skipped} skip, ${errors} err) en ${tenants} tenants`,
      );
      return { tenants, warehouses_due: warehousesDue, folios_created: foliosCreated, skipped, errors };
    } finally {
      this.isRunning = false;
    }
  }

  /** Genera folios cíclicos para un tenant (todos sus almacenes, o uno si se pasa). */
  async generateForTenant(
    tenantId: string,
    opts: { maxItemsPerFolio?: number; warehouseId?: string } = {},
  ) {
    const maxItems = Math.min(500, Math.max(1, Number(opts.maxItemsPerFolio) || 50));
    return this.tenantCtx.run({ tenantId }, async () => {
      const whs = await this.tk.run((trx) => {
        let q = trx('commercial.warehouses').where({ active: true });
        if (opts.warehouseId) q = q.where({ id: opts.warehouseId });
        return q.select('id', 'code');
      });

      let warehousesDue = 0, foliosCreated = 0, skipped = 0, errors = 0;
      for (const wh of whs) {
        try {
          const due = await this.abc.cycleDue({ warehouse_id: wh.id, only_due: true });
          if (!due.items.length) continue;
          warehousesDue++;
          const productIds = due.items.slice(0, maxItems).map((i: any) => i.product_id);
          try {
            await this.counts.openCycleCount({
              warehouse_id: wh.id,
              product_ids: productIds,
              max_items: maxItems,
              notes: 'Auto-cíclico (scheduler)',
            });
            foliosCreated++;
          } catch (e: any) {
            if (/abierto/i.test(e?.message || '')) skipped++; // ya hay folio abierto → ok
            else throw e;
          }
        } catch (e: any) {
          errors++;
          this.logger.error(`cycle-gen almacén=${wh.id} tenant=${tenantId}: ${e?.message}`);
        }
      }
      return { warehouses_due: warehousesDue, folios_created: foliosCreated, skipped, errors };
    });
  }
}
