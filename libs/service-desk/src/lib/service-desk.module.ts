import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { ServiceDeskAgentsService } from './agents.service';
import { ServiceDeskAttachmentsService } from './attachments.service';
import { ServiceDeskConfigService } from './service-desk-config.service';
import { ServiceDeskController } from './service-desk.controller';
import { ServiceDeskRequestsService } from './requests.service';

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
  providers: [ServiceDeskConfigService, ServiceDeskAttachmentsService, ServiceDeskAgentsService, ServiceDeskRequestsService],
  exports: [ServiceDeskRequestsService, ServiceDeskConfigService],
})
export class ServiceDeskModule {}
