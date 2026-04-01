import { Controller, Get, UseGuards, Res, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  @Roles('superadmin', 'reportes')
  @ApiOperation({ summary: 'Genera un payload con el KPI global de toda la plataforma' })
  getSummary() {
    return this.reportsService.getSummary();
  }

  @Get('data')
  @Roles('superadmin', 'reportes')
  @ApiOperation({ summary: 'Obtiene datos filtrados y agregados para el dashboard' })
  getData(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('userId') userId?: string,
    @Query('zone') zone?: string,
  ) {
    return this.reportsService.getFilteredData({ startDate, endDate, userId, zone });
  }

  @Get('export')
  @Roles('superadmin', 'reportes')
  @ApiOperation({ summary: 'Descarga el histórico en un formato CSV ultra-ligero con filtros' })
  async exportCsv(
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('userId') userId?: string,
    @Query('zone') zone?: string,
  ) {
    const csvBuffer = await this.reportsService.exportCsvInBuffer({ startDate, endDate, userId, zone });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="reporte_ejecutivos_trade.csv"');
    
    // Disparar
    res.send(csvBuffer);
  }
}
