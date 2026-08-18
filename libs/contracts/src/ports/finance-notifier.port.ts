// Port de inversión de dependencia: el motor de Maat (libs/finance) necesita
// notificar hallazgos CRÍTICOS de forma proactiva (WS + push), pero esos canales
// viven en libs/commercial (AlertsGateway, CommercialPushService) y finance NO
// puede cruzar la frontera de dominio. En vez de importar commercial, finance
// inyecta este token + interface (@Optional); el binding al impl real se hace en
// el composition root (app.module), único lugar que conoce ambos lados.
//
// Si no hay binding (o los canales están apagados), el motor sigue corriendo sin
// notificar — la notificación es best-effort, nunca bloquea el scan.

export const FINANCE_NOTIFIER_PORT = 'FINANCE_NOTIFIER_PORT';

export interface FinanceCriticalItem {
  rule_key: string;
  titulo: string;
  importe: number;
}

/** Aviso informativo genérico de finanzas (no crítico): feed nuevo, movimientos, etc. */
export interface FinanceNotice {
  key: string;                    // clave de origen/regla (dedup + ícono en la campana)
  severity: 'info' | 'warn';
  title: string;
  message: string;
  route?: string;                 // deep-link (p.ej. '/finanzas/bancos')
  data?: Record<string, any>;
}

export interface FinanceNotifierPort {
  /** Notifica hallazgos críticos NUEVOS de un tenant (proactivo: WS + push). Best-effort. */
  notifyCritical(tenantId: string, items: FinanceCriticalItem[]): Promise<void>;

  /**
   * Aviso informativo genérico a los usuarios de Finanzas del tenant (WS a la campana).
   * Opcional: impls viejas pueden no traerlo → el emisor debe checar `notifier.notify?.`.
   * Best-effort, nunca bloquea.
   */
  notify?(tenantId: string, notice: FinanceNotice): Promise<void>;
}
