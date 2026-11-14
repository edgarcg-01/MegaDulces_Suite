import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';

/**
 * `[MDT.2.3]` Vale de servicio (Fase MDT, D8/D8b). `TenantKnexService` y `TenantContextService` llegan de
 * los módulos globales; `ObjectStorageService` (las firmas) de `CloudinaryModule`, igual que el motor de
 * checklist y la Mesa de Servicio.
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService],
  exports: [WorkOrdersService],
})
export class WorkOrdersModule {}
