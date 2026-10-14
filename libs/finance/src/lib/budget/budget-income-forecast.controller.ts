import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { IncomeForecastResponse } from '@megadulces/contracts';
import { BudgetIncomeForecastService } from './budget-income-forecast.service';

/**
 * `[PU.13]` El estimado de ingresos por día. Controlador propio y no un endpoint más en
 * `BudgetComparisonController`: aquel lo editan varias sesiones a la vez y esto no comparte nada
 * con él. Sólo lectura con `PRESUPUESTOS_VER` → sin permiso nuevo y sin re-login.
 */
@ApiTags('finance-budget')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget')
export class BudgetIncomeForecastController {
  constructor(private readonly svc: BudgetIncomeForecastService) {}

  @Get('income-forecast')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({
    summary:
      'Estimado de ingresos por día (bancos y caja general) de la versión vigente, con lo real al lado ' +
      '(cobranza del módulo de Bancos, leída en el momento). Lo real va en null después del último día cargado.',
  })
  vigente(): Promise<IncomeForecastResponse> {
    return this.svc.vigente();
  }
}
