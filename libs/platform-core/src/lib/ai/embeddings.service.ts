import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Wrapper de Voyage AI Embeddings (Fase K — AI product match).
 *
 * Provee `embedSingle` y `embedBatch` con retry exponencial en 429/5xx.
 * Usar `input_type: 'query'` al embeber queries de búsqueda online y
 * `'document'` al embeber el corpus (mejora la calidad del KNN según los
 * docs de Voyage).
 *
 * Vars necesarias en `.env`:
 *   - VOYAGE_API_KEY (required)
 *   - VOYAGE_EMBED_MODEL (default 'voyage-3')
 *
 * Dim esperada: 1024 (voyage-3 default).
 */
@Injectable()
export class EmbeddingsService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly endpoint = 'https://api.voyageai.com/v1/embeddings';
  private readonly model = process.env.VOYAGE_EMBED_MODEL || 'voyage-3';
  private readonly apiKey = process.env.VOYAGE_API_KEY || '';
  private readonly maxAttempts = 3;
  private readonly timeoutMs = 10_000;

  onModuleInit(): void {
    if (!this.apiKey) {
      // Log warning en lugar de throw: la app puede arrancar sin esta key
      // si nadie llega al endpoint AI. Recién al primer match-ai falla con
      // 500 — mensaje claro abajo.
      this.logger.warn(
        'VOYAGE_API_KEY no configurada. /products/match-ai responderá 500.',
      );
    } else {
      this.logger.log(`Voyage embeddings habilitado (model=${this.model}).`);
    }
  }

  async embedSingle(
    text: string,
    inputType: 'query' | 'document' = 'query',
  ): Promise<number[]> {
    const [vec] = await this.embedBatch([text], inputType);
    return vec;
  }

  async embedBatch(
    texts: string[],
    inputType: 'query' | 'document' = 'query',
  ): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error(
        'EmbeddingsService: falta VOYAGE_API_KEY en .env. Generar key en https://dash.voyageai.com',
      );
    }
    if (texts.length === 0) return [];
    if (texts.length > 128) {
      throw new Error(
        `EmbeddingsService: Voyage acepta hasta 128 inputs por request, recibido ${texts.length}`,
      );
    }

    return this.callWithRetry(texts, inputType, 1);
  }

  private async callWithRetry(
    texts: string[],
    inputType: 'query' | 'document',
    attempt: number,
  ): Promise<number[][]> {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
          input_type: inputType,
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(tId);
      // Network / timeout: reintenta hasta maxAttempts.
      if (attempt < this.maxAttempts) {
        const wait = 1000 * Math.pow(2, attempt);
        this.logger.warn(
          `Voyage network error (intento ${attempt}/${this.maxAttempts}): ${e.message}. Retry en ${wait}ms`,
        );
        await new Promise((r) => setTimeout(r, wait));
        return this.callWithRetry(texts, inputType, attempt + 1);
      }
      throw new Error(`Voyage unreachable tras ${this.maxAttempts} intentos: ${e.message}`);
    }
    clearTimeout(tId);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attempt < this.maxAttempts) {
        const wait = 1000 * Math.pow(2, attempt);
        this.logger.warn(
          `Voyage ${res.status} (intento ${attempt}/${this.maxAttempts}). Retry en ${wait}ms`,
        );
        await new Promise((r) => setTimeout(r, wait));
        return this.callWithRetry(texts, inputType, attempt + 1);
      }
      throw new Error(`Voyage API ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
