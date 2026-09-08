import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '@megadulces/platform-core';
import { KpService } from './kp.service';
import { SucursalesService } from './sucursales.service';

/**
 * Verificador de precios de mostrador. Todas las rutas son PÚBLICAS (`@Public()`,
 * sin sesión) a propósito: las consumen los verificadores de mostrador/kiosco,
 * que no tienen con quién autenticarse. Sólo devuelven precios de venta, nunca
 * costos ni márgenes.
 *
 * Absorbido a `apps/api` desde el app standalone `apps/catalogo-kp` (que tenía
 * su propio `main.ts`/bootstrap/CORS/Pool). Ahora hereda Helmet, Throttler, CORS
 * y la conexión `KNEX_NEW_DB` de la plataforma — un solo backend, no dos.
 */
@Controller('kp')
export class KpController {
  constructor(
    private readonly kpService: KpService,
    private readonly sucursalesService: SucursalesService,
  ) {}

  /**
   * Precio de UN producto por clave interna o código de barras.
   * GET /api/kp/precio?q=17083
   */
  @Public()
  @Get('precio')
  getPrecio(@Query('q') q: string) { return this.kpService.getPrecio(q); }

  /**
   * Todo el catálogo con precios por unidad (fuente del verificador offline).
   * GET /api/kp/precios-todos?sucursal=01
   */
  @Public()
  @Get('precios-todos')
  getPreciosTodos(@Query('sucursal') sucursal?: string) {
    return this.kpService.getPreciosTodos(sucursal);
  }
}

/**
 * Catálogo de sucursales para el verificador (nombres, almacenes, frescura ODS).
 * Pública: la consume el generador del verificador para saber para qué plazas
 * armar el archivo, sin código quemado.
 */
@Controller('sucursales')
export class SucursalesController {
  constructor(private readonly sucursalesService: SucursalesService) {}

  /** GET /api/sucursales */
  @Public()
  @Get()
  getSucursales() { return this.sucursalesService.getSucursales(); }
}
