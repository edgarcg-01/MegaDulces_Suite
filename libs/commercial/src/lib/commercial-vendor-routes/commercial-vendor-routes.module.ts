import { Module } from '@nestjs/common';
import { CommercialVendorRoutesService } from './commercial-vendor-routes.service';
import { CommercialVendorRoutesController } from './commercial-vendor-routes.controller';
import { VisitMonitorService } from './visit-monitor.service';
import { VisitMonitorController } from './visit-monitor.controller';
import { SupervisorBoardService } from './supervisor-board.service';
import { SupervisorBoardController } from './supervisor-board.controller';
import { VecinalVendorsMonitorService } from './vecinal-vendors-monitor.service';
import { VecinalVendorsMonitorController } from './vecinal-vendors-monitor.controller';

@Module({
  // [MCP.3.7] VisitMonitorController: monitoreo de visitas del día (supervisor de ventas).
  // [MCP.3.9] SupervisorBoardController: tablero del supervisor. Va PRIMERO: sus rutas son
  // literales (`supervisor/…`) y comparten prefijo con el `DELETE :id` de cartera.
  // [MV.2] VecinalVendorsMonitorController: Monitoreo vecinal, vendedores (prefijo propio).
  controllers: [SupervisorBoardController, CommercialVendorRoutesController, VisitMonitorController, VecinalVendorsMonitorController],
  providers: [CommercialVendorRoutesService, VisitMonitorService, SupervisorBoardService, VecinalVendorsMonitorService],
  exports: [CommercialVendorRoutesService],
})
export class CommercialVendorRoutesModule {}
