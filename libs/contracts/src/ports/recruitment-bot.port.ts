// Port de inversión de dependencia (Fase RH, `[RH.3.1]`): la ingesta de WhatsApp (libs/whatsapp) le pasa los mensajes
// del NÚMERO DE RECLUTAMIENTO al bot de reclutamiento (libs/hr) SIN importar el dominio de RH. Mismo patrón que
// BANK_CAPTURE_PORT: la ingesta inyecta este token con @Optional() (el binding sólo existe con ENABLE_MULTITENANT=true) y
// lo llama dentro del scope de tenant (CLS). El binding se hace en el composition root.
//
// El bot decide QUÉ contestar; la ingesta se encarga de mandarlo desde el número que recibió y de registrarlo en el libro
// de WhatsApp. El bot no sabe de Meta ni de colas.

export const RECRUITMENT_BOT_PORT = 'RECRUITMENT_BOT_PORT';

/** Un mensaje que llegó al número de reclutamiento. */
export interface RecruitmentInbound {
  /** El tenant dueño del número que lo recibió (`phone_number_tenant_map`). */
  tenantId: string;
  /** Teléfono canónico del remitente (52XXXXXXXXXX). */
  phone: string;
  /** El número de la empresa que lo recibió (Meta `phone_number_id`). */
  phoneNumberId: string | null;
  waMessageId: string;
  type: 'text' | 'interactive' | 'image' | 'document' | 'audio' | 'location' | 'unsupported';
  /** Texto, o el `id` del botón si fue una respuesta interactiva. */
  text: string | null;
  profileName: string | null;
  media: { id: string; mimeType: string; filename: string | null } | null;
  /**
   * Descarga el adjunto (si lo hay). La ingesta lo provee para que el bot no conozca al proveedor; devuelve null si no
   * hay credenciales o el archivo ya expiró.
   */
  descargar: (() => Promise<{ buffer: Uint8Array; mime: string } | null>) | null;
}

/** Lo que el bot quiere contestar (la ingesta lo manda desde el mismo número y lo registra). */
export type RecruitmentReply =
  | { kind: 'text'; body: string }
  | { kind: 'interactive'; body: string; buttons: Array<{ id: string; title: string }>; header?: string | null }
  /** `[RH.3.3.3]` Un documento (el CV que el bot le armó): el archivo en base64, su tipo, nombre y un texto opcional. */
  | { kind: 'document'; base64: string; mime: string; filename: string; caption?: string | null };

export interface RecruitmentBotPort {
  /** Procesa un mensaje del número de reclutamiento y devuelve 0..n respuestas, en orden. Scope CLS ya establecido. */
  handleMessage(msg: RecruitmentInbound): Promise<RecruitmentReply[]>;
}
