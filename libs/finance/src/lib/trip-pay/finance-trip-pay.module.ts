import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { TripPayController } from './trip-pay.controller';
import { TripPayService } from './trip-pay.service';

// EMB.29 — Vale de comisiones y viáticos de logística. CloudinaryModule trae el ObjectStorageService
// donde se guarda la hoja de viajes del vale.
@Module({
  imports: [CloudinaryModule],
  controllers: [TripPayController],
  providers: [TripPayService],
})
export class FinanceTripPayModule {}
