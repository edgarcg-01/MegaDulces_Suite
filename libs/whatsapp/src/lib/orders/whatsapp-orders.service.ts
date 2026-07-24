import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { TenantContextService } from '@megadulces/platform-core';
import type { CommerceConversationPort } from '@megadulces/contracts';
import { COMMERCE_CONVERSATION_PORT } from '@megadulces/contracts';
import { ConversationThreadService } from '../conversation/conversation-thread.service';
import { WhatsAppQueueService } from '../queue/whatsapp-queue.service';

/**
 * Fase F.3 (ADR-034) — Bandeja de pedidos WhatsApp: el HUMANO confirma.
 *
 * Los hilos que el bot dejó en `review` (carrito + domicilio armados) esperan a
 * un operador. Confirmar = crear el pedido a domicilio real (canal whatsapp) vía
 * el puerto (reusa el intake de última milla), linkear el order_id al hilo,
 * cerrarlo (`done`) y avisar al cliente por WhatsApp. De ahí sigue el flujo
 * normal de `/reparto/asignar`. Rechazar = cerrar el hilo + avisar.
 *
 * El bot NUNCA cierra el pedido; la aprobación humana ES la confirmación
 * (ADR-034). Endpoints protegidos con WHATSAPP_BOT_* en el controller.
 */
@Injectable()
export class WhatsAppOrdersService {
  private readonly logger = new Logger(WhatsAppOrdersService.name);

  constructor(
    private readonly threads: ConversationThreadService,
    private readonly queue: WhatsAppQueueService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(COMMERCE_CONVERSATION_PORT) private readonly commerce?: CommerceConversationPort,
  ) {}

  /** Bandeja: hilos listos para aprobar (state='review') con su carrito+domicilio+total. */
  async listPending() {
    const rows = await this.threads.listByState('review');
    return rows.map((t) => {
      const total = (t.cart || []).reduce((s, c) => s + c.qty * (c.unit_price || 0), 0);
      return {
        thread_id: t.id,
        phone: t.phone,
        customer_name: t.delivery_address?.recipient_name || t.profile_name || null,
        items: (t.cart || []).map((c) => ({ name: c.name, qty: c.qty, unit_price: c.unit_price })),
        total: Math.round(total * 100) / 100,
        delivery_address: t.delivery_address,
        last_message_at: t.last_message_at,
      };
    });
  }

  /** Aprueba el hilo → crea el pedido a domicilio + avisa al cliente + cierra el hilo. */
  async confirm(threadId: string) {
    if (!this.commerce) throw new BadRequestException('Catálogo/pedidos no disponibles (binding ausente)');
    const t = await this.threads.getById(threadId);
    if (!t) throw new NotFoundException('Conversación no encontrada');
    if (t.state !== 'review') throw new ConflictException(`La conversación no está en revisión (estado=${t.state})`);
    if (t.order_id) throw new ConflictException('La conversación ya tiene un pedido');
    if (!t.cart?.length) throw new BadRequestException('El carrito está vacío');
    if (!t.delivery_address?.street) throw new BadRequestException('Falta el domicilio de entrega');

    const res = await this.commerce.createHomeDeliveryOrder({
      casual: { name: t.delivery_address.recipient_name || t.profile_name || `Cliente ${t.phone}`, phone: t.phone },
      delivery_address: {
        street: t.delivery_address.street,
        references: t.delivery_address.references,
        recipient_name: t.delivery_address.recipient_name,
        phone: t.delivery_address.phone || t.phone,
      },
      lines: t.cart.map((c) => ({ product_id: c.product_id, quantity: c.qty })),
    });

    await this.threads.update(threadId, { order_id: res.order_id, state: 'done' });

    const money = res.total.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
    await this.enqueueOut(
      t.phone,
      threadId,
      `¡Tu pedido ${res.code} quedó confirmado! 🎉 Un repartidor te lo lleva a domicilio. ` +
        `Pagas ${money} en efectivo al recibir. ¡Gracias por tu compra en Mega Dulces!`,
    );
    this.logger.log(`Pedido WhatsApp ${res.code} confirmado desde hilo ${threadId}.`);
    return { thread_id: threadId, order_id: res.order_id, code: res.code, total: res.total };
  }

  /** Rechaza el hilo → lo cierra + avisa al cliente (motivo opcional). */
  async reject(threadId: string, reason?: string) {
    const t = await this.threads.getById(threadId);
    if (!t) throw new NotFoundException('Conversación no encontrada');
    if (t.state === 'done') throw new ConflictException('La conversación ya está cerrada');

    await this.threads.update(threadId, { state: 'done' });
    await this.enqueueOut(
      t.phone,
      threadId,
      reason?.trim()
        ? `No pudimos procesar tu pedido: ${reason.trim()}. Escríbenos para ayudarte. 🙏`
        : 'No pudimos procesar tu pedido en este momento. Escríbenos para ayudarte. 🙏',
    );
    return { thread_id: threadId, status: 'rejected' };
  }

  private async enqueueOut(to: string, threadId: string, body: string) {
    await this.queue.enqueue({
      dir: 'out',
      tenant_id: this.tenantCtx.get()?.tenantId,
      payload: { to, thread_id: threadId, kind: 'text', body },
    });
  }
}
