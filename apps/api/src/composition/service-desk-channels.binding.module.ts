import { Global, Injectable, Module } from '@nestjs/common';
import { SERVICE_DESK_CHANNEL_PORT, type SdPushNotice, type ServiceDeskChannelPort } from '@megadulces/contracts';
import { AlertsService, CommercialAlertsModule } from '@megadulces/commercial';

/**
 * `[MS.2.6]` Composition root de los canales de la Mesa de Servicio.
 *
 * Único lugar que conoce ambos lados: liga `SERVICE_DESK_CHANNEL_PORT` (declarado en contracts, inyectado
 * `@Optional` por `ServiceDeskNotificationsService`) al canal de alertas en vivo de `commercial`
 * (`AlertsService.emitTo` → cuarto PERSONAL del usuario). `@Global()` para que el token resuelva sin que
 * `libs/service-desk` importe `libs/commercial` (la regla de fronteras no se lo permite).
 *
 * ⚠️ Sólo `pushToUser`. **WhatsApp NO está ligado a propósito** (P5): un aviso iniciado por el negocio fuera
 * de la ventana de 24 h exige una PLANTILLA aprobada en Meta, y esa aprobación no existe todavía. Sin binding
 * la mesa registra `whatsapp_no_configurado` en `notification_log`: se declara, no se finge.
 *
 * ⚠️ El push en vivo sólo existe en el proceso de la API. Los avisos que nacen en el cron (worker, sin
 * WebSocket — ADR-080) no dependen de él: dejan su fila `app` en la base y la campana los recoge por poll.
 */
@Injectable()
class ServiceDeskChannelAdapter implements ServiceDeskChannelPort {
  constructor(private readonly alerts: AlertsService) {}

  pushToUser(tenantId: string, username: string, notice: SdPushNotice): void {
    this.alerts.emitTo(tenantId, username, {
      // 'service_desk' no está en el union AlertType de commercial → cast en el glue (composition root),
      // como hace el binding de Finanzas con 'finance_feed'.
      type: notice.type as never,
      severity: notice.severity,
      title: notice.title,
      message: notice.message,
      data: notice.data ?? {},
    });
  }
}

@Global()
@Module({
  imports: [CommercialAlertsModule],
  providers: [ServiceDeskChannelAdapter, { provide: SERVICE_DESK_CHANNEL_PORT, useExisting: ServiceDeskChannelAdapter }],
  exports: [SERVICE_DESK_CHANNEL_PORT],
})
export class ServiceDeskChannelsBindingModule {}
