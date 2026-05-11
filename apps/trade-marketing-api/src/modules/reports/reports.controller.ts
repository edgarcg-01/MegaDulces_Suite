import { Controller, Get, UseGuards, Res, Query, Delete, Param } from '@nestjs/common';
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
  getSummary(
    @ReqUser() user: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('zone') zone?: string,
    @Query('supervisorId') supervisorId?: string,
    @Query('userIds') userIds?: string[],
  ) {
    return this.reportsService.getSummary({ startDate, endDate, zone, supervisorId, userIds }, user);
  }

  @Get('daily-compliance')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Obtiene métricas de cumplimiento diario filtradas por fecha',
  })
  getDailyCompliance(
    @ReqUser() user: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('zone') zone?: string,
    @Query('supervisorId') supervisorId?: string,
    @Query('userIds') userIds?: string[],
  ) {
    return this.reportsService.getDailyCompliance(
      { startDate, endDate, zone, supervisorId, userIds },
      user,
    );
  }

  @Get('daily-scores/per-user')
  @RequirePermissions(Permission.VER_SEGUIMIENTO)
  @ApiOperation({
    summary: 'Obtiene puntuaciones diarias por usuario para el módulo de Seguimiento',
  })
  getDailyScoresPerUser(
    @ReqUser() user: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('zone') zone?: string,
    @Query('supervisorId') supervisorId?: string,
    @Query('userIds') userIds?: string[],
  ) {
    return this.reportsService.getDailyScoresPerUser(
      { startDate, endDate, zone, supervisorId, userIds },
      user,
    );
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

  @Get('stores')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Obtiene métricas por tienda para el tab de Tiendas',
  })
  getStoresData(
    @ReqUser() user: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('storeId') storeId?: string,
    @Query('zone') zone?: string,
  ) {
    return this.reportsService.getStoresData(
      { startDate, endDate, storeId, zone },
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

  @Delete(':id')
  @RequirePermissions(Permission.REPORTES_GESTIONAR)
  @ApiOperation({
    summary: 'Elimina un reporte (captura diaria) permanentemente',
  })
  deleteReport(@Param('id') id: string, @ReqUser() user: any) {
    return this.reportsService.deleteReport(id, user);
  }
}
