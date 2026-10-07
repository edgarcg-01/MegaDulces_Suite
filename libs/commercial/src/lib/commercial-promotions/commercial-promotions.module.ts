import { Module } from '@nestjs/common';
import { CommercialPromotionsService } from './commercial-promotions.service';
import { CommercialPromotionsController } from './commercial-promotions.controller';

@Module({
  controllers: [CommercialPromotionsController],
  providers: [CommercialPromotionsService],
  exports: [CommercialPromotionsService],
})
export class CommercialPromotionsModule {}
