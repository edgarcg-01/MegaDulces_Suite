/**
 * Fase F (ADR-006/034) — Puerto abstracto de WhatsApp.
 *
 * Aísla el motor conversacional del proveedor de mensajería. Hay dos
 * implementaciones:
 *   - MetaCloudWhatsAppAdapter (F.1) — Meta WhatsApp Cloud API real.
 *   - SimulatorWhatsAppAdapter (F.0) — dev/pruebas SIN Meta (no envía nada real).
 *
 * Se elige por `WHATSAPP_PROVIDER=meta|simulator` (default `simulator`).
 * Cambiar a otro BSP (360dialog/Twilio) = un adaptador nuevo, sin tocar el
 * orquestador ni el resto de la fase.
 */

/** Token DI para inyectar la implementación activa del puerto. */
export const WHATSAPP_PORT = 'WHATSAPP_PORT';

/** Mensaje entrante ya normalizado (independiente del proveedor). */
export interface InboundMessage {
  /** id del mensaje en el proveedor (idempotencia / dedup). */
  wa_message_id: string;
  /** número del remitente en E.164 (sin '+'), tal como lo entrega el proveedor. */
  from: string;
  /** wa_id del contacto (Meta) — suele coincidir con `from`. */
  wa_id: string;
  /** phone_number_id del número receptor (Meta metadata) — routing multi-tenant (FIQ.0). */
  phone_number_id?: string | null;
  /** nombre de perfil del contacto, si el proveedor lo manda. */
  profile_name?: string | null;
  /** tipo del mensaje entrante. */
  type: 'text' | 'interactive' | 'image' | 'audio' | 'location' | 'unsupported';
  /** cuerpo de texto (o el título del botón/lista elegido en interactive). */
  text?: string | null;
  /** payload crudo del proveedor por si el orquestador necesita más. */
  raw?: unknown;
  /** epoch segundos del mensaje (del proveedor). */
  timestamp?: number | null;
}

/** Botón de respuesta rápida (reply button). */
export interface QuickReply {
  id: string;
  title: string; // ≤ 20 chars (límite Meta)
}

/** Mensaje interactivo saliente (botones). Listas se agregan cuando hagan falta. */
export interface InteractiveMessage {
  body: string;
  buttons: QuickReply[]; // ≤ 3 (límite Meta)
  header?: string;
  footer?: string;
}

/** Imagen saliente (F.7). `link` es una URL pública accesible por Meta. */
export interface ImageMessage {
  link: string;
  caption?: string;
}

/**
 * Mensaje de PLANTILLA (F.7) — obligatorio para promos iniciadas por el negocio
 * fuera de la ventana de 24h. La plantilla debe estar aprobada en Meta.
 * `imageLink` llena el header de imagen; `bodyParams` los {{1}},{{2}}… del body.
 */
export interface TemplateMessage {
  name: string;
  language: string; // ej. 'es_MX' | 'es'
  imageLink?: string;
  bodyParams?: string[];
}

/** Resultado del envío. `message_id` null si el proveedor no lo devuelve (simulador). */
export interface SendResult {
  message_id: string | null;
}

/**
 * Contrato del canal. Enviar es idempotente por parte del proveedor; el dedup
 * de ENTRADA lo hace la capa de webhook con `wa_message_id`.
 */
export interface WhatsAppPort {
  /** Nombre del proveedor activo (para logs / diagnóstico). */
  readonly provider: 'meta' | 'simulator';

  /** Envía texto plano al número dado (E.164 sin '+'). */
  sendText(to: string, body: string): Promise<SendResult>;

  /** Envía un mensaje con botones de respuesta rápida. */
  sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult>;

  /** Envía una imagen (URL pública) con caption opcional. Solo dentro de la ventana 24h. */
  sendImage(to: string, msg: ImageMessage): Promise<SendResult>;

  /** Envía una plantilla aprobada (promos fuera de la ventana 24h). */
  sendTemplate(to: string, msg: TemplateMessage): Promise<SendResult>;

  /**
   * Verificación del webhook (handshake GET de Meta). Devuelve el `challenge`
   * si `mode=subscribe` y el token coincide; si no, null (→ 403 en el controller).
   */
  verifyWebhook(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null;

  /**
   * Normaliza el body del webhook a `InboundMessage[]`. Valida la firma HMAC
   * (`X-Hub-Signature-256`) cuando el proveedor la manda; si la firma es
   * inválida DEBE lanzar. Devuelve [] si el evento no trae mensajes (p. ej.
   * status callbacks).
   */
  parseInbound(body: unknown, signature?: string, rawBody?: Buffer | string): InboundMessage[];
}
