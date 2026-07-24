import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantContextService } from '@megadulces/platform-core';
import { WHATSAPP_PORT } from '../ports/whatsapp.port';
import type {
  ImageMessage,
  InboundMessage,
  InteractiveMessage,
  TemplateMessage,
  WhatsAppPort,
} from '../ports/whatsapp.port';
import { WhatsAppQueueService, WhatsAppJob } from '../queue/whatsapp-queue.service';
import { ConversationThreadService } from '../conversation/conversation-thread.service';
import { ConversationOrchestratorService } from '../conversation/conversation-orchestrator.service';
import { WhatsAppOptinService } from '../broadcast/whatsapp-optin.service';

/** Payload de un job de ENTRADA (un mensaje del cliente a procesar). */
interface InJobPayload {
  thread_id: string;
  phone: string;
  wa_id: string;
  text: string | null;
  wa_message_id: string;
}

/** Payload de un job de SALIDA (una respuesta a enviar por el puerto). */
interface OutJobPayload {
  to: string;
  thread_id: string;
  kind: 'text' | 'interactive' | 'image' | 'template';
  body: string;
  interactive?: InteractiveMessage;
  image?: ImageMessage;
  template?: TemplateMessage;
}

/**
 * Fase F.1 (ADR-034) — Ingesta de WhatsApp: del webhook a la cola.
 *
 * Flujo de ENTRADA:
 *   webhook → parseInbound (puerto valida HMAC) → por cada mensaje:
 *     resolver tenant → scope CLS sintético (tenantCtx.run) → dedup por
 *     wa_message_id → hilo (getOrCreate) → log 'in' → encolar job 'in'.
 *
 * El WORKER de 'in' (registrado acá) procesa el mensaje. En F.1 es un
 * RESPONDEDOR PLACEHOLDER (saluda / acusa recibo) que prueba el ida-y-vuelta
 * completo (webhook → cola → puerto → outbox). **F.2 lo reemplaza** por el
 * orquestador conversacional con Claude Haiku, sin tocar este cableado.
 *
 * El WORKER de 'out' envía por el puerto (Meta o simulador) y registra 'out'.
 *
 * IMPORTANTE (tenant en workers): en modo BullMQ el worker corre en un contexto
 * async NUEVO sin el scope del request → cada handler RE-ESTABLECE el scope con
 * `tenantCtx.run({ tenantId: job.tenant_id })`. En modo in-process también, para
 * que el comportamiento sea idéntico.
 */
@Injectable()
export class WhatsAppIngestService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppIngestService.name);

  /**
   * Tenant del piloto (single-tenant). Meta manda `phone_number_id` en el
   * webhook; cuando haya varios números/tenants, esto se reemplaza por una
   * tabla de mapeo phone_number_id → tenant_id (F.3+). Default = mega_dulces.
   */
  private readonly tenantId =
    process.env.WHATSAPP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

  constructor(
    @Inject(WHATSAPP_PORT) private readonly port: WhatsAppPort,
    private readonly queue: WhatsAppQueueService,
    private readonly threads: ConversationThreadService,
    private readonly orchestrator: ConversationOrchestratorService,
    private readonly optin: WhatsAppOptinService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.process('in', (job) => this.onInboundJob(job));
    await this.queue.process('out', (job) => this.onOutboundJob(job));
    this.logger.log(`Ingesta lista (cola ${this.queue.mode}, proveedor ${this.port.provider}).`);
  }

  /** Verificación del webhook (handshake GET de Meta). Delega en el puerto. */
  verify(mode?: string, token?: string, challenge?: string): string | null {
    return this.port.verifyWebhook(mode, token, challenge);
  }

  /**
   * Punto de entrada del webhook real (Meta). `rawBody`+`signature` para validar
   * la firma HMAC en el puerto. Devuelve cuántos mensajes se aceptaron.
   */
  async ingest(body: unknown, signature?: string, rawBody?: Buffer | string): Promise<number> {
    const messages = this.port.parseInbound(body, signature, rawBody);
    return this.acceptMessages(messages);
  }

  /** Punto de entrada del simulador (dev): shape simple, sin firma. */
  async ingestSimulator(body: unknown): Promise<number> {
    const messages = this.port.parseInbound(body);
    return this.acceptMessages(messages);
  }

  /** Común a ambos: por cada mensaje, dentro del scope del tenant, encola. */
  private async acceptMessages(messages: InboundMessage[]): Promise<number> {
    let accepted = 0;
    for (const msg of messages) {
      if (msg.type !== 'text' && msg.type !== 'interactive') {
        this.logger.debug(`Mensaje ${msg.type} ignorado (F.1 solo texto/interactive).`);
        continue;
      }
      const tenantId = this.resolveTenantId(msg);
      await this.tenantCtx.run({ tenantId }, async () => {
        if (await this.threads.isDuplicateInbound(msg)) {
          this.logger.debug(`Duplicado ${msg.wa_message_id} — ignorado.`);
          return;
        }
        const thread = await this.threads.getOrCreate(msg.from, msg.wa_id, msg.profile_name);
        await this.threads.logMessage(thread.id, 'in', {
          wa_message_id: msg.wa_message_id,
          type: msg.type,
          body: msg.text,
          payload: msg.raw,
        });
        const payload: InJobPayload = {
          thread_id: thread.id,
          phone: msg.from,
          wa_id: msg.wa_id,
          text: msg.text ?? null,
          wa_message_id: msg.wa_message_id,
        };
        await this.queue.enqueue({ dir: 'in', tenant_id: tenantId, payload }, `in:${tenantId}:${msg.wa_message_id}`);
        accepted++;
      });
    }
    return accepted;
  }

  /** Resolución de tenant. Single-tenant piloto (ver nota de la propiedad). */
  private resolveTenantId(_msg: InboundMessage): string {
    return this.tenantId;
  }

  // ── Workers ────────────────────────────────────────────────────────────────

  /**
   * Worker de ENTRADA (F.2): corre el orquestador conversacional (Claude tool-use)
   * sobre el estado del hilo y encola la respuesta. Sin API key / sin catálogo el
   * orquestador degrada a handoff (respuesta honesta), no rompe.
   */
  private async onInboundJob(job: WhatsAppJob): Promise<void> {
    const tenantId = job.tenant_id || this.tenantId;
    const p = job.payload as InJobPayload;
    await this.tenantCtx.run({ tenantId }, async () => {
      // Opt-out de marketing SIEMPRE primero (regla Meta): "BAJA"/"STOP" → baja +
      // acuse, sin pasar por el orquestador.
      if (this.optin.isOptOutMessage(p.text)) {
        await this.optin.optOut(p.phone);
        await this.enqueueOut({
          to: p.phone,
          thread_id: p.thread_id,
          kind: 'text',
          body: 'Listo, no te enviaremos más promociones. Si querés volver a recibirlas, escribinos. 🙌',
        });
        return;
      }
      const result = await this.orchestrator.handleTurn(p.thread_id, p.text || '');
      await this.enqueueOut({ to: p.phone, thread_id: p.thread_id, kind: 'text', body: result.reply });
    });
  }

  /** Worker de SALIDA. Envía por el puerto (Meta/simulador) y registra 'out'. */
  private async onOutboundJob(job: WhatsAppJob): Promise<void> {
    const tenantId = job.tenant_id || this.tenantId;
    const p = job.payload as OutJobPayload;
    await this.tenantCtx.run({ tenantId }, async () => {
      let res;
      if (p.kind === 'interactive' && p.interactive) res = await this.port.sendInteractive(p.to, p.interactive);
      else if (p.kind === 'image' && p.image) res = await this.port.sendImage(p.to, p.image);
      else if (p.kind === 'template' && p.template) res = await this.port.sendTemplate(p.to, p.template);
      else res = await this.port.sendText(p.to, p.body);
      await this.threads.logMessage(p.thread_id, 'out', {
        wa_message_id: res.message_id,
        type: p.kind,
        body: p.body,
        payload: p.interactive ?? p.image ?? p.template ?? null,
      });
    });
  }

  /** Encola una respuesta saliente (usado por el worker de entrada y por F.2). */
  private async enqueueOut(payload: OutJobPayload): Promise<void> {
    await this.queue.enqueue({ dir: 'out', tenant_id: this.tenantId, payload });
  }
}
