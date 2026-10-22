import { Module } from '@nestjs/common';
import { NewCustomersKeplerController, SimilarCustomersController } from './new-customers-kepler.controller';
import { NewCustomersKeplerService } from './new-customers-kepler.service';

/**
 * `[MCP.3.8]` Cliente nuevo: alta en la Suite y liga con Kepler.
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  controllers: [NewCustomersKeplerController, SimilarCustomersController],
  providers: [NewCustomersKeplerService],
  exports: [NewCustomersKeplerService],
})
export class NewCustomersKeplerModule {}
