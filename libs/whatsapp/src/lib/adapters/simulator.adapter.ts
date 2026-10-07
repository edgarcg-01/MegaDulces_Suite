import { Injectable, Logger } from '@nestjs/common';
import {
  ImageMessage,
  InboundMessage,
  InteractiveMessage,
  SendResult,
  TemplateMessage,
  WhatsAppPort,
} from '../ports/whatsapp.port';

/** Mensaje saliente capturado por el simulador (para inspección en dev/tests). */
export interface SimOutbound {
  to: string;
  kind: 'text' | 'interactive' | 'image' | 'template';
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

  /**
   * CBW.0 — media inyectada en pruebas: media_id → binario. El endpoint/smoke
   * manda `{ from, type:'image', media_data_uri }`; parseInbound guarda los bytes
   * y `downloadMedia(id)` los devuelve, replicando el 2-pasos de Meta sin red.
   */
  private readonly mediaStore = new Map<string, { buffer: Buffer; mime: string }>();

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
    // ID único ENTRE reinicios: sin el timestamp, el contador reinicia en cada
    // restart y colisiona con el índice único (tenant_id, wa_message_id) → los
    // `out` no se registraban. Meta manda ids únicos reales; esto solo simula eso.
    return { message_id: `sim-out-${Date.now()}-${++this.seq}` };
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

  async sendImage(to: string, msg: ImageMessage): Promise<SendResult> {
    return this.push({
      to,
      kind: 'image',
      body: `[imagen ${msg.link}]${msg.caption ? ' ' + msg.caption : ''}`,
      at: new Date().toISOString(),
    });
  }

  async sendTemplate(to: string, msg: TemplateMessage): Promise<SendResult> {
    return this.push({
      to,
      kind: 'template',
      body: `[template ${msg.name}/${msg.language}]${msg.imageLink ? ' +img' : ''}${msg.bodyParams?.length ? ' (' + msg.bodyParams.join(', ') + ')' : ''}`,
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
   *
   * CBW.0 — soporta adjuntos: `{ from, type:'image'|'document', media_data_uri:'data:...;base64,...', text? }`.
   * Guarda los bytes en `mediaStore` bajo un media_id sintético y devuelve el
   * mensaje con `media:{ id, mime_type }`, igual que el adapter de Meta.
   */
  parseInbound(body: unknown): InboundMessage[] {
    const items = Array.isArray(body) ? body : [body];
    const out: InboundMessage[] = [];
    for (const it of items) {
      const b = (it || {}) as Record<string, unknown>;
      const from = String(b['from'] ?? '').trim();
      const text = b['text'] != null ? String(b['text']) : null;
      if (!from) continue;
      const rawType = String(b['type'] ?? 'text');
      let type: InboundMessage['type'] = rawType === 'image' || rawType === 'document' ? rawType : 'text';
      let media: InboundMessage['media'] = null;
      const dataUri = b['media_data_uri'] != null ? String(b['media_data_uri']) : null;
      if (dataUri) {
        const parsed = this.parseDataUri(dataUri);
        if (parsed) {
          const id = `sim-media-${Date.now()}-${++this.seq}`;
          this.mediaStore.set(id, parsed);
          if (this.mediaStore.size > 200) this.mediaStore.delete(this.mediaStore.keys().next().value as string);
          media = { id, mime_type: parsed.mime };
          if (type === 'text') type = parsed.mime.includes('pdf') ? 'document' : 'image';
        }
      }
      out.push({
        wa_message_id: String(b['wa_message_id'] ?? `sim-in-${Date.now()}-${++this.seq}`),
        from,
        wa_id: String(b['wa_id'] ?? from),
        profile_name: (b['profile_name'] as string) ?? null,
        type,
        text,
        media,
        raw: it,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }
    return out;
  }

  /** CBW.0 — devuelve el binario inyectado para ese media_id (o null). */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mime: string } | null> {
    return this.mediaStore.get(mediaId) ?? null;
  }

  /** Parsea `data:<mime>;base64,<datos>` → buffer + mime. */
  private parseDataUri(uri: string): { buffer: Buffer; mime: string } | null {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(uri);
    if (!m) return null;
    return { buffer: Buffer.from(m[2], 'base64'), mime: m[1] };
  }
}
