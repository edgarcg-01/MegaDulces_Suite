import { Controller, Get, UseGuards, Res, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { ReqUser } from '../../shared/decorators/req-user.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Genera un payload con el KPI global de toda la plataforma',
  })
  getSummary(@ReqUser() user: any) {
    return this.reportsService.getSummary(user);
  }

  @Get('data')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Obtiene datos filtrados y agregados para el dashboard',
  })
  getData(
    @ReqUser() user: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('userId') userId?: string,
    @Query('userIds') userIds?: string[],
    @Query('zone') zone?: string,
    @Query('supervisorId') supervisorId?: string,
  ) {
    console.log('[ReportsController] GET /reports/data', {
      startDate,
      endDate,
      userId,
      userIds,
      zone,
      supervisorId,
    });
    return this.reportsService.getFilteredData(
      { startDate, endDate, userId, userIds, zone, supervisorId },
      user,
    );
  }

  @Get('export')
  @RequirePermissions(Permission.REPORTES_EXPORTAR)
  @ApiOperation({
    summary: 'Descarga el histórico en un formato CSV ultra-ligero con filtros',
  })
  async exportCsv(
    @ReqUser() user: any,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('userId') userId?: string,
    @Query('userIds') userIds?: string[],
    @Query('zone') zone?: string,
    @Query('supervisorId') supervisorId?: string,
  ) {
    const csvBuffer = await this.reportsService.exportCsvInBuffer(
      { startDate, endDate, userId, userIds, zone, supervisorId },
      user,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="reporte_ejecutivos_trade.csv"',
    );

    // Disparar
    res.send(csvBuffer);
  }
}
