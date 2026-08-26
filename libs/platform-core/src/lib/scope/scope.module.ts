import { Global, Module } from '@nestjs/common';
import { ScopeService } from './scope.service';

/**
 * `[ID.2]` — Módulo del alcance de datos (Fase ID / ADR-050).
 *
 * `@Global()` por la misma razón que `AbilityModule`: el alcance lo va a
 * consultar cualquier service de cualquier feature module, y no tiene sentido
 * importarlo 41 veces.
 *
 * Depende de `KNEX_CONNECTION` y `TenantContextService`, que ya son globales.
 */
@Global()
@Module({
  providers: [ScopeService],
  exports: [ScopeService],
})
export class ScopeModule {}
