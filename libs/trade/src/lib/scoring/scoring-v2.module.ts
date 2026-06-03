import { Global, Module } from '@nestjs/common';
import { ScoringV2Service } from './scoring-v2.service';

@Global()
@Module({
  providers: [ScoringV2Service],
  exports: [ScoringV2Service],
})
export class ScoringV2Module {}
