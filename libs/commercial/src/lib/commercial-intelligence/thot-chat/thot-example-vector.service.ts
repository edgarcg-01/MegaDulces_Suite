import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_VECTOR_DB } from '@megadulces/platform-core';
import { EmbeddingsService } from '@megadulces/platform-core';
import { ThotExample } from './thot-examples';

/**
 * TC.4b (ADR-026) — Retrieval de ejemplos por EMBEDDINGS (Voyage + pgvector).
 * Vive en la DB vector dedicada (la misma de Fase K, VECTOR_DATABASE_URL). Mejora
 * el few-shot vs el solape de tokens (entiende parafraseo / sinónimos).
 *
 * Degrada solo: si no hay vectorDb o falla, ThotExamplesService cae al ranking
 * por solape. Tabla denormalizada (sin join cross-DB): trae el ejemplo completo.
 */
const VEC_DIM = 1024; // voyage-3
const MIN_SCORE = 0.45; // por debajo no inyectamos (ruido)

@Injectable()
export class ThotExampleVectorService {
  private readonly logger = new Logger(ThotExampleVectorService.name);
  private schemaReady = false;

  constructor(
    @Optional() @Inject(KNEX_VECTOR_DB) private readonly vectorDb: Knex | null,
    private readonly embeddings: EmbeddingsService,
  ) {}

  available(): boolean {
    return !!this.vectorDb && !!process.env.VOYAGE_API_KEY;
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady || !this.vectorDb) return;
    await this.vectorDb.raw('CREATE EXTENSION IF NOT EXISTS vector');
    await this.vectorDb.raw(`
      CREATE TABLE IF NOT EXISTS thot_example_embeddings (
        tenant_id  text NOT NULL,
        example_id text NOT NULL,
        profile    text NOT NULL DEFAULT 'all',
        question   text NOT NULL,
        answer     text,
        tools      jsonb DEFAULT '[]',
        note       text,
        enabled    boolean NOT NULL DEFAULT true,
        embedding  vector(${VEC_DIM}),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, example_id)
      )`);
    await this.vectorDb.raw(
      `CREATE INDEX IF NOT EXISTS idx_thot_ex_emb_hnsw ON thot_example_embeddings USING hnsw (embedding vector_cosine_ops)`,
    ).catch((e: any) => this.logger.warn(`HNSW index: ${e?.message || e}`));
    this.schemaReady = true;
  }

  private literal(vec: number[]): string {
    return `[${vec.join(',')}]`;
  }

  /** KNN de ejemplos parecidos a la pregunta (enabled, perfil o 'all'). */
  async search(tenantId: string, profile: string, question: string, k = 3): Promise<ThotExample[]> {
    if (!this.available() || !question?.trim()) return [];
    try {
      await this.ensureSchema();
      const vec = await this.embeddings.embedSingle(question, 'query');
      const lit = this.literal(vec);
      const res = await this.vectorDb!.raw(
        `SELECT profile, question, answer, tools, note,
                ROUND((1 - (embedding <=> ?::vector))::numeric, 4) AS score
         FROM thot_example_embeddings
         WHERE tenant_id = ? AND enabled = true AND (profile = ? OR profile = 'all')
         ORDER BY embedding <=> ?::vector
         LIMIT ?`,
        [lit, tenantId, profile, lit, k],
      );
      return (res.rows || [])
        .filter((r: any) => Number(r.score) >= MIN_SCORE)
        .map((r: any) => ({
          profile: r.profile === 'all' ? undefined : r.profile,
          question: r.question,
          answer: r.answer || '',
          tools: Array.isArray(r.tools) ? r.tools.map((t: any) => t?.name || t) : [],
          note: r.note || undefined,
        }));
    } catch (e: any) {
      this.logger.warn(`vector search falló (${e?.message || e}); fallback a solape.`);
      return [];
    }
  }

  /** Upsert de un ejemplo (embed de la pregunta). Best-effort. */
  async upsert(tenantId: string, exampleId: string, ex: { profile?: string; question: string; answer?: string; tools?: any[]; note?: string; enabled?: boolean }): Promise<void> {
    if (!this.available()) return;
    try {
      await this.ensureSchema();
      const vec = await this.embeddings.embedSingle(ex.question, 'document');
      await this.vectorDb!.raw(
        `INSERT INTO thot_example_embeddings (tenant_id, example_id, profile, question, answer, tools, note, enabled, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::vector, now())
         ON CONFLICT (tenant_id, example_id) DO UPDATE SET
           profile = EXCLUDED.profile, question = EXCLUDED.question, answer = EXCLUDED.answer,
           tools = EXCLUDED.tools, note = EXCLUDED.note, enabled = EXCLUDED.enabled,
           embedding = EXCLUDED.embedding, updated_at = now()`,
        [tenantId, exampleId, ex.profile || 'all', ex.question, ex.answer || null,
         JSON.stringify(ex.tools || []), ex.note || null, ex.enabled !== false, this.literal(vec)],
      );
    } catch (e: any) {
      this.logger.warn(`vector upsert falló (${e?.message || e})`);
    }
  }

  async setEnabled(tenantId: string, exampleId: string, enabled: boolean): Promise<void> {
    if (!this.available()) return;
    try {
      await this.vectorDb!('thot_example_embeddings').where({ tenant_id: tenantId, example_id: exampleId }).update({ enabled });
    } catch { /* best-effort */ }
  }

  /** Reindexa: embebe semillas + ejemplos curados en lote. */
  async reindex(tenantId: string, seeds: ThotExample[], curated: Array<{ id: string } & ThotExample>): Promise<{ indexed: number }> {
    if (!this.available()) return { indexed: 0 };
    await this.ensureSchema();
    let n = 0;
    for (let i = 0; i < seeds.length; i++) {
      await this.upsert(tenantId, `seed:${i}`, { ...seeds[i], enabled: true });
      n++;
    }
    for (const c of curated) {
      await this.upsert(tenantId, c.id, c);
      n++;
    }
    return { indexed: n };
  }
}
