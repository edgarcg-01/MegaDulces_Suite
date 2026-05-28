import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '../../shared/database/new-database.module';
import { EmbeddingsService } from '../../shared/ai/embeddings.service';
import { LlmExtractorService } from '../../shared/ai/llm-extractor.service';

export interface MatchedProduct {
  product_id: string;
  brand_id: string | null;
  brand_name: string | null;
  product_name: string;
  score: number; // 0..1 (cosine similarity)
}

export interface MatchedItem {
  raw: string;
  normalized: string;
  suggested: (MatchedProduct & { autoConfirm: boolean }) | null;
  alternatives: MatchedProduct[]; // top 2 además del suggested
}

export interface MatchResponse {
  items: MatchedItem[];
  meta: {
    items_count: number;
    elapsed_ms: number;
    extractor_used: 'claude' | 'heuristic' | 'mixed';
  };
}

/**
 * Threshold para auto-confirmar un match.
 *
 * Iteración 2026-05-27 (post-K.1.7 smoke HTTP real): el smoke K.0 había
 * sugerido 0.50 pero al probar con texto crudo + Haiku extract, scores
 * típicos de matches obvios cayeron en 0.38-0.49. Bajado a 0.40 para
 * capturar hits buenos sin meter falsos positivos.
 *
 * Conservador a propósito — false negatives son OK (UX espera revisión),
 * false positives ROMPEN data.
 */
const AUTO_CONFIRM_THRESHOLD = 0.4;

const MAX_ITEMS_DEFAULT = 50;
const MAX_RAW_LENGTH = 5000;

@Injectable()
export class AiProductMatcherService {
  private readonly logger = new Logger(AiProductMatcherService.name);
  private readonly maxItems: number;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly embeddings: EmbeddingsService,
    private readonly extractor: LlmExtractorService,
  ) {
    const parsed = Number(process.env.AI_PRODUCT_MATCH_MAX_ITEMS);
    this.maxItems =
      Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_ITEMS_DEFAULT;
  }

  async match(rawText: string): Promise<MatchResponse> {
    const t0 = Date.now();
    const trimmed = (rawText ?? '').trim();

    if (!trimmed) {
      throw new BadRequestException('rawText vacío');
    }
    if (trimmed.length > MAX_RAW_LENGTH) {
      throw new BadRequestException(
        `rawText supera ${MAX_RAW_LENGTH} caracteres (recibido ${trimmed.length})`,
      );
    }

    // 1) Extract items via Claude (con fallback heurístico interno).
    const extracted = await this.extractor.extractProductItems(trimmed);
    if (extracted.length === 0) {
      return {
        items: [],
        meta: {
          items_count: 0,
          elapsed_ms: Date.now() - t0,
          extractor_used: 'heuristic',
        },
      };
    }
    if (extracted.length > this.maxItems) {
      throw new BadRequestException(
        `Se detectaron ${extracted.length} items, máximo permitido ${this.maxItems}. ` +
          `Dividí la lista en varios envíos.`,
      );
    }

    // 2) Embed batch los normalizados con input_type='query' (Voyage optimiza
    //    diferente vs documentos del corpus).
    const queries = extracted.map((it) => it.normalized);
    const vectors = await this.embeddings.embedBatch(queries, 'query');

    // 3) KNN top-3 por item (paralelo). HNSW index parcial + WHERE activo=true
    //    + embedding IS NOT NULL = scan en ~2-5ms cada uno.
    const items: MatchedItem[] = await Promise.all(
      extracted.map(async (it, idx) => {
        const vec = vectors[idx];
        const vecLiteral = `[${vec.join(',')}]`;

        // `1 - (embedding <=> $1)` convierte cosine distance → cosine similarity.
        // Score 1.0 = idéntico, 0 = ortogonal. (Negativo = anti-correlación,
        // imposible con embeddings normalizados de Voyage).
        const rows = await this.knex.raw(
          `
          SELECT p.id AS product_id,
                 p.brand_id,
                 b.nombre AS brand_name,
                 p.nombre AS product_name,
                 ROUND((1 - (p.embedding <=> ?::vector))::numeric, 4) AS score
          FROM products p
          LEFT JOIN brands b ON b.id = p.brand_id
          WHERE p.activo = true AND p.embedding IS NOT NULL
          ORDER BY p.embedding <=> ?::vector
          LIMIT 3
          `,
          [vecLiteral, vecLiteral],
        );

        const matches: MatchedProduct[] = rows.rows.map((r: any) => ({
          product_id: r.product_id,
          brand_id: r.brand_id,
          brand_name: r.brand_name,
          product_name: r.product_name,
          score: Number(r.score),
        }));

        const [top, ...rest] = matches;
        const suggested = top
          ? { ...top, autoConfirm: top.score >= AUTO_CONFIRM_THRESHOLD }
          : null;

        return {
          raw: it.raw,
          normalized: it.normalized,
          suggested,
          alternatives: rest,
        };
      }),
    );

    const elapsed = Date.now() - t0;
    this.logger.log(
      `match(): ${extracted.length} items en ${elapsed}ms ` +
        `(autoConfirm=${items.filter((i) => i.suggested?.autoConfirm).length})`,
    );

    return {
      items,
      meta: {
        items_count: extracted.length,
        elapsed_ms: elapsed,
        // El extractor decide internamente claude vs heurístico; reportamos
        // genéricamente para no acoplar al controller. Podríamos exponer si
        // hizo falta — por ahora "claude" si la key existe, "heuristic" si no.
        extractor_used: process.env.ANTHROPIC_API_KEY ? 'claude' : 'heuristic',
      },
    };
  }
}
