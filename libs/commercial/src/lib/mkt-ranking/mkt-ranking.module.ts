import { Module } from '@nestjs/common';
import { MktRankingService } from './mkt-ranking.service';
import { MktRankingController } from './mkt-ranking.controller';

/**
 * `[MKT.10]` — Ranking de promociones e incentivos de Marketing. Se wirea en `AppModule` junto a
 * los otros módulos de Mercadotecnia (`CommercialPromoSelloutModule`).
 */
@Module({
  controllers: [MktRankingController],
  providers: [MktRankingService],
  exports: [MktRankingService],
})
export class MktRankingModule {}
