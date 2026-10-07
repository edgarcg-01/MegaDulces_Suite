// Puertos de salida de la Mesa de Servicio (Fase MS, ADR-081).
//
// `libs/service-desk` NO puede importar `libs/commercial` (donde vive la campana en vivo) ni
// `libs/whatsapp` (el canal): la regla de fronteras sólo le permite depender de plataforma y
// compartidos. Igual que `FINANCE_NOTIFIER_PORT`, la mesa declara lo que NECESITA y el
// composition root (`apps/api/src/composition`) liga cada token a su implementación real.
//
// ⚠️ Todo es OPCIONAL y best-effort: sin binding, el aviso se registra como `skipped` con el motivo
// en `servicedesk.notification_log`. Un aviso que no salió se DECLARA, no se finge.

/** Aviso en vivo a la campana. */
export interface SdPushNotice {
  /** Tipo de alerta: por dónde la campana decide a quién le llega y con qué ícono. */
  type: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

export const SERVICE_DESK_CHANNEL_PORT = 'SERVICE_DESK_CHANNEL_PORT';

export interface ServiceDeskChannelPort {
  /**
   * Empuja un aviso por WebSocket al cuarto PERSONAL del usuario (`username`, que es como la app registra
   * a la persona en `AlertsService.emitTo`). Sólo existe en el proceso de la API: el worker, donde corren
   * los crons, no tiene WebSocket (ADR-080) — por eso todo aviso también deja su fila `app` en la base.
   */
  pushToUser?(tenantId: string, username: string, notice: SdPushNotice): void;

  /**
   * WhatsApp. Un mensaje iniciado por el negocio fuera de la ventana de 24 h exige PLANTILLA aprobada en
   * Meta (P5: pendiente). Hasta que exista el binding, la mesa registra `whatsapp_no_configurado`.
   */
  sendWhatsApp?(phone: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

// Puerto hacia la Bitácora de Sistemas. Hoy es un no-op: ESTÁ PREPARADO, NO EJECUTADO (P5: la unificación
// con task llega después). Existe para que unificar sea escribir un adaptador y cambiar un binding, no
// reabrir `RequestsService`.
export const BITACORA_PORT = 'BITACORA_PORT';

export interface BitacoraTicketEvent {
  tenantId: string;
  requestId: string;
  folio: string;
  event: 'created' | 'assigned' | 'status' | 'priority' | 'time_logged';
  status: string;
  assignedTo: string | null;
}

export interface BitacoraPort {
  /** Best-effort: no lanza, no bloquea la operación del ticket. */
  onTicketChanged(event: BitacoraTicketEvent): Promise<void>;
}
