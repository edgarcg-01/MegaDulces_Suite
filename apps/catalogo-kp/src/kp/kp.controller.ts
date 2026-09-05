import { Controller, Get, Query } from '@nestjs/common';
import { KpService } from './kp.service';

/**
 * Verificador de precios de mostrador. Ambas rutas son PÚBLICAS (sin sesión)
 * a propósito: las consumen los verificadores de mostrador/kiosco, que no
 * tienen con quién autenticarse. Sólo devuelven precios de venta, nunca
 * costos ni márgenes.
 */
@Controller('kp')
export class KpController {
  constructor(private readonly kpService: KpService) {}

  /**
   * Precio de UN producto por clave interna o código de barras.
   * GET /api/kp/precio?q=17083
   */
  @Get('precio')
  getPrecio(@Query('q') q: string) { return this.kpService.getPrecio(q); }

  /**
   * Todo el catálogo con precios por unidad.
   * Es la fuente del verificador OFFLINE: `herramientas/Actualizar_Verificador.ps1`
   * lo incrusta en `public/verificador-NN.html`.
   * GET /api/kp/precios-todos?sucursal=01
   */
  @Get('precios-todos')
  getPreciosTodos(@Query('sucursal') sucursal?: string) {
    return this.kpService.getPreciosTodos(sucursal);
  }
}
