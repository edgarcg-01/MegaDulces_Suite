import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { DevProjectsController } from './dev-projects.controller';
import { DevProjectsService } from './dev-projects.service';

/**
 * `[DEV]` Desarrolladores › Proyectos. `CloudinaryModule` es quien EXPORTA `ObjectStorageService`
 * (el bucket privado de los adjuntos); `TenantKnexService`/`TenantContextService` son globales.
 * Se wirea en `AppModule` dentro del toggle `ENABLE_MULTITENANT` (las tablas viven en la DB nueva).
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [DevProjectsController],
  providers: [DevProjectsService],
})
export class DevProjectsModule {}
