import { Module } from '@nestjs/common';
import { ObjectStorageService } from '@megadulces/platform-core';
import { NewCustomersKeplerModule } from '../new-customers-kepler/new-customers-kepler.module';
import { CustomerOnboardingController } from './customer-onboarding.controller';
import { CustomerOnboardingService } from './customer-onboarding.service';
import { KeplerClienteSinkAdapter } from './kepler-cliente-sink.adapter';

/**
 * `[ALC]` Alta de clientes. Reusa la liga de MCP.3.8 (`NewCustomersKeplerService.link`) para el
 * cliente `V-` del vendedor. TenantKnexService, TenantContextService y ScopeService son globales;
 * `ObjectStorageService` se declara aquí como en `commercial-replenishment`.
 * `[ALC.2.7]` `KeplerClienteSinkAdapter` escribe el alta en Kepler (apagado por default).
 */
@Module({
  imports: [NewCustomersKeplerModule],
  controllers: [CustomerOnboardingController],
  providers: [CustomerOnboardingService, ObjectStorageService, KeplerClienteSinkAdapter],
})
export class CustomerOnboardingModule {}
