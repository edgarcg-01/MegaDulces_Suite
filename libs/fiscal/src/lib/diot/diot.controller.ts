import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { DiotService } from './diot.service';

/** FISCAL.8.1 — API DIOT + resumen de IVA (IVA efectivamente pagado). */
@ApiTags('fiscal-diot')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/diot')
export class DiotController {
  constructor(private readonly svc: DiotService) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_DIOT_VER)
  @ApiOperation({ summary: 'DIOT del periodo (YYYY-MM): un renglón por proveedor con IVA pagado.' })
  build(@Query('period') period: string) { return this.svc.build(period); }

  @Get('iva')
  @RequirePermissions(Permission.FISCAL_DIOT_VER)
  @ApiOperation({ summary: 'Resumen de IVA del periodo: acreditable vs trasladado → a cargo/favor.' })
  iva(@Query('period') period: string) { return this.svc.ivaResumen(period); }
}
