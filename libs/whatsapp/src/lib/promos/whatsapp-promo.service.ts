import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '@megadulces/platform-core';
import { ConversationThreadService } from '../conversation/conversation-thread.service';
import { WhatsAppQueueService } from '../queue/whatsapp-queue.service';

/**
 * Fase F.7 (ADR-034) — Envío de promociones con imagen.
 *
 * Bloque base (un destinatario). El broadcast masivo (F.8) reusa estos métodos
 * sobre una lista con opt-in + rate-limit por cola.
 *
 * REGLA DE VENTANA (Meta): fuera de la ventana de 24h (cliente que NO te escribió
 * recientemente) SOLO se puede iniciar con `sendTemplate` (plantilla de marketing
 * APROBADA). La imagen libre (`sendImageInWindow`) solo funciona dentro de la
 * ventana de 24h. Enviar imagen libre fuera de ventana → Meta lo rechaza.
 */
@Injectable()
export class WhatsAppPromoService {
  private readonly logger = new Logger(WhatsAppPromoService.name);

  constructor(
    private readonly threads: ConversationThreadService,
    private readonly queue: WhatsAppQueueService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private normalizePhone(phone: string): string {
    const p = (phone || '').replace(/[^\d]/g, '');
    if (p.length < 10) throw new BadRequestException('Teléfono inválido');
    return p;
  }

  /**
   * Imagen libre (con caption) — SOLO dentro de la ventana de 24h. Úsalo para
   * responder promos a quien ya está conversando. Fuera de ventana usar template.
   */
  async sendImageInWindow(phone: string, imageUrl: string, caption?: string) {
    const to = this.normalizePhone(phone);
    if (!/^https?:\/\//i.test(imageUrl || '')) throw new BadRequestException('image_url debe ser una URL pública');
    const thread = await this.threads.getOrCreate(to, to);
    await this.queue.enqueue({
      dir: 'out',
      tenant_id: this.tenantCtx.get()?.tenantId,
      payload: { to, thread_id: thread.id, kind: 'image', body: caption || '[imagen]', image: { link: imageUrl, caption } },
    });
    return { to, thread_id: thread.id, sent: 'image' };
  }

  /**
   * Plantilla de marketing aprobada (con header de imagen opcional). Válido para
   * iniciar conversación fuera de la ventana de 24h (el caso del broadcast).
   */
  async sendTemplate(phone: string, name: string, language: string, imageUrl?: string, bodyParams?: string[]) {
    const to = this.normalizePhone(phone);
    if (!name?.trim()) throw new BadRequestException('template name requerido');
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) throw new BadRequestException('image_url debe ser una URL pública');
    const thread = await this.threads.getOrCreate(to, to);
    await this.queue.enqueue({
      dir: 'out',
      tenant_id: this.tenantCtx.get()?.tenantId,
      payload: {
        to,
        thread_id: thread.id,
        kind: 'template',
        body: `[template ${name}]`,
        template: { name: name.trim(), language: language || 'es_MX', imageLink: imageUrl, bodyParams },
      },
    });
    return { to, thread_id: thread.id, sent: 'template' };
  }
}
