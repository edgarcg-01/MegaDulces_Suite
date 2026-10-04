import { Module } from '@nestjs/common';
import { CommercialPricingService } from './commercial-pricing.service';
import { CommercialPricingController } from './commercial-pricing.controller';
import { PriceExperimentService, PriceExperimentReadService } from './price-experiment.service';
import { PriceExperimentController } from './price-experiment.controller';
import { MarginEngineService } from './margin-engine.service';
import { MarginEngineController } from './margin-engine.controller';
// [VTK.3] La lista del vendedor saca unidades y precios por unidad de la escalera del motor de
// cotizaciones (la misma con la que después se cobra el pedido).
import { CommercialQuotesModule } from '../commercial-quotes/commercial-quotes.module';

@Module({
  imports: [CommercialQuotesModule],
  controllers: [CommercialPricingController, PriceExperimentController, MarginEngineController],
  providers: [CommercialPricingService, PriceExperimentService, PriceExperimentReadService,
    MarginEngineService],
  exports: [CommercialPricingService, PriceExperimentService, PriceExperimentReadService,
    MarginEngineService],
})
export class CommercialPricingModule {}
