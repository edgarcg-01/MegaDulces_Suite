import { Module } from '@nestjs/common';
import { LogisticsFleetService } from './logistics-fleet.service';
import { LogisticsFleetController } from './logistics-fleet.controller';
import { VehicleAssignmentService } from './vehicle-assignment.service';

@Module({
  controllers: [LogisticsFleetController],
  providers: [LogisticsFleetService, VehicleAssignmentService],
  exports: [LogisticsFleetService, VehicleAssignmentService],
})
export class LogisticsFleetModule {}
