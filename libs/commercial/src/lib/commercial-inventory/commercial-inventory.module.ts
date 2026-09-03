import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { CommercialInventoryService } from './commercial-inventory.service';
import { CommercialInventoryController } from './commercial-inventory.controller';
import { InventoryCountService } from './inventory-count.service';
import { InventoryCountController } from './inventory-count.controller';
import { InventoryAbcService } from './inventory-abc.service';
import { InventoryAbcController } from './inventory-abc.controller';
import { CycleCountSchedulerService } from './cycle-count-scheduler.service';
import { WarehouseAislesService } from './warehouse-aisles.service';
import { WarehouseAislesController } from './warehouse-aisles.controller';
import { InventoryTeamService } from './inventory-team.service';
import { InventoryTeamController } from './inventory-team.controller';
import { InventoryMonitorGateway } from './inventory-monitor.gateway';
import { BinLocationService } from './bin-location.service';
import { BinLocationController } from './bin-location.controller';
import { InventoryInvestigationService } from './inventory-investigation.service';
import { InventoryInvestigationController } from './inventory-investigation.controller';
import { InventoryMonitoringService } from './inventory-monitoring.service';
import { InventoryMonitoringController } from './inventory-monitoring.controller';
import { InventoryRiskService } from './inventory-risk.service';
import { InventoryRiskController } from './inventory-risk.controller';

@Module({
  imports: [
    // JwtModule embebido para decodificar el token del handshake WS (igual que
    // commercial-alerts). Default secret matched con auth-mt para evitar mismatch.
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [CommercialInventoryController, InventoryCountController, InventoryAbcController, WarehouseAislesController, InventoryTeamController, BinLocationController, InventoryInvestigationController, InventoryMonitoringController, InventoryRiskController],
  providers: [CommercialInventoryService, InventoryCountService, InventoryAbcService, CycleCountSchedulerService, WarehouseAislesService, InventoryTeamService, InventoryMonitorGateway, BinLocationService, InventoryInvestigationService, InventoryMonitoringService, InventoryRiskService],
  exports: [CommercialInventoryService, InventoryCountService, InventoryAbcService, WarehouseAislesService, BinLocationService, InventoryInvestigationService, InventoryMonitoringService, InventoryRiskService],
})
export class CommercialInventoryModule {}
