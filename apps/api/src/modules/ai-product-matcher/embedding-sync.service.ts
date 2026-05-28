import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { EmbeddingsService } from '../../shared/ai/embeddings.service';

/**
 * Fase K integridad: scanner periódico que detecta products con embedding
 * stale (insertados sin embedding, renombrados, o brand renombrado) y los
 * re-embed via Voyage.
 *
 * **Cuándo corre**:
 *   - `@Cron('0 *\/15 * * * *')` — cada 15 minutos (segundos 0).
 *   - Endpoint manual `POST /api/ai/products/sync-now` (admin).
 *
 * **Qué detecta stale**:
 *   - `activo = true` (productos soft-deleted no importan).
 *   - `embedding IS NULL` (nunca embedded — backfill original o insert sin hook).
 *   - `embedding_updated_at IS NULL` (marcado stale por trigger o updateBrand).
 *
 * **Idempotente y safe**:
 *   - Lock `isRunning` previene overlap si un tick demora más de 15 min.
 *   - Failure-tolerant: si Voyage cae, log warning y reintenta en el próximo tick.
 *   - No-op si `VOYAGE_API_KEY` falta (warn una vez al boot).
 *
 * **Batches**: 50 products por iteración para acotar memoria + API cost por
 * tick. Si hay 500 stale, se procesan 50 ahora y los otros 450 en los próximos
 * 9 ticks.
 */
@Injectable()
export class EmbeddingSyncService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingSyncService.name);
  private isRunning = false;
  private readonly enabled = !!process.env.VOYAGE_API_KEY;
  private readonly batchSize = 50;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly embeddings: EmbeddingsService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'EmbeddingSyncService: VOYAGE_API_KEY no configurada — el scanner queda en no-op. Llamadas a sync-now responden 503.',
      );
    } else {
      this.logger.log(
        `EmbeddingSyncService habilitado (batch=${this.batchSize}, cron=cada 15min).`,
      );
    }
  }

  /**
   * Ejecutado por NestJS Schedule. Si el tick anterior aún corre, skip.
   */
  @Cron('0 */15 * * * *')
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.isRunning) {
      this.logger.warn('tick(): previous run still in progress, skipping.');
      return;
    }
    this.isRunning = true;
    try {
      const result = await this.syncBatch();
      if (result.processed > 0) {
        this.logger.log(
          `tick(): processed ${result.processed} stale embeddings (${result.failed} failed)`,
        );
      }
    } catch (e: any) {
      this.logger.error(`tick() failed: ${e.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Una iteración del scanner: detecta hasta `batchSize` rows stale, calcula
   * source_text, llama Voyage en un batch, y persiste los embeddings.
   *
   * Devuelve `{ processed, failed }` para reporting / endpoint manual.
   */
  async syncBatch(): Promise<{ processed: number; failed: number; pending: number }> {
    // Detecta stale: activo + (sin embedding O sin updated_at).
    const stale = await this.knex('products as p')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .where('p.activo', true)
      .where((q) =>
        q.whereNull('p.embedding').orWhereNull('p.embedding_updated_at'),
      )
      .orderBy('p.updated_at', 'asc')
      .limit(this.batchSize)
      .select(
        'p.id',
        'p.nombre as product_name',
        'b.nombre as brand_name',
      );

    if (stale.length === 0) {
      return { processed: 0, failed: 0, pending: 0 };
    }

    // Cuenta total de pendientes (sin limit) — útil para reporting.
    const pendingRow = await this.knex('products')
      .where('activo', true)
      .where((q) =>
        q.whereNull('embedding').orWhereNull('embedding_updated_at'),
      )
      .count<{ n: string }[]>('* as n')
      .first();
    const pendingTotal = Number(pendingRow?.n ?? 0);

    // Compose source_text para cada row.
    const sourceTexts = stale.map((r) =>
      [r.brand_name, r.product_name]
        .filter((s) => s && s.trim())
        .map((s) => s.trim())
        .join(' — '),
    );

    let vectors: number[][];
    try {
      vectors = await this.embeddings.embedBatch(sourceTexts, 'document');
    } catch (e: any) {
      this.logger.warn(
        `syncBatch: Voyage embedBatch failed (${e.message}). Reintenta en el próximo tick.`,
      );
      return { processed: 0, failed: stale.length, pending: pendingTotal };
    }

    // Persist embeddings. Hacemos un UPDATE por row dentro de un trx —
    // las queries SQL del trigger reaccionan solo a cambios de nombre/brand_id,
    // así que estos UPDATEs NO re-disparan staleness.
    let failed = 0;
    await this.knex.transaction(async (trx) => {
      for (let i = 0; i < stale.length; i++) {
        try {
          const vecLiteral = `[${vectors[i].join(',')}]`;
          await trx.raw(
            `UPDATE products
               SET embedding = ?::vector,
                   embedding_source_text = ?,
                   embedding_updated_at = NOW()
             WHERE id = ?`,
            [vecLiteral, sourceTexts[i], stale[i].id],
          );
        } catch (e: any) {
          failed++;
          this.logger.warn(
            `syncBatch: failed to persist embedding for ${stale[i].id}: ${e.message}`,
          );
        }
      }
    });

    return {
      processed: stale.length - failed,
      failed,
      pending: Math.max(0, pendingTotal - (stale.length - failed)),
    };
  }
}
