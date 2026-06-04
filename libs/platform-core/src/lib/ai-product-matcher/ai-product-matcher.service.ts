import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../database/database.module';
import { KNEX_VECTOR_DB } from '../database/vector-database.module';
import { EmbeddingsService } from '../ai/embeddings.service';
import { LlmExtractorService } from '../ai/llm-extractor.service';

export interface MatchedProduct {
  product_id: string;
  brand_id: string | null;
  brand_name: string | null;
  product_name: string;
  score: number; // 0..1 (cosine similarity)
  /**
   * Solo en el path `active` (matcher del ticket del vendedor contra
   * `inventory.products_active`): SKU del producto ERP. En el path `catalog`
   * queda null (los consumidores ahí usan `product_id` UUID).
   */
  sku?: string | null;
}

export type MatchConfidence = 'high' | 'medium' | 'low' | 'no_match';

export interface MatchedItem {
  raw: string;
  normalized: string;
  /** Cantidad solicitada por el usuario en el query crudo. Default 1. */
  quantity: number;
  suggested:
    | (MatchedProduct & { autoConfirm: boolean; confidence: MatchConfidence })
    | null;
  alternatives: MatchedProduct[]; // top 2 además del suggested
  confidence: MatchConfidence; // duplicado a top-level para queries no_match
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
 * Thresholds dinámicos para auto-confirmar y clasificar confidence.
 *
 * Iteración 2026-05-28: el threshold estático 0.40 daba dos clases de bugs:
 *   - "borrachito" (no existe en catálogo) → matcheaba SOPA MARUCHAN a 0.43.
 *   - "volt azul" → matcheaba ELECTROLIT MORA AZUL a 0.37 cuando había
 *     VOLT BLUE ENERGY disponible.
 *
 * Ahora el threshold depende del bonus textual (señales de match real):
 *   - Bonus alto (≥0.30): match con evidencia textual — threshold 0.35 OK.
 *   - Bonus medio (0.10..0.30): match parcial — threshold 0.50.
 *   - Bonus 0 (sin overlap ni brand): puro embedding — threshold 0.65.
 *
 * Conservador a propósito — false negatives son OK (UX espera revisión),
 * false positives ROMPEN data.
 */
// Fix 2 (2026-05-29): subimos thresholds para autoConfirm. Antes
// THRESHOLD_HIGH_BONUS=0.35 dejaba pasar matches puramente por marca a "high".
const THRESHOLD_HIGH_BONUS = 0.55;
const THRESHOLD_MID_BONUS = 0.6;
const THRESHOLD_NO_BONUS = 0.7;
const BONUS_HIGH_CUTOFF = 0.3;
const BONUS_MID_CUTOFF = 0.1;

/**
 * Confidence cutoffs sobre el score final (post-bonus).
 * Fix 2: HIGH subido de 0.6 → 0.65 para reducir false positives.
 */
const CONFIDENCE_HIGH = 0.65;
const CONFIDENCE_MEDIUM = 0.45;
const CONFIDENCE_LOW = 0.3;

const MAX_ITEMS_DEFAULT = 50;
const MAX_RAW_LENGTH = 5000;

/**
 * Hybrid scoring weights (post-rerank).
 *
 * Iteración 2026-05-28 v2 — calidad máxima:
 *   - BRAND_TOKEN_MATCH: query contiene token de brand_name registrada → +0.25
 *   - INFERRED_BRAND: query contiene PRIMER token del product_name (real brand
 *     cuando registrada como distribuidor — ej VOLT bajo AJEMEX) → +0.20
 *   - FIRST_TOKEN: query contiene el PRIMER token del product_name → +0.20
 *     (se solapa con inferred brand cuando hay categoría/distribuidor, pero
 *     cuentan independiente — un query como "volt azul" gana mucho aquí)
 *   - TOKEN_OVERLAP_MAX: fracción de query tokens en product_name → hasta +0.20
 *   - HIGH_COVERAGE_BONUS: si ≥50% query tokens matchean → +0.15 extra
 */
const RERANK_TOP_K = 50;
const BONUS_BRAND_TOKEN_MATCH = 0.25;
const BONUS_INFERRED_BRAND_MATCH = 0.2;
const BONUS_FIRST_TOKEN = 0.2;
const BONUS_TOKEN_OVERLAP_MAX = 0.2;
const BONUS_HIGH_COVERAGE = 0.15;
const HIGH_COVERAGE_FRACTION = 0.5;
const RETURN_TOP_N = 3;

/**
 * Fixes 2026-05-29 (post-ticket OCR real):
 *
 * 1. **Variant mismatch cap**: si el query tiene ≥2 tokens distintivos (no brand,
 *    >=3 chars, no stopword) y NINGUNO matchea el candidato → es match "brand-only".
 *    Capamos el score combinado al techo de "medium" para que no llegue a "high"
 *    (caso VERO MIX DULCE CLUB ≠ VERO SANDIBROCHAS).
 *
 * 2. **Thresholds estrictos**: HIGH ahora exige score ≥ 0.65 (era 0.6), y para
 *    autoConfirm bajo "high bonus" exigimos score ≥ 0.55 (era 0.35). Reduce
 *    falsos positivos en tickets ruidosos.
 *
 * 3. **No catálogo**: si el cosine BRUTO (pre-bonus) es < 0.25, forzamos
 *    `no_match` aunque la marca coincida. Atrapa items que no existen
 *    en el catálogo (caso POPOTIX → ORBIT).
 */
const VARIANT_MISMATCH_CAP = 0.55; // techo cuando brand-only y variant no aparece
const MIN_DISTINCTIVE_TOKEN_LEN = 3;
const MIN_DISTINCTIVE_QUERY_TOKENS_FOR_PENALTY = 2;
const NO_CATALOG_RAW_THRESHOLD = 0.25;

@Injectable()
export class AiProductMatcherService {
  private readonly logger = new Logger(AiProductMatcherService.name);
  private readonly maxItems: number;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Inject(KNEX_VECTOR_DB) private readonly vectorDb: Knex | null,
    private readonly embeddings: EmbeddingsService,
    private readonly extractor: LlmExtractorService,
  ) {
    const parsed = Number(process.env.AI_PRODUCT_MATCH_MAX_ITEMS);
    this.maxItems =
      Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_ITEMS_DEFAULT;
    if (this.vectorDb) {
      this.logger.log('Matcher usa la DB vector dedicada (product_embeddings).');
    } else {
      this.logger.warn(
        'Matcher usa la fuente legacy (products.embedding). Setear VECTOR_DATABASE_URL para la DB dedicada.',
      );
    }
  }

  /**
   * KNN coseno overfetch a K=RERANK_TOP_K. Si hay DB vector dedicada, consulta
   * `product_embeddings` (denormalizada, sin join). Si no, cae a la fuente
   * legacy `products.embedding` con join a brands.
   */
  private async knnCandidates(
    vecLiteral: string,
    source: 'catalog' | 'active' = 'catalog',
  ): Promise<MatchedProduct[]> {
    // Path `active`: ticket del vendedor contra `inventory.products_active`
    // (6489), keyed por sku, en su PROPIA tabla del vector store
    // (`active_product_embeddings`). Aislado del corpus catalog (1199) que usan
    // captures y route-control. Requiere vector DB dedicada (sin fallback).
    if (source === 'active') {
      if (!this.vectorDb) {
        this.logger.warn(
          'knnCandidates(active) sin vector DB — no hay corpus de inventory.products_active. Devuelve vacío.',
        );
        return [];
      }
      const rows = await this.vectorDb.raw(
        `
        SELECT sku,
               product_name,
               category,
               ROUND((1 - (embedding <=> ?::vector))::numeric, 4) AS score
        FROM active_product_embeddings
        ORDER BY embedding <=> ?::vector
        LIMIT ${RERANK_TOP_K}
        `,
        [vecLiteral, vecLiteral],
      );
      return rows.rows.map((r: any) => ({
        product_id: '', // el path active identifica por sku, no UUID
        sku: r.sku,
        brand_id: null,
        brand_name: r.category ?? null,
        product_name: r.product_name,
        score: Number(r.score),
      }));
    }

    if (this.vectorDb) {
      const rows = await this.vectorDb.raw(
        `
        SELECT product_id,
               brand_id,
               brand_name,
               product_name,
               ROUND((1 - (embedding <=> ?::vector))::numeric, 4) AS score
        FROM product_embeddings
        ORDER BY embedding <=> ?::vector
        LIMIT ${RERANK_TOP_K}
        `,
        [vecLiteral, vecLiteral],
      );
      return rows.rows.map((r: any) => ({
        product_id: r.product_id,
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        product_name: r.product_name,
        score: Number(r.score),
        sku: null,
      }));
    }

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
      LIMIT ${RERANK_TOP_K}
      `,
      [vecLiteral, vecLiteral],
    );
    return rows.rows.map((r: any) => ({
      product_id: r.product_id,
      brand_id: r.brand_id,
      brand_name: r.brand_name,
      product_name: r.product_name,
      score: Number(r.score),
    }));
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
    return this.matchExtractedItems(extracted, t0);
  }

  /**
   * Variante para Fase V (ticket OCR): el caller ya tiene items extraídos
   * (vision Claude leyó el ticket) y solo necesita la fase de matching contra
   * el catálogo (embed + KNN + rerank). Reutiliza todo el pipeline post-extract.
   */
  async matchExtractedItems(
    extracted: { raw: string; normalized: string; quantity: number }[],
    t0: number = Date.now(),
    source: 'catalog' | 'active' = 'catalog',
  ): Promise<MatchResponse> {
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

    // 3) KNN + rerank híbrido en JS. Overfetch a K=50 para que rerank tenga
    //    suficiente recall.
    const items: MatchedItem[] = await Promise.all(
      extracted.map(async (it, idx) => {
        try {
          const vec = vectors[idx];
          const vecLiteral = `[${vec.join(',')}]`;

          const candidates = await this.knnCandidates(vecLiteral, source);

          const rerankedFull = this.rerankCandidates(it.normalized, candidates);
          const reranked = rerankedFull.slice(0, RETURN_TOP_N);

          const [top, ...rest] = reranked;
          const topBonus = top ? top.bonus : 0;

          const decision = this.classifyMatch(top, topBonus);

          // Strip intermediates antes de mandar al wire (bonus / rawScore /
          // variantMismatch son solo señales internas del rerank+classifier).
          const cleanRest = rest.map(
            ({ bonus: _b, rawScore: _r, variantMismatch: _v, ...r }) => r,
          );

          const suggested =
            top && decision.confidence !== 'no_match'
              ? {
                  product_id: top.product_id,
                  sku: top.sku ?? null,
                  brand_id: top.brand_id,
                  brand_name: top.brand_name,
                  product_name: top.product_name,
                  score: top.score,
                  autoConfirm: decision.autoConfirm,
                  confidence: decision.confidence,
                }
              : null;

          return {
            raw: it.raw,
            normalized: it.normalized,
            quantity: it.quantity,
            suggested,
            alternatives: cleanRest,
            confidence: decision.confidence,
          };
        } catch (err: any) {
          this.logger.error(
            `match() item "${it.raw}" → "${it.normalized}" falló: ${err?.message}`,
            err?.stack,
          );
          return {
            raw: it.raw,
            normalized: it.normalized,
            quantity: it.quantity,
            suggested: null,
            alternatives: [],
            confidence: 'no_match' as MatchConfidence,
          };
        }
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

  /**
   * Re-rank de candidatos KNN sumando 2 señales textuales al cosine sim del
   * vector:
   *   - **Brand token match**: si CUALQUIER token de la marca aparece en el
   *     query → +0.25. Catches "lucas panzon" (brand LUCAS), "la rosa", "canels".
   *   - **Token Jaccard parcial**: porcentaje de tokens del query que aparecen
   *     en el product_name → hasta +0.20. Catches keywords como "mazapán",
   *     "chicle", "azul", "fresa" sin necesidad de marca.
   *
   * Score combinado = `min(1.0, cosine + bonus_brand + bonus_overlap)`.
   *
   * El re-rank cambia el ORDEN dentro de los top-K candidatos del KNN. No
   * agrega productos nuevos (HNSW ya filtró el corpus). Por eso overfetch a
   * K=20 — necesitamos suficiente recall del KNN para que el rerank pueda
   * encontrar el ganador correcto incluso si vec_score lo puso en posición 5+.
   */
  private rerankCandidates(
    query: string,
    candidates: MatchedProduct[],
  ): (MatchedProduct & {
    bonus: number;
    rawScore: number;
    variantMismatch: boolean;
  })[] {
    const queryNorm = this.normalizeForMatch(query);
    const queryTokens = this.tokenize(queryNorm);
    const queryTokenSet = new Set(queryTokens);

    const scored = candidates.map((c) => {
      let bonus = 0;
      const rawScore = c.score;

      const productTokens = this.tokenize(
        this.normalizeForMatch(c.product_name),
      );
      const productTokenSet = new Set(productTokens);

      // Tokens de la marca del candidato (para fix 1: excluirlos al medir
      // "distintividad" del query).
      const brandTokens = c.brand_name
        ? this.tokenize(this.normalizeForMatch(c.brand_name))
        : [];
      const brandTokenSet = new Set(brandTokens);

      // 1) Brand token match: si query contiene algún token significativo
      //    de la marca registrada (brand_name). Catches "lucas X" → marca LUCAS.
      if (c.brand_name) {
        const queryHasBrand = brandTokens.some((bt) => queryTokenSet.has(bt));
        if (queryHasBrand) bonus += BONUS_BRAND_TOKEN_MATCH;
      }

      // 2) Inferred brand: cuando la "brand real" está registrada como
      //    distribuidor (ej VOLT bajo AJEMEX), el primer token del product_name
      //    suele ser la marca verdadera. Si está en el query, boostear igual
      //    que un brand match.
      if (productTokens.length > 0 && queryTokenSet.has(productTokens[0])) {
        bonus += BONUS_INFERRED_BRAND_MATCH;
      }

      // 3) First-token bonus: query token matchea cualquier token al inicio
      //    del product_name. Los primeros 2 tokens del product_name suelen
      //    cargar la identidad (marca/sub-marca). Captura "volt" en
      //    "VOLT BLUE ENERGY", "lucas" en "LUCAS PANZON".
      //    NB: se solapa parcialmente con inferred brand; intencional — refuerza.
      const firstTwo = productTokens.slice(0, 2);
      const queryMatchesFirst = firstTwo.some((pt) => queryTokenSet.has(pt));
      if (queryMatchesFirst) bonus += BONUS_FIRST_TOKEN;

      // 4) Token coverage del query: fracción de tokens del query que aparecen
      //    en product_name. Sesgado al QUERY (no Jaccard completo) porque los
      //    product_names son más largos.
      let fraction = 0;
      if (queryTokens.length > 0) {
        const matches = queryTokens.filter((qt) => productTokenSet.has(qt))
          .length;
        fraction = matches / queryTokens.length;
        bonus += BONUS_TOKEN_OVERLAP_MAX * fraction;
      }

      // 5) High-coverage bonus: si ≥50% de tokens del query están en el
      //    product_name, agrega push extra. Refuerza queries cortos exactos
      //    como "cheto bola" contra "APROZA CHETO BOLA CH 50G".
      if (fraction >= HIGH_COVERAGE_FRACTION) {
        bonus += BONUS_HIGH_COVERAGE;
      }

      // ── Fix 1 (2026-05-29): variant mismatch detector ───────────────────
      // Tokens "distintivos" del query = no brand, no muy cortos, no stopwords.
      // Si el query tiene 2+ tokens distintivos y NINGUNO matchea el candidato,
      // el match es solo por marca → sospechoso. Marcamos para capar el score
      // en classifyMatch.
      const distinctiveQueryTokens = queryTokens.filter(
        (qt) => qt.length >= MIN_DISTINCTIVE_TOKEN_LEN && !brandTokenSet.has(qt),
      );
      const distinctiveMatched = distinctiveQueryTokens.filter((qt) =>
        productTokenSet.has(qt),
      );
      const variantMismatch =
        distinctiveQueryTokens.length >= MIN_DISTINCTIVE_QUERY_TOKENS_FOR_PENALTY &&
        distinctiveMatched.length === 0;

      let combined = Math.min(1.0, rawScore + bonus);
      if (variantMismatch && combined > VARIANT_MISMATCH_CAP) {
        combined = VARIANT_MISMATCH_CAP;
      }

      return {
        ...c,
        score: Number(combined.toFixed(4)),
        rawScore: Number(rawScore.toFixed(4)),
        bonus: Number(bonus.toFixed(4)),
        variantMismatch,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Clasifica el top match en confidence buckets + decide autoConfirm.
   *
   * Threshold dinámico según bonus textual:
   *   - bonus ≥ HIGH_CUTOFF: alta evidencia textual → threshold 0.35.
   *   - bonus ≥ MID_CUTOFF: evidencia parcial → threshold 0.50.
   *   - bonus 0: solo embedding → threshold 0.65 (estricto).
   *
   * Quality gate: si bonus == 0 Y score < threshold → `no_match` (forza al
   * usuario a buscar manual). Esto previene "borrachito" → SOPA MARUCHAN.
   */
  private classifyMatch(
    top:
      | (MatchedProduct & { bonus?: number; rawScore?: number; variantMismatch?: boolean })
      | undefined,
    bonus: number,
  ): { confidence: MatchConfidence; autoConfirm: boolean } {
    if (!top) return { confidence: 'no_match', autoConfirm: false };

    // ── Fix 3 (2026-05-29): "no catálogo" detector ──────────────────────
    // Si el cosine BRUTO (pre-bonus) está muy bajo, el item probablemente NO
    // existe en el catálogo. La marca puede coincidir por azar, pero el
    // embedding no se parece. Forzamos no_match.
    const rawScore = top.rawScore ?? top.score;
    if (rawScore < NO_CATALOG_RAW_THRESHOLD) {
      return { confidence: 'no_match', autoConfirm: false };
    }

    const threshold =
      bonus >= BONUS_HIGH_CUTOFF
        ? THRESHOLD_HIGH_BONUS
        : bonus >= BONUS_MID_CUTOFF
          ? THRESHOLD_MID_BONUS
          : THRESHOLD_NO_BONUS;

    const score = top.score;

    if (bonus === 0 && score < threshold) {
      return { confidence: 'no_match', autoConfirm: false };
    }

    let confidence: MatchConfidence;
    if (score >= CONFIDENCE_HIGH) confidence = 'high';
    else if (score >= CONFIDENCE_MEDIUM) confidence = 'medium';
    else if (score >= CONFIDENCE_LOW) confidence = 'low';
    else confidence = 'no_match';

    // Fix 1 (2026-05-29): si rerank detectó variant mismatch, NUNCA auto-confirmar.
    // El usuario debe revisar la línea manualmente.
    const autoConfirm =
      !top.variantMismatch && score >= threshold && confidence !== 'low';

    return { confidence, autoConfirm };
  }

  /**
   * Normalización para comparar texto: lowercase, NFD + strip diacríticos,
   * collapse punctuation a espacios, trim. Asegura "mazapán" === "mazapan",
   * "canel's" === "canels", "MORA AZUL" === "mora azul".
   */
  private normalizeForMatch(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Tokenize: split por espacios, descarta tokens de 1 char (ruido como "y",
   * números sueltos) y palabras comunes muy frecuentes ("de", "la", "el") que
   * rompen el Jaccard sin aportar señal.
   */
  private tokenize(s: string): string[] {
    const stopwords = new Set([
      'de',
      'la',
      'el',
      'los',
      'las',
      'un',
      'una',
      'y',
      'o',
      'con',
      'sin',
      'para',
      'pz',
      'pza',
      'pzs',
      'gr',
      'kg',
      'ml',
      'lt',
    ]);
    return s
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !stopwords.has(t));
  }
}
