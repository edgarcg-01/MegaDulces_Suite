import { Module } from '@nestjs/common';
import { MktRankingService } from './mkt-ranking.service';
import { MktRankingController } from './mkt-ranking.controller';
import { MktVendedorasService } from './mkt-vendedoras.service';
import { MktVendedorasController } from './mkt-vendedoras.controller';

/**
 * `[MKT.10]` — Ranking de promociones e incentivos de Marketing. Se wirea en `AppModule` junto a
 * los otros módulos de Mercadotecnia (`CommercialPromoSelloutModule`).
 */
@Module({
  // [MKT.18] Quién vendió cada ticket con promoción (lo escribe la cajera desde su arqueo).
  controllers: [MktRankingController, MktVendedorasController],
  providers: [MktRankingService, MktVendedorasService],
  exports: [MktRankingService],
})
export class MktRankingModule {}
