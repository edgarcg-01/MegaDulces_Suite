import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Suggestion {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  qty: number;
  unit_price: number;
  min_qty: number;
  reason: string;
}

interface SuggestInput {
  message: string;
  history: ChatMessage[];
  /**
   * Opcional. Si no viene, el service lo resuelve via
   * `tenantCtx.userId → public.users.customer_id` (auth-mt no emite
   * `customer_id` en el JWT).
   */
  customerId?: string | null;
  tenantId: string;
}

interface CatalogItem {
  id: string;
  product_name: string;
  brand_name: string | null;
  brand_id: string | null;
  price: number;
  min_qty: number;
}

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CATALOG_ITEMS = 300;
const TIMEOUT_MS = 25_000;

@Injectable()
export class PortalAiOrderService {
  private readonly logger = new Logger(PortalAiOrderService.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async suggest(input: SuggestInput) {
    const message = (input.message || '').trim();
    if (!message) throw new BadRequestException('message vacío');

    const customerId = input.customerId ?? (await this.resolveCustomerIdFromCtx());
    const catalog = await this.loadCatalog(customerId);
    if (catalog.length === 0) {
      return {
        assistant_message:
          'No encontré productos en tu lista de precios. Avisá a tu administrador para que active tu catálogo.',
        suggestions: [],
      };
    }

    if (!this.apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY ausente — fallback sin AI.');
      return this.fallback(message, catalog);
    }

    try {
      return await this.callClaude(message, input.history, catalog);
    } catch (e: any) {
      this.logger.warn(`Claude suggest fallback (${e.message})`);
      return this.fallback(message, catalog);
    }
  }

  private async resolveCustomerIdFromCtx(): Promise<string | null> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return null;
    return this.tk.run(async (trx) => {
      const row = await trx('public.users').where({ id: userId }).select('customer_id').first();
      return row?.customer_id || null;
    });
  }

  private async loadCatalog(customerId: string | null): Promise<CatalogItem[]> {
    return this.tk.run(async (trx) => {
      let priceListId: string | null = null;

      if (customerId) {
        const customer = await trx('commercial.customers')
          .where({ id: customerId })
          .first('default_price_list_id');
        priceListId = customer?.default_price_list_id || null;
      }

      if (!priceListId) {
        const def = await trx('commercial.price_lists')
          .where({ is_default: true })
          .whereNull('deleted_at')
          .first('id');
        priceListId = def?.id || null;
      }

      if (!priceListId) return [];

      const rows = await trx('commercial.product_prices as pp')
        .leftJoin('public.products as p', function () {
          this.on('p.id', '=', 'pp.product_id').andOn('p.tenant_id', '=', 'pp.tenant_id');
        })
        .leftJoin('public.brands as b', function () {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        .where('pp.price_list_id', priceListId)
        .whereNull('pp.deleted_at')
        .whereNull('p.deleted_at')
        .select(
          'pp.product_id as id',
          'p.nombre as product_name',
          'p.brand_id as brand_id',
          'b.nombre as brand_name',
          'pp.price',
          'pp.min_qty',
        )
        .orderBy('b.nombre', 'asc')
        .orderBy('p.nombre', 'asc')
        .limit(MAX_CATALOG_ITEMS);

      return rows.map((r: any) => ({
        id: r.id,
        product_name: r.product_name,
        brand_name: r.brand_name,
        brand_id: r.brand_id,
        price: Number(r.price),
        min_qty: Number(r.min_qty || 1),
      }));
    });
  }

  private async callClaude(
    message: string,
    history: ChatMessage[],
    catalog: CatalogItem[],
  ) {
    const catalogJson = catalog.map((c) => ({
      id: c.id,
      name: c.product_name,
      brand: c.brand_name,
      price: c.price,
      min_qty: c.min_qty,
    }));

    const system = `Eres un asistente de ventas B2B para una distribuidora de dulces (Mega Dulces). El cliente que te habla es un dueño/comprador de tienda. Tu trabajo es ayudarle a armar su pedido sugiriendo productos del catálogo que se le permite comprar.

CATÁLOGO DISPONIBLE PARA ESTE CLIENTE (JSON, máximo ${MAX_CATALOG_ITEMS} items):
${JSON.stringify(catalogJson)}

REGLAS ESTRICTAS:
1. SOLO podés sugerir productos cuyo "id" esté EXACTAMENTE en el catálogo de arriba. No inventes IDs.
2. La cantidad sugerida debe ser ≥ min_qty del producto.
3. Si el cliente pide algo que no está en su catálogo (ej. "Coca Cola" cuando solo tenés dulces), aclaralo en assistant_message y sugerí alternativas que sí tengas.
4. Sé conciso y útil. Hablá en español mexicano informal pero profesional.
5. Si el mensaje es ambiguo, hacé preguntas aclaratorias en assistant_message Y dejá suggestions vacío o con pocos items tentativos.
6. Si el cliente pide modificar/quitar items, ajustá la sugerencia.

Devolvé tu respuesta SIEMPRE invocando la tool "suggest_order".`;

    const messages: ChatMessage[] = [
      ...history.slice(-10),
      { role: 'user', content: message },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 2048,
          system,
          messages,
          tools: [
            {
              name: 'suggest_order',
              description:
                'Devuelve un mensaje conversacional para el cliente y una lista estructurada de productos sugeridos del catálogo.',
              input_schema: {
                type: 'object',
                properties: {
                  assistant_message: {
                    type: 'string',
                    description: 'Mensaje conversacional en español para el cliente.',
                  },
                  suggestions: {
                    type: 'array',
                    description: 'Productos sugeridos (puede ser vacío si solo hay pregunta).',
                    items: {
                      type: 'object',
                      properties: {
                        product_id: { type: 'string', description: 'UUID del catálogo' },
                        qty: { type: 'integer', minimum: 1 },
                        reason: { type: 'string', description: 'Por qué este producto' },
                      },
                      required: ['product_id', 'qty'],
                    },
                  },
                },
                required: ['assistant_message', 'suggestions'],
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'suggest_order' },
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Claude HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }

      const json: any = await res.json();
      const toolUse = (json.content || []).find((c: any) => c.type === 'tool_use');
      if (!toolUse) throw new Error('Claude no devolvió tool_use');
      const input = toolUse.input || {};
      const rawSuggestions: any[] = Array.isArray(input.suggestions) ? input.suggestions : [];

      const byId = new Map(catalog.map((c) => [c.id, c]));
      const suggestions: Suggestion[] = [];
      for (const s of rawSuggestions) {
        const item = byId.get(s.product_id);
        if (!item) continue;
        const qty = Math.max(item.min_qty, Number(s.qty) || item.min_qty);
        suggestions.push({
          product_id: item.id,
          product_name: item.product_name,
          brand_name: item.brand_name,
          qty,
          unit_price: item.price,
          min_qty: item.min_qty,
          reason: String(s.reason || ''),
        });
      }

      return {
        assistant_message: String(input.assistant_message || ''),
        suggestions,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fallback heurístico — busca palabras del mensaje en product_name/brand_name
   * y devuelve los top 5 matches. UX degradada pero el feature no muere.
   */
  private fallback(message: string, catalog: CatalogItem[]) {
    const tokens = message
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/\W+/u)
      .filter((t) => t.length > 2);

    const scored = catalog.map((c) => {
      const hay = `${c.product_name} ${c.brand_name || ''}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score++;
      return { c, score };
    });
    const top = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map<Suggestion>((s) => ({
        product_id: s.c.id,
        product_name: s.c.product_name,
        brand_name: s.c.brand_name,
        qty: s.c.min_qty,
        unit_price: s.c.price,
        min_qty: s.c.min_qty,
        reason: 'Coincide con tu búsqueda',
      }));

    const msg = top.length
      ? `Encontré ${top.length} producto(s) que podrían interesarte. Decime si querés ajustar cantidades.`
      : 'No encontré coincidencias claras. ¿Podrías ser más específico (marca, tipo de dulce, gramaje)?';
    return { assistant_message: msg, suggestions: top };
  }
}
