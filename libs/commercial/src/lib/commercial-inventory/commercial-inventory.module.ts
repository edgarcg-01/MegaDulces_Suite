import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CommercialInventoryService } from './commercial-inventory.service';
import { CommercialInventoryController } from './commercial-inventory.controller';
import { InventoryCountService } from './inventory-count.service';
import { InventoryCountController } from './inventory-count.controller';
import { InventoryAbcService } from './inventory-abc.service';
import { InventoryAbcController } from './inventory-abc.controller';
import { CycleCountSchedulerService } from './cycle-count-scheduler.service';
import { InventoryMonitorGateway } from './inventory-monitor.gateway';

@Module({
  imports: [
    // JwtModule embebido para decodificar el token del handshake WS (igual que
    // commercial-alerts). Default secret matched con auth-mt para evitar mismatch.
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  controllers: [CommercialInventoryController, InventoryCountController, InventoryAbcController],
  providers: [CommercialInventoryService, InventoryCountService, InventoryAbcService, CycleCountSchedulerService, InventoryMonitorGateway],
  exports: [CommercialInventoryService, InventoryCountService, InventoryAbcService],
})
export class CommercialInventoryModule {}
