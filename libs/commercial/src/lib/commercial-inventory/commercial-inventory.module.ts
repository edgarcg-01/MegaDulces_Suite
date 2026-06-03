import { Module } from '@nestjs/common';
import { CommercialInventoryService } from './commercial-inventory.service';
import { CommercialInventoryController } from './commercial-inventory.controller';

@Module({
  controllers: [CommercialInventoryController],
  providers: [CommercialInventoryService],
  exports: [CommercialInventoryService],
})
export class CommercialInventoryModule {}
