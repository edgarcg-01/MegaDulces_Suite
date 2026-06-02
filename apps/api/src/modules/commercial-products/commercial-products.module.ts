import { Module } from '@nestjs/common';
import { CommercialProductsService } from './commercial-products.service';
import { CommercialProductsController } from './commercial-products.controller';

@Module({
  controllers: [CommercialProductsController],
  providers: [CommercialProductsService],
  exports: [CommercialProductsService],
})
export class CommercialProductsModule {}
