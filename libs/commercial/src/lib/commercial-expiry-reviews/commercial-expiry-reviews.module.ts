import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';
import { CommercialExpiryReviewsController } from './commercial-expiry-reviews.controller';

/**
 * Fase P2.6 — Control de Caducidades digital (ADR-022). Reusa CloudinaryModule
 * para la foto de evidencia por renglón. TenantKnexService/TenantContextService
 * son globales. Wireado en AppModule bajo el toggle ENABLE_MULTITENANT.
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [CommercialExpiryReviewsController],
  providers: [CommercialExpiryReviewsService],
  exports: [CommercialExpiryReviewsService],
})
export class CommercialExpiryReviewsModule {}
