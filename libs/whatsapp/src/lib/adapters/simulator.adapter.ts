import { Injectable, Logger } from '@nestjs/common';
import {
  InboundMessage,
  InteractiveMessage,
  SendResult,
  WhatsAppPort,
} from '../ports/whatsapp.port';

/** Mensaje saliente capturado por el simulador (para inspección en dev/tests). */
export interface SimOutbound {
  to: string;
  kind: 'text' | 'interactive';
  body: string;
  buttons?: { id: string; title: string }[];
  at: string; // ISO
}

/**
 * Fase F.0 — Adaptador SIMULADOR de WhatsApp.
 *
 * NO habla con Meta ni envía nada real. Permite construir y probar TODO el flujo
 * conversacional (webhook → orquestador → respuesta) sin depender de la app de
 * Meta ni de un número verificado. Los envíos se guardan en un buffer en memoria
 * (`drain()` / `outbox`) que un endpoint de dev o un smoke test puede leer.
 *
 * La verificación del webhook siempre pasa (el handshake de Meta no aplica) y
 * `parseInbound` acepta un shape simple `{ from, text, wa_message_id? }` que
 * inyecta el endpoint `POST /webhooks/whatsapp/sim`.
 */
@Injectable()
export class SimulatorWhatsAppAdapter implements WhatsAppPort {
  readonly provider = 'simulator' as const;
  private readonly logger = new Logger(SimulatorWhatsAppAdapter.name);

  /** Buffer de salientes (en memoria). Limitado para no crecer sin fin. */
  private readonly _outbox: SimOutbound[] = [];
  private seq = 0;

  get outbox(): readonly SimOutbound[] {
    return this._outbox;
  }

  /** Devuelve y limpia el buffer de salientes (útil en smoke tests). */
  drain(): SimOutbound[] {
    const out = this._outbox.splice(0, this._outbox.length);
    return out;
  }

  private push(o: SimOutbound): SendResult {
    this._outbox.push(o);
    if (this._outbox.length > 500) this._outbox.splice(0, this._outbox.length - 500);
    this.logger.debug(`[sim →${o.to}] ${o.kind}: ${o.body}`);
    return { message_id: `sim-out-${++this.seq}` };
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    return this.push({ to, kind: 'text', body, at: new Date().toISOString() });
  }

  async sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult> {
    return this.push({
      to,
      kind: 'interactive',
      body: msg.body,
      buttons: msg.buttons,
      at: new Date().toISOString(),
    });
  }

  /** Handshake no aplica al simulador: devolvemos el challenge tal cual. */
  verifyWebhook(_mode: string | undefined, _token: string | undefined, challenge: string | undefined): string | null {
    return challenge ?? 'sim-ok';
  }

  /**
   * Acepta el shape del endpoint de dev: `{ from, text, wa_message_id?, profile_name? }`
   * (objeto o arreglo). Sin firma que validar.
   */
  parseInbound(body: unknown): InboundMessage[] {
    const items = Array.isArray(body) ? body : [body];
    const out: InboundMessage[] = [];
    for (const it of items) {
      const b = (it || {}) as Record<string, unknown>;
      const from = String(b['from'] ?? '').trim();
      const text = b['text'] != null ? String(b['text']) : null;
      if (!from) continue;
      out.push({
        wa_message_id: String(b['wa_message_id'] ?? `sim-in-${++this.seq}`),
        from,
        wa_id: String(b['wa_id'] ?? from),
        profile_name: (b['profile_name'] as string) ?? null,
        type: 'text',
        text,
        raw: it,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }
    return out;
  }
}
