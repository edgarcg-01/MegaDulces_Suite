import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { KNEX_VECTOR_DB } from '@megadulces/platform-core';
import { EmbeddingsService } from '@megadulces/platform-core';

/**
 * Fase K v2 — Sync del corpus del RAG hacia la DB vector dedicada.
 *
 * Fuente de verdad: `public.products` (catálogo ERP) en la DB transaccional
 * (`KNEX_CONNECTION`). Destino: `product_embeddings` en la DB vector dedicada
 * (`KNEX_VECTOR_DB`), denormalizada (brand_name/product_name) para que el
 * matcher haga KNN sin join cross-DB.
 *
 * Cada tick:
 *   1. Lee productos activos de la fuente (id, brand, nombre).
 *   2. Borra del vector store los que dejaron de estar activos (con guarda
 *      anti-wipe: si borraría >30% del store, la fuente está mal apuntada).
 *   3. Detecta nuevos (no están en el store) o renombrados (`source_text`
 *      difiere) → los re-embebe via Voyage (input_type='document') y upsert.
 *
 * Idempotente, bounded (hasta `tickBatch` por tick), failure-tolerant. No-op
 * si falta `VOYAGE_API_KEY` o `VECTOR_DATABASE_URL`.
 */
@Injectable()
export class EmbeddingSyncService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingSyncService.name);
  private isRunning = false;
  private readonly hasKey = !!process.env.VOYAGE_API_KEY;
  /** Máximo de productos re-embebidos por tick (acota costo Voyage por tick). */
  private readonly tickBatch = Number(process.env.VECTOR_SYNC_TICK_BATCH) || 200;
  /** Voyage acepta hasta 128 inputs por request. */
  private readonly embedChunk = 100;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Inject(KNEX_VECTOR_DB) private readonly vectorDb: Knex | null,
    private readonly embeddings: EmbeddingsService,
  ) {}

  onModuleInit(): void {
    if (!this.hasKey) {
      this.logger.warn(
        'EmbeddingSyncService: VOYAGE_API_KEY no configurada — scanner en no-op, sync-now responde sin trabajo.',
      );
    } else if (!this.vectorDb) {
      this.logger.warn(
        'EmbeddingSyncService: VECTOR_DATABASE_URL no configurada — scanner en no-op. Setear para activar la DB vector dedicada.',
      );
    } else {
      this.logger.log(
        `EmbeddingSyncService habilitado (tickBatch=${this.tickBatch}, cron=cada 15min).`,
      );
    }
  }

  @Cron('0 */15 * * * *')
  async tick(): Promise<void> {
    if (!this.hasKey || !this.vectorDb) return;
    if (this.isRunning) {
      this.logger.warn('tick(): run anterior aún en curso, skip.');
      return;
    }
    this.isRunning = true;
    try {
      const r = await this.syncBatch();
      if (r.processed > 0 || r.deleted > 0) {
        this.logger.log(
          `tick(): ${r.processed} embebidos, ${r.deleted} borrados, ${r.failed} fallidos, ${r.pending} pendientes.`,
        );
      }
    } catch (e: any) {
      this.logger.error(`tick() falló: ${e.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private sourceText(brandName: string | null, productName: string): string {
    return [brandName, productName]
      .filter((s) => s && s.trim())
      .map((s) => s!.trim())
      .join(' — ');
  }

  /**
   * Una iteración del sync. Devuelve métricas para el endpoint manual.
   * `pending` = stale restantes tras este batch (re-correr para drenar).
   */
  async syncBatch(): Promise<{
    processed: number;
    failed: number;
    deleted: number;
    pending: number;
  }> {
    if (!this.vectorDb) {
      throw new Error('VECTOR_DATABASE_URL no configurada — no hay DB vector destino.');
    }

    // 1) Productos activos de la fuente.
    const active: {
      id: string;
      tenant_id: string | null;
      brand_id: string | null;
      product_name: string;
      brand_name: string | null;
    }[] = await this.knex('products as p')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .where('p.activo', true)
      .select(
        'p.id',
        'p.tenant_id',
        'p.brand_id',
        'p.nombre as product_name',
        'b.nombre as brand_name',
      );

    const activeIds = new Set(active.map((p) => p.id));

    // 2) Estado actual del vector store (id → source_text).
    const existingRows: { product_id: string; source_text: string }[] =
      await this.vectorDb('product_embeddings').select('product_id', 'source_text');
    const existing = new Map(existingRows.map((r) => [r.product_id, r.source_text]));

    // 3) Borrar inactivos (en el store pero ya no activos en la fuente).
    //    Guarda anti-wipe: si borrar limpiaría >30% del store, la fuente
    //    probablemente está mal apuntada (ej. PRODUCT_SOURCE_URL → DB con
    //    catálogo viejo/parcial). Saltamos el delete y alertamos en vez de
    //    vaciar el RAG sembrado.
    const toDelete = existingRows
      .map((r) => r.product_id)
      .filter((id) => !activeIds.has(id));
    let deleted = 0;
    const wipeRatio = existingRows.length > 0 ? toDelete.length / existingRows.length : 0;
    if (toDelete.length > 0 && wipeRatio > 0.3) {
      this.logger.error(
        `syncBatch: el delete eliminaría ${toDelete.length}/${existingRows.length} (${Math.round(wipeRatio * 100)}%) del store. ` +
          `Fuente probablemente incompleta — SALTANDO borrado. Revisar PRODUCT_SOURCE_URL.`,
      );
    } else if (toDelete.length > 0) {
      for (let i = 0; i < toDelete.length; i += 500) {
        const chunk = toDelete.slice(i, i + 500);
        deleted += await this.vectorDb('product_embeddings')
          .whereIn('product_id', chunk)
          .del();
      }
    }

    // 4) Detectar stale: nuevos o renombrados (source_text difiere).
    const staleAll = active.filter((p) => {
      const text = this.sourceText(p.brand_name, p.product_name);
      return existing.get(p.id) !== text;
    });
    const pending = Math.max(0, staleAll.length - this.tickBatch);
    const batch = staleAll.slice(0, this.tickBatch);

    if (batch.length === 0) {
      return { processed: 0, failed: 0, deleted, pending: 0 };
    }

    // 5) Embeber en sub-chunks (límite Voyage) + upsert.
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < batch.length; i += this.embedChunk) {
      const chunk = batch.slice(i, i + this.embedChunk);
      const texts = chunk.map((p) => this.sourceText(p.brand_name, p.product_name));
      let vectors: number[][];
      try {
        vectors = await this.embeddings.embedBatch(texts, 'document');
      } catch (e: any) {
        this.logger.warn(
          `syncBatch: Voyage embedBatch falló (${e.message}). Reintenta próximo tick.`,
        );
        failed += chunk.length;
        continue;
      }

      await this.vectorDb.transaction(async (trx) => {
        for (let j = 0; j < chunk.length; j++) {
          try {
            const p = chunk[j];
            const vecLiteral = `[${vectors[j].join(',')}]`;
            await trx.raw(
              `
              INSERT INTO product_embeddings
                (product_id, tenant_id, brand_id, brand_name, product_name, source_text, embedding, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?::vector, now())
              ON CONFLICT (product_id) DO UPDATE SET
                tenant_id    = EXCLUDED.tenant_id,
                brand_id     = EXCLUDED.brand_id,
                brand_name   = EXCLUDED.brand_name,
                product_name = EXCLUDED.product_name,
                source_text  = EXCLUDED.source_text,
                embedding    = EXCLUDED.embedding,
                updated_at   = now()
              `,
              [
                p.id,
                p.tenant_id,
                p.brand_id,
                p.brand_name,
                p.product_name,
                texts[j],
                vecLiteral,
              ],
            );
            processed++;
          } catch (e: any) {
            failed++;
            this.logger.warn(
              `syncBatch: upsert falló para ${chunk[j].id}: ${e.message}`,
            );
          }
        }
      });
    }

    return { processed, failed, deleted, pending };
  }
}
