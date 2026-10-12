import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { TripClosureController } from './trip-closure.controller';
import { TripClosureService } from './trip-closure.service';

// EMB.24/26/27 — cierre del viaje. CloudinaryModule trae el ObjectStorageService (bucket privado)
// donde se guarda la foto de la remisión firmada.
@Module({
  imports: [CloudinaryModule],
  controllers: [TripClosureController],
  providers: [TripClosureService],
  exports: [TripClosureService],
})
export class LogisticsTripClosureModule {}
