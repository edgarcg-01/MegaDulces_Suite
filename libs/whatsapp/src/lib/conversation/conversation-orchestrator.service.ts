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

    // FIQ.0 (ADR-036): reconocer al cliente por su teléfono. Lookup indexado
    // barato; se hace cada turno para tener el nombre fresco y persiste el
    // customer_id la primera vez que se resuelve. El MOTOR resuelve, el LLM saluda.
    let customerName: string | null = null;
    try {
      const customer = await this.commerce.resolveCustomerByPhone(thread.phone);
      if (customer) {
        customerName = customer.name;
        if (!thread.customer_id) {
          await this.threads.update(threadId, { customer_id: customer.customer_id });
        }
      }
    } catch (e: any) {
      this.logger.warn(`resolveCustomerByPhone falló (${e?.message}) — sigo sin personalizar.`);
    }

    // Estado de trabajo del turno (se persiste al final).
    const work = {
      cart: [...thread.cart] as CartItem[],
      address: thread.delivery_address as any,
      state: thread.state as ThreadState,
      handoff: false,
      customerName,
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
          resultados: hits.map((h) => {
            const factor = h.pieces_per_package || 1;
            return {
              product_id: h.product_id,
              nombre: h.name,
              marca: h.brand_name,
              precio_pieza: h.unit_price,
              minimo_piezas: h.min_qty,
              // Empaque: cómo se vende. factor 1 = suelto por pieza.
              piezas_por_paquete: factor,
              se_vende_por: factor > 1 ? 'pieza o paquete' : 'pieza',
              // Existencia (en el almacén de surtido). El bot NO debe prometer más.
              disponible_piezas: h.stock_pieces,
              disponible_paquetes: factor > 1 ? Math.floor(h.stock_pieces / factor) : null,
              agotado: h.stock_pieces <= 0,
            };
          }),
        };
      }
      case 'agregar_al_carrito': {
        const pid = String(input.product_id || '');
        const cantidad = Math.max(1, Math.floor(Number(input.cantidad) || 1));
        const unidad = String(input.unidad || 'pieza').toLowerCase() === 'paquete' ? 'paquete' : 'pieza';
        const hit = seen.get(pid);
        if (!hit) return { error: 'Producto no encontrado en la última búsqueda. Usá buscar_producto primero y agregá con un product_id de esos resultados.' };
        const factor = hit.pieces_per_package || 1;
        // Convertir a PIEZAS (unidad canónica del pedido).
        const addPieces = unidad === 'paquete' ? cantidad * factor : cantidad;
        const existing = work.cart.find((c) => c.product_id === pid);
        const already = existing?.qty || 0;
        // Validación de existencia (motor, no LLM): nunca por encima del stock.
        if (hit.stock_pieces <= 0) {
          return { error: `"${hit.name}" está agotado ahora mismo. Ofrecé otra opción.` };
        }
        if (already + addPieces > hit.stock_pieces) {
          const maxPk = factor > 1 ? Math.floor(hit.stock_pieces / factor) : null;
          return {
            error: 'Existencia insuficiente.',
            disponible_piezas: hit.stock_pieces,
            disponible_paquetes: maxPk,
            ya_en_carrito_piezas: already,
          };
        }
        if (existing) existing.qty += addPieces;
        else work.cart.push({ product_id: pid, sku: null, name: hit.name, qty: addPieces, unit_price: hit.unit_price, pieces_per_package: factor });
        if (work.state === 'greeting') work.state = 'shopping';
        return { ok: true, agregado: { producto: hit.name, piezas: addPieces, como: `${cantidad} ${unidad}(s)` }, carrito: this.cartView(work.cart) };
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
    const items = cart.map((c) => {
      const factor = c.pieces_per_package || 1;
      const paquetes = factor > 1 && c.qty % factor === 0 ? c.qty / factor : null;
      return {
        nombre: c.name,
        piezas: c.qty,
        // Presentación legible: "2 paquetes (80 pzas)" o "5 piezas".
        presentacion: paquetes ? `${paquetes} paquete(s) de ${factor} (${c.qty} pzas)` : `${c.qty} pieza(s)`,
        precio_pieza: c.unit_price,
        subtotal: Math.round(c.qty * (c.unit_price || 0) * 100) / 100,
      };
    });
    const total = Math.round(items.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    return { items, total };
  }

  // ── Claude ──────────────────────────────────────────────────────────────────

  private async callClaude(
    messages: any[],
    work: { cart: CartItem[]; address: any; state: ThreadState; customerName?: string | null },
  ): Promise<any> {
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

  private systemPrompt(work: {
    cart: CartItem[];
    address: any;
    state: ThreadState;
    customerName?: string | null;
  }): string {
    const cart = this.cartView(work.cart);
    const cliente = work.customerName
      ? `CLIENTE RECONOCIDO: "${work.customerName}". Saludalo por su nombre (usá solo el primer nombre, cálido) al inicio de la conversación. Ya es cliente de Mega Dulces.`
      : 'CLIENTE NUEVO/NO IDENTIFICADO: tratalo con calidez; no inventes su nombre.';
    return [
      'Sos el asistente de pedidos de Mega Dulces (dulcería) por WhatsApp. Hablás en español mexicano, cálido y breve (mensajes cortos, sin markdown).',
      cliente,
      'Tu trabajo: ayudar al cliente a armar un pedido a domicilio.',
      'REGLAS DURAS:',
      '- Para agregar un producto SIEMPRE usá primero buscar_producto y luego agregar_al_carrito con un product_id de esos resultados. Nunca inventes productos ni precios.',
      '- Los precios, existencia y total salen de las herramientas, no los inventes ni los cambies.',
      '- EXISTENCIA: nunca prometas ni agregues más de lo disponible. Si buscar_producto dice agotado (disponible_piezas 0), ofrecé otra opción. Si el cliente pide más de lo que hay, decile cuánto hay y ofrecé el máximo.',
      '- UNIDADES: los productos se venden por PIEZA y a veces por PAQUETE/CAJA (piezas_por_paquete). Cuando el cliente diga "una caja", "un paquete" o "una bolsa", agregá con unidad="paquete"; cuando diga piezas sueltas, unidad="pieza". Aclarale al cliente cómo viene (ej. "viene en paquete de 40 piezas, ¿cuántos paquetes?") y confirmá siempre la cantidad en piezas y paquetes.',
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
        description: 'Busca productos del catálogo por nombre/descripción en lenguaje natural. Devuelve product_id + precio_pieza + piezas_por_paquete + disponible_piezas/paquetes + agotado. Úsalo SIEMPRE antes de agregar al carrito.',
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Lo que el cliente quiere (ej. "pulparindo", "mazapán de la rosa", "paletas payaso")' } }, required: ['query'] },
      },
      {
        name: 'agregar_al_carrito',
        description: 'Agrega un producto al carrito. Usá un product_id que haya devuelto buscar_producto. Especificá la unidad: "pieza" (suelto) o "paquete" (caja/bolsa completa de piezas_por_paquete). Valida existencia automáticamente y rechaza si no alcanza.',
        input_schema: {
          type: 'object',
          properties: {
            product_id: { type: 'string' },
            cantidad: { type: 'integer', minimum: 1, description: 'Cuántas unidades (piezas o paquetes según "unidad").' },
            unidad: { type: 'string', enum: ['pieza', 'paquete'], description: 'Cómo lo pide el cliente. Default "pieza".' },
          },
          required: ['product_id', 'cantidad'],
        },
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
