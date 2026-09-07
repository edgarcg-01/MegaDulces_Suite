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
  /**
   * `[RE.27.C]` Tipo de alerta, que es **por dónde la campana decide a quién le llega**.
   * Omitirlo deja el default `finance_feed`, que la campana filtra a quien tiene Bancos.
   *
   * Existe porque un aviso puede salir de `libs/finance` y no ser para Finanzas: la cola
   * de órdenes de entrada la atiende Compras. Sin esto habría que esconder la excepción
   * adentro de `finance_feed` mirando el `key` — un caso especial disfrazado de tipo
   * genérico, que es como se pudre un filtro.
   */
  type?: string;
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
