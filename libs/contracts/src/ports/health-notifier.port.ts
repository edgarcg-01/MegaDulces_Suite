// Port de aviso de Salud BD por un canal que llega al BOLSILLO (OBS.5.2).
//
// El correo (`MAILER_PORT`, DBH.3) resolvió que la alerta saliera de la pestaña. No resolvió que
// llegue **rápido**: el incidente del 2026-08-27 tardó **seis días** en descubrirse, y el objetivo
// de la fase es que un carril parado se sepa en **menos de 15 minutos**. Un correo se lee cuando se
// abre el correo; un WhatsApp vibra.
//
// El emisor (`DbHealthScannerService`) no sabe si atrás hay WhatsApp, Telegram o un SMS: cambiar de
// canal es un adapter nuevo en el composition root. Mismo contrato que `MAILER_PORT` y
// `FINANCE_NOTIFIER_PORT`.
//
// ⚠️ Este canal es SÓLO para crítico. La bandeja ya demostró que el ruido entrena a ignorar: 488
// alertas en cinco semanas, **cero** reconocidas. Un aviso que vibra tiene que ser raro para que
// signifique algo.

export const HEALTH_NOTIFIER_PORT = 'HEALTH_NOTIFIER_PORT';

/** Una fuente en crítico, ya reducida a lo que cabe en una notificación. */
export interface HealthAlertItem {
  /** Clave de la fuente (`ods_live_hot`, `kepler_ods`…). */
  key: string;
  /** Nombre legible. Es lo que va a leer un humano en el celular. */
  label: string;
  /** Por qué se avisa: 'nueva' | 'escaló a crítico' | 'sigue sin resolverse'. */
  motivo: string;
  /** Antigüedad en palabras ('3 h', '2 días'). `null` si no se pudo medir. */
  age_human: string | null;
}

export interface HealthNotifierPort {
  /**
   * ¿Hay canal configurado? Convención de la casa: **sin credenciales, no-op con warning, nunca
   * crash**. Quien emite lo consulta antes de armar el mensaje.
   */
  isConfigured(): boolean;

  /**
   * Avisa de fuentes en crítico. Best-effort: no lanza — el que avisa no puede caerse porque el
   * aviso no salió. Devuelve si al menos un destinatario recibió, para que el emisor decida si
   * marcar como notificado o reintentar en el próximo ciclo.
   */
  notifyCritical(items: HealthAlertItem[]): Promise<{ ok: boolean; error?: string }>;
}
