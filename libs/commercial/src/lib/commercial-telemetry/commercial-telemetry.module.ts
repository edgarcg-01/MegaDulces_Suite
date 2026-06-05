import { Module } from '@nestjs/common';
import { CommercialTelemetryService } from './commercial-telemetry.service';
import { CommercialTelemetryController } from './commercial-telemetry.controller';

@Module({
  controllers: [CommercialTelemetryController],
  providers: [CommercialTelemetryService],
  exports: [CommercialTelemetryService],
})
export class CommercialTelemetryModule {}
