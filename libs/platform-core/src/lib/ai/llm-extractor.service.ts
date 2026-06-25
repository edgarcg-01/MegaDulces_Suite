import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Campos de cabecera extraídos de un ticket de ruta (cierre de ruta).
 * `total`/`liters` numéricos o null; el resto string o null según el tipo.
 */
export interface RouteTicketFields {
  route_code: string | null;
  ticket_date: string | null; // ISO YYYY-MM-DD
  ticket_time: string | null; // hora impresa HH:MM (24h), wall-clock. null si no se ve.
  total: number | null;
  corte_number: string | null; // solo venta
  reference: string | null; // solo combustible
  liters: number | null; // solo combustible
  folio: string | null; // solo carga — identificador del ticket (ej. "T153142782")
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
      route_code: null, ticket_date: null, ticket_time: null, total: null,
      corte_number: null, reference: null, liters: null, folio: null,
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
        'Ticket de CORTE DE VENTA de una ruta. Extrae: route_code (el número de ruta, tras "RD" o "Ruta", ej. "Ruta 28" → "28"). ' +
        'ticket_date. ticket_time (hora impresa). ' +
        'total = la VENTA NETA: el monto de la línea "Vtas tot - Dev (MN)" (ventas totales menos devoluciones). ' +
        'Si no está esa línea, usa "Total en caja" / "Total Disponible". Solo el número, sin símbolo ni comas. ' +
        'corte_number = el número de corte, que aparece tras "Folio de corte", "Numero de corte" o "Corte" (ej. "Folio de corte: 955" → "955"). ' +
        'reference y liters van null.',
      carga:
        'Ticket de CARGA de mercancía a un camión de ruta. Extrae: route_code (número tras "RD" o "Ruta"), ' +
        'ticket_date, ticket_time (hora impresa), total (valor total cargado), folio (el identificador que aparece tras "FOLIO:", ' +
        'ej. "T153142782" — cópialo TAL CUAL, incluye letras y números). corte_number, reference y liters van null.',
      combustible:
        'Ticket de COMBUSTIBLE/gasolina de una ruta. Extrae: route_code (número tras "RD" o "Ruta"), ' +
        'ticket_date, ticket_time (hora impresa), total (importe), liters (litros cargados), reference (folio/referencia del ticket). ' +
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
                  ticket_date: { type: ['string', 'null'], description: 'Fecha del ticket en ISO YYYY-MM-DD. Acepta CUALQUIER formato visible y conviértelo ("23/jun/2026", "23/06/2026", "23 de junio de 2026" → "2026-06-23"). Si NO hay fecha visible, devuelve null — NUNCA inventes ni pongas "<UNKNOWN>".' },
                  ticket_time: { type: ['string', 'null'], description: 'Hora impresa en el ticket en formato 24h HH:MM (ej. "Hora: 03:33 p.m." → "15:33"). null si no se ve.' },
                  total: { type: ['number', 'null'], description: 'Monto total en pesos (sin símbolo ni comas). null si no se ve.' },
                  corte_number: { type: ['string', 'null'], description: 'Número de corte (solo venta). null en otros tipos.' },
                  reference: { type: ['string', 'null'], description: 'Folio/referencia (solo combustible). null en otros tipos.' },
                  liters: { type: ['number', 'null'], description: 'Litros (solo combustible). null en otros tipos.' },
                  folio: { type: ['string', 'null'], description: 'Folio identificador tras "FOLIO:" (solo carga), ej. "T153142782". Copiar tal cual. null en otros tipos.' },
                },
                required: ['route_code', 'ticket_date', 'ticket_time', 'total', 'corte_number', 'reference', 'liters', 'folio'],
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
    // Placeholders que el LLM a veces devuelve cuando NO encuentra el dato → null.
    const PLACEHOLDERS = new Set(['<unknown>', 'unknown', 'n/a', 'na', 'null', 'none', '-', '--', '?', 'desconocido', 'sin fecha']);
    const str = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t && !PLACEHOLDERS.has(t.toLowerCase()) ? t : null;
    };
    // Hora a HH:MM (24h). Acepta "15:33", "15:33:03", "3:33"; descarta basura.
    const time = (v: unknown): string | null => {
      const s = str(v);
      const m = s?.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (!m) return null;
      const h = Math.min(Math.max(parseInt(m[1], 10), 0), 23);
      return `${String(h).padStart(2, '0')}:${m[2]}`;
    };
    return {
      route_code: str(inp.route_code),
      ticket_date: this.parseTicketDate(inp.ticket_date),
      ticket_time: time(inp.ticket_time),
      total: num(inp.total),
      corte_number: ticketType === 'venta' ? str(inp.corte_number) : null,
      reference: ticketType === 'combustible' ? str(inp.reference) : null,
      liters: ticketType === 'combustible' ? num(inp.liters) : null,
      folio: ticketType === 'carga' ? str((inp as any).folio) : null,
    };
  }

  /**
   * Normaliza una fecha de ticket en CUALQUIER formato a ISO YYYY-MM-DD.
   * Acepta: ISO ("2026-06-23"), numérico DD/MM/YYYY o DD-MM-YY ("23/06/2026",
   * "23-6-26"), y con mes en español abreviado o completo ("23/jun/2026",
   * "23 de junio de 2026", "23 jun 26"). Devuelve null si no hay fecha legible
   * (incluye placeholders tipo "<UNKNOWN>") — NUNCA propaga basura como fecha.
   */
  private parseTicketDate(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const raw = v.trim();
    if (!raw || ['<unknown>', 'unknown', 'n/a', 'na', 'null', 'none', '-', '--', '?', 'desconocido', 'sin fecha'].includes(raw.toLowerCase()))
      return null;

    const iso = (y: number, mo: number, d: number): string | null => {
      if (y < 100) y += 2000;
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };

    // 1) ISO directo (puede venir con hora pegada).
    let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);

    // 2) Numérico DD/MM/YYYY (o - . como separador).
    m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) return iso(+m[3], +m[2], +m[1]);

    // 3) Con mes en español (abreviado o completo): "23/jun/2026", "23 de junio de 2026".
    const MONTHS: Record<string, number> = {
      ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7,
      ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
    };
    m = raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // sin acentos
      .match(/(\d{1,2})\D+([a-z]{3,})\D+(\d{2,4})/);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 3)];
      if (mo) return iso(+m[3], mo, +m[1]);
    }
    return null;
  }
}
