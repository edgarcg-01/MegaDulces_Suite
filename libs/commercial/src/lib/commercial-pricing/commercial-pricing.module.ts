import { Module } from '@nestjs/common';
import { CommercialPricingService } from './commercial-pricing.service';
import { CommercialPricingController } from './commercial-pricing.controller';
import { PriceExperimentService } from './price-experiment.service';

@Module({
  controllers: [CommercialPricingController],
  providers: [CommercialPricingService, PriceExperimentService],
  exports: [CommercialPricingService, PriceExperimentService],
})
export class CommercialPricingModule {}
