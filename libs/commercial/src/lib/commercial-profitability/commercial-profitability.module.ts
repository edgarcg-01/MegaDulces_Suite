import { Module } from '@nestjs/common';
import { CommercialProfitabilityService } from './commercial-profitability.service';
import { CommercialProfitabilityController } from './commercial-profitability.controller';

@Module({
  controllers: [CommercialProfitabilityController],
  providers: [CommercialProfitabilityService],
  exports: [CommercialProfitabilityService],
})
export class CommercialProfitabilityModule {}
