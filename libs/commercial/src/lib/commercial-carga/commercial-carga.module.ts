import { Module } from '@nestjs/common';
import { CommercialCargaService } from './commercial-carga.service';
import { CommercialCargaController } from './commercial-carga.controller';

@Module({
  controllers: [CommercialCargaController],
  providers: [CommercialCargaService],
  exports: [CommercialCargaService],
})
export class CommercialCargaModule {}
