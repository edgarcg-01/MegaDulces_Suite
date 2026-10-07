import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_VECTOR_DB, EmbeddingsService } from '@megadulces/platform-core';

/**
 * MAAT.9 (RAG) — Retrieval semántico de la base de conocimiento de Maat.
 *
 * Vectoriza cada entrada de `finance.knowledge` (Voyage voyage-3, 1024d) y la
 * guarda en la DB vector dedicada (misma de Fase K, VECTOR_DATABASE_URL). El
 * tool `maat_conocimiento` busca por similitud coseno en vez de ILIKE → entiende
 * parafraseo/sinónimos ("¿por qué se duplican las compras?" encuentra el issue
 * del 4× aunque no compartan palabras).
 *
 * Degrada solo: sin vectorDb / sin VOYAGE_API_KEY / si falla, el tool cae a la
 * búsqueda ILIKE. Tabla denormalizada (sin join cross-DB): trae la entrada completa.
 * PK (tenant_id, kind, title) espeja la unique key de finance.knowledge → upserts
 * y re-embeds idempotentes.
 */
const VEC_DIM = 1024; // voyage-3
const MIN_SCORE = 0.42; // por debajo es ruido

export interface KnowledgeHit {
  kind: string;
  title: string;
  body: string;
  source?: string;
  score: number;
}

@Injectable()
export class MaatKnowledgeVectorService {
  private readonly logger = new Logger(MaatKnowledgeVectorService.name);
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
      CREATE TABLE IF NOT EXISTS maat_knowledge_embeddings (
        tenant_id  text NOT NULL,
        kind       text NOT NULL,
        title      text NOT NULL,
        body       text NOT NULL,
        source     text,
        embedding  vector(${VEC_DIM}),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, kind, title)
      )`);
    await this.vectorDb
      .raw(`CREATE INDEX IF NOT EXISTS idx_maat_kb_emb_hnsw ON maat_knowledge_embeddings USING hnsw (embedding vector_cosine_ops)`)
      .catch((e: any) => this.logger.warn(`HNSW index: ${e?.message || e}`));
    this.schemaReady = true;
  }

  private literal(vec: number[]): string {
    return `[${vec.join(',')}]`;
  }

  /** KNN de conocimiento parecido a la query. `kind` opcional acota el tipo. */
  async search(tenantId: string, query: string, kind?: string, k = 6): Promise<KnowledgeHit[]> {
    if (!this.available() || !query?.trim()) return [];
    try {
      await this.ensureSchema();
      const vec = await this.embeddings.embedSingle(query, 'query');
      const lit = this.literal(vec);
      const params: any[] = [lit, tenantId];
      let kindClause = '';
      if (kind) { kindClause = 'AND kind = ?'; params.push(kind); }
      params.push(lit, k);
      const res = await this.vectorDb!.raw(
        `SELECT kind, title, body, source,
                ROUND((1 - (embedding <=> ?::vector))::numeric, 4) AS score
         FROM maat_knowledge_embeddings
         WHERE tenant_id = ? ${kindClause}
         ORDER BY embedding <=> ?::vector
         LIMIT ?`,
        params,
      );
      return (res.rows || [])
        .filter((r: any) => Number(r.score) >= MIN_SCORE)
        .map((r: any) => ({ kind: r.kind, title: r.title, body: r.body, source: r.source || undefined, score: Number(r.score) }));
    } catch (e: any) {
      this.logger.warn(`vector search falló (${e?.message || e}); fallback a ILIKE.`);
      return [];
    }
  }

  /** Upsert de una entrada (embed del title+body). Best-effort. */
  async upsert(tenantId: string, entry: { kind: string; title: string; body: string; source?: string }): Promise<void> {
    if (!this.available()) return;
    try {
      await this.ensureSchema();
      const text = `${entry.title}\n${entry.body}`;
      const vec = await this.embeddings.embedSingle(text, 'document');
      await this.vectorDb!.raw(
        `INSERT INTO maat_knowledge_embeddings (tenant_id, kind, title, body, source, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?::vector, now())
         ON CONFLICT (tenant_id, kind, title) DO UPDATE SET
           body = EXCLUDED.body, source = EXCLUDED.source,
           embedding = EXCLUDED.embedding, updated_at = now()`,
        [tenantId, entry.kind, entry.title, entry.body, entry.source || null, this.literal(vec)],
      );
    } catch (e: any) {
      this.logger.warn(`vector upsert falló (${e?.message || e})`);
    }
  }

  /** Quita una entrada del índice (al retirar conocimiento). Best-effort. */
  async remove(tenantId: string, kind: string, title: string): Promise<void> {
    if (!this.vectorDb) return;
    try {
      await this.vectorDb('maat_knowledge_embeddings').where({ tenant_id: tenantId, kind, title }).del();
    } catch { /* best-effort */ }
  }

  /** Reindexa un lote de entradas (backfill / re-embed masivo). */
  async reindex(tenantId: string, entries: Array<{ kind: string; title: string; body: string; source?: string }>): Promise<{ indexed: number }> {
    if (!this.available()) return { indexed: 0 };
    await this.ensureSchema();
    let n = 0;
    for (const e of entries) {
      await this.upsert(tenantId, e);
      n++;
    }
    return { indexed: n };
  }
}
