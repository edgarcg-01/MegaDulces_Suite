import { Module } from '@nestjs/common';
import { CommercialInventoryService } from './commercial-inventory.service';
import { CommercialInventoryController } from './commercial-inventory.controller';
import { InventoryCountService } from './inventory-count.service';
import { InventoryCountController } from './inventory-count.controller';

@Module({
  controllers: [CommercialInventoryController, InventoryCountController],
  providers: [CommercialInventoryService, InventoryCountService],
  exports: [CommercialInventoryService, InventoryCountService],
})
export class CommercialInventoryModule {}
