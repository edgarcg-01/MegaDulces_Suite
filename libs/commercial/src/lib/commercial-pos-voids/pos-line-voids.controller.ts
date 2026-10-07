import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  RolesGuard,
  RequirePermissions,
  RequireAnyPermission,
  Permission,
} from '@megadulces/platform-core';
import {
  PosLineVoidsService,
  RegistrarVoidDto,
  RegistrarVoidResult,
  VoidSalida,
  ResumenSupervisor,
} from './pos-line-voids.service';

/**
 * `[BP.4]` — Bitácora de retiros en caja.
 *
 * ── Quién puede qué ──────────────────────────────────────────────────────────────────────────
 *  · `STORE_POS_VOID_CAPTURAR` — registra. Deriva de `STORE_LIVE_VER` (supervisión de tienda),
 *    **no** del arqueo: lo que se registra es una autorización y la firma es de quien la dio.
 *    Por eso `cajero` queda fuera, al revés que en la Lista de faltantes.
 *  · `STORE_POS_VOID_VER` — mira la bitácora. Deriva de `STORE_LIVE_VER` **o**
 *    `RECONCILIATION_VER`, para que prevención de pérdidas —consumidor natural de una señal
 *    antifraude— no quede fuera.
 *
 * ── La sucursal viaja explícita, y el alcance se verifica ────────────────────────────────────
 * Nunca se deduce del usuario. Y el servicio llama a `ScopeService.assertCanRead('warehouse', …)`
 * en las tres operaciones: el permiso dice «puede abrir la pantalla», el alcance dice «sobre
 * qué filas» (ADR-050). El módulo hermano ya pagó ese defecto — aceptaba cualquier código en la
 * ruta y alguien de una plaza podía leer otra.
 */
@ApiTags('commercial-pos-line-voids')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/pos-line-voids')
export class PosLineVoidsController {
  constructor(private readonly service: PosLineVoidsService) {}

  @Post()
  @RequirePermissions(Permission.STORE_POS_VOID_CAPTURAR)
  @ApiOperation({
    summary: 'Registrar un retiro autorizado de producto del ticket',
    description:
      'Lo captura quien AUTORIZÓ. `est_value` puede venir NULL con `est_source=sin_dato` — y ' +
      '`est_motivo` dice por qué (unidad que no es pieza, producto sin resolver, o sin precio de ' +
      'etiqueta). Nunca $0: un cero dibujado se lee como "no vale nada".',
  })
  registrar(@Body() dto: RegistrarVoidDto): Promise<RegistrarVoidResult> {
    return this.service.registrar(dto);
  }

  @Get('sucursal/:code')
  // La bitácora es CONSULTA. Se abre con VER, y también con CAPTURAR: quien registra tiene que
  // poder ver lo que registró. Misma lección que obligó a corregir Caducidades y Faltantes,
  // donde gatear sólo con VER dejaba sin pantalla a quien únicamente captura.
  @RequireAnyPermission(Permission.STORE_POS_VOID_VER, Permission.STORE_POS_VOID_CAPTURAR)
  @ApiOperation({ summary: 'Retiros registrados en una sucursal' })
  listar(
    @Param('code') code: string,
    @Query('dias') dias?: string,
    @Query('limite') limite?: string,
  ): Promise<VoidSalida[]> {
    return this.service.listar(code, Number(dias) || 30, Number(limite) || 200);
  }

  @Get('sucursal/:code/por-supervisor')
  // Sólo VER: es el ángulo de auditoría, no la pantalla de captura.
  @RequirePermissions(Permission.STORE_POS_VOID_VER)
  @ApiOperation({
    summary: 'Cuánto autoriza cada supervisor',
    description:
      '`valor_total` suma SÓLO lo valorado y `eventos_sin_valorar` dice cuántos quedaron fuera. ' +
      'Leer la suma sin ese acompañante afirma algo distinto de lo que el dato sostiene.',
  })
  porSupervisor(@Param('code') code: string, @Query('dias') dias?: string): Promise<ResumenSupervisor[]> {
    return this.service.resumenPorSupervisor(code, Number(dias) || 30);
  }
}
