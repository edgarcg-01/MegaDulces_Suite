import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  RolesGuard,
  RequirePermissions,
  RequireAnyPermission,
  Permission,
} from '@megadulces/platform-core';
import {
  FloorStockoutsService,
  ReportarDto,
  ReportarResult,
  StockoutDecision,
  StockoutStatus,
  FaltanteSalida,
  CodigoQueFalla,
  ResumenFaltantes,
  ConsultaResultado,
  DeshacerResult,
  VENTANA_DESHACER_MIN,
} from './floor-stockouts.service';

/**
 * `[FLT.4]` — Lista de faltantes. Dos superficies, dos familias de permisos.
 *
 * ── Quién puede qué, y por qué no es una sola clave ──────────────────────────────────────────
 *  · **Tienda** — `STORE_STOCKOUT_CAPTURAR` reporta · `STORE_STOCKOUT_VER` mira su sucursal.
 *    Se midió antes de repartirlos (mig `20260919150100`): el rol `cajero` **no tiene** el
 *    permiso del verificador, así que derivar de esa sola clave habría dejado sin reportar justo
 *    a quien atiende al cliente que pregunta.
 *  · **Compras** — `COMPRAS_HALLAZGOS_VER` / `_GESTIONAR`, las MISMAS de Hallazgos y Reclamos.
 *    Es la misma persona y la misma bandeja mental; una clave nueva sería una puerta más que
 *    alguien tendría que acordarse de abrir.
 *
 * ── La sucursal viaja explícita, siempre ─────────────────────────────────────────────────────
 * Nunca se deduce del usuario. El kiosco de mostrador corre sin cuenta de persona (mismo caso que
 * el verificador, `[CV.24]`) y la máquina del frente puede no tener sesión de esa tienda.
 *
 * ⚠️ A diferencia de `/api/kp/*`, estas rutas **no** son `@Public()`: acá se ESCRIBE. El kiosco
 * usa una cuenta de dispositivo con `STORE_STOCKOUT_CAPTURAR`, que es el mismo patrón que
 * `HR_ATTENDANCE_CHECAR` resolvió para el checador.
 */
@ApiTags('commercial-floor-stockouts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/floor-stockouts')
export class FloorStockoutsController {
  constructor(private readonly service: FloorStockoutsService) {}

  // ── TIENDA ────────────────────────────────────────────────────────────────────────────────

  @Post()
  @RequirePermissions(Permission.STORE_STOCKOUT_CAPTURAR)
  @ApiOperation({ summary: 'Reportar un faltante de piso (agotado / no se maneja / no está en catálogo / el código no pasó)' })
  reportar(@Body() dto: ReportarDto): Promise<ReportarResult> {
    return this.service.reportar(dto);
  }

  @Patch(':id/deshacer')
  // `[FLT.23]` CAPTURAR y no `COMPRAS_HALLAZGOS_GESTIONAR`: es la contracara de reportar, no una
  // decisión de bandeja. Quien puede anotar tiene que poder desanotar lo que acaba de anotar — si
  // no, el alta automática del verificador es una puerta de un solo sentido desde el mostrador.
  // Los frenos (alcance, sólo `open`, sólo dentro de la ventana) viven en el servicio.
  @RequirePermissions(Permission.STORE_STOCKOUT_CAPTURAR)
  @ApiOperation({
    summary: 'Deshacer un faltante recién anotado (resta un reporte de la semana)',
    description:
      `Sólo dentro de ${VENTANA_DESHACER_MIN} minutos y sólo si sigue en \`open\`. Resta 1 al ` +
      'contador de la semana y recalcula la valoración; si era el único reporte, borra la fila. ' +
      'Un faltante viejo se corrige con `PATCH :id/decision` + `era_error`, del lado de Compras.',
  })
  deshacer(@Param('id') id: string): Promise<DeshacerResult> {
    return this.service.deshacer(id);
  }

  @Get('sucursal/:code/consulta')
  // `[FLT.22]` Es una CONSULTA, no una captura: la abre quien reporta y quien supervisa. Gatearla
  // sólo con VER dejaría a la cajera —que tiene CAPTURAR y no VER, medido— sin poder preguntar si
  // hay existencia, que es justo lo que la trae a esta pantalla.
  @RequireAnyPermission(Permission.STORE_STOCKOUT_VER, Permission.STORE_STOCKOUT_CAPTURAR)
  @ApiOperation({
    summary: '¿Lo tenemos? — resuelve el producto y contesta la existencia ANTES de reportar',
    description:
      'Devuelve `veredicto`: hay_en_tienda (va a piso, se recupera hoy) · sin_existencia (va a ' +
      'Compras) · no_medido (no se pudo leer la existencia; NO es cero).',
  })
  consultar(@Param('code') code: string, @Query('q') q: string): Promise<ConsultaResultado> {
    return this.service.consultar(code, q);
  }

  @Get('sucursal/:code')
  // `anyOf` y no sólo VER: quien captura tiene que poder ver lo que acaba de reportar, o la
  // pantalla le contesta 403 en su propia bandeja. Es la misma corrección que necesitó
  // Caducidades, donde el gate en VER le negaba la pantalla al colaborador que sólo captura.
  @RequireAnyPermission(Permission.STORE_STOCKOUT_VER, Permission.STORE_STOCKOUT_CAPTURAR)
  @ApiOperation({ summary: 'Lo reportado en una sucursal (últimas N semanas)' })
  porSucursal(@Param('code') code: string, @Query('semanas') semanas?: string): Promise<FaltanteSalida[]> {
    return this.service.listarPorSucursal(code, { semanas: semanas ? Number(semanas) : undefined });
  }

  @Get('sucursal/:code/codigos-que-fallan')
  @RequireAnyPermission(Permission.STORE_STOCKOUT_VER, Permission.STORE_STOCKOUT_CAPTURAR)
  @ApiOperation({
    summary: 'Herramienta de caja: los códigos que más fallan al escanear en esta sucursal',
    description:
      'NO es "los productos sin código de barras" — eso son 139 SKUs (1.5% del catálogo) que valen ' +
      '0.01% de la venta y en su mayoría ni son mercancía. Esta lista sale de los escaneos que de ' +
      'verdad fallaron, ordenada por frecuencia real.',
  })
  codigosQueFallan(@Param('code') code: string, @Query('limite') limite?: string): Promise<CodigoQueFalla[]> {
    return this.service.codigosQueFallan(code, limite ? Number(limite) : undefined);
  }

  // ── COMPRAS ───────────────────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_VER)
  @ApiOperation({ summary: 'Bandeja de Compras: faltantes por resolver, ordenados por dinero estimado' })
  bandeja(
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('warehouse_code') warehouseCode?: string,
    @Query('limite') limite?: string,
  ): Promise<FaltanteSalida[]> {
    return this.service.bandeja({
      status, kind, warehouse_code: warehouseCode,
      limite: limite ? Number(limite) : undefined,
    });
  }

  @Get('resumen')
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_VER)
  @ApiOperation({ summary: 'KPIs de la bandeja (lo no valorado se cuenta aparte, nunca como $0)' })
  resumen(): Promise<ResumenFaltantes> {
    return this.service.resumen();
  }

  @Patch(':id/decision')
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_GESTIONAR)
  @ApiOperation({
    summary: 'Decidir un faltante — es lo que regresa a la sucursal',
    description:
      'alta_catalogo · ya_en_camino · no_se_trabaja (exige motivo escrito) · codigo_corregido · era_error.',
  })
  decidir(@Param('id') id: string, @Body() dto: { decision: StockoutDecision; nota?: string }): Promise<{ id: string; status: StockoutStatus; decision: StockoutDecision }> {
    return this.service.decidir(id, dto);
  }
}
