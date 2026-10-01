import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { InventoryVarianceService, ActorExpediente } from './inventory-variance.service';
import { InventoryCountPlanService } from './inventory-count-plan.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

/**
 * [IC.0] Diferencias del conteo físico de Kepler.
 *
 * Gate `COMMERCIAL_INVENTORY_VER`: es lectura, y ese permiso **ya está repartido** a 10 roles
 * y 29 usuarios activos (compras, dirección, encargado de tienda, prevención, supervisor…).
 * Crear un permiso nuevo habría repetido el error de [LC.6.2] — una clave declarada en el
 * enum que nadie tiene, o sea un módulo en prod que no puede abrir ni una persona.
 */
@ApiTags('commercial-inventory-variance')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/variance')
export class InventoryVarianceController {
  constructor(
    private readonly service: InventoryVarianceService,
    private readonly plan: InventoryCountPlanService,
  ) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Descuadre por evento de conteo (almacén × fecha). '
      + 'Excluye cargas iniciales salvo ?include_initial_load=true — una migración de ERP no es un descuadre.',
  })
  summary(
    @Query('warehouse_id') warehouseId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('include_initial_load') includeInitialLoad?: string,
  ) {
    return this.service.summary({
      warehouse_id: warehouseId,
      date_from: dateFrom,
      date_to: dateTo,
      include_initial_load: includeInitialLoad === 'true',
    });
  }

  @Get('events')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Almacenes y fechas con conteo — para poblar filtros sin adivinar' })
  events() {
    return this.service.events();
  }

  @Get('coverage')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Cobertura del conteo: cuántos SKUs con existencia quedaron SIN contar. '
      + 'Sin esto el tablero miente por omisión.',
  })
  coverage(
    @Query('warehouse_id') warehouseId: string,
    @Query('fecha') fecha: string,
  ) {
    return this.service.coverage({ warehouse_id: warehouseId, fecha });
  }

  // ── [IC.8] El KPI de la fase ─────────────────────────────────────────────────────────
  @Get('kpi')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: '¿Sirvió? Descuadre por trimestre como % del valor contado, sin cargas '
      + 'iniciales. Devuelve `comparable: false` cuando los períodos no tienen los mismos '
      + 'almacenes — comparar ahí mentiría.',
  })
  kpi(@Query('warehouse_id') warehouseId?: string) {
    return this.service.kpi({ warehouse_id: warehouseId });
  }

  // ── [IC.5] El plan del mes ───────────────────────────────────────────────────────────
  @Get('plan')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary: 'Qué contar este mes: la ola rotativa (un tercio del catálogo) + el top. '
      + 'La ola sale del mes salvo que se pase ?ola=1|2|3.',
  })
  monthlyPlan(
    @Query('warehouse_id') warehouseId: string,
    @Query('ola') ola?: string,
    @Query('top_n') topN?: string,
    @Query('limit') limit?: string,
  ) {
    return this.plan.monthlyPlan({
      warehouse_id: warehouseId,
      ola: ola ? Number(ola) : undefined,
      top_n: topN ? Number(topN) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('plan/coverage')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({
    summary: 'Las 3 olas, ¿cubren TODO el catálogo? Si una quedara vacía, un tercio no se '
      + 'contaría nunca y cada mes el plan se vería normal.',
  })
  waveCoverage(@Query('warehouse_id') warehouseId: string) {
    return this.plan.waveCoverage(warehouseId);
  }

  @Get('detail')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Detalle SKU por SKU de un evento — la lista accionable' })
  detail(
    @Query('warehouse_id') warehouseId: string,
    @Query('fecha') fecha: string,
    @Query('signo') signo?: 'sobrante' | 'faltante',
    @Query('explicacion') explicacion?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.detail({
      warehouse_id: warehouseId,
      fecha,
      signo,
      explicacion,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── [EXP.2] El expediente del renglón ───────────────────────────────────────────────
  @Get('expediente')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Todo lo que la plataforma sabe de UN renglón del descuadre, en un solo viaje: '
      + 'las líneas del ajuste, la trayectoria del SKU entre conteos, la conciliación de cada '
      + 'período, los movimientos documento a documento, las órdenes de entrada, la existencia '
      + 'de hoy y el expediente de Prevención. ⛔ Cada sección DECLARA su permiso cuando está '
      + 'oculta: un panel a medias se lee como «no hay nada que ver».',
  })
  expediente(
    @Query('warehouse_id') warehouseId: string,
    @Query('sku') sku: string,
    @Query('fecha') fecha: string,
    // ⚠️ `req.user.permissions` lo repone FRESCO `RolesGuard` en cada request (no es el
    // snapshot del JWT). El god-mode lo resuelve el servicio con los roles de DB.
    @Req() req: { user?: ActorExpediente },
  ) {
    return this.service.expediente(
      { warehouse_id: warehouseId, sku, fecha }, req?.user);
  }

  // ── [EXP.1b] El embudo: cuánto del descuadre cae en cada explicación ─────────────────
  @Get('embudo')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Cuánto del descuadre explica cada causa, por evento. Es lo que convierte la '
      + 'pantalla en una decisión: medido en sep-2026, de $8.86M brutos la pila sin_explicacion '
      + 'son 818 SKUs y $248,436. ⛔ no_medido NO es "sin causa": es que falta un testigo, y se '
      + 'cuenta aparte. Agrega sobre el NETO por SKU, no sobre el bruto por línea.',
  })
  embudo(
    @Query('warehouse_id') warehouseId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
  ) {
    return this.service.embudo({
      warehouse_id: warehouseId,
      date_from: dateFrom,
      date_to: dateTo,
    });
  }

  // ── [IC.3b] La vista de IC.3 llevaba en prod sin un solo consumidor ──────────────────
  @Get('reincidencia')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Qué SKU descuadra una y otra vez, separando el que SE COMPENSA (error de '
      + 'captura o unidad) del que RETIENE el faltante (merma). Ordena por lo que queda, '
      + 'no por lo que se movió. Los SKUs con menos de 2 conteos se declaran en sin_base.',
  })
  reincidencia(
    @Query('warehouse_id') warehouseId?: string,
    @Query('patron') patron?: string,
    @Query('sku') sku?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.reincidencia({
      warehouse_id: warehouseId,
      patron,
      sku,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ── [IC.11] Conciliación entre dos conteos: a dónde se fue la mercancía ──────────────
  @Get('rollforward/periodos')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Los períodos conciliables (dos conteos consecutivos del mismo almacén), y los '
      + 'almacenes que NO tienen par con su motivo — uno que desaparece del selector se lee '
      + 'como que no tiene problema.',
  })
  rollforwardPeriodos() {
    return this.service.rollforwardPeriodos();
  }

  @Get('rollforward')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({
    summary: 'Conciliación de un período: contado inicial + compras + recibido − vendido − '
      + 'enviado = esperado, contra lo contado al final. Lo que los movimientos NO explican es '
      + 'la merma real. Los totales son del PERÍODO, no de la página.',
  })
  rollforward(
    @Query('warehouse_id') warehouseId: string,
    @Query('desde') desde: string,
    @Query('hasta') hasta: string,
    @Query('veredicto') veredicto?: string,
    @Query('sku') sku?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.rollforward({
      warehouse_id: warehouseId,
      desde,
      hasta,
      veredicto,
      sku,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
