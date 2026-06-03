import { Module } from '@nestjs/common';
import { RecommendationsService } from './recommendations.service';
import { RecommendationsRefreshService } from './recommendations-refresh.service';
import { RecommendationsController } from './recommendations.controller';

@Module({
  controllers: [RecommendationsController],
  providers: [RecommendationsService, RecommendationsRefreshService],
  exports: [RecommendationsService],
})
export class CommercialRecommendationsModule {}
