import { Module } from '@nestjs/common';
import { CommercialProductsService } from './commercial-products.service';
import { CommercialProductsController } from './commercial-products.controller';
import { NewProductsService } from './new-products.service';
import { ProductFlowService } from './product-flow.service';

@Module({
  controllers: [CommercialProductsController],
  providers: [CommercialProductsService, NewProductsService, ProductFlowService],
  exports: [CommercialProductsService],
})
export class CommercialProductsModule {}
