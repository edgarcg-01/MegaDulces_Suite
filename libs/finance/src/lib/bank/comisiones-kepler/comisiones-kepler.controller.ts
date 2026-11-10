import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ComisionesKeplerService } from './comisiones-kepler.service';

/**
 * `[CB.62]` Las comisiones de la terminal: de la descarga del banco a Kepler. Por ahora sólo LEE (la propuesta);
 * la escritura llega con su interruptor, su `GRANT` y su ensayo (CB.62.4). Controlador propio para no tocar la
 * firma inyectada de los demás (#414). Permiso: el mismo que ver Bancos.
 */
@ApiTags('finance-bank')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/bank/comisiones-kepler')
export class ComisionesKeplerController {
  constructor(private readonly svc: ComisionesKeplerService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: '[CB.62] Qué comisiones de la descarga del banco irían a Kepler: listas, ya capturadas a mano (no se escriben) y por revisar, con su porqué. Sólo lee.' })
  propuesta(@Query('dias') dias?: string): ReturnType<ComisionesKeplerService['propuesta']> {
    return this.svc.propuesta(dias ? Number(dias) : undefined);
  }
}
