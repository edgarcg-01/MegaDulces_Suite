import { Module } from '@nestjs/common';
import { CommercialPricingService } from './commercial-pricing.service';
import { CommercialPricingController } from './commercial-pricing.controller';
import { PriceExperimentService, PriceExperimentReadService } from './price-experiment.service';
import { PriceExperimentController } from './price-experiment.controller';
import { MarginEngineService } from './margin-engine.service';
import { MarginEngineController } from './margin-engine.controller';

@Module({
  controllers: [CommercialPricingController, PriceExperimentController, MarginEngineController],
  providers: [CommercialPricingService, PriceExperimentService, PriceExperimentReadService,
    MarginEngineService],
  exports: [CommercialPricingService, PriceExperimentService, PriceExperimentReadService,
    MarginEngineService],
})
export class CommercialPricingModule {}
