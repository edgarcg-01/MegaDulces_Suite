import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import type { InboundMessage } from '../ports/whatsapp.port';

/** Estado del diálogo (máquina simple; el orquestador F.2 lo hace avanzar). */
export type ThreadState = 'greeting' | 'shopping' | 'address' | 'review' | 'handoff' | 'done';

export interface CartItem {
  product_id: string;
  sku?: string | null;
  name?: string | null;
  /** Cantidad en PIEZAS (unidad canónica del pedido, = order_lines.quantity). */
  qty: number;
  unit_price?: number | null;
  /** Piezas por paquete/caja (factor_sale). Para mostrar "2 paquetes (80 pzas)". */
  pieces_per_package?: number | null;
}

export interface ConversationThread {
  id: string;
  phone: string;
  wa_id: string;
  profile_name: string | null;
  customer_id: string | null;
  state: ThreadState;
  cart: CartItem[];
  delivery_address: any | null;
  handoff_at: string | null;
  order_id: string | null;
  last_message_at: string | null;
}

/**
 * Fase F.0 — Estado de la conversación por número (persistencia del hilo + log
 * de mensajes). RLS forzado: todo pasa por `TenantKnexService.run()` (regla dura
 * del proyecto — sin scope de tenant, 0 filas). El orquestador (F.2) lee/escribe
 * el carrito y el estado; el webhook (F.1) registra los mensajes in/out.
 */
@Injectable()
export class ConversationThreadService {
  private readonly logger = new Logger(ConversationThreadService.name);

  constructor(private readonly tk: TenantKnexService) {}

  private parse(row: any): ConversationThread {
    const j = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
    return {
      id: row.id,
      phone: row.phone,
      wa_id: row.wa_id,
      profile_name: row.profile_name ?? null,
      customer_id: row.customer_id ?? null,
      state: row.state,
      cart: (j(row.cart) as CartItem[]) ?? [],
      delivery_address: row.delivery_address ? j(row.delivery_address) : null,
      handoff_at: row.handoff_at ?? null,
      order_id: row.order_id ?? null,
      last_message_at: row.last_message_at ?? null,
    };
  }

  /** Trae el hilo abierto del número o crea uno nuevo en `greeting`. */
  async getOrCreate(phone: string, waId: string, profileName?: string | null): Promise<ConversationThread> {
    return this.tk.run(async (trx) => {
      const existing = await trx('whatsapp.conversation_threads')
        .where({ phone })
        .whereNot('state', 'done')
        .orderBy('created_at', 'desc')
        .first();
      if (existing) return this.parse(existing);

      const [row] = await trx('whatsapp.conversation_threads')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          phone,
          wa_id: waId,
          profile_name: profileName || null,
          state: 'greeting',
          cart: JSON.stringify([]),
          last_message_at: trx.fn.now(),
        })
        .returning('*');
      return this.parse(row);
    });
  }

  /** Trae un hilo por id (o null). Para el orquestador (estado + carrito frescos). */
  async getById(id: string): Promise<ConversationThread | null> {
    return this.tk.run(async (trx) => {
      const row = await trx('whatsapp.conversation_threads').where({ id }).first();
      return row ? this.parse(row) : null;
    });
  }

  /** Hilos en un estado dado (p. ej. 'review' = bandeja de pedidos por aprobar). */
  async listByState(state: ThreadState, limit = 100): Promise<ConversationThread[]> {
    return this.tk.run(async (trx) => {
      const rows = await trx('whatsapp.conversation_threads')
        .where({ state })
        .orderBy('last_message_at', 'asc')
        .limit(limit);
      return rows.map((r) => this.parse(r));
    });
  }

  /** Últimos N mensajes del hilo (orden cronológico) para dar contexto al LLM. */
  async recentMessages(threadId: string, limit = 8): Promise<{ direction: 'in' | 'out'; body: string | null }[]> {
    return this.tk.run(async (trx) => {
      const rows = await trx('whatsapp.messages')
        .where({ thread_id: threadId })
        .orderBy('created_at', 'desc')
        .limit(limit)
        .select('direction', 'body');
      return rows.reverse();
    });
  }

  /** Patch parcial del hilo (estado / carrito / domicilio / customer / order / handoff). */
  async update(
    id: string,
    patch: Partial<{
      state: ThreadState;
      cart: CartItem[];
      delivery_address: any;
      customer_id: string | null;
      order_id: string | null;
      handoff: boolean;
    }>,
  ): Promise<void> {
    await this.tk.run(async (trx) => {
      const u: Record<string, unknown> = { updated_at: trx.fn.now(), last_message_at: trx.fn.now() };
      if (patch.state !== undefined) u['state'] = patch.state;
      if (patch.cart !== undefined) u['cart'] = JSON.stringify(patch.cart);
      if (patch.delivery_address !== undefined)
        u['delivery_address'] = patch.delivery_address ? JSON.stringify(patch.delivery_address) : null;
      if (patch.customer_id !== undefined) u['customer_id'] = patch.customer_id;
      if (patch.order_id !== undefined) u['order_id'] = patch.order_id;
      if (patch.handoff) u['handoff_at'] = trx.fn.now();
      await trx('whatsapp.conversation_threads').where({ id }).update(u);
    });
  }

  /**
   * Registra un mensaje (in/out). Idempotente por `wa_message_id` (dedup del
   * webhook). Devuelve `true` si insertó, `false` si ya existía (duplicado).
   */
  async logMessage(
    threadId: string,
    direction: 'in' | 'out',
    m: { wa_message_id?: string | null; type?: string; body?: string | null; payload?: unknown },
  ): Promise<boolean> {
    return this.tk.run(async (trx) => {
      try {
        await trx('whatsapp.messages').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          thread_id: threadId,
          direction,
          wa_message_id: m.wa_message_id || null,
          type: m.type || 'text',
          body: m.body ?? null,
          payload: m.payload != null ? JSON.stringify(m.payload) : null,
        });
        return true;
      } catch (e: any) {
        // 23505 = unique_violation contra el índice parcial (tenant_id, wa_message_id)
        // → mensaje ya registrado (reintrega de Meta / doble encolado). No es error.
        if (e?.code === '23505') return false;
        throw e;
      }
    });
  }

  /**
   * FIQ.4 — Perfil persistente del contacto (memoria cross-sesión) por teléfono
   * canónico. Devuelve null si es la primera vez que escribe.
   */
  async getContactProfile(
    phone: string,
  ): Promise<{ last_address: any | null; summary: string | null; customer_id: string | null } | null> {
    return this.tk.run(async (trx) => {
      const row = await trx('whatsapp.contact_profile').where({ whatsapp: phone }).first();
      if (!row) return null;
      const j = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
      return {
        last_address: row.last_address ? j(row.last_address) : null,
        summary: row.summary ?? null,
        customer_id: row.customer_id ?? null,
      };
    });
  }

  /** FIQ.4 — UPSERT del perfil por (tenant_id, whatsapp). Patch parcial. */
  async upsertContactProfile(
    phone: string,
    patch: { customer_id?: string | null; last_address?: any; summary?: string | null },
  ): Promise<void> {
    await this.tk.run(async (trx) => {
      const set: Record<string, unknown> = { updated_at: trx.fn.now() };
      if (patch.customer_id !== undefined) set['customer_id'] = patch.customer_id;
      if (patch.last_address !== undefined)
        set['last_address'] = patch.last_address ? JSON.stringify(patch.last_address) : null;
      if (patch.summary !== undefined) set['summary'] = patch.summary;
      const existing = await trx('whatsapp.contact_profile').where({ whatsapp: phone }).first('id');
      if (existing) {
        await trx('whatsapp.contact_profile').where({ id: existing.id }).update(set);
      } else {
        await trx('whatsapp.contact_profile').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          whatsapp: phone,
          ...set,
        });
      }
    });
  }

  /** Helper: ¿ya vimos este mensaje entrante? (dedup previo al encolado). */
  async isDuplicateInbound(msg: InboundMessage): Promise<boolean> {
    if (!msg.wa_message_id) return false;
    return this.tk.run(async (trx) => {
      const hit = await trx('whatsapp.messages')
        .where({ wa_message_id: msg.wa_message_id, direction: 'in' })
        .first();
      return !!hit;
    });
  }
}
