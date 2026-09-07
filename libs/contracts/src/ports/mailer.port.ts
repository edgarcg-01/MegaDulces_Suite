// Port de correo saliente (DBH.3).
//
// Hasta el 2026-09-01 la plataforma NO tenía correo: ni dependencia, ni servicio, ni variable de
// entorno, ni columna `email` en `identity.users`. Los canales existentes eran WebSocket (exige
// pestaña abierta y la alerta es efímera), Web Push (sólo suscrito en `vendor`/`portal`) y WhatsApp.
//
// El costo de esa ausencia quedó medido: `wincaja_branch_stale` estuvo **20 días en `critical`** y
// nadie se enteró, porque el único aviso era un toast que se emite sólo en la transición — sale una
// vez, hacia quien tenga la pestaña abierta en ese instante. En cinco semanas se abrieron 488
// alertas y se reconocieron **cero**.
//
// El emisor no sabe si atrás hay SMTP, Resend o SendGrid: cambiar de proveedor es un adapter nuevo
// en el composition root, sin tocar a quien manda. Igual que `WHATSAPP_PORT` y `FLEET_PROVIDER_PORT`.

export const MAILER_PORT = 'MAILER_PORT';

export interface MailMessage {
  /** Uno o varios destinatarios. Si viene vacío, el adapter no envía y lo dice en el log. */
  to: string[];
  subject: string;
  /** Cuerpo en texto plano — obligatorio: es lo que se ve en un reloj o en un cliente sin HTML. */
  text: string;
  /** Cuerpo HTML opcional. Si falta, se manda sólo el texto. */
  html?: string;
}

export interface MailerPort {
  /**
   * ¿Hay credenciales configuradas? Convención de la casa (`CommercialPushService.isEnabled()`,
   * `FleetProviderPort.isConfigured()`): **sin credenciales, no-op con warning, nunca crash**.
   * Quien emite debe consultarlo antes de armar un cuerpo caro.
   */
  isConfigured(): boolean;

  /** Envía. Best-effort: no lanza — un fallo de correo no puede tumbar el proceso que avisa. */
  send(msg: MailMessage): Promise<{ ok: boolean; error?: string }>;
}
