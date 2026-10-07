import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, normalizeMxPhone } from '@megadulces/platform-core';
import { BANK_CAPTURE_PORT } from '@megadulces/contracts';
import type { BankCapturePort, BankCaptureSender } from '@megadulces/contracts';
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

/**
 * CBW (ADR-042/CBW.5) — desvío bancario de un mensaje de un remitente autorizado.
 * `capture` = trae imagen/documento (media_id a descargar) → entra directo a la
 * bandeja. `nudge` = mandó texto (sin foto) → le recordamos que envíe la imagen,
 * para mantenerlo en el flujo bancario y NO caer en el bot comercial. Sin SÍ/NO
 * (CBW.5): Cobranza es el único gate. Sin thread conversacional (audit en el inbox).
 */
type BankInJob =
  | { action: 'capture'; media_id: string; mime: string; caption: string | null; sender: BankCaptureSender }
  | { action: 'nudge' };

/** Payload de un job de ENTRADA (un mensaje del cliente a procesar). */
interface InJobPayload {
  thread_id: string | null;
  phone: string;
  wa_id: string;
  text: string | null;
  /** FIQ.5 — coords si el mensaje fue un pin de ubicación. */
  location?: { lat: number; lng: number; name?: string | null; address?: string | null } | null;
  wa_message_id: string;
  /** CBW — si viene, el mensaje se procesa como captura bancaria, no comercial. */
  bank?: BankInJob;
}

/** Payload de un job de SALIDA (una respuesta a enviar por el puerto). */
interface OutJobPayload {
  to: string;
  thread_id: string | null;
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

  /** Cache phone_number_id → tenant_id (tabla global, cambia rara vez). */
  private readonly tenantByPhoneId = new Map<string, string>();

  constructor(
    @Inject(WHATSAPP_PORT) private readonly port: WhatsAppPort,
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly queue: WhatsAppQueueService,
    private readonly threads: ConversationThreadService,
    private readonly orchestrator: ConversationOrchestratorService,
    private readonly optin: WhatsAppOptinService,
    private readonly tenantCtx: TenantContextService,
    // CBW (ADR-042): captura bancaria por WhatsApp. @Optional — solo hay binding
    // con ENABLE_MULTITENANT=true; sin él, todo sigue por el camino comercial.
    @Optional() @Inject(BANK_CAPTURE_PORT) private readonly bankCapture?: BankCapturePort,
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
      // CBW: imagen/documento también son enrutables (posible captura bancaria).
      const routable =
        msg.type === 'text' || msg.type === 'interactive' || msg.type === 'location' ||
        msg.type === 'image' || msg.type === 'document';
      if (!routable) {
        this.logger.debug(`Mensaje ${msg.type} ignorado (no enrutable).`);
        continue;
      }
      const tenantId = await this.resolveTenantId(msg);
      // FIQ.0: teléfono canónico (52XXXXXXXXXX) para hilo/lookup/outbound. Un solo
      // formato en todo el pipeline → el cliente recurrente matchea y no se duplica.
      const phone = normalizeMxPhone(msg.from) || msg.from;
      await this.tenantCtx.run({ tenantId }, async () => {
        if (await this.threads.isDuplicateInbound(msg)) {
          this.logger.debug(`Duplicado ${msg.wa_message_id} — ignorado.`);
          return;
        }
        // CBW (ADR-042): ¿es una captura bancaria de un remitente autorizado?
        // Se decide ANTES del bot comercial. Si lo es, no toca conversation_threads.
        const bank = await this.tryBuildBankJob(msg, phone);
        if (bank) {
          const payload: InJobPayload = {
            thread_id: null,
            phone,
            wa_id: msg.wa_id,
            text: msg.text ?? null,
            wa_message_id: msg.wa_message_id,
            bank,
          };
          await this.queue.enqueue({ dir: 'in', tenant_id: tenantId, payload }, `in:${tenantId}:${msg.wa_message_id}`);
          accepted++;
          return;
        }
        // No bancario: imagen/documento de un NO autorizado se ignoran (el bot
        // comercial solo maneja texto/interactive/location).
        if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'location') {
          this.logger.debug(`Mensaje ${msg.type} de no-autorizado ignorado.`);
          return;
        }
        const thread = await this.threads.getOrCreate(phone, msg.wa_id, msg.profile_name);
        await this.threads.logMessage(thread.id, 'in', {
          wa_message_id: msg.wa_message_id,
          type: msg.type,
          body: msg.text,
          payload: msg.raw,
        });
        const payload: InJobPayload = {
          thread_id: thread.id,
          phone,
          wa_id: msg.wa_id,
          text: msg.text ?? null,
          location: msg.location ?? null,
          wa_message_id: msg.wa_message_id,
        };
        await this.queue.enqueue({ dir: 'in', tenant_id: tenantId, payload }, `in:${tenantId}:${msg.wa_message_id}`);
        accepted++;
      });
    }
    return accepted;
  }

  /**
   * CBW — decide si el mensaje va al flujo bancario. Solo consulta la allowlist si
   * hay algo bancario que hacer (una imagen/documento, o un texto SÍ/NO que podría
   * confirmar una captura pendiente). Devuelve el job bancario o null (→ comercial).
   * Debe correr dentro del scope de tenant (CLS) ya establecido.
   */
  private async tryBuildBankJob(msg: InboundMessage, phone: string): Promise<BankInJob | null> {
    if (!this.bankCapture) return null;
    const isMedia = (msg.type === 'image' || msg.type === 'document') && !!msg.media;
    const isText = msg.type === 'text';
    if (!isMedia && !isText) return null;
    let sender: BankCaptureSender | null = null;
    try {
      sender = await this.bankCapture.resolveSender(phone);
    } catch (e: any) {
      this.logger.warn(`resolveSender falló (${e?.message}) — sigo por camino comercial.`);
      return null;
    }
    if (!sender) return null; // no autorizado → no es flujo bancario
    if (isMedia && msg.media) {
      return { action: 'capture', media_id: msg.media.id, mime: msg.media.mime_type, caption: msg.text ?? null, sender };
    }
    // Remitente autorizado que escribió texto (sin foto) → recordatorio, no bot comercial.
    return { action: 'nudge' };
  }

  /**
   * Resolución de tenant por `phone_number_id` de Meta vía
   * `whatsapp.phone_number_tenant_map` (tabla global sin RLS). Cachea el mapeo.
   * Fallback al tenant default (piloto single-tenant) si no hay id o no matchea.
   */
  private async resolveTenantId(msg: InboundMessage): Promise<string> {
    const pnid = msg.phone_number_id;
    if (!pnid) return this.tenantId;
    const cached = this.tenantByPhoneId.get(pnid);
    if (cached) return cached;
    try {
      const row = await this.knex('whatsapp.phone_number_tenant_map')
        .where({ phone_number_id: pnid })
        .first('tenant_id');
      const tid = (row?.tenant_id as string) || this.tenantId;
      this.tenantByPhoneId.set(pnid, tid);
      return tid;
    } catch (e: any) {
      this.logger.warn(`resolveTenantId map falló (${e?.message}) — uso tenant default.`);
      return this.tenantId;
    }
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
      // CBW (ADR-042): rama bancaria — descarga la media + OCR + staging, o confirma.
      if (p.bank) {
        await this.handleBankJob(tenantId, p);
        return;
      }
      // A partir de aquí es camino COMERCIAL: siempre trae thread (defensivo).
      if (!p.thread_id) return;
      const threadId = p.thread_id;
      // Opt-out de marketing SIEMPRE primero (regla Meta): "BAJA"/"STOP" → baja +
      // acuse, sin pasar por el orquestador.
      if (this.optin.isOptOutMessage(p.text)) {
        await this.optin.optOut(p.phone);
        await this.enqueueOut(tenantId, {
          to: p.phone,
          thread_id: threadId,
          kind: 'text',
          body: 'Listo, no te enviaremos más promociones. Si querés volver a recibirlas, escribinos. 🙌',
        });
        return;
      }
      // FIQ.1 — Throttle / budget-guard (canal público = techo de gasto + anti-DoS):
      // si un número supera N turnos LLM en 24h, degradamos a un template + handoff,
      // SIN llamar al LLM. Cap configurable (WHATSAPP_DAILY_TURN_CAP, default 50).
      const cap = Number(process.env.WHATSAPP_DAILY_TURN_CAP) || 50;
      const recentTurns = await this.threads.countRecentTurns(p.phone, 24);
      if (recentTurns >= cap) {
        await this.threads.update(threadId, { handoff: true, state: 'handoff' });
        await this.enqueueOut(tenantId, {
          to: p.phone,
          thread_id: threadId,
          kind: 'text',
          body: 'Gracias por tu mensaje 🙌 En breve un asesor de Mega Dulces continúa tu atención.',
        });
        this.logger.warn(`Throttle: ${p.phone} superó ${cap} turnos/24h → handoff sin LLM.`);
        return;
      }
      // FIQ.5: un pin de ubicación llega sin texto → sinteticé uno para el LLM.
      const userText = p.text || (p.location ? '📍 Te comparto mi ubicación' : '');
      const result = await this.orchestrator.handleTurn(threadId, userText, {
        location: p.location || undefined,
      });
      await this.enqueueOut(tenantId, { to: p.phone, thread_id: threadId, kind: 'text', body: result.reply });
    });
  }

  /**
   * CBW (ADR-042) — procesa un job bancario. `capture`: descarga la media por el
   * puerto (Meta/simulador) y la manda al motor de captura (Cloudinary + OCR +
   * staging). `confirm`: aplica SÍ/NO a la última captura pendiente. La respuesta
   * al remitente se encola como 'out' (sin thread). Best-effort: sin binding no
   * llega acá (el ingest no arma el job).
   */
  private async handleBankJob(tenantId: string, p: InJobPayload): Promise<void> {
    if (!this.bankCapture || !p.bank) return;
    if (p.bank.action === 'capture') {
      const media = await this.port.downloadMedia(p.bank.media_id);
      if (!media) {
        await this.enqueueOut(tenantId, { to: p.phone, thread_id: null, kind: 'text', body: 'No pude descargar la imagen 😕 ¿Puedes reenviarla?' });
        return;
      }
      const res = await this.bankCapture.capture({
        fromPhone: p.phone,
        sender: p.bank.sender,
        waMessageId: p.wa_message_id,
        fileBase64: media.buffer.toString('base64'),
        mime: media.mime,
        caption: p.bank.caption,
      });
      await this.enqueueOut(tenantId, { to: p.phone, thread_id: null, kind: 'text', body: res.reply });
      return;
    }
    // nudge: remitente autorizado escribió texto sin foto → recordatorio.
    await this.enqueueOut(tenantId, {
      to: p.phone, thread_id: null, kind: 'text',
      body: '📸 Para registrar un depósito, mándame la *foto del comprobante*. Crédito y Cobranza lo aplica.',
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
      // CBW: las respuestas bancarias no tienen thread → no se registran en messages.
      if (p.thread_id) {
        await this.threads.logMessage(p.thread_id, 'out', {
          wa_message_id: res.message_id,
          type: p.kind,
          body: p.body,
          payload: p.interactive ?? p.image ?? p.template ?? null,
        });
      }
    });
  }

  /**
   * Encola una respuesta saliente en el MISMO tenant del mensaje de entrada
   * (FIQ.0 fix): sin esto el reply se encolaba con el tenant default y, con un 2º
   * tenant en el mapa, el worker reabría scope equivocado → 23503 (FK compuesta
   * (tenant_id, thread_id)) + reintentos que duplican el envío al cliente.
   */
  private async enqueueOut(tenantId: string, payload: OutJobPayload): Promise<void> {
    await this.queue.enqueue({ dir: 'out', tenant_id: tenantId, payload });
  }
}
