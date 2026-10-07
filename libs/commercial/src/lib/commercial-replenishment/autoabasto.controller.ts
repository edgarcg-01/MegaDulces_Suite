import { BadRequestException, Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, MX_TZ, toMxDateKey } from '@megadulces/platform-core';
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * ADR-052 — el boundary va tipado. Y acá el tipo correcto es **el del motor**, derivado, no una
 * interfaz nueva: este controlador no calcula nada, así que declarar a mano la forma de la
 * respuesta sería una SEGUNDA definición del mismo hecho — justo lo que la regla de "derivá, no
 * materialices" evita. Derivándolo, el día que el motor agregue una columna, la firma la sigue
 * sola en vez de quedarse mintiendo.
 */
type AutoabastoMesa = Awaited<ReturnType<CommercialReplenishmentService['criticalStock']>>;
type AutoabastoResumen = Awaited<ReturnType<CommercialReplenishmentService['summary']>>;
type AutoabastoFiltros = Awaited<ReturnType<CommercialReplenishmentService['filters']>>;

/**
 * `[AB.13]` El reporte imprimible: las MISMAS filas y el MISMO resumen que la mesa, completos y
 * para UN almacén, más el sello de cuándo y quién. La hora la pone el servidor, en hora de
 * México: la de la computadora de quien imprime puede estar mal, y el papel tiene que decir la
 * verdad sobre cuándo se consultó el dato.
 */
interface AutoabastoReporte {
  almacen: { id: string; code: string; name: string };
  generado_en: string;   // ISO, UTC
  fecha_mx: string;      // AAAA-MM-DD en hora de México
  hora_mx: string;       // HH:mm en hora de México
  generado_por: string | null;
  resumen: AutoabastoResumen;
  mesa: AutoabastoMesa;
}

/**
 * `[AB.13]` El área de alcance de Autoabasto es el proyecto **Almacén** ([ZN.8]: las áreas son los
 * proyectos de `AUTHZ_TREE`, y `autoabasto` cuelga de `almacen`). Antes la mesa heredaba el
 * alcance del área Compras porque reusa el motor de Compras — y la regla del almacenista en
 * Compras no es la que debe mandar en su propia mesa.
 */
const AREA_AUTOABASTO = 'almacen';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
   * El alcance lo aplica el motor: lo que se pide en `warehouse_id(s)` se intersecta con lo que
   * la persona alcanza en el área Almacén (`ScopeService`, ADR-050). Sin regla, no ve nada.
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
  ): Promise<AutoabastoMesa> {
    return this.svc.criticalStock({
      warehouse_id, warehouse_ids, supplier_id, category_id, abc, bucket, search,
      target_basis, sort_by, sort_dir,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    }, AREA_AUTOABASTO);
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
  ): Promise<AutoabastoResumen> {
    return this.svc.summary({ warehouse_id, warehouse_ids, supplier_id, category_id, search, target_basis }, AREA_AUTOABASTO);
  }

  /** Los almacenes (ya recortados al alcance de la persona) y proveedores para filtrar la mesa. */
  @Get('filtros')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'Catálogos para los filtros de la mesa' })
  filtros(): Promise<AutoabastoFiltros> {
    return this.svc.filters(AREA_AUTOABASTO);
  }

  /**
   * `[AB.13]` El reporte de necesidades de UN almacén, completo (sin paginar), para imprimirlo.
   *
   * Es por almacén a propósito: el papel dice «del almacén X», y un reporte de varios no tiene
   * un almacén que poner en el encabezado. El almacén tiene que estar dentro del alcance de la
   * persona — se comprueba contra la MISMA lista que alimenta el filtro, no se confía en el query.
   */
  @Get('reporte')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'Reporte imprimible de necesidades de un almacén (todas las filas + resumen + sello de fecha y hora)' })
  async reporte(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('bucket') bucket?: string,
    @Query('search') search?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
    @Req() req?: { user?: { username?: string } },
  ): Promise<AutoabastoReporte> {
    if (!warehouse_id || !UUID_RX.test(warehouse_id)) {
      throw new BadRequestException('El reporte es por almacén: elige uno.');
    }
    const { warehouses } = await this.svc.filters(AREA_AUTOABASTO);
    const almacen = (warehouses as { id: string; code: string; name: string }[]).find((w) => w.id === warehouse_id);
    if (!almacen) throw new ForbiddenException('Ese almacén no está dentro de tu alcance.');

    const ahora = new Date();
    const q = { warehouse_id, supplier_id, bucket, search, sort_by, sort_dir };
    const [mesa, resumen] = await Promise.all([
      this.svc.criticalStock({ ...q, export: true }, AREA_AUTOABASTO),
      // Sin `search` a propósito: en summary() el texto filtra por NOMBRE DE PROVEEDOR, no por
      // producto (defecto abierto de la revisión de AB). El resumen del papel es del almacén.
      this.svc.summary({ warehouse_id, supplier_id }, AREA_AUTOABASTO),
    ]);
    return {
      almacen: { id: almacen.id, code: almacen.code, name: almacen.name },
      generado_en: ahora.toISOString(),
      fecha_mx: toMxDateKey(ahora),
      hora_mx: new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora),
      generado_por: req?.user?.username ?? null,
      resumen,
      mesa,
    };
  }
}
