import { Module } from '@nestjs/common';
import { TemporadasController } from './temporadas.controller';
import { TemporadasService } from './temporadas.service';

// `[PQ.94]` Compras › Temporadas: el calendario de temporadas y los productos de cada una (plan PQ §19).
// TenantKnexService y TenantContextService vienen del módulo global de plataforma, como en ProductSheetsModule.
@Module({
  controllers: [TemporadasController],
  providers: [TemporadasService],
})
export class TemporadasModule {}
