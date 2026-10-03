import { Module } from '@nestjs/common';
import { BITACORA_PORT } from '@megadulces/contracts';
import { CloudinaryModule } from '@megadulces/platform-core';
import { ServiceDeskActorsService } from './actors.service';
import { ServiceDeskAgentsService } from './agents.service';
import { ServiceDeskAttachmentsService } from './attachments.service';
import { ServiceDeskConfigService } from './service-desk-config.service';
import { ServiceDeskConfigAdminService } from './config-admin.service';
import { NullBitacoraAdapter } from './null-bitacora.adapter';
import { ServiceDeskNotificationsService } from './notifications.service';
import { ServiceDeskPreferencesService } from './preferences.service';
import { ServiceDeskController } from './service-desk.controller';
import { ServiceDeskRequestsService } from './requests.service';
import { ServiceDeskReportsService } from './reports.service';
import { ServiceDeskRoutingService } from './routing.service';
import { ServiceDeskSlaService } from './sla.service';

/**
 * Fase MS — Mesa de Servicio (ADR-081). Tickets de soporte para toda la suite: cualquiera reporta, quien
 * atiende trabaja desde una bandeja priorizada, y cada ticket es a la vez una TAREA de su asignado.
 *
 * `CloudinaryModule` es el que exporta `ObjectStorageService` (el bucket privado de los adjuntos); no abre
 * ningún servicio de Cloudinary para esta fase.
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [ServiceDeskController],
  providers: [
    ServiceDeskConfigService,
    ServiceDeskAttachmentsService,
    ServiceDeskActorsService,
    ServiceDeskAgentsService,
    ServiceDeskNotificationsService,
    ServiceDeskPreferencesService,
    ServiceDeskConfigAdminService,
    ServiceDeskRoutingService,
    ServiceDeskReportsService,
    ServiceDeskRequestsService,
    ServiceDeskSlaService,
    // Preparado, no ejecutado (P5): hasta unificar con task, el espejo hacia la Bitácora es un no-op.
    // Unificar = escribir un adaptador y cambiar ESTE binding; `RequestsService` no se reabre.
    { provide: BITACORA_PORT, useClass: NullBitacoraAdapter },
  ],
  exports: [ServiceDeskRequestsService, ServiceDeskConfigService, ServiceDeskSlaService],
})
export class ServiceDeskModule {}
