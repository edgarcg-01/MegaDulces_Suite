import { Module } from '@nestjs/common';
import { CommercialVendorRoutesService } from './commercial-vendor-routes.service';
import { CommercialVendorRoutesController } from './commercial-vendor-routes.controller';
import { VisitMonitorService } from './visit-monitor.service';
import { VisitMonitorController } from './visit-monitor.controller';
import { SupervisorBoardService } from './supervisor-board.service';
import { SupervisorBoardController } from './supervisor-board.controller';

@Module({
  // [MCP.3.7] VisitMonitorController: monitoreo de visitas del día (supervisor de ventas).
  // [MCP.3.9] SupervisorBoardController: tablero del supervisor. Va PRIMERO: sus rutas son
  // literales (`supervisor/…`) y comparten prefijo con el `DELETE :id` de cartera.
  controllers: [SupervisorBoardController, CommercialVendorRoutesController, VisitMonitorController],
  providers: [CommercialVendorRoutesService, VisitMonitorService, SupervisorBoardService],
  exports: [CommercialVendorRoutesService],
})
export class CommercialVendorRoutesModule {}
