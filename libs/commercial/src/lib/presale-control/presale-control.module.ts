import { Module } from '@nestjs/common';
import { PresaleControlController } from './presale-control.controller';
import { PresaleControlService } from './presale-control.service';

/**
 * `[MCP.1]` Mesa de Control de Preventa (Fase MCP, ADR-089).
 * TenantKnexService, TenantContextService y ScopeService son globales.
 */
@Module({
  controllers: [PresaleControlController],
  providers: [PresaleControlService],
  exports: [PresaleControlService],
})
export class PresaleControlModule {}
