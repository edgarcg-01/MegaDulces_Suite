import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  InboundMessage,
  InteractiveMessage,
  SendResult,
  WhatsAppPort,
} from '../ports/whatsapp.port';

/**
 * Fase F.1 (ADR-006) — Adaptador de Meta WhatsApp Cloud API directo.
 *
 * Envía por `POST graph.facebook.com/v21.0/{phone_number_id}/messages` con el
 * access token permanente, y normaliza los webhooks entrantes validando la
 * firma HMAC `X-Hub-Signature-256` contra `WHATSAPP_APP_SECRET`.
 *
 * Config (env):
 *   WHATSAPP_PHONE_NUMBER_ID   id del número emisor
 *   WHATSAPP_ACCESS_TOKEN      token permanente (System User)
 *   WHATSAPP_VERIFY_TOKEN      token del handshake GET del webhook
 *   WHATSAPP_APP_SECRET        secreto de la app (validación de firma)
 *   WHATSAPP_GRAPH_VERSION     opcional, default v21.0
 *
 * Degrada con gracia si faltan credenciales: loguea y los envíos son no-op (no
 * tira el boot). El motor sigue funcionando; solo no sale nada a Meta.
 */
@Injectable()
export class MetaCloudWhatsAppAdapter implements WhatsAppPort {
  readonly provider = 'meta' as const;
  private readonly logger = new Logger(MetaCloudWhatsAppAdapter.name);

  private readonly phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  private readonly accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  private readonly verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
  private readonly appSecret = process.env.WHATSAPP_APP_SECRET || '';
  private readonly graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
  private readonly timeoutMs = 15_000;

  private get baseUrl(): string {
    return `https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/messages`;
  }

  private ready(): boolean {
    if (!this.phoneNumberId || !this.accessToken) {
      this.logger.warn('WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN ausentes — envío no-op.');
      return false;
    }
    return true;
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    if (!this.ready()) return { message_id: null };
    try {
      const res = await axios.post(this.baseUrl, payload, {
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        timeout: this.timeoutMs,
      });
      const id = res.data?.messages?.[0]?.id ?? null;
      return { message_id: id };
    } catch (e: any) {
      // No re-lanzamos: el worker de la cola decide reintentos. Logueamos la causa Meta.
      this.logger.error(`Meta send falló: ${e?.response?.status} ${JSON.stringify(e?.response?.data || e?.message)}`);
      throw e; // deja que BullMQ aplique backoff; en modo in-process el caller captura.
    }
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    });
  }

  async sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(msg.header ? { header: { type: 'text', text: msg.header } } : {}),
        body: { text: msg.body },
        ...(msg.footer ? { footer: { text: msg.footer } } : {}),
        action: {
          buttons: msg.buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  verifyWebhook(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null {
    if (mode === 'subscribe' && token && this.verifyToken && token === this.verifyToken) {
      return challenge ?? '';
    }
    return null;
  }

  /** Valida la firma HMAC sha256 del body crudo contra el app secret. */
  private verifySignature(signature: string | undefined, rawBody: Buffer | string | undefined): void {
    if (!this.appSecret) {
      // Sin secreto configurado no podemos validar; en dev lo permitimos con warning.
      this.logger.warn('WHATSAPP_APP_SECRET ausente — firma del webhook NO validada.');
      return;
    }
    if (!signature || rawBody == null) throw new BadRequestException('Firma de webhook ausente');
    const expected =
      'sha256=' + createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Firma de webhook inválida');
    }
  }

  parseInbound(body: unknown, signature?: string, rawBody?: Buffer | string): InboundMessage[] {
    this.verifySignature(signature, rawBody);
    const out: InboundMessage[] = [];
    const b = (body || {}) as any;
    const entries = Array.isArray(b?.entry) ? b.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const ch of changes) {
        const value = ch?.value || {};
        const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
        const profileByWaId = new Map<string, string>();
        for (const c of contacts) if (c?.wa_id) profileByWaId.set(c.wa_id, c?.profile?.name || '');
        const messages = Array.isArray(value?.messages) ? value.messages : [];
        for (const m of messages) {
          out.push(this.normalize(m, profileByWaId));
        }
      }
    }
    return out;
  }

  private normalize(m: any, profiles: Map<string, string>): InboundMessage {
    const from = String(m?.from ?? '');
    let type: InboundMessage['type'] = 'unsupported';
    let text: string | null = null;
    switch (m?.type) {
      case 'text':
        type = 'text';
        text = m?.text?.body ?? null;
        break;
      case 'interactive':
        type = 'interactive';
        text = m?.interactive?.button_reply?.title ?? m?.interactive?.list_reply?.title ?? null;
        break;
      case 'image':
        type = 'image';
        text = m?.image?.caption ?? null;
        break;
      case 'audio':
        type = 'audio';
        break;
      case 'location':
        type = 'location';
        break;
      default:
        type = 'unsupported';
    }
    return {
      wa_message_id: String(m?.id ?? ''),
      from,
      wa_id: from,
      profile_name: profiles.get(from) ?? null,
      type,
      text,
      raw: m,
      timestamp: m?.timestamp ? Number(m.timestamp) : null,
    };
  }
}
