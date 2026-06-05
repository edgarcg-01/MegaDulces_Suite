import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  LogisticsPayrollService,
  CreatePeriodDto,
  UpdatePeriodDto,
  UpdateLiquidationDto,
  CreateAdjustmentDto,
} from './logistics-payroll.service';

@ApiTags('logistics-payroll')
@Controller('logistics/payroll')
export class LogisticsPayrollController {
  constructor(private readonly service: LogisticsPayrollService) {}

  // ── Periods ──────────────────────────────────────────────────────────────

  @Post('periods')
  @ApiOperation({ summary: 'Crear período (catorcena)' })
  createPeriod(@Body() body: CreatePeriodDto) {
    return this.service.createPeriod(body);
  }

  @Get('periods')
  @ApiOperation({ summary: 'Listar períodos (filtra por year opcional)' })
  listPeriods(@Query('year') year?: string) {
    return this.service.listPeriods(year ? Number(year) : undefined);
  }

  @Get('periods/:id')
  @ApiOperation({ summary: 'Obtener período por id' })
  findPeriod(@Param('id') id: string) {
    return this.service.findPeriod(id);
  }

  @Patch('periods/:id')
  @ApiOperation({ summary: 'Actualizar período (status, fechas, notes)' })
  updatePeriod(@Param('id') id: string, @Body() body: UpdatePeriodDto) {
    return this.service.updatePeriod(id, body);
  }

  @Post('periods/:id/calculate')
  @ApiOperation({ summary: 'Calcular liquidaciones del período (idempotente, respeta bonuses/deductions manuales)' })
  calculate(@Param('id') id: string) {
    return this.service.calculatePeriod(id);
  }

  // ── Liquidations ─────────────────────────────────────────────────────────

  @Get('periods/:id/liquidations')
  @ApiOperation({ summary: 'Listar liquidaciones del período (join con driver name)' })
  listLiquidations(@Param('id') periodId: string) {
    return this.service.listLiquidations(periodId);
  }

  @Patch('liquidations/:id')
  @ApiOperation({ summary: 'Editar liquidación (bonuses/deductions/status). Recalcula net_amount.' })
  updateLiquidation(@Param('id') id: string, @Body() body: UpdateLiquidationDto) {
    return this.service.updateLiquidation(id, body);
  }

  // ── Adjustments (anticipos / préstamos / multas / faltas / bonos) ────────

  @Post('adjustments')
  @ApiOperation({ summary: 'Registrar ajuste de nómina por persona y período. Recomputa la liquidación si existe.' })
  createAdjustment(@Body() body: CreateAdjustmentDto) {
    return this.service.createAdjustment(body);
  }

  @Get('adjustments')
  @ApiOperation({ summary: 'Listar ajustes (filtrá por driver_id y/o period_id)' })
  listAdjustments(
    @Query('driver_id') driver_id?: string,
    @Query('period_id') period_id?: string,
  ) {
    return this.service.listAdjustments({ driver_id, period_id });
  }

  @Delete('adjustments/:id')
  @ApiOperation({ summary: 'Eliminar ajuste. Recomputa la liquidación. Solo si el período no está pagado/cerrado.' })
  deleteAdjustment(@Param('id') id: string) {
    return this.service.deleteAdjustment(id);
  }
}
