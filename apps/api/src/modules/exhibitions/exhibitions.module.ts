import { Module } from '@nestjs/common';
import { ExhibitionsController } from './exhibitions.controller';
import { ExhibitionsService } from './exhibitions.service';
import { ScoringModule } from '../scoring/scoring.module';

@Module({
  imports: [ScoringModule],
  controllers: [ExhibitionsController],
  providers: [ExhibitionsService]
})
export class ExhibitionsModule {}
