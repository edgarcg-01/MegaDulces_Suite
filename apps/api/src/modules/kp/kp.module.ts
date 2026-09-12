import { Module } from '@nestjs/common';
import { KpController, SucursalesController } from './kp.controller';
import { KpService } from './kp.service';
import { SucursalesService } from './sucursales.service';

/**
 * Verificador de precios de mostrador (KP). Rutas públicas de sólo lectura sobre
 * `kepler_ods.*` en `postgres_platform` (vía `KNEX_NEW_DB`, `@Global`).
 *
 * Absorbe el app standalone `apps/catalogo-kp`: la lógica de queries es la misma
 * de `KpService`, pero vive como módulo de `apps/api` en vez de un segundo
 * backend con su propio `main.ts`.
 *
 * `SucursalesService` exportado a propósito: `CatalogoInternoModule` (mismo
 * origen standalone) lo reusa para no duplicar `getSucursales()` — la única
 * copia ya trae la frescura correcta (`analytics.cron_runs`).
 */
@Module({
  controllers: [KpController, SucursalesController],
  providers: [KpService, SucursalesService],
  exports: [SucursalesService],
})
export class KpModule {}
