import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Permission, RequirePermissions, ScopeService, ReqUser } from '@megadulces/platform-core';
import { CatalogoInternoService, CatalogoQuery } from './catalogo-interno.service';

/**
 * Catálogo interno (costo/margen/valor de inventario) — absorbido desde el
 * repo standalone `0SistemasMD/catalogo-kp`. Todo gateado por
 * `CATALOGO_INTERNO_VER`; el detalle de costo/margen exige además
 * `CATALOGO_INTERNO_COSTOS_VER` (dato más sensible — quién ve el catálogo no
 * necesariamente debe ver cuánto cuesta o cuánto se gana).
 *
 * El verificador de precios de mostrador (público, sin sesión) es el módulo
 * `kp` — separado a propósito, no se toca acá.
 */
@ApiTags('catalogo-interno')
@Controller('catalogo-interno')
export class CatalogoInternoController {
  constructor(
    private readonly service: CatalogoInternoService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * GET /api/catalogo-interno?sucursal=01&q=mazapan&familia=001&stock=con&page=1&limit=50
   *
   * `sucursal` acepta el alias `warehouse`/`warehouses`/`warehouse_id`
   * también (ver `PARAM_ALIASES` de `ScopeService`) — se documenta como
   * `sucursal` porque es el nombre que ya usaba el catálogo original.
   */
  @Get()
  @RequirePermissions(Permission.CATALOGO_INTERNO_VER)
  @ApiOperation({ summary: 'Catálogo interno paginado (existencia y precio); costo/margen sólo con CATALOGO_INTERNO_COSTOS_VER.' })
  @ApiQuery({ name: 'sucursal', required: false, description: 'Código de sucursal, o varias separadas por coma. Vacío = todas las que el rol pueda ver.' })
  async getCatalogo(@Query() query: Record<string, unknown>, @ReqUser() user: any) {
    const sucursales = await this.scope.readParam(query, 'warehouse', 'catalogo-interno');
    const verCostos = user?.permissions?.[Permission.CATALOGO_INTERNO_COSTOS_VER] === true;
    return this.service.getCatalogo(query as CatalogoQuery, sucursales, verCostos);
  }

  /** GET /api/catalogo-interno/filtros — opciones de familia/subfamilia/marca. */
  @Get('filtros')
  @RequirePermissions(Permission.CATALOGO_INTERNO_VER)
  @ApiOperation({ summary: 'Opciones de familia/subfamilia/marca para los filtros del catálogo interno.' })
  getFiltros() {
    return this.service.getFiltros();
  }

  /** GET /api/catalogo-interno/estado — frescura del pipeline kepler_ods. */
  @Get('estado')
  @RequirePermissions(Permission.CATALOGO_INTERNO_VER)
  @ApiOperation({ summary: 'Hasta cuándo están frescos kdii/kdik/kdil en kepler_ods (_sync_status).' })
  getEstado() {
    return this.service.getEstado();
  }

  /** GET /api/catalogo-interno/producto/:codigo — ficha por sucursal y almacén. */
  @Get('producto/:codigo')
  @RequirePermissions(Permission.CATALOGO_INTERNO_VER)
  @ApiOperation({ summary: 'Ficha de un producto: precio y existencia por sucursal/almacén, recortada al alcance del rol.' })
  async getProducto(@Param('codigo') codigo: string, @Query() query: Record<string, unknown>, @ReqUser() user: any) {
    const sucursales = await this.scope.readParam(query, 'warehouse', 'catalogo-interno/producto');
    const verCostos = user?.permissions?.[Permission.CATALOGO_INTERNO_COSTOS_VER] === true;
    return this.service.getProducto(codigo, sucursales, verCostos);
  }
}
