import { Module } from '@nestjs/common';
import { CatalogoInternoController } from './catalogo-interno.controller';
import { CatalogoInternoService } from './catalogo-interno.service';
import { KpModule } from '../kp/kp.module';

/**
 * Catálogo interno (costo/margen/valor de inventario), absorbido desde el
 * repo standalone `0SistemasMD/catalogo-kp`. Vive como módulo de `apps/api`
 * — sin `main.ts`/bootstrap propio — igual que ya se hizo con el verificador
 * de precios público (`KpModule`).
 *
 * Importa `KpModule` para reusar `SucursalesService` (frescura vía
 * `analytics.cron_runs`) en vez de duplicarlo.
 *
 * NO incluidos en este módulo — deuda documentada, ver PR:
 *   - "Actualizar Wix" / generación de variantes (`kp-excel.service.ts` del
 *     repo original) — feature grande aparte, no portada todavía.
 *   - Captura de errores del navegador — sin decisión de si la Suite ya
 *     tiene un mecanismo equivalente que reusar.
 *   - Dashboard de ventas del repo original — parece duplicar
 *     `analytics.sales_monthly`/`COMMERCIAL_SELLOUT_VER` ya existentes; no se
 *     portó para no reconstruir algo que ya existe (pendiente de que Edgar
 *     confirme si hay una brecha real que sí justifique un endpoint propio).
 */
@Module({
  imports: [KpModule],
  controllers: [CatalogoInternoController],
  providers: [CatalogoInternoService],
})
export class CatalogoInternoModule {}
