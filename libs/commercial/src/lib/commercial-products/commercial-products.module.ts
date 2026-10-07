import { Module } from '@nestjs/common';
import { CommercialProductsService } from './commercial-products.service';
import { CommercialProductsController } from './commercial-products.controller';
import { NewProductsService } from './new-products.service';

@Module({
  controllers: [CommercialProductsController],
  providers: [CommercialProductsService, NewProductsService],
  exports: [CommercialProductsService],
})
export class CommercialProductsModule {}
