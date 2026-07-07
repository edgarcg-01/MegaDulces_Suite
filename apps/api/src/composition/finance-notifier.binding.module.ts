import { Global, Injectable, Module } from '@nestjs/common';
import { FINANCE_NOTIFIER_PORT, FinanceNotifierPort, FinanceCriticalItem } from '@megadulces/contracts';
import { CommercialAlertsModule } from '@megadulces/commercial';
import { AlertsService } from '@megadulces/commercial';

/**
 * MAAT.9 (3.0 P2) — Composition root del Port de notificación de Maat.
 *
 * Único lugar que conoce ambos lados: liga FINANCE_NOTIFIER_PORT (declarado en
 * contracts, inyectado @Optional por MaatScannerService) al canal de alertas WS
 * de commercial (AlertsService → AlertsGateway, room por tenant). @Global() para
 * que el token resuelva sin que finance importe commercial. Best-effort: si el
 * gateway aún no está listo, AlertsService lo loguea y sigue.
 */
@Injectable()
class FinanceNotifierAdapter implements FinanceNotifierPort {
  constructor(private readonly alerts: AlertsService) {}

  async notifyCritical(tenantId: string, items: FinanceCriticalItem[]): Promise<void> {
    if (!items?.length) return;
    const top = items.slice(0, 5);
    const total = items.reduce((a, i) => a + (Number(i.importe) || 0), 0);
    const fmt = (n: number) => '$' + Math.round(n).toLocaleString('es-MX');
    this.alerts.emit(tenantId, {
      // 'finance_finding' no está en el union AlertType de commercial → cast en el glue (composition root).
      type: 'finance_finding' as never,
      severity: 'critical',
      title: `Maat detectó ${items.length} hallazgo(s) crítico(s)`,
      message: `${top.map((i) => `${i.titulo} (${fmt(i.importe)})`).join(' · ')}${items.length > top.length ? ` +${items.length - top.length} más` : ''} — total ${fmt(total)}`,
      data: { source: 'maat', count: items.length, total, items: top, route: '/finanzas/hallazgos' },
    });
  }
}

@Global()
@Module({
  imports: [CommercialAlertsModule],
  providers: [
    FinanceNotifierAdapter,
    { provide: FINANCE_NOTIFIER_PORT, useExisting: FinanceNotifierAdapter },
  ],
  exports: [FINANCE_NOTIFIER_PORT],
})
export class FinanceNotifierBindingModule {}
