import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { CommercialExpiryReviewsService } from './commercial-expiry-reviews.service';
import { CommercialExpiryReviewsController } from './commercial-expiry-reviews.controller';
import { PromoterBrandsService } from './promoter-brands.service';
import { PromoterBrandsController } from './promoter-brands.controller';

/**
 * Fase P2.6 — Control de Caducidades digital (ADR-022). Reusa CloudinaryModule
 * para la foto de evidencia por renglón. Incluye promotores de marca propia
 * (scoping por marca). TenantKnexService/TenantContextService son globales.
 * Wireado en AppModule bajo el toggle ENABLE_MULTITENANT.
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [CommercialExpiryReviewsController, PromoterBrandsController],
  providers: [CommercialExpiryReviewsService, PromoterBrandsService],
  exports: [CommercialExpiryReviewsService, PromoterBrandsService],
})
export class CommercialExpiryReviewsModule {}
