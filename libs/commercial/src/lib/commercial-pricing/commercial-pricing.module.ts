import { Module } from '@nestjs/common';
import { CommercialPricingService } from './commercial-pricing.service';
import { CommercialPricingController } from './commercial-pricing.controller';

@Module({
  controllers: [CommercialPricingController],
  providers: [CommercialPricingService],
  exports: [CommercialPricingService],
})
export class CommercialPricingModule {}
