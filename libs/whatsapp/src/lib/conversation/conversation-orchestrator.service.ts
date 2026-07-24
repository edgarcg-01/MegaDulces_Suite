import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  CommerceConversationPort,
  ConversationProductHit,
} from '@megadulces/contracts';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import { CartItem, ConversationThreadService, ThreadState } from './conversation-thread.service';

/** Resultado de un turno: la respuesta a enviar + si hay que derivar a humano. */
export interface TurnResult {
  reply: string;
  handoff: boolean;
  state: ThreadState;
}

/**
 * Fase F.2 (ADR-007/016/034) — Orquestador conversacional.
 *
 * Claude Haiku conduce la charla por TOOL-USE sobre el estado del hilo:
 * busca productos, arma el carrito, captura el domicilio (texto) y, al confirmar,
 * deja el hilo en `review` para que un HUMANO lo finalice en la bandeja (F.3).
 *
 * Invariantes:
 *   - El LLM NO decide precios (ADR-016): `agregar_al_carrito` toma el precio del
 *     resultado de `buscar_producto` (motor), no del texto del modelo.
 *   - El bot NO crea la orden ni cobra: `confirmar_pedido` solo marca `review`.
 *   - Sin `ANTHROPIC_API_KEY` o sin el puerto de catálogo → degrada a handoff
 *     humano (honesto: "un asesor te atiende"), nunca inventa un pedido.
 */
@Injectable()
export class ConversationOrchestratorService {
  private readonly logger = new Logger(ConversationOrchestratorService.name);
  private readonly endpoint = 'https://api.anthropic.com/v1/messages';
  private readonly model = 'claude-haiku-4-5-20251001';
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';
  private readonly timeoutMs = 20_000;
  private readonly maxIters = 6;

  constructor(
    private readonly threads: ConversationThreadService,
    @Optional() @Inject(COMMERCE_CONVERSATION_PORT) private readonly commerce?: CommerceConversationPort,
  ) {}

  /** Procesa un mensaje del cliente y devuelve la respuesta (persiste el hilo). */
  async handleTurn(threadId: string, userText: string): Promise<TurnResult> {
    const thread = await this.threads.getById(threadId);
    if (!thread) {
      return { reply: 'Perdón, no encontramos tu conversación. Intenta de nuevo.', handoff: false, state: 'greeting' };
    }

    // Degradación honesta: sin LLM o sin catálogo, derivamos a un humano.
    if (!this.apiKey || !this.commerce) {
      await this.threads.update(threadId, { handoff: true, state: 'handoff' });
      const why = !this.apiKey ? 'sin ANTHROPIC_API_KEY' : 'sin puerto de catálogo';
      this.logger.warn(`Orquestador degradado (${why}) → handoff.`);
      return {
        reply: 'En un momento te atiende un asesor de Mega Dulces para tomar tu pedido. 🙌',
        handoff: true,
        state: 'handoff',
      };
    }

    // Estado de trabajo del turno (se persiste al final).
    const work = {
      cart: [...thread.cart] as CartItem[],
      address: thread.delivery_address as any,
      state: thread.state as ThreadState,
      handoff: false,
    };
    // Productos vistos en ESTE turno (product_id → hit). El precio del carrito
    // sale de aquí, no del LLM.
    const seen = new Map<string, ConversationProductHit>();

    const history = await this.threads.recentMessages(threadId, 8);
    const messages: any[] = [];
    for (const m of history) {
      if (!m.body) continue;
      messages.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body });
    }
    messages.push({ role: 'user', content: userText });

    let reply = '';
    try {
      reply = await this.runToolLoop(messages, work, seen);
    } catch (e: any) {
      this.logger.warn(`Tool loop falló (${e?.message}) → handoff.`);
      await this.threads.update(threadId, { handoff: true, state: 'handoff' });
      return {
        reply: 'Tuvimos un problema técnico. Un asesor te contacta enseguida. 🙏',
        handoff: true,
        state: 'handoff',
      };
    }

    await this.threads.update(threadId, {
      cart: work.cart,
      delivery_address: work.address,
      state: work.state,
      handoff: work.handoff || undefined,
    });
    return { reply: reply || 'Listo.', handoff: work.handoff, state: work.state };
  }

  // ── Loop de tool-use ────────────────────────────────────────────────────────

  private async runToolLoop(
    messages: any[],
    work: { cart: CartItem[]; address: any; state: ThreadState; handoff: boolean },
    seen: Map<string, ConversationProductHit>,
  ): Promise<string> {
    for (let i = 0; i < this.maxIters; i++) {
      const res = await this.callClaude(messages, work);
      const content: any[] = res?.content || [];
      const toolUses = content.filter((c) => c.type === 'tool_use');
      const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);

      if (toolUses.length === 0) {
        // Turno terminado: el texto es la respuesta al cliente.
        return textParts.join('\n').trim();
      }

      // Ejecutar cada tool y devolver resultados.
      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        const out = await this.execTool(tu.name, tu.input || {}, work, seen);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    // Se agotaron las iteraciones: respuesta segura.
    return 'Perfecto, ya casi. ¿Confirmo tu pedido o querés agregar algo más?';
  }

  private async execTool(
    name: string,
    input: any,
    work: { cart: CartItem[]; address: any; state: ThreadState; handoff: boolean },
    seen: Map<string, ConversationProductHit>,
  ): Promise<any> {
    switch (name) {
      case 'buscar_producto': {
        const hits = await this.commerce!.searchProducts(String(input.query || ''), { limit: 5 });
        for (const h of hits) seen.set(h.product_id, h);
        if (work.state === 'greeting') work.state = 'shopping';
        return {
          resultados: hits.map((h) => ({
            product_id: h.product_id,
            nombre: h.name,
            marca: h.brand_name,
            precio: h.unit_price,
            minimo: h.min_qty,
          })),
        };
      }
      case 'agregar_al_carrito': {
        const pid = String(input.product_id || '');
        const qty = Math.max(1, Math.floor(Number(input.cantidad) || 1));
        const hit = seen.get(pid);
        if (!hit) return { error: 'Producto no encontrado en la última búsqueda. Usá buscar_producto primero y agregá con un product_id de esos resultados.' };
        const existing = work.cart.find((c) => c.product_id === pid);
        if (existing) existing.qty += qty;
        else work.cart.push({ product_id: pid, sku: null, name: hit.name, qty, unit_price: hit.unit_price });
        if (work.state === 'greeting') work.state = 'shopping';
        return { ok: true, carrito: this.cartView(work.cart) };
      }
      case 'quitar_del_carrito': {
        const pid = String(input.product_id || '');
        work.cart = work.cart.filter((c) => c.product_id !== pid);
        return { ok: true, carrito: this.cartView(work.cart) };
      }
      case 'ver_carrito':
        return { carrito: this.cartView(work.cart) };
      case 'capturar_domicilio': {
        const calle = String(input.calle || '').trim();
        if (!calle) return { error: 'Falta la calle y número.' };
        work.address = {
          street: calle,
          references: input.referencias ? String(input.referencias) : undefined,
          recipient_name: input.nombre ? String(input.nombre) : undefined,
          phone: input.telefono ? String(input.telefono) : undefined,
        };
        work.state = 'address';
        return { ok: true, domicilio: work.address };
      }
      case 'confirmar_pedido': {
        if (work.cart.length === 0) return { error: 'El carrito está vacío. Agregá al menos un producto.' };
        if (!work.address?.street) return { error: 'Falta el domicilio de entrega. Pedí la calle y número.' };
        work.state = 'review';
        return {
          ok: true,
          mensaje: 'Pedido listo para revisión de un asesor.',
          resumen: { carrito: this.cartView(work.cart), domicilio: work.address },
        };
      }
      case 'handoff_humano':
        work.handoff = true;
        work.state = 'handoff';
        return { ok: true };
      default:
        return { error: `Herramienta desconocida: ${name}` };
    }
  }

  private cartView(cart: CartItem[]) {
    const items = cart.map((c) => ({ nombre: c.name, cantidad: c.qty, precio_unitario: c.unit_price, subtotal: Math.round((c.qty * (c.unit_price || 0)) * 100) / 100 }));
    const total = Math.round(items.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    return { items, total };
  }

  // ── Claude ──────────────────────────────────────────────────────────────────

  private async callClaude(messages: any[], work: { cart: CartItem[]; address: any; state: ThreadState }): Promise<any> {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          system: this.systemPrompt(work),
          tools: this.toolDefs(),
          messages,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      return await res.json();
    } finally {
      clearTimeout(tId);
    }
  }

  private systemPrompt(work: { cart: CartItem[]; address: any; state: ThreadState }): string {
    const cart = this.cartView(work.cart);
    return [
      'Sos el asistente de pedidos de Mega Dulces (dulcería) por WhatsApp. Hablás en español mexicano, cálido y breve (mensajes cortos, sin markdown).',
      'Tu trabajo: ayudar al cliente a armar un pedido a domicilio.',
      'REGLAS DURAS:',
      '- Para agregar un producto SIEMPRE usá primero buscar_producto y luego agregar_al_carrito con un product_id de esos resultados. Nunca inventes productos ni precios.',
      '- Los precios y el total salen de las herramientas, no los inventes ni los cambies.',
      '- Antes de confirmar necesitás: al menos 1 producto en el carrito Y el domicilio (calle y número).',
      '- Al confirmar, avisá que un asesor de Mega Dulces revisa y confirma el pedido (no lo cierres vos).',
      '- Si el cliente pide algo que no entendés, se enoja, o pide hablar con una persona, usá handoff_humano.',
      '- El pago es contra-entrega (efectivo al recibir). No pidas datos de tarjeta.',
      `ESTADO ACTUAL → etapa: ${work.state}. Carrito: ${cart.items.length ? JSON.stringify(cart) : 'vacío'}. Domicilio: ${work.address?.street ? JSON.stringify(work.address) : 'no capturado'}.`,
    ].join('\n');
  }

  private toolDefs(): any[] {
    return [
      {
        name: 'buscar_producto',
        description: 'Busca productos del catálogo por nombre/descripción en lenguaje natural. Devuelve product_id + nombre + precio. Úsalo SIEMPRE antes de agregar al carrito.',
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Lo que el cliente quiere (ej. "pulparindo", "mazapán de la rosa", "paletas payaso")' } }, required: ['query'] },
      },
      {
        name: 'agregar_al_carrito',
        description: 'Agrega un producto al carrito. Usá un product_id que haya devuelto buscar_producto en esta conversación.',
        input_schema: { type: 'object', properties: { product_id: { type: 'string' }, cantidad: { type: 'integer', minimum: 1 } }, required: ['product_id', 'cantidad'] },
      },
      {
        name: 'quitar_del_carrito',
        description: 'Quita un producto del carrito por su product_id.',
        input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
      },
      {
        name: 'ver_carrito',
        description: 'Devuelve el carrito actual con subtotales y total.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'capturar_domicilio',
        description: 'Guarda el domicilio de entrega (texto). Pedí al menos calle y número.',
        input_schema: {
          type: 'object',
          properties: {
            calle: { type: 'string', description: 'Calle y número' },
            referencias: { type: 'string', description: 'Entre calles, color de casa, etc.' },
            nombre: { type: 'string', description: 'Quién recibe' },
            telefono: { type: 'string', description: 'Teléfono de contacto' },
          },
          required: ['calle'],
        },
      },
      {
        name: 'confirmar_pedido',
        description: 'Marca el pedido como listo para que un asesor lo revise y confirme. Requiere carrito con productos y domicilio.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'handoff_humano',
        description: 'Deriva la conversación a un asesor humano cuando no podés ayudar o el cliente lo pide.',
        input_schema: { type: 'object', properties: { motivo: { type: 'string' } } },
      },
    ];
  }
}
