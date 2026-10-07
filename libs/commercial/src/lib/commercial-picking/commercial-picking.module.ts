import { Module } from '@nestjs/common';
import { ScopeModule } from '@megadulces/platform-core';
import { PickingController } from './picking.controller';
import { PickingService } from './picking.service';

/**
 * Fase SU.2 — pool de pedidos por surtir y olas de surtido (ADR-067).
 * TenantKnexService/TenantContextService son globales.
 *
 * `[VEC.4]` `ScopeModule` va EXPLÍCITO aunque sea `@Global()`: la bandeja de avisos exige
 * `ScopeService` para recortar por sucursal y no es `@Optional()`. Sin el import Nest no
 * arranca — que es mejor que arrancar con el corte apagado y que cada sucursal vea los avisos
 * de las demás. Mismo criterio que `commercial-promo-sellout`.
 */
@Module({
  imports: [ScopeModule],
  controllers: [PickingController],
  providers: [PickingService],
  exports: [PickingService],
})
export class CommercialPickingModule {}
