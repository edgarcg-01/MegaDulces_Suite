import { Module } from '@nestjs/common';
import { CommercialTrackingService } from './commercial-tracking.service';
import { CommercialTrackingController } from './commercial-tracking.controller';

@Module({
  controllers: [CommercialTrackingController],
  providers: [CommercialTrackingService],
  exports: [CommercialTrackingService],
})
export class CommercialTrackingModule {}
