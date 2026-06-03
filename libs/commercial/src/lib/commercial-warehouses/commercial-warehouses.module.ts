import { Module } from '@nestjs/common';
import { CommercialWarehousesService } from './commercial-warehouses.service';
import { CommercialWarehousesController } from './commercial-warehouses.controller';

@Module({
  controllers: [CommercialWarehousesController],
  providers: [CommercialWarehousesService],
  exports: [CommercialWarehousesService],
})
export class CommercialWarehousesModule {}
