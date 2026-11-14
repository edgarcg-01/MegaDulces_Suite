import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { ChecklistsController } from './checklists.controller';
import { ChecklistsService } from './checklists.service';

/**
 * `[MDT.2]` Motor de checklist / tareas por puesto (Fase MDT). `TenantKnexService` y
 * `TenantContextService` llegan de los módulos globales; `ObjectStorageService` (la evidencia) de
 * `CloudinaryModule`, igual que la Mesa de Servicio. El servicio se exporta para que otro dominio
 * (logística, cuando su checklist de embarque pase a este motor) lo use sin un segundo motor.
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [ChecklistsController],
  providers: [ChecklistsService],
  exports: [ChecklistsService],
})
export class ChecklistsModule {}
