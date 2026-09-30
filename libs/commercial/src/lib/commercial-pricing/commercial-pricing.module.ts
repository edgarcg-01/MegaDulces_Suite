import { Module } from '@nestjs/common';
import { CommercialPricingService } from './commercial-pricing.service';
import { CommercialPricingController } from './commercial-pricing.controller';
import { PriceExperimentService, PriceExperimentReadService } from './price-experiment.service';
import { PriceExperimentController } from './price-experiment.controller';

@Module({
  controllers: [CommercialPricingController, PriceExperimentController],
  providers: [CommercialPricingService, PriceExperimentService, PriceExperimentReadService],
  exports: [CommercialPricingService, PriceExperimentService, PriceExperimentReadService],
})
export class CommercialPricingModule {}
