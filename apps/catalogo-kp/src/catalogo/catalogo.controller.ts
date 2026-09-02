import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { CatalogoService, type CatalogoQuery } from './catalogo.service';
import { esInterno } from '../auth/sesion.util';

@Controller('catalogo')
export class CatalogoController {
  constructor(private readonly catalogo: CatalogoService) {}

  /**
   * Catálogo con existencias y precios.
   * GET /api/catalogo?sucursal=03&q=mazapan&familia=001&stock=con&page=1&limit=50
   *   sucursal   '00'..'05' | 'TODAS' (consolidado, default)
   *   q          busca en código, nombre y código de barras
   *   familia / subfamilia / marca  códigos de kdie / kdif / kdig
   *   stock      'con' | 'sin' | 'todos'
   *   orden      'nombre' | 'codigo' | 'existencia' | 'precio' | 'valor'
   *   dir        'asc' | 'desc'
   */
  @Get()
  get(@Query() query: CatalogoQuery, @Req() req: any) {
    // La tienda consume este mismo endpoint sin sesión: en ese caso el
    // servicio omite costo, margen y valor de inventario.
    return this.catalogo.getCatalogo(query, esInterno(req));
  }

  /** Sucursales con sus almacenes y frescura de datos. GET /api/catalogo/sucursales */
  @Get('sucursales')
  getSucursales() { return this.catalogo.getSucursales(); }

  /** Opciones de familia / subfamilia / marca. GET /api/catalogo/filtros */
  @Get('filtros')
  getFiltros() { return this.catalogo.getFiltros(); }

  /** Hasta cuándo están frescos los datos. GET /api/catalogo/estado */
  @Get('estado')
  getEstado() { return this.catalogo.getEstado(); }

  /**
   * Códigos de producto que tienen foto en public/img/productos.
   * La tienda lo consulta una vez para no pedir imágenes que no existen.
   * GET /api/catalogo/imagenes
   */
  @Get('imagenes')
  getImagenes() { return this.catalogo.getImagenes(); }

  /** Ficha de un producto en las 6 sucursales. GET /api/catalogo/producto/17083 */
  @Get('producto/:codigo')
  getProducto(@Param('codigo') codigo: string, @Req() req: any) {
    return this.catalogo.getProducto(codigo, esInterno(req));
  }
}
