import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ComisionesKeplerService } from './comisiones-kepler.service';
import { ComisionesKeplerEscritorService } from './comisiones-kepler.escritor.service';

/**
 * `[CB.62]` Las comisiones de la terminal: de la descarga del banco a Kepler. Controlador propio para no tocar la
 * firma inyectada de los demás (#414).
 *
 * - **Leer** la propuesta: `FINANCE_BANK_VER`, el mismo que ver Bancos.
 * - **Generar** (`[CB.62.4]`): `FINANCE_BANK_GESTIONAR`, el permiso con el que Bancos ya escribe (subir el estado
 *   de cuenta, conciliar, editar cuentas). ⛔ **No se inventó una clave nueva**: una clave propia habría nacido sin
 *   nadie que la tenga y el módulo se habría desplegado sin producir una sola fila (regla 20). Lo que de verdad
 *   frena esto no es el permiso sino los cinco diales del escritor, que nacen apagados.
 */
@ApiTags('finance-bank')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/bank/comisiones-kepler')
export class ComisionesKeplerController {
  constructor(
    private readonly svc: ComisionesKeplerService,
    private readonly escritor: ComisionesKeplerEscritorService,
  ) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: '[CB.62] Qué comisiones de la descarga del banco irían a Kepler: listas, ya capturadas a mano (no se escriben) y por revisar, con su porqué. Sólo lee.' })
  propuesta(@Query('dias') dias?: string): ReturnType<ComisionesKeplerService['propuesta']> {
    return this.svc.propuesta(dias ? Number(dias) : undefined);
  }

  /**
   * ⛔ El cuerpo NO trae qué escribir: sólo la ventana. El escritor vuelve a leer la propuesta y vuelve a correr
   * los candados. Lo que mandó el navegador puede tener minutos, y en ese rato Finanzas pudo capturar el día.
   */
  @Post('generar')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: '[CB.62.4] Escribe en Kepler los días de comisiones que están listos: solicitud X-A-15, gasto X-A-10 y un pago X-D-26 por cargo. Nace apagado; cada día dice si se escribió o por qué no.' })
  generar(@Body() body?: { dias?: number }): ReturnType<ComisionesKeplerEscritorService['generar']> {
    return this.escritor.generar(body?.dias ? Number(body.dias) : undefined);
  }
}
