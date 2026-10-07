import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  CommerceConversationPort,
  ConversationProductHit,
} from '@megadulces/contracts';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import { AnthropicService } from '@megadulces/platform-core';
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
  // FIQ.1 — model tiering: Haiku enruta el grueso; Sonnet toma los turnos
  // "difíciles" (mensajes largos, ambigüedad, comparación/negociación, mayoreo).
  private readonly model = 'claude-haiku-4-5-20251001';
  private readonly sonnetModel = process.env.WHATSAPP_SONNET_MODEL || 'claude-sonnet-5';
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';
  private readonly timeoutMs = 20_000;
  private readonly maxIters = 6;

  constructor(
    private readonly threads: ConversationThreadService,
    private readonly anthropic: AnthropicService,
    @Optional() @Inject(COMMERCE_CONVERSATION_PORT) private readonly commerce?: CommerceConversationPort,
  ) {}

  /** Procesa un mensaje del cliente y devuelve la respuesta (persiste el hilo). */
  async handleTurn(
    threadId: string,
    userText: string,
    opts?: { location?: { lat: number; lng: number; name?: string | null; address?: string | null } },
  ): Promise<TurnResult> {
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
    let customerId: string | null = thread.customer_id;
    try {
      const customer = await this.commerce.resolveCustomerByPhone(thread.phone);
      if (customer) {
        customerName = customer.name;
        customerId = customer.customer_id;
        if (!thread.customer_id) {
          await this.threads.update(threadId, { customer_id: customer.customer_id });
        }
      }
    } catch (e: any) {
      this.logger.warn(`resolveCustomerByPhone falló (${e?.message}) — sigo sin personalizar.`);
    }

    // FIQ.4: memoria cross-sesión — última dirección conocida para dar continuidad.
    let knownAddress: any = null;
    try {
      const prof = await this.threads.getContactProfile(thread.phone);
      if (prof) knownAddress = prof.last_address;
    } catch (e: any) {
      this.logger.warn(`getContactProfile falló (${e?.message}) — sin memoria.`);
    }

    // Estado de trabajo del turno (se persiste al final).
    const work = {
      cart: [...thread.cart] as CartItem[],
      address: thread.delivery_address as any,
      state: thread.state as ThreadState,
      handoff: false,
      customerName,
      customerId,
      knownAddress,
      phone: thread.phone as string, // FIQ.6: ancla del apartado (E.164 canónico).
    };
    // FIQ.5: pin de ubicación → coords en delivery_address (habilita el geofence
    // de entrega de última milla, que lee delivery_address.lat/lng). El motor
    // guarda las coords; el LLM confirma la dirección y pide calle/referencias.
    if (opts?.location && Number.isFinite(opts.location.lat) && Number.isFinite(opts.location.lng)) {
      const loc = opts.location;
      work.address = {
        ...(work.address || {}),
        lat: loc.lat,
        lng: loc.lng,
        street: (work.address && work.address.street) || loc.address || loc.name || 'Ubicación compartida (pin)',
      };
      if (work.state === 'greeting' || work.state === 'shopping') work.state = 'address';
      this.logger.debug(`FIQ.5: ubicación capturada (${loc.lat},${loc.lng}) en thread ${threadId}.`);
    }
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

    // FIQ.1: elegí el modelo del turno (Haiku por defecto, Sonnet si es complejo).
    const model = this.pickModel(userText, history.length);
    const t0 = Date.now();
    let loop: { text: string; iterations: number; tools: string[] };
    try {
      loop = await this.runToolLoop(messages, work, seen, model);
    } catch (e: any) {
      this.logger.warn(`Tool loop falló (${e?.message}) → handoff.`);
      await this.threads.update(threadId, { handoff: true, state: 'handoff' });
      return {
        reply: 'Tuvimos un problema técnico. Un asesor te contacta enseguida. 🙏',
        handoff: true,
        state: 'handoff',
      };
    }
    const reply = loop.text;

    await this.threads.update(threadId, {
      cart: work.cart,
      delivery_address: work.address,
      state: work.state,
      handoff: work.handoff || undefined,
    });
    // FIQ.4: persistir memoria cross-sesión (última dirección) para el próximo contacto.
    if (work.address?.street) {
      await this.threads
        .upsertContactProfile(thread.phone, { last_address: work.address, customer_id: work.customerId })
        .catch((e: any) => this.logger.warn(`upsertContactProfile falló (${e?.message}).`));
    }
    // FIQ.1: auditoría del turno (modelo/tools/latencia) + fuente del throttle.
    await this.threads.logBotTurn({
      thread_id: threadId,
      phone: thread.phone,
      user_text: userText,
      reply_text: reply,
      model,
      escalated: model !== this.model,
      tools_used: loop.tools,
      iterations: loop.iterations,
      latency_ms: Date.now() - t0,
    });
    return { reply: reply || 'Listo.', handoff: work.handoff, state: work.state };
  }

  // ── Loop de tool-use ────────────────────────────────────────────────────────

  private async runToolLoop(
    messages: any[],
    work: { cart: CartItem[]; address: any; state: ThreadState; handoff: boolean },
    seen: Map<string, ConversationProductHit>,
    model: string,
  ): Promise<{ text: string; iterations: number; tools: string[] }> {
    const tools: string[] = [];
    for (let i = 0; i < this.maxIters; i++) {
      const res = await this.callClaude(messages, work, model);
      const content: any[] = res?.content || [];
      const toolUses = content.filter((c) => c.type === 'tool_use');
      const textParts = content.filter((c) => c.type === 'text').map((c) => c.text);

      if (toolUses.length === 0) {
        // Turno terminado: el texto es la respuesta al cliente.
        return { text: textParts.join('\n').trim(), iterations: i + 1, tools };
      }

      // Ejecutar cada tool y devolver resultados.
      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        tools.push(tu.name);
        const out = await this.execTool(tu.name, tu.input || {}, work, seen);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    // Se agotaron las iteraciones: respuesta segura.
    return { text: 'Perfecto, ya casi. ¿Confirmo tu pedido o querés agregar algo más?', iterations: this.maxIters, tools };
  }

  private async execTool(
    name: string,
    input: any,
    work: {
      cart: CartItem[];
      address: any;
      state: ThreadState;
      handoff: boolean;
      customerName?: string | null;
      customerId?: string | null;
      phone?: string | null;
    },
    seen: Map<string, ConversationProductHit>,
  ): Promise<any> {
    switch (name) {
      case 'mi_historial': {
        // FIQ.4: "lo de siempre" / reorden. Requiere cliente reconocido (FIQ.0).
        if (!work.customerId) {
          return { info: 'Cliente no identificado (número nuevo): no hay historial. Ofrecé ayudarle a buscar productos.' };
        }
        const hist = await this.commerce!.customerHistory(work.customerId, { limit: 8 });
        for (const h of hist) seen.set(h.product_id, h); // habilita agregar_al_carrito (tope con stock)
        if (work.state === 'greeting') work.state = 'shopping';
        if (hist.length === 0) return { info: 'El cliente no tiene compras previas registradas.' };
        return {
          historial: hist.map((h) => {
            const factor = h.pieces_per_package || 1;
            return {
              product_id: h.product_id,
              nombre: h.name,
              marca: h.brand_name,
              precio_pieza: h.unit_price,
              precio_paquete: factor > 1 ? h.price_per_package : null,
              piezas_por_paquete: factor,
              se_vende_por: factor > 1 ? 'pieza o paquete' : 'pieza',
              disponibilidad: h.availability,
              veces_pedido: h.times_ordered,
            };
          }),
        };
      }
      case 'sugeridos_para_ti': {
        // FIQ.4: canasta IA (upsell/cross-sell). Requiere cliente reconocido.
        if (!work.customerId) {
          return { info: 'Cliente no identificado: no hay sugeridos personalizados. Usá promociones_activas o buscar_producto.' };
        }
        const sug = await this.commerce!.customerSuggested(work.customerId);
        for (const h of sug) seen.set(h.product_id, h);
        if (work.state === 'greeting') work.state = 'shopping';
        if (sug.length === 0) return { info: 'Sin sugerencias por ahora.' };
        return {
          sugeridos: sug.map((h) => {
            const factor = h.pieces_per_package || 1;
            return {
              product_id: h.product_id,
              nombre: h.name,
              marca: h.brand_name,
              precio_pieza: h.unit_price,
              precio_paquete: factor > 1 ? h.price_per_package : null,
              piezas_por_paquete: factor,
              se_vende_por: factor > 1 ? 'pieza o paquete' : 'pieza',
              disponibilidad: h.availability,
              motivo: h.reason,
            };
          }),
        };
      }
      case 'promociones_activas': {
        // FIQ.4: promos vigentes para el cliente (o all_customers si casual).
        const promos = await this.commerce!.activePromotions({ customerId: work.customerId });
        for (const h of promos) seen.set(h.product_id, h);
        if (work.state === 'greeting') work.state = 'shopping';
        if (promos.length === 0) return { info: 'No hay promociones activas en este momento.' };
        return {
          promociones: promos.map((h) => {
            const factor = h.pieces_per_package || 1;
            return {
              product_id: h.product_id,
              nombre: h.name,
              marca: h.brand_name,
              precio_pieza: h.unit_price,
              precio_paquete: factor > 1 ? h.price_per_package : null,
              piezas_por_paquete: factor,
              se_vende_por: factor > 1 ? 'pieza o paquete' : 'pieza',
              disponibilidad: h.availability,
              promo: h.promo_name,
            };
          }),
        };
      }
      case 'top_productos': {
        // FIQ.8: los más pedidos (demanda real agregada) — prueba social para
        // indecisos/nuevos. El motor filtra tenant explícito.
        const hits = await this.commerce!.marketTopProducts({
          brand: input.marca ? String(input.marca) : undefined,
          limit: 5,
        });
        for (const h of hits) seen.set(h.product_id, h);
        if (work.state === 'greeting') work.state = 'shopping';
        if (hits.length === 0) return { info: 'Aún no tengo datos de lo más vendido.' };
        return { top: hits.map((h) => this.marketView(h)) };
      }
      case 'tendencias_mercado': {
        // FIQ.8: lo que más se mueve últimamente ("de temporada").
        const hits = await this.commerce!.marketTrending({ limit: 5 });
        for (const h of hits) seen.set(h.product_id, h);
        if (work.state === 'greeting') work.state = 'shopping';
        if (hits.length === 0) return { info: 'Sin tendencias claras por ahora.' };
        return { tendencias: hits.map((h) => this.marketView(h)) };
      }
      case 'buscar_producto': {
        // FIQ.3: precio de la lista del cliente reconocido (mayoreo).
        const hits = await this.commerce!.searchProducts(String(input.query || ''), {
          limit: 5,
          customerId: work.customerId,
        });
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
              // FIQ.3: precio por caja (mayoreo) cuando viene en paquete.
              precio_paquete: factor > 1 ? h.price_per_package : null,
              minimo_piezas: h.min_qty,
              // Empaque: cómo se vende. factor 1 = suelto por pieza.
              piezas_por_paquete: factor,
              se_vende_por: factor > 1 ? 'pieza o paquete' : 'pieza',
              // FIQ.2: existencia CUALITATIVA (nunca el número exacto). El tope real
              // lo aplica agregar_al_carrito con stock_pieces (interno, no se expone).
              disponibilidad: h.availability,
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
          // FIQ.2: rechaza sin revelar el total. El LLM ofrece menos o waitlist,
          // NUNCA dice cuántas piezas hay.
          return {
            error: 'insuficiente',
            mensaje: 'No tengo esa cantidad disponible ahora mismo.',
            instruccion:
              'Pedí una cantidad menor o ofrecé avisarle cuando se reponga. NO menciones el número disponible.',
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
        // FIQ.7 (ADR-037): gate de confianza. El MOTOR decide el tier; el LLM
        // comunica sin acusar. Degrada a 'allow' si el puerto falla (no romper).
        let trust: { tier: string; reasons: string[] } | null = null;
        if (work.phone) {
          try {
            trust = await this.commerce!.assessContactTrust(work.phone);
          } catch (e: any) {
            this.logger.warn(`assessContactTrust falló (${e?.message}) — confirmo sin gate.`);
          }
        }
        if (trust?.tier === 'block') {
          // No auto-confirmar: derivar a un humano (nunca refuse hard ni acuse).
          work.handoff = true;
          work.state = 'handoff';
          return {
            gate: 'handoff',
            instruccion:
              'NO confirmes el pedido. Con calidez, decile que un asesor de Mega Dulces lo va a contactar para coordinar este pedido. NUNCA menciones su historial, ni "bloqueo", ni desconfianza. Amable y neutral.',
          };
        }
        work.state = 'review';
        if (trust?.tier === 'require_deposit') {
          return {
            ok: true,
            gate: 'require_deposit',
            mensaje: 'Pedido listo para revisión de un asesor.',
            resumen: { carrito: this.cartView(work.cart), domicilio: work.address },
            instruccion:
              'Pedile con tacto un ANTICIPO o pago por TRANSFERENCIA para asegurar el pedido (política para pedidos nuevos o grandes) y avisá que un asesor lo confirma. NO menciones su historial ni des explicaciones negativas, NO pidas datos de tarjeta (no hay pago en línea).',
          };
        }
        return {
          ok: true,
          mensaje: 'Pedido listo para revisión de un asesor.',
          resumen: { carrito: this.cartView(work.cart), domicilio: work.address },
        };
      }
      case 'apartar_pedido': {
        // FIQ.6 (ADR-038): aparta (reserva con TTL) lo que hay en el carrito. El
        // MOTOR reserva el stock de forma atómica; el bot NO cierra el pedido.
        if (!work.phone) return { error: 'No tengo el teléfono del contacto para el apartado.' };
        if (work.cart.length === 0) return { error: 'El carrito está vacío. Agregá productos antes de apartar.' };
        const horas = Math.max(1, Math.min(Math.floor(Number(input.horas) || 3), 24));
        try {
          const res = await this.commerce!.reserveStock({
            phone: work.phone,
            customerId: work.customerId ?? null,
            lines: work.cart.map((c) => ({ product_id: c.product_id, quantity: c.qty })),
            ttlMinutes: horas * 60,
          });
          // El stock queda reservado bajo el folio → vaciamos el carrito de trabajo
          // (los items pasaron al apartado) para no reservar dos veces si confirma luego.
          work.cart = [];
          return {
            ok: true,
            folio: res.folio,
            vence_en_horas: Math.max(1, Math.round(res.expires_in_minutes / 60)),
            total: res.total,
            items: res.lines.map((l) => ({ producto: l.name, piezas: l.quantity })),
            instruccion:
              'Confirmá el folio y hasta cuándo se lo guardamos. El apartado NO es una entrega: si quiere que se lo llevemos, armá un pedido con confirmar_pedido (domicilio + confirmar).',
          };
        } catch (e: any) {
          // Stock insuficiente (ConflictException del motor) → mensaje cualitativo, sin números.
          return {
            error: 'no_apartado',
            mensaje: e?.message || 'No pudimos apartar esos productos ahora.',
            instruccion: 'Ofrecé una cantidad menor o quitar el producto que no alcanzó. NUNCA menciones números de inventario.',
          };
        }
      }
      case 'consultar_apartado': {
        // FIQ.6: apartados vigentes del contacto.
        if (!work.phone) return { info: 'Sin teléfono no puedo consultar apartados.' };
        const list = await this.commerce!.activeReservations(work.phone);
        if (list.length === 0) return { info: 'No tenés apartados activos en este momento.' };
        return {
          apartados: list.map((r) => ({
            folio: r.folio,
            vence_en_horas: Math.max(1, Math.round(r.expires_in_minutes / 60)),
            total: r.total,
            items: r.lines.map((l) => ({ producto: l.name, piezas: l.quantity })),
          })),
        };
      }
      case 'cancelar_apartado': {
        // FIQ.6: libera TODOS los apartados activos del contacto y devuelve el stock.
        if (!work.phone) return { error: 'Sin teléfono no puedo cancelar apartados.' };
        const res = await this.commerce!.releaseReservation({ phone: work.phone });
        if (res.released === 0) return { info: 'No tenías apartados activos para cancelar.' };
        return { ok: true, cancelados: res.released, instruccion: 'Confirmá que liberaste el apartado.' };
      }
      case 'handoff_humano':
        work.handoff = true;
        work.state = 'handoff';
        return { ok: true };
      default:
        return { error: `Herramienta desconocida: ${name}` };
    }
  }

  /** FIQ.8: vista customer-safe de un hit de mercado (sin revenue ni unidades exactas). */
  private marketView(h: ConversationProductHit & { market_label?: string; rank?: number }) {
    const factor = h.pieces_per_package || 1;
    return {
      product_id: h.product_id,
      nombre: h.name,
      marca: h.brand_name,
      precio_pieza: h.unit_price,
      precio_paquete: factor > 1 ? h.price_per_package : null,
      piezas_por_paquete: factor,
      se_vende_por: factor > 1 ? 'pieza o paquete' : 'pieza',
      disponibilidad: h.availability,
      etiqueta: h.market_label,
      posicion: h.rank,
    };
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
    work: { cart: CartItem[]; address: any; state: ThreadState; customerName?: string | null; knownAddress?: any },
    model: string,
  ): Promise<any> {
    // Transporte compartido. cachePrefix OFF a propósito: el system se recomputa
    // cada iteración con el estado del carrito → no habría hit de caché de prefijo.
    return this.anthropic.messages(
      {
        model,
        maxTokens: 1024,
        system: this.systemPrompt(work),
        tools: this.toolDefs(),
        messages,
      },
      { timeoutMs: this.timeoutMs },
    );
  }

  /**
   * FIQ.1 — Tiering de modelo. Haiku conduce el grueso (rápido/barato); Sonnet
   * toma los turnos "difíciles": mensajes largos, hilo ya extenso, o señales de
   * ambigüedad/comparación/negociación/mayoreo/factura donde el razonamiento
   * paga. Heurístico y barato (sin llamada extra). El motor sigue poniendo los
   * números (ADR-016) sin importar el modelo.
   */
  private pickModel(userText: string, historyLen: number): string {
    const t = (userText || '').toLowerCase();
    const complex =
      t.length > 160 ||
      historyLen >= 6 ||
      /(por qu|porqu|cu[aá]l|diferencia|recomien|no s[eé]|conviene|mejor opci|comparar|cu[aá]nto.*(sale|cuesta|queda).*(si|con)|mayoreo|al por mayor|factura|descuento|precio especial|crédito|credito)/i.test(
        t,
      );
    return complex ? this.sonnetModel : this.model;
  }

  private systemPrompt(work: {
    cart: CartItem[];
    address: any;
    state: ThreadState;
    customerName?: string | null;
    knownAddress?: any;
  }): string {
    const cart = this.cartView(work.cart);
    const cliente = work.customerName
      ? `CLIENTE RECONOCIDO: "${work.customerName}". Saludalo por su nombre (solo el primer nombre, cálido) al inicio. Ya es cliente de Mega Dulces: si pide "lo de siempre"/su pedido habitual, o si querés sugerirle, usá mi_historial.`
      : 'CLIENTE NUEVO/NO IDENTIFICADO: tratalo con calidez; no inventes su nombre ni su historial.';
    // FIQ.4: memoria — dirección de un pedido anterior (solo si aún no capturó una en este pedido).
    const memoria =
      work.knownAddress?.street && !work.address?.street
        ? `MEMORIA: en un pedido anterior lo enviaste a "${work.knownAddress.street}". Cuando llegue el momento de la entrega, ofrecé enviar a la misma dirección (confirmá antes de usarla; si dice que sí, capturala con capturar_domicilio).`
        : '';
    return [
      'Sos el asistente de pedidos de Mega Dulces (dulcería) por WhatsApp. Hablás en español mexicano, cálido y breve (mensajes cortos, sin markdown).',
      cliente,
      memoria,
      'Tu trabajo: ayudar al cliente a armar un pedido a domicilio.',
      'REGLAS DURAS:',
      '- Para agregar un producto SIEMPRE usá primero buscar_producto y luego agregar_al_carrito con un product_id de esos resultados. Nunca inventes productos ni precios.',
      '- Los precios, existencia y total salen de las herramientas, no los inventes ni los cambies.',
      '- EXISTENCIA: NUNCA menciones cantidades exactas de inventario ni "quedan N piezas". Comunicá SOLO la disponibilidad cualitativa de buscar_producto (disponibilidad: "disponible" = hay; "pocas" = quedan pocas, podés generar urgencia SIN número; "agotado" = ofrecé otra opción). Si el cliente pide más de lo que hay, agregar_al_carrito lo rechaza: pedile una cantidad menor o ofrecé avisarle cuando se reponga, SIN decir el número disponible.',
      '- UNIDADES: los productos se venden por PIEZA y a veces por PAQUETE/CAJA (piezas_por_paquete). Cuando el cliente diga "una caja", "un paquete" o "una bolsa", agregá con unidad="paquete"; cuando diga piezas sueltas, unidad="pieza". Aclarale al cliente cómo viene (ej. "viene en paquete de 40 piezas, ¿cuántos paquetes?") y confirmá siempre la cantidad en piezas y paquetes.',
      '- MAYOREO/PRECIOS: los precios que te da buscar_producto YA son los del cliente (de mayoreo si está reconocido) — nunca inventes ni cambies un precio. Cuando el producto viene en caja (piezas_por_paquete > 1), ofrecé SIEMPRE el precio por CAJA (precio_paquete) además del de pieza, ej. "la caja de 40 te sale a $precio_paquete ($precio_pieza c/u)". Respetá minimo_piezas (cantidad mínima de compra) al cerrar.',
      '- UPSELL (con tacto): si el cliente está reconocido y por cerrar o dudando, ofrecé 1-2 productos de sugeridos_para_ti (con su motivo) o de promociones_activas. Nunca insistas ni satures; máximo una sugerencia por turno.',
      '- QUÉ COMPRAR/MERCADO: si el cliente es NUEVO, está indeciso, o pregunta "¿qué me recomiendas?"/"¿qué es lo más vendido?"/"¿qué está de moda?", usá top_productos (los más pedidos) o tendencias_mercado (lo de temporada) como prueba social. Funciona también para casual sin historial. Preséntalo natural ("de lo que más se llevan es...") sin dar cifras de ventas.',
      '- APARTADO: si el cliente quiere que le GUARDES/RESERVES producto para que no se agote (sin entregarlo aún, o porque lo recoge después, o no está listo para dar domicilio), armá el carrito y usá apartar_pedido. Dale el folio AP-... y decile hasta cuándo se lo guardás. El apartado NO es una entrega: si además quiere que se lo lleven, eso es un pedido aparte (domicilio + confirmar_pedido). Puede consultar (consultar_apartado) o cancelar (cancelar_apartado) su apartado.',
      '- ENTREGA (UBICACIÓN PRIMERO): cuando ya haya productos y toque la entrega, PEDÍ PRIMERO que comparta su UBICACIÓN por WhatsApp (📎/clip → Ubicación → "Enviar tu ubicación actual"). Es lo más rápido y exacto para que el repartidor llegue. Es el método preferido.',
      '- Cuando comparta su ubicación (pin), YA queda guardada: SOLO confirmá con calidez ("¡Listo, recibí tu ubicación! 📍, ya casi"). Con el pin ALCANZA para entregar — podés pedir una referencia corta (color de casa) pero NO la exijas ni bloquees por eso.',
      '- Solo si NO puede o NO quiere mandar el pin, recién ahí pedile la calle y número por texto y guardala con capturar_domicilio.',
      '- Antes de confirmar necesitás: al menos 1 producto en el carrito Y la ubicación de entrega (el pin compartido O la calle capturada).',
      '- Al confirmar, avisá que un asesor de Mega Dulces revisa y confirma el pedido (no lo cierres vos).',
      '- CONFIANZA/PAGO: si confirmar_pedido te devuelve una instrucción de pedir anticipo/transferencia o de derivar a un asesor, seguila con calidez y SIN explicaciones negativas. NUNCA menciones el historial del cliente, "bloqueo", deuda ni desconfianza.',
      '- Si el cliente pide algo que no entendés, se enoja, o pide hablar con una persona, usá handoff_humano.',
      '- El pago es contra-entrega (efectivo al recibir). No pidas datos de tarjeta.',
      `ESTADO ACTUAL → etapa: ${work.state}. Carrito: ${cart.items.length ? JSON.stringify(cart) : 'vacío'}. Domicilio: ${work.address?.street ? JSON.stringify(work.address) : 'no capturado'}.`,
    ].join('\n');
  }

  private toolDefs(): any[] {
    return [
      {
        name: 'mi_historial',
        description: 'Devuelve los productos que ESTE cliente ya compró antes (frecuencia + disponibilidad). Úsalo cuando pida "lo de siempre", "lo mismo", su pedido habitual, o para sugerir según su historial. Los product_id sirven para agregar_al_carrito. Solo funciona con cliente reconocido.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'sugeridos_para_ti',
        description: 'Canasta de recomendaciones IA para el cliente (lo que suele llevar + productos afines que no compra + novedades), cada uno con un motivo. Úsalo para UPSELL/cross-sell: cuando el cliente termina o duda, ofrecele 1-2 sugeridos relevantes. Solo con cliente reconocido. product_id sirven para agregar_al_carrito.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'promociones_activas',
        description: 'Lista productos con promoción/oferta vigente para el cliente. Úsalo cuando pregunte por ofertas/promociones o para tentarlo con lo que está en promo. product_id sirven para agregar_al_carrito.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'top_productos',
        description: 'Lista los productos MÁS PEDIDOS/vendidos (prueba social por demanda real). Úsalo cuando el cliente pregunte "¿qué es lo más vendido?", "¿qué me recomiendas?", "¿qué llevan más?", o para orientar a alguien indeciso o nuevo. Opcional filtrar por marca. Los product_id sirven para agregar_al_carrito.',
        input_schema: { type: 'object', properties: { marca: { type: 'string', description: 'Filtrar por marca (opcional)' } } },
      },
      {
        name: 'tendencias_mercado',
        description: 'Lista los productos EN TENDENCIA (más movimiento reciente / lo de temporada). Úsalo para "¿qué está de moda?", "¿qué se vende ahorita?", o para tentar con lo que está pegando. Los product_id sirven para agregar_al_carrito.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'buscar_producto',
        description: 'Busca productos del catálogo por nombre/descripción en lenguaje natural. Devuelve product_id + precio_pieza + piezas_por_paquete + disponibilidad (cualitativa). Úsalo SIEMPRE antes de agregar al carrito.',
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
        name: 'apartar_pedido',
        description:
          'Aparta (reserva/guarda) los productos del carrito por unas horas para que no se agoten, SIN entregarlos todavía. Úsalo cuando el cliente diga "apártame", "resérvame", "guárdamelo", "lo recojo después", o no esté listo para dar domicilio. Devuelve un folio AP-... y hasta cuándo se guarda. El apartado NO es un pedido a domicilio.',
        input_schema: {
          type: 'object',
          properties: {
            horas: { type: 'integer', minimum: 1, maximum: 24, description: 'Cuántas horas guardarlo (default 3, máx 24).' },
          },
        },
      },
      {
        name: 'consultar_apartado',
        description: 'Muestra los apartados vigentes del cliente (folio, qué guardó, hasta cuándo, total). Úsalo si pregunta "¿qué tengo apartado?" o "¿sigue mi apartado?".',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'cancelar_apartado',
        description: 'Cancela/libera los apartados vigentes del cliente (devuelve los productos al inventario). Úsalo si dice "cancela mi apartado" o "ya no lo quiero".',
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
