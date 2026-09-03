import { Global, Injectable, Module } from '@nestjs/common';
import { RECON_NOTIFIER_PORT, ReconNotifierPort, ReconBadCutItem, ReconArqueoDueItem } from '@megadulces/contracts';
import { StoreGateway } from '../modules/store/store.gateway';
import { StoreModule } from '../modules/store/store.module';
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
  constructor(private readonly alerts: AlertsService, private readonly store: StoreGateway) {}

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

  /**
   * Va por el room PERSONAL del `/store` gateway, no por AlertsService: éste emite
   * al tenant entero y el aviso terminaría en la pantalla de todas las cajeras.
   * Un aviso que no es tuyo se ignora, y a los dos días se ignoran todos.
   *
   * El payload no lleva un solo monto: es un recordatorio de que cuentes, no una
   * pista de cuánto debería haber (SM.10).
   */
  async notifyArqueoDue(tenantId: string, item: ReconArqueoDueItem): Promise<void> {
    const esRetiro = item.motivo === 'retiro';
    this.store.emitToCajero(tenantId, item.cajero_code, 'arqueo_due', {
      type: 'arqueo_due',
      severity: item.vencido ? 'warn' : 'info',
      title: esRetiro ? 'Cuenta el retiro' : 'Haz tu arqueo',
      message: esRetiro
        ? `Kepler te pidió sacar efectivo de la caja ${item.caja}. Cuenta los billetes antes de entregarlos.`
        : item.vencido
          ? `Kepler cerró tu caja ${item.caja} hace ${Math.round(item.cerrado_hace_min / 60)} h y todavía no cuentas el efectivo.`
          : `Kepler cerró tu caja ${item.caja}${item.hora_cierre ? ` a las ${item.hora_cierre.slice(0, 5)}` : ''}. Cuenta el efectivo y guárdalo.`,
      route: '/tienda/arqueo',
      ...item,
    });
  }
}

@Global()
@Module({
  imports: [CommercialAlertsModule, StoreModule],
  providers: [
    ReconNotifierAdapter,
    { provide: RECON_NOTIFIER_PORT, useExisting: ReconNotifierAdapter },
  ],
  exports: [RECON_NOTIFIER_PORT],
})
export class ReconNotifierBindingModule {}
