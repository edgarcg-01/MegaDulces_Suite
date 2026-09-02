import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { TiendaService, type TiendaQuery } from './tienda.service';
import { esInterno } from '../auth/sesion.util';

/**
 * Tienda en línea. Rutas públicas: las consume un cliente sin cuenta.
 *
 * Lo que separa esto del catálogo interno es qué NO se devuelve. Sin sesión
 * válida no salen costos ni márgenes, y no se puede consultar otra sucursal
 * que no sea PH. Con sesión interna sí, para que el departamento de e-commerce
 * pueda ver el inventario del resto desde la misma interfaz.
 */
@Controller('tienda')
export class TiendaController {
  constructor(private readonly tienda: TiendaService) {}

  /**
   * Reglas de la tienda: envío, sucursal, paqueterías.
   * El frontend las lee de aquí para no traerlas escritas a mano, y así
   * cambiar el umbral de envío gratis no obliga a tocar el HTML.
   * GET /api/tienda/config
   */
  @Get('config')
  getConfig() { return this.tienda.getConfig(); }

  /**
   * Catálogo de mayoreo con existencia en PH.
   * GET /api/tienda/catalogo?q=mazapan&familia=001&page=1&limit=40
   */
  @Get('catalogo')
  getCatalogo(@Query() query: TiendaQuery, @Req() req: any) {
    return this.tienda.getCatalogo(query, esInterno(req));
  }

  /** Ficha de un producto. GET /api/tienda/producto/08036 */
  @Get('producto/:codigo')
  getProducto(@Param('codigo') codigo: string, @Req() req: any) {
    return this.tienda.getProducto(codigo, esInterno(req));
  }
}
