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

export interface FinanceNotifierPort {
  /** Notifica hallazgos críticos NUEVOS de un tenant (proactivo: WS + push). Best-effort. */
  notifyCritical(tenantId: string, items: FinanceCriticalItem[]): Promise<void>;
}
