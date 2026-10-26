import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, MX_TZ, toMxDateKey, isPlatformAdminRole } from '@megadulces/platform-core';
import type {
  AutoabastoPedidoResponse, AutoabastoAjusteRequest, AutoabastoAjusteResponse,
  AutoabastoRestablecerRequest, AutoabastoAceptarGrupoRequest, AutoabastoAbrirRequest,
  AutoabastoPosicionesRequest, PosicionPedido,
  AutoabastoRenglonesResponse, EstadoRenglon, SurteRenglon, OrdenMesa,
  AutoabastoEnviarRequest, AutoabastoEnviarResponse,
} from '@megadulces/contracts';
import { ESTADOS_RENGLON, ORDENES_MESA } from '@megadulces/contracts';
import { CommercialReplenishmentService } from './commercial-replenishment.service';
import { AutoabastoPedidoService } from './autoabasto-pedido.service';

/**
 * ADR-052 — el boundary va tipado. Y acá el tipo correcto es **el del motor**, derivado, no una
 * interfaz nueva: este controlador no calcula nada, así que declarar a mano la forma de la
 * respuesta sería una SEGUNDA definición del mismo hecho — justo lo que la regla de "derivá, no
 * materialices" evita. Derivándolo, el día que el motor agregue una columna, la firma la sigue
 * sola en vez de quedarse mintiendo.
 */
type AutoabastoMesa = Awaited<ReturnType<CommercialReplenishmentService['criticalStock']>>;
type AutoabastoResumen = Awaited<ReturnType<CommercialReplenishmentService['summary']>>;
/** `[AB.36]` Sólo los almacenes: ninguna pantalla de Autoabasto pinta proveedores, marcas ni categorías. */
type AutoabastoFiltros = { warehouses: Awaited<ReturnType<CommercialReplenishmentService['almacenes']>> };

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

/**
 * `[AB.15]` Cuánto pedir se calcula IGUAL que en /compras/pedido: venta de 30 días × temporalidad
 * × 30 días de cobertura − existencia (base 'demanda' del motor). Decisión de Francisco,
 * 2026-10-12: el almacenista y el comprador tienen que ver la misma cantidad. El mín / reorden /
 * máx dinámicos siguen decidiendo el semáforo y qué es sobrante. Compras no cambia: su default
 * sigue siendo 'max'.
 */
const BASE_AUTOABASTO = 'demanda';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que `RolesGuard` deja en `req.user`: permisos y roles FRESCOS de la base, no el JWT. */
interface ActorAutoabasto {
  username?: string;
  role_name?: string;
  roles_frescos?: string[];
  permissions?: Record<string, boolean>;
}

/**
 * `[AB.18]` ¿Puede ajustar su pedido? El god-mode va por ROL (ADR-054): `superadmin` no trae la
 * clave en su mapa y entra por rol, igual que en el guard.
 */
function puedeAjustar(u?: ActorAutoabasto): boolean {
  if (!u) return false;
  const roles = u.roles_frescos ?? (u.role_name ? [u.role_name] : []);
  return roles.some((r) => isPlatformAdminRole(r)) || u.permissions?.[Permission.AUTOABASTO_SOLICITAR] === true;
}

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
  constructor(
    private readonly svc: CommercialReplenishmentService,
    private readonly pedidos: AutoabastoPedidoService,
  ) {}

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
    @Query('accion') accion?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AutoabastoMesa> {
    return this.svc.criticalStock({
      warehouse_id, warehouse_ids, supplier_id, category_id, abc, bucket, accion, search,
      target_basis: target_basis || BASE_AUTOABASTO, sort_by, sort_dir,
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
    // `[AB.14]` En esta mesa el buscador es de PRODUCTO: el resumen cuenta lo mismo que la tabla
    // lista. (En summary() `search` filtra por proveedor, que es como lo usa Compras.)
    return this.svc.summary({ warehouse_id, warehouse_ids, supplier_id, category_id, product_search: search, target_basis: target_basis || BASE_AUTOABASTO }, AREA_AUTOABASTO);
  }

  /**
   * Los almacenes ya recortados al alcance de la persona. `[AB.36]` Antes devolvía `filters()` entero
   * (proveedores, marcas y categorías de toda la red: 157–193 ms, medido 2026-10-24) y la pantalla lo
   * espera ANTES de pedir la mesa; sólo usaba los almacenes.
   */
  @Get('filtros')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'Catálogos para los filtros de la mesa' })
  async filtros(): Promise<AutoabastoFiltros> {
    return { warehouses: await this.svc.almacenes(AREA_AUTOABASTO) };
  }

  /**
   * `[AB.16]` «Mi pedido»: el pedido de UN almacén, agrupado por a quién se le pide (su matriz o
   * el proveedor), con lo ya pedido / atorado / negado y la cantidad redondeada a como se captura
   * en Kepler. Mismo control de alcance que el reporte: el almacén se busca en la lista que la
   * persona alcanza, no se confía en el query.
   */
  @Get('pedido')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'Mi pedido: el pedido de un almacén por origen (matriz / proveedor), con ya pedido, atorado, negado y cantidad redondeada' })
  async pedido(
    @Query('warehouse_id') warehouse_id?: string,
    @Req() req?: { user?: ActorAutoabasto },
  ): Promise<AutoabastoPedidoResponse> {
    const almacen = await this.almacenEnAlcance(warehouse_id);
    return this.pedidos.pedido(almacen, AREA_AUTOABASTO, puedeAjustar(req?.user));
  }

  /**
   * `[AB.27]` La mesa de UN almacén sobre la cuenta única del renglón: los mismos renglones que «Mi
   * pedido» (estado, a quién se le pide, lo que ya viene, falta neta) más mínimo, reorden, máximo y
   * entrega. Sólo lee. Mismo control de alcance que «Mi pedido»: el almacén se busca en la lista que la
   * persona alcanza. Convive con `/mesa` hasta que la pantalla se cambie (AB.28).
   */
  @Get('renglones')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: '[AB.27] Mesa de un almacén sobre la cuenta única de «Mi pedido»: estado, a quién se le pide, lo que ya viene y falta neta' })
  async renglones(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('estado') estado?: string,
    @Query('posicion') posicion?: string,
    @Query('surte') surte?: string,
    @Query('search') search?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('todos') todos?: string,
  ): Promise<AutoabastoRenglonesResponse> {
    const almacen = await this.almacenEnAlcance(warehouse_id);
    // Un filtro que no existe se dice, no se ignora: ignorarlo devolvería la lista entera como si fuera el filtro.
    if (estado && !(ESTADOS_RENGLON as readonly string[]).includes(estado)) throw new BadRequestException('Estado inválido.');
    if (surte && !['matriz', 'proveedor', 'sin_ruta'].includes(surte)) throw new BadRequestException('«Surte» inválido.');
    if (sort_by && !(ORDENES_MESA as readonly string[]).includes(sort_by)) throw new BadRequestException('Orden inválido.');
    return this.pedidos.renglones(almacen, AREA_AUTOABASTO, {
      estado: (estado as EstadoRenglon | undefined) ?? null,
      posicion: posicion || null,
      surte: (surte as SurteRenglon['tipo'] | undefined) ?? null,
      search: search || null,
      sort_by: (sort_by as OrdenMesa | undefined) ?? 'lectura',
      sort_dir: sort_dir === 'asc' ? 'asc' : 'desc',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      // El PDF: todo lo del almacén con el filtro, sin paginar.
      todos: todos === '1' || todos === 'true',
    });
  }

  /**
   * `[AB.18]` El almacén tiene que estar dentro del alcance de la persona, en el área Almacén. Se
   * comprueba contra la MISMA lista que alimenta el filtro, nunca se confía en lo que manda el cliente.
   */
  private async almacenEnAlcance(warehouse_id?: string): Promise<{ id: string; code: string; name: string }> {
    if (!warehouse_id || !UUID_RX.test(warehouse_id)) {
      throw new BadRequestException('El pedido es por almacén: elige uno.');
    }
    // `[AB.36]` Sólo los almacenes: `filters()` entero costaba ~175 ms más de proveedores y marcas.
    const warehouses = await this.svc.almacenes(AREA_AUTOABASTO);
    const almacen = (warehouses as { id: string; code: string; name: string }[]).find((w) => w.id === warehouse_id);
    if (!almacen) throw new ForbiddenException('Ese almacén no está dentro de tu alcance.');
    return { id: almacen.id, code: almacen.code, name: almacen.name };
  }

  /** `[AB.18]` Guarda lo que la persona dejó en un renglón (con motivo si se aleja más de 20%). */
  @Put('pedido/ajuste')
  @RequirePermissions(Permission.AUTOABASTO_SOLICITAR)
  @ApiOperation({ summary: 'Mi pedido: ajustar la cantidad de un renglón (− / +), con motivo y huella' })
  async ajustar(@Body() body: AutoabastoAjusteRequest): Promise<AutoabastoAjusteResponse> {
    const almacen = await this.almacenEnAlcance(body?.warehouse_id);
    if (!body?.product_id || !UUID_RX.test(body.product_id)) throw new BadRequestException('Falta el producto.');
    return this.pedidos.ajustar(almacen.id, body);
  }

  /**
   * `[AB.29]` «Enviar a Compras»: lo que le falta por pedir a la sucursal sale como requisición (una
   * por origen) y le llega a quien tiene la responsabilidad `compras.requisiciones_sucursal`. Mismo
   * permiso y mismo control de alcance que ajustar: quien arma el pedido de su sucursal lo manda.
   */
  @Post('pedido/enviar')
  @RequirePermissions(Permission.AUTOABASTO_SOLICITAR)
  @ApiOperation({ summary: '[AB.29] Mi pedido: mandar a Compras lo que falta por pedir (una requisición por origen, por aprobar)' })
  async enviar(@Body() body: AutoabastoEnviarRequest): Promise<AutoabastoEnviarResponse> {
    const almacen = await this.almacenEnAlcance(body?.warehouse_id);
    return this.pedidos.enviar(almacen, AREA_AUTOABASTO, body);
  }

  /** `[AB.18]` Vuelve el renglón al sugerido. */
  @Post('pedido/restablecer')
  @RequirePermissions(Permission.AUTOABASTO_SOLICITAR)
  @ApiOperation({ summary: 'Mi pedido: volver un renglón al sugerido' })
  async restablecer(@Body() body: AutoabastoRestablecerRequest): Promise<AutoabastoAjusteResponse> {
    const almacen = await this.almacenEnAlcance(body?.warehouse_id);
    if (!body?.product_id || !UUID_RX.test(body.product_id)) throw new BadRequestException('Falta el producto.');
    return this.pedidos.restablecer(almacen.id, body);
  }

  /** `[AB.18]` La persona revisó un grupo y lo acepta como está (huella). */
  @Post('pedido/aceptar-grupo')
  @RequirePermissions(Permission.AUTOABASTO_SOLICITAR)
  @ApiOperation({ summary: 'Mi pedido: aceptar un grupo como está' })
  async aceptarGrupo(@Body() body: AutoabastoAceptarGrupoRequest): Promise<{ ok: true }> {
    const almacen = await this.almacenEnAlcance(body?.warehouse_id);
    return this.pedidos.aceptarGrupo(almacen.id, body);
  }

  /** `[AB.19]` Hasta dónde pide: agotado, bajo mínimo, bajo reorden y/o el resto con venta. */
  @Put('pedido/posiciones')
  @RequirePermissions(Permission.AUTOABASTO_SOLICITAR)
  @ApiOperation({ summary: 'Mi pedido: qué posiciones entran al pedido' })
  async posiciones(@Body() body: AutoabastoPosicionesRequest): Promise<{ posiciones: PosicionPedido[] }> {
    const almacen = await this.almacenEnAlcance(body?.warehouse_id);
    return this.pedidos.guardarPosiciones(almacen.id, body);
  }

  /** `[AB.18]` La persona abrió su pedido (huella). Sólo exige VER. */
  @Post('pedido/abrir')
  @RequirePermissions(Permission.AUTOABASTO_VER)
  @ApiOperation({ summary: 'Mi pedido: huella de apertura' })
  async abrir(@Body() body: AutoabastoAbrirRequest): Promise<{ ok: true }> {
    const almacen = await this.almacenEnAlcance(body?.warehouse_id);
    return this.pedidos.abrir(almacen.id, body);
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
    @Query('accion') accion?: string,
    @Query('search') search?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
    @Req() req?: { user?: { username?: string } },
  ): Promise<AutoabastoReporte> {
    if (!warehouse_id || !UUID_RX.test(warehouse_id)) {
      throw new BadRequestException('El reporte es por almacén: elige uno.');
    }
    // `[AB.36]` Sólo los almacenes: `filters()` entero costaba ~175 ms más de proveedores y marcas.
    const warehouses = await this.svc.almacenes(AREA_AUTOABASTO);
    const almacen = (warehouses as { id: string; code: string; name: string }[]).find((w) => w.id === warehouse_id);
    if (!almacen) throw new ForbiddenException('Ese almacén no está dentro de tu alcance.');

    const ahora = new Date();
    const q = { warehouse_id, supplier_id, bucket, accion, search, sort_by, sort_dir, target_basis: BASE_AUTOABASTO };
    const [mesa, resumen] = await Promise.all([
      this.svc.criticalStock({ ...q, export: true }, AREA_AUTOABASTO),
      // `[AB.14]` El resumen del papel sigue el mismo buscador de producto que la mesa.
      this.svc.summary({ warehouse_id, supplier_id, product_search: search, target_basis: BASE_AUTOABASTO }, AREA_AUTOABASTO),
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
