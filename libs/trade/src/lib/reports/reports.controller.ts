import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ReportsService } from './reports.service';
import { PdfService } from './pdf.service';
import { BrandPresenceReportService } from './brand-presence-report.service';
import { RequireAuthGuard } from '@megadulces/platform-core';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { ReqUser } from '@megadulces/platform-core';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  BrandPresenceFilterDto,
  ExportPdfDto,
  ReportsDataFilterDto,
  ReportsFilterDto,
  ReportsStoresFilterDto,
} from './dto/reports-filter.dto';
import { getDataScope } from '@megadulces/platform-core';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('reports')
export class ReportsController {
  private readonly logger = new Logger(ReportsController.name);

  constructor(
    private readonly reportsService: ReportsService,
    private readonly pdfService: PdfService,
    private readonly brandPresenceReport: BrandPresenceReportService,
  ) {}

  @Get('summary')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Genera un payload con el KPI global de toda la plataforma',
  })
  getSummary(@ReqUser() user: any, @Query() filters: ReportsFilterDto) {
    return this.reportsService.getSummary(filters, user);
  }

  @Get('daily-compliance')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Obtiene métricas de cumplimiento diario filtradas por fecha',
  })
  getDailyCompliance(@ReqUser() user: any, @Query() filters: ReportsFilterDto) {
    return this.reportsService.getDailyCompliance(filters, user);
  }

  @Get('daily-scores/per-user')
  @RequirePermissions(Permission.VER_SEGUIMIENTO)
  @ApiOperation({
    summary: 'Obtiene puntuaciones diarias por usuario para el módulo de Seguimiento',
  })
  async getDailyScoresPerUser(
    @ReqUser() user: any,
    @Query() filters: ReportsFilterDto,
  ) {
    try {
      return await this.reportsService.getDailyScoresPerUser(filters, user);
    } catch (error) {
      this.logger.error(`getDailyScoresPerUser error: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('data')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Obtiene datos filtrados y agregados para el dashboard',
  })
  getData(@ReqUser() user: any, @Query() filters: ReportsDataFilterDto) {
    // El service aún recibe page/pageSize como string en su contrato actual.
    // Convertimos a string aquí para no tocar reports.service en este pase.
    return this.reportsService.getFilteredData(
      {
        ...filters,
        page: filters.page != null ? String(filters.page) : undefined,
        pageSize: filters.pageSize != null ? String(filters.pageSize) : undefined,
      },
      user,
    );
  }

  @Get('routes')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({ summary: 'Obtiene métricas agregadas por ruta' })
  getRoutesData(@ReqUser() user: any, @Query() filters: ReportsFilterDto) {
    return this.reportsService.getRoutesData(filters, user);
  }

  @Get('stores')
  @RequirePermissions(Permission.REPORTES_VER_PROPIO)
  @ApiOperation({
    summary: 'Obtiene métricas por tienda para el tab de Tiendas',
  })
  getStoresData(@ReqUser() user: any, @Query() filters: ReportsStoresFilterDto) {
    return this.reportsService.getStoresData(filters, user);
  }

  // ── Apartado "Rutas" (análisis: tiendas por ruta, tiempos, trazabilidad) ──
  @Get('routes/:routeId/visits')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary:
      'Visitas de una ruta (tienda, hora_inicio/fin, duración min, GPS, score) ordenadas por hora — tiempos + trazabilidad',
  })
  getRouteVisits(
    @ReqUser() user: any,
    @Param('routeId') routeId: string,
    @Query() filters: ReportsFilterDto,
  ) {
    return this.reportsService.getRouteVisits(routeId, filters, user);
  }

  @Get('routes/:routeId/stores')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary:
      'Tiendas asignadas a una ruta (stores.ruta_id) con coords + flag visited (cobertura)',
  })
  getRouteStores(
    @ReqUser() user: any,
    @Param('routeId') routeId: string,
    @Query() filters: ReportsFilterDto,
  ) {
    return this.reportsService.getRouteStores(routeId, filters, user);
  }

  @Get('routes/:routeId/idle')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary:
      'Tiempos muertos de una ruta: gaps entre visitas consecutivas del mismo vendedor (gap − traslado estimado) + totales',
  })
  getRouteIdle(
    @ReqUser() user: any,
    @Param('routeId') routeId: string,
    @Query() filters: ReportsFilterDto,
  ) {
    return this.reportsService.getRouteIdle(routeId, filters, user);
  }

  @Get('idle/summary')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary:
      'Resumen de tiempos muertos agregado por vendedor sobre un rango (todas las rutas del scope) — para dashboard',
  })
  getIdleSummary(@ReqUser() user: any, @Query() filters: ReportsFilterDto) {
    return this.reportsService.getIdleSummary(filters, user);
  }

  @Get('export')
  @RequirePermissions(Permission.REPORTES_EXPORTAR)
  @ApiOperation({
    summary: 'Descarga el histórico en un formato CSV ultra-ligero con filtros',
  })
  async exportCsv(
    @ReqUser() user: any,
    @Res() res: Response,
    @Query() filters: ReportsDataFilterDto,
  ) {
    const csvBuffer = await this.reportsService.exportCsvInBuffer(
      filters,
      user,
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="reporte_ejecutivos_trade.csv"',
    );

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

  @Post('export-pdf')
  @RequirePermissions(Permission.REPORTES_EXPORTAR)
  @ApiOperation({
    summary: 'Genera un PDF del reporte usando Puppeteer',
  })
  async exportPdf(
    @ReqUser() user: any,
    @Body() datos: ExportPdfDto,
    @Res() res: Response,
  ) {
    // Verificar ownership: si el body trae userId distinto al solicitante,
    // solo permitir si el usuario tiene scope global.
    if (datos.userId && datos.userId !== user.sub) {
      const scope = getDataScope(user);
      if (scope.type !== 'all') {
        throw new ForbiddenException(
          'No puedes exportar reportes de otro usuario.',
        );
      }
    }

    try {
      const buffer = await this.pdfService.generarReporte(datos);

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename=reporte-mercadeo.pdf',
        'Content-Length': buffer.length,
      });

      res.end(buffer);
    } catch (error) {
      this.logger.error(`exportPdf error: ${error.message}`, error.stack);
      res.status(500).json({
        error: 'Error generando PDF',
        message: error.message,
      });
    }
  }

  @Post('brand-presence/pdf')
  @RequirePermissions(Permission.REPORTES_EXPORTAR)
  @ApiOperation({
    summary: 'Genera el reporte de Presencia de Marca (PDF Tier-1)',
  })
  async exportBrandPresencePdf(
    @ReqUser() user: any,
    @Body() filters: BrandPresenceFilterDto,
    @Res() res: Response,
  ) {
    try {
      const { buffer, filename } = await this.brandPresenceReport.generatePdf(filters, user);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
    } catch (error: any) {
      this.logger.error(`exportBrandPresencePdf error: ${error.message}`, error.stack);
      res.status(500).json({
        error: 'Error generando el reporte de presencia de marca',
        message: error.message,
      });
    }
  }
}
