import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CajaControlService } from './caja-control.service';

/**
 * `[CG.105]` — Expediente diario e historial de cortes de Caja General.
 *
 * Lectura pura. **Sin `GESTIONAR` ni endpoints de escritura a propósito**: lo que se ve acá lo
 * captura Control, y corregirlo se corrige allá (mismo criterio que ADR-040 con ContPAQi). Una
 * pantalla que deja editar el espejo fabrica una segunda verdad.
 */
@ApiTags('finance-caja-control')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/caja-control')
export class CajaControlController {
  constructor(private readonly svc: CajaControlService) {}

  @Get('cortes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Historial de cortes diarios de Caja General (Control)' })
  cortes(@Query('desde') desde?: string, @Query('hasta') hasta?: string, @Query('limit') limit?: string) {
    return this.svc.cortes({ desde, hasta, limit: limit ? Number(limit) : undefined });
  }

  /**
   * ⚠️ La fecha va en la RUTA y no en query: es el identificador del expediente, no un filtro.
   * `YYYY-MM-DD`; cualquier otra cosa la rechaza Postgres al comparar contra una columna `date`,
   * que es el único lugar donde el formato se puede juzgar de verdad.
   */
  @Get('expediente/:fecha')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Expediente de un día: cada movimiento con su ticket por denominación' })
  expediente(@Param('fecha') fecha: string) {
    return this.svc.expediente(fecha);
  }
}
