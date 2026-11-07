import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { KeplerDelVale } from '@megadulces/contracts';

import { AutorizacionKeplerLecturaService } from './autorizacion-kepler-lectura.service';

/**
 * `[PGP.79]` La solicitud de Kepler de los vales que la pantalla de Aprobación ya tiene en lista.
 * Ruta base propia (no `finance/expenses/proofs/...`): ahí `GET :id` se comería «kepler».
 * Mismo permiso que la pantalla: `FINANCE_EXPENSES_COMPROBAR`.
 */
@ApiTags('finance-expense-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/kepler-autorizacion')
export class AutorizacionKeplerController {
  constructor(private readonly lectura: AutorizacionKeplerLecturaService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[PGP.79] Por vale (ids separados por coma, hasta 200): la solicitud XA1501 de Kepler, su estado hoy (null = no medido) y qué hizo la Suite al firmar (escrito / ya_estaba / no_escrito).' })
  porVales(@Query('ids') ids?: string): Promise<Record<string, KeplerDelVale>> {
    return this.lectura.porVales(String(ids ?? '').split(','));
  }
}
