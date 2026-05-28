import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Wrapper de Anthropic Claude Haiku 4.5 — extracción estructurada de items
 * de producto desde texto crudo del colaborador.
 *
 * Input típico:
 *   "carlota fresa, mazapán rosa 12pz / pulparindo y vero mango chamoy"
 *
 * Output:
 *   [
 *     { raw: "carlota fresa", normalized: "carlota fresa" },
 *     { raw: "mazapán rosa 12pz", normalized: "mazapán rosa 12 piezas" },
 *     { raw: "pulparindo", normalized: "pulparindo" },
 *     { raw: "vero mango chamoy", normalized: "vero mango chamoy" }
 *   ]
 *
 * Usa Claude Haiku 4.5 con tool_use (function calling). Si el LLM falla
 * (timeout / 5xx / response inválido), cae a un splitter heurístico por
 * comas/líneas/barras — peor calidad pero el feature no muere.
 *
 * Vars necesarias en `.env`:
 *   - ANTHROPIC_API_KEY (required)
 */
@Injectable()
export class LlmExtractorService implements OnModuleInit {
  private readonly logger = new Logger(LlmExtractorService.name);
  private readonly endpoint = 'https://api.anthropic.com/v1/messages';
  private readonly model = 'claude-haiku-4-5-20251001';
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';
  private readonly timeoutMs = 15_000;

  onModuleInit(): void {
    if (!this.apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY no configurada. /products/match-ai degrada a fallback heurístico.',
      );
    } else {
      this.logger.log(`Claude Haiku habilitado (model=${this.model}).`);
    }
  }

  async extractProductItems(
    rawText: string,
  ): Promise<{ raw: string; normalized: string }[]> {
    const trimmed = rawText.trim();
    if (!trimmed) return [];

    if (!this.apiKey) {
      this.logger.warn('Fallback heurístico (sin ANTHROPIC_API_KEY)');
      return this.heuristicSplit(trimmed);
    }

    try {
      const items = await this.callClaude(trimmed);
      if (items.length === 0) return this.heuristicSplit(trimmed);
      return items;
    } catch (e: any) {
      this.logger.warn(
        `Claude extract failed (${e.message}). Fallback heurístico.`,
      );
      return this.heuristicSplit(trimmed);
    }
  }

  /**
   * Splitter heurístico — separa por saltos de línea, comas, barras y
   * conjunciones obvias ("y"). NO normaliza más allá de trim. Solo se usa
   * cuando Claude no responde o no hay key.
   */
  private heuristicSplit(text: string): { raw: string; normalized: string }[] {
    return text
      .split(/[\n,;\/|]+|\s+y\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => ({ raw: s, normalized: s }));
  }

  private async callClaude(
    rawText: string,
  ): Promise<{ raw: string; normalized: string }[]> {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          tool_choice: { type: 'tool', name: 'extract_products' },
          tools: [
            {
              name: 'extract_products',
              description:
                'Extrae cada producto mencionado en el texto como un item separado. ' +
                'Normaliza abreviaciones (12pz → 12 piezas, gr → gramos), arregla typos obvios y ' +
                'mantiene el texto original en `raw`. Si el texto no contiene productos, devuelve lista vacía.',
              input_schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        raw: {
                          type: 'string',
                          description: 'El fragmento exacto del texto original.',
                        },
                        normalized: {
                          type: 'string',
                          description:
                            'Versión normalizada: lowercase, abreviaciones expandidas, espacios limpios.',
                        },
                      },
                      required: ['raw', 'normalized'],
                    },
                  },
                },
                required: ['items'],
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content:
                'Texto del colaborador (lista de productos en una tienda):\n\n' +
                rawText +
                '\n\nExtrae cada producto como un item separado usando la herramienta extract_products.',
            },
          ],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tId);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; name: string; input: { items?: { raw: string; normalized: string }[] } }
      >;
    };

    const toolUse = json.content.find(
      (c): c is Extract<typeof c, { type: 'tool_use' }> =>
        c.type === 'tool_use' && c.name === 'extract_products',
    );
    if (!toolUse) {
      throw new Error('Claude no devolvió tool_use con extract_products');
    }
    const items = toolUse.input.items ?? [];

    // Sanitize: cada item debe tener raw y normalized non-empty.
    return items
      .filter(
        (it) =>
          typeof it.raw === 'string' &&
          typeof it.normalized === 'string' &&
          it.raw.trim() &&
          it.normalized.trim(),
      )
      .map((it) => ({
        raw: it.raw.trim(),
        normalized: it.normalized.trim(),
      }));
  }
}
