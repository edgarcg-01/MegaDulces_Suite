import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Campos de cabecera extraídos de un ticket de ruta (cierre de ruta).
 * `total`/`liters` numéricos o null; el resto string o null según el tipo.
 */
export interface RouteTicketFields {
  route_code: string | null;
  ticket_date: string | null; // ISO YYYY-MM-DD
  total: number | null;
  corte_number: string | null; // solo venta
  reference: string | null; // solo combustible
  liters: number | null; // solo combustible
}

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

  /**
   * Fase V — Extrae líneas de producto desde una FOTO de ticket de venta.
   * Usa Claude Haiku 4.5 vision (mismo modelo que el text extractor).
   *
   * @param imageBase64  Imagen en base64 puro (sin data:URL prefix).
   * @param mediaType    'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'.
   * @returns Items con `raw` (línea literal del ticket), `normalized` (nombre
   *          limpio para matchear contra catálogo) y `quantity` (default 1).
   *
   * Si la imagen es ilegible o no contiene productos, devuelve array vacío.
   */
  async extractFromTicketImage(
    imageBase64: string,
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
  ): Promise<{ raw: string; normalized: string; quantity: number }[]> {
    if (!this.apiKey) {
      this.logger.warn('Ticket OCR sin ANTHROPIC_API_KEY — devuelvo []');
      return [];
    }
    if (!imageBase64) return [];

    try {
      const items = await this.callClaudeVision(imageBase64, mediaType);
      return items;
    } catch (e: any) {
      this.logger.warn(`Claude vision ticket extract failed: ${e.message}`);
      return [];
    }
  }

  /**
   * "Cierre de ruta" — extrae los campos de CABECERA de un ticket de ruta
   * (venta/carga/combustible) desde la foto. NO desglosa productos: estos
   * tickets son documentos de control/totales. Reemplaza al OCR Mistral +
   * parsers regex de Automation_RD por una sola llamada Claude vision.
   *
   * @returns Campos parseados (null donde no aplica / no se detecta).
   */
  async extractRouteTicket(
    imageBase64: string,
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
    ticketType: 'venta' | 'carga' | 'combustible',
  ): Promise<RouteTicketFields> {
    const empty: RouteTicketFields = {
      route_code: null, ticket_date: null, total: null,
      corte_number: null, reference: null, liters: null,
    };
    if (!this.apiKey) {
      this.logger.warn('Route ticket OCR sin ANTHROPIC_API_KEY — devuelvo campos vacíos');
      return empty;
    }
    if (!imageBase64) return empty;
    try {
      return await this.callClaudeVisionRouteTicket(imageBase64, mediaType, ticketType);
    } catch (e: any) {
      this.logger.warn(`Claude route-ticket extract failed: ${e.message}`);
      return empty;
    }
  }

  async extractProductItems(
    rawText: string,
  ): Promise<{ raw: string; normalized: string; quantity: number }[]> {
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
   * conjunciones obvias ("y"). NO normaliza más allá de trim. Intenta
   * extraer un número líder ("30 mazapanes" → qty=30) o por defecto 1.
   * Solo se usa cuando Claude no responde o no hay key.
   */
  private heuristicSplit(
    text: string,
  ): { raw: string; normalized: string; quantity: number }[] {
    return text
      .split(/[\n,;\/|]+|\s+y\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        // Match líder: "30 mazapán", "30x mazapán", "30 pzas mazapán"
        const m = s.match(/^(\d+)\s*(?:x|pz|pzs|pza|pzas|piezas|unidades?)?\s+(.+)$/i);
        if (m) {
          const qty = parseInt(m[1], 10);
          const rest = m[2].trim();
          if (qty > 0 && rest) return { raw: s, normalized: rest, quantity: qty };
        }
        return { raw: s, normalized: s, quantity: 1 };
      });
  }

  private async callClaude(
    rawText: string,
  ): Promise<{ raw: string; normalized: string; quantity: number }[]> {
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
                'Extrae cada producto mencionado en el texto como un item separado, junto con su cantidad. ' +
                'Normaliza abreviaciones (12pz → 12 piezas, gr → gramos), arregla typos obvios y ' +
                'mantiene el texto original en `raw`. ' +
                'Si el usuario menciona una cantidad explícita ("30 mazapanes", "necesito 50 pulparindos", "2 cajas de paleta payaso") ' +
                'extraela como `quantity` (entero). Si no especifica cantidad, usar 1. ' +
                'Si el texto no contiene productos, devuelve lista vacía.',
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
                          description: 'El fragmento exacto del texto original (sin el número de cantidad).',
                        },
                        normalized: {
                          type: 'string',
                          description:
                            'Versión normalizada del NOMBRE DEL PRODUCTO únicamente (sin la cantidad): lowercase, abreviaciones expandidas, espacios limpios.',
                        },
                        quantity: {
                          type: 'integer',
                          description: 'Cantidad de unidades pedidas. Default 1 si no se especifica. Mínimo 1.',
                          minimum: 1,
                        },
                      },
                      required: ['raw', 'normalized', 'quantity'],
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
        | { type: 'tool_use'; name: string; input: { items?: { raw: string; normalized: string; quantity?: number }[] } }
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

    // Sanitize: cada item debe tener raw y normalized non-empty. quantity es
    // entero ≥ 1 (default 1 si Claude no la incluye o es inválida).
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
        quantity: Number.isInteger(it.quantity) && (it.quantity as number) >= 1 ? (it.quantity as number) : 1,
      }));
  }

  /**
   * Variante vision del extractor. Recibe la imagen del ticket en base64 y le
   * pide a Claude Haiku que identifique las líneas de producto + cantidades.
   * Mismo tool_use schema que `callClaude` para que el output sea compatible
   * con `AiProductMatcherService.match()`.
   *
   * Timeout subido a 30s porque vision suele tardar 5-15s en tickets reales.
   */
  private async callClaudeVision(
    imageBase64: string,
    mediaType: string,
  ): Promise<{ raw: string; normalized: string; quantity: number }[]> {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 30_000);

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
          max_tokens: 2048,
          tool_choice: { type: 'tool', name: 'extract_ticket_lines' },
          tools: [
            {
              name: 'extract_ticket_lines',
              description:
                'Extrae cada línea de PRODUCTO del ticket de venta de una tienda mexicana. ' +
                'Ignora: encabezado de tienda, RFC, dirección, totales, IVA, "GRACIAS POR SU COMPRA", ' +
                'forma de pago, cambio, fecha/hora, número de ticket/folio. ' +
                'Solo extrae líneas que sean PRODUCTOS REALES vendidos. ' +
                'Para cada línea: `raw` con el texto literal del ticket, `normalized` con el nombre ' +
                'del producto limpio (lowercase, sin códigos, sin precios, abreviaciones expandidas), ' +
                'y `quantity` como entero (default 1 si no es claro). ' +
                'Si el ticket está ilegible o no se distingue ningún producto, devuelve items vacíos.',
              input_schema: {
                type: 'object',
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        raw: { type: 'string', description: 'Línea literal tal como aparece en el ticket.' },
                        normalized: { type: 'string', description: 'Nombre del producto limpio para matchear con catálogo.' },
                        quantity: { type: 'integer', description: 'Cantidad. Default 1.', minimum: 1 },
                      },
                      required: ['raw', 'normalized', 'quantity'],
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
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: imageBase64 },
                },
                {
                  type: 'text',
                  text:
                    'Esta es una foto de un ticket de venta de una tiendita mexicana. ' +
                    'Extrae cada línea de producto usando la herramienta extract_ticket_lines.',
                },
              ],
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
      throw new Error(`Anthropic vision ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; name: string; input: { items?: { raw: string; normalized: string; quantity?: number }[] } }
      >;
    };

    const toolUse = json.content.find(
      (c): c is Extract<typeof c, { type: 'tool_use' }> =>
        c.type === 'tool_use' && c.name === 'extract_ticket_lines',
    );
    if (!toolUse) throw new Error('Claude vision no devolvió tool_use');

    const items = toolUse.input.items ?? [];
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
        quantity: Number.isInteger(it.quantity) && (it.quantity as number) >= 1 ? (it.quantity as number) : 1,
      }));
  }

  /**
   * Vision para tickets de ruta. Pide a Claude los campos de cabecera según el
   * tipo. `route_code` = el número que sigue a "RD" (ej. "12"). Fechas a ISO.
   */
  private async callClaudeVisionRouteTicket(
    imageBase64: string,
    mediaType: string,
    ticketType: 'venta' | 'carga' | 'combustible',
  ): Promise<RouteTicketFields> {
    const perType: Record<typeof ticketType, string> = {
      venta:
        'Ticket de CORTE DE VENTA de una ruta (RD). Extrae: route_code (número tras "RD"), ' +
        'ticket_date, total (monto vendido, el importe mayor), corte_number (el número que aparece tras "Numero"). ' +
        'reference y liters van null.',
      carga:
        'Ticket de CARGA de mercancía a un camión de ruta (RD). Extrae: route_code (número tras "RD"), ' +
        'ticket_date, total (valor total cargado). corte_number, reference y liters van null.',
      combustible:
        'Ticket de COMBUSTIBLE/gasolina de una ruta (RD). Extrae: route_code (número tras "RD"), ' +
        'ticket_date, total (importe), liters (litros cargados), reference (folio/referencia del ticket). ' +
        'corte_number va null.',
    };

    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 30_000);

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
          max_tokens: 512,
          tool_choice: { type: 'tool', name: 'extract_route_ticket' },
          tools: [
            {
              name: 'extract_route_ticket',
              description:
                'Extrae los campos de cabecera de un ticket de ruta. Usa null para cualquier campo ' +
                'que no aplique al tipo o que no se distinga en la imagen. Fechas siempre en formato ISO YYYY-MM-DD.',
              input_schema: {
                type: 'object',
                properties: {
                  route_code: { type: ['string', 'null'], description: 'Número de ruta tras "RD" (ej. "12"). null si no se ve.' },
                  ticket_date: { type: ['string', 'null'], description: 'Fecha del ticket en ISO YYYY-MM-DD. null si no se ve.' },
                  total: { type: ['number', 'null'], description: 'Monto total en pesos (sin símbolo ni comas). null si no se ve.' },
                  corte_number: { type: ['string', 'null'], description: 'Número de corte (solo venta). null en otros tipos.' },
                  reference: { type: ['string', 'null'], description: 'Folio/referencia (solo combustible). null en otros tipos.' },
                  liters: { type: ['number', 'null'], description: 'Litros (solo combustible). null en otros tipos.' },
                },
                required: ['route_code', 'ticket_date', 'total', 'corte_number', 'reference', 'liters'],
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
                { type: 'text', text: perType[ticketType] + ' Usa la herramienta extract_route_ticket.' },
              ],
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
      throw new Error(`Anthropic route-ticket ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; name: string; input: Partial<RouteTicketFields> }
      >;
    };
    const toolUse = json.content.find(
      (c): c is Extract<typeof c, { type: 'tool_use' }> =>
        c.type === 'tool_use' && c.name === 'extract_route_ticket',
    );
    if (!toolUse) throw new Error('Claude route-ticket no devolvió tool_use');

    const inp = toolUse.input || {};
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null;
    return {
      route_code: str(inp.route_code),
      ticket_date: str(inp.ticket_date),
      total: num(inp.total),
      corte_number: ticketType === 'venta' ? str(inp.corte_number) : null,
      reference: ticketType === 'combustible' ? str(inp.reference) : null,
      liters: ticketType === 'combustible' ? num(inp.liters) : null,
    };
  }
}
