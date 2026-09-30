import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  RolesGuard,
  RequirePermissions,
  RequireAnyPermission,
  Permission,
} from '@megadulces/platform-core';
import {
  PromoSelloutService,
  ResultadoCanal,
  ResumenAcuerdo,
  CoberturaCodigos,
  Conciliacion,
} from './promo-sellout.service';

/**
 * `[MKT.6]` — Resultado de la activación. **Sólo lectura, y sin claves nuevas.**
 *
 * ── Por qué NO estrena permisos ──────────────────────────────────────────────────────────────
 * Esto no es un módulo nuevo: es la otra mitad de la pregunta que `[MKT.1]` ya abrió. Quien
 * puede ver un acuerdo tiene que poder ver si sirvió; inventar un `*_SELLOUT_VER` sería una
 * puerta más que alguien tendría que acordarse de abrir, y la lección de `[LC.6.2]` es
 * justamente que una clave nueva sin repartir deja el módulo invisible en producción.
 *
 *   · `MKT_AGREEMENTS_VER` — Mercadotecnia, que ve todos los canales.
 *   · `MKT_AGREEMENT_EVIDENCE_SUBIR` — la plaza. Entra SÓLO a `/sucursal/:code`, y lo que ve ahí
 *     lo recorta su alcance (ADR-050), no el permiso. Quien sube la foto tiene derecho a saber
 *     si su exhibición vendió; lo que no ve por esta vía es la bandeja completa.
 *
 * ⚠️ `monto_negociado` viaja en la respuesta de la bandeja y del acuerdo — es dinero pactado con
 * el proveedor. Por eso esas dos rutas exigen `MKT_AGREEMENTS_VER` a secas y no aceptan la clave
 * de evidencia, que en `[MKT.1]` existe precisamente para quien NO debe ver el monto.
 */
@ApiTags('mkt-promo-sellout')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/promo-sellout')
export class PromoSelloutController {
  constructor(private readonly service: PromoSelloutService) {}

  @Get()
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({
    summary: 'Resultado de cada canal: venta en la vigencia contra la línea base',
    description:
      'Ordenado por uplift descendente, con lo no medible AL FINAL. `medicion` declara los ' +
      'cuatro casos (medida / sin_baseline / sin_venta / sin_alcance): "no se puede medir" y ' +
      '"vendió cero" no son lo mismo.',
  })
  listar(
    @Query('folio') folio?: string,
    @Query('medicion') medicion?: string,
    @Query('limite') limite?: string,
  ): Promise<ResultadoCanal[]> {
    return this.service.listar({ folio, medicion, limite: limite ? Number(limite) : undefined });
  }

  @Get('acuerdo/:id')
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({
    summary: 'Los canales de un acuerdo + su rollup',
    description:
      'El rollup agrega SÓLO los canales medidos y cuenta el resto por motivo. Sumar los no ' +
      'medidos como cero haría que un acuerdo a medio capturar se lea como un fracaso comercial.',
  })
  porAcuerdo(@Param('id') id: string): Promise<{ resumen: ResumenAcuerdo; canales: ResultadoCanal[] }> {
    return this.service.porAcuerdo(id);
  }

  @Get('acuerdo/:id/cobertura')
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({
    summary: 'Diagnóstico: cuántos códigos están ligados al catálogo y cuántos podrían ligarse',
    description:
      'Un `sin_alcance` sin explicación es inútil. Esto dice si el arreglo está a un clic ' +
      '(el SKU existe idéntico) o si de verdad no hay producto. NO liga nada: escribir ' +
      '`product_id` es del flujo de captura del acuerdo.',
  })
  cobertura(@Param('id') id: string): Promise<CoberturaCodigos> {
    return this.service.coberturaDeCodigos(id);
  }

  @Get('acuerdo/:id/conciliacion')
  @RequirePermissions(Permission.MKT_AGREEMENTS_VER)
  @ApiOperation({
    summary: 'Lo negociado contra lo que el proveedor de verdad acreditó (notas de crédito del ERP)',
    description:
      'Lee `analytics.erp_purchase_adjustments` (X-D-40 / X-D-55). Declara `fuente_vacia` si el ' +
      'espejo no tiene filas — no reporta $0 acreditado — y declara en `metodo` si la liga con ' +
      'el proveedor fue por código o por nombre (heurística).',
  })
  conciliacion(@Param('id') id: string): Promise<Conciliacion> {
    return this.service.conciliacion(id);
  }

  @Get('sucursal/:code')
  // `anyOf`: quien sube la evidencia de su plaza tiene derecho a ver si sirvió. El recorte de
  // QUÉ plazas ve no lo hace el permiso — lo hace el alcance, dentro del servicio.
  @RequireAnyPermission(Permission.MKT_AGREEMENTS_VER, Permission.MKT_AGREEMENT_EVIDENCE_SUBIR)
  @ApiOperation({ summary: 'El resultado de las activaciones de UNA plaza' })
  porSucursal(@Param('code') code: string): Promise<ResultadoCanal[]> {
    return this.service.porSucursal(code);
  }
}
