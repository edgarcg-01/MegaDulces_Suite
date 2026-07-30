import { Global, Injectable, Module } from '@nestjs/common';
import { RECON_NOTIFIER_PORT, ReconNotifierPort, ReconBadCutItem } from '@megadulces/contracts';
import { CommercialAlertsModule } from '@megadulces/commercial';
import { AlertsService } from '@megadulces/commercial';

/**
 * SM.9 — Composition root del Port de notificación del Supervisor de Movimientos.
 *
 * Liga RECON_NOTIFIER_PORT (declarado en contracts, inyectado @Optional por
 * BlindCountService) al canal de alertas WS de commercial (AlertsService →
 * AlertsGateway, room por tenant). @Global() para que el token resuelva sin que
 * reconciliation importe commercial. Rutea a /almacen/cuadre (no /finanzas/hallazgos).
 * Best-effort: si el gateway no está listo, AlertsService lo loguea y sigue.
 */
@Injectable()
class ReconNotifierAdapter implements ReconNotifierPort {
  constructor(private readonly alerts: AlertsService) {}

  async notifyBadCut(tenantId: string, item: ReconBadCutItem): Promise<void> {
    const abs = Math.abs(Number(item.diff_real) || 0);
    const falta = (Number(item.diff_real) || 0) > 0;
    const fmt = (n: number) => '$' + Math.round(n).toLocaleString('es-MX');
    this.alerts.emit(tenantId, {
      type: 'recon_bad_cut',
      severity: item.kepler_enmascaro ? 'critical' : 'warn',
      title: `Corte malo — suc ${item.warehouse_code} caja ${item.caja}`,
      message: `Arqueo ciego destapa ${falta ? 'faltante' : 'sobrante'} real ${fmt(abs)}${item.kepler_enmascaro ? ' — Kepler lo dio por cuadrado' : ''}${item.cajero ? ` · cajero ${item.cajero}` : ''}.`,
      data: { source: 'reconciliation', route: '/almacen/cuadre', ...item },
    });
  }
}

@Global()
@Module({
  imports: [CommercialAlertsModule],
  providers: [
    ReconNotifierAdapter,
    { provide: RECON_NOTIFIER_PORT, useExisting: ReconNotifierAdapter },
  ],
  exports: [RECON_NOTIFIER_PORT],
})
export class ReconNotifierBindingModule {}
