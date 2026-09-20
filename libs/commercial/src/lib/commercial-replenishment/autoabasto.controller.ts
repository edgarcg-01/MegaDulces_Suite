import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * Fase AB — **Autoabasto**: la mesa de trabajo del almacenista y del encargado de sucursal.
 *
 * ── Por qué es un controlador nuevo y no un permiso más en el de Compras ─────
 * El módulo es de OTRA audiencia. El comprador recibe la solicitud y la gestiona en Compras;
 * el almacenista administra la necesidad de SU negocio. Son dos trabajos y dos facultades.
 *
 * Y hay una medición que lo vuelve concreto, no filosófico: hoy
 * `COMPRAS_PEDIDO_VER` está en **`false` explícito** para `almacenista` y en `true` para
 * `encargado_tienda`. O sea que el encargado ya alcanza Existencia Crítica y **el almacenista
 * no** — la persona que hace el trabajo es justo la que no puede ver los números. Ese `false`
 * es una decisión manual guardada desde `/admin/roles` y **no se pisa**: se le abre la puerta
 * con una llave propia (`AUTOABASTO_VER`), que es una clave nueva y por lo tanto NULL en todos
 * los roles, sin tocar nada del lado de Compras.
 *
 * ── Lo que este controlador NO hace: calcular ────────────────────────────────
 * Delega en `CommercialReplenishmentService`, el motor de la Fase RA — el mismo `criticalStock`
 * y el mismo `summary` que usa `/compras/existencia`. **Dos audiencias, un solo número.** Un
 * segundo motor de reorden sería la forma más cara de que el almacén y el comprador discutan
 * cifras distintas del mismo hecho (ADR-056: el primitivo que ya existe se consume, no se copia).
 *
 * Lo que sí es propio de esta superficie —la escalera de facultades, el backorder, la solicitud
 * de traspaso— entra en los PR siguientes de la fase.
 */
@ApiTags('commercial-autoabasto')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/autoabasto')
export class AutoabastoController {
  constructor(private readonly svc: CommercialReplenishmentService) {}

  /**
   * La mesa: qué falta, cuánto pedir y para cuándo, con el sugerido ya neto de tránsito.
   *
   * ⚠️ `warehouse_id` es del llamador, no del token: **el scope por sucursal todavía NO está
   * aplicado**. Hoy un almacenista con la clave ve la red completa si no filtra. Queda
   * declarado acá y en el plan de la fase en vez de simularse con un filtro de pantalla, que
   * daría sensación de alcance sin serlo.
   */
  @Get('mesa')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'Mesa de autoabasto: existencia vs mín/reorden/máx + sugerido neto de tránsito' })
  mesa(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('abc') abc?: string,
    @Query('bucket') bucket?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.criticalStock({
      warehouse_id, warehouse_ids, supplier_id, category_id, abc, bucket, search,
      target_basis, sort_by, sort_dir,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** KPIs por bucket (agotado / bajo mínimo / bajo reorden / sobrestock) + costo del sugerido. */
  @Get('mesa/resumen')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'KPIs de la mesa por bucket + costo sugerido' })
  resumen(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
  ) {
    return this.svc.summary({ warehouse_id, warehouse_ids, supplier_id, category_id, search, target_basis });
  }

  /** Los almacenes y proveedores con los que se puede filtrar la mesa. */
  @Get('filtros')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'Catálogos para los filtros de la mesa' })
  filtros() {
    return this.svc.filters();
  }
}
