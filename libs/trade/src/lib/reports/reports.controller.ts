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
import { RoutePingsBatchDto } from './dto/route-pings.dto';
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

  @Get('routes/:routeId/track')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary:
      'Traza GPS (breadcrumbs) por vendedor de una ruta + última posición — para el recorrido en el mapa',
  })
  getRouteTrack(
    @ReqUser() user: any,
    @Param('routeId') routeId: string,
    @Query() filters: ReportsFilterDto,
  ) {
    return this.reportsService.getRouteTrack(routeId, filters, user);
  }

  @Get('routes/:routeId/snapped')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary:
      'Recorrido "por calles" (map-matching) + paradas por vendedor de una ruta en un día — historial',
  })
  getRouteSnapped(
    @ReqUser() user: any,
    @Param('routeId') routeId: string,
    @Query('date') date?: string,
  ) {
    return this.reportsService.getRouteSnapped(routeId, date, user);
  }

  @Get('field-users')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Vendedores con actividad GPS en un día (picker del historial)' })
  getFieldUsers(@ReqUser() user: any, @Query('date') date?: string) {
    return this.reportsService.getFieldUsers(date, user);
  }

  @Get('stores-geo')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Tiendas geolocalizadas (capa de contexto del Mapa en Vivo)' })
  getStoresGeo(@ReqUser() user: any) {
    return this.reportsService.getStoresGeo(user);
  }

  @Get('team-day')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({ summary: 'Resumen del equipo hoy: por vendedor (km, visitas detectadas, sin captura, estado)' })
  getTeamDay(@ReqUser() user: any, @Query('date') date?: string) {
    return this.reportsService.getTeamDay(date, user);
  }

  // ETA y optimización: utilidades de campo (solo auth, las usa la app del
  // vendedor que no tiene RUTAS_VER) — no exponen datos de otros tenants.
  @Get('eta')
  @ApiOperation({ summary: 'ETA con tráfico entre dos coords (Mapbox Directions)' })
  getEta(
    @Query('from_lat') fromLat: string,
    @Query('from_lng') fromLng: string,
    @Query('to_lat') toLat: string,
    @Query('to_lng') toLng: string,
  ) {
    return this.reportsService.getEta(+fromLat, +fromLng, +toLat, +toLng);
  }

  @Post('optimize-stops')
  @ApiOperation({ summary: 'Orden óptimo de visita (Mapbox Optimization, ≤12 paradas)' })
  optimizeStops(@Body() body: { stops: { lat: number; lng: number }[] }) {
    return this.reportsService.optimizeRoute(body?.stops || []);
  }

  @Get('geocode')
  @ApiOperation({ summary: 'Geocoding directo: texto → coordenadas (Mapbox, sesgo MX/La Piedad)' })
  geocode(@Query('q') q: string) {
    return this.reportsService.geocode(q);
  }

  @Get('reverse-geocode')
  @ApiOperation({ summary: 'Geocoding inverso: coordenada → dirección legible (Mapbox)' })
  reverseGeocode(@Query('lat') lat: string, @Query('lng') lng: string) {
    return this.reportsService.reverseGeocode(+lat, +lng);
  }

  @Get('vendor-day')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary: 'Día de un vendedor: recorrido por calles + paradas + KPIs (historial)',
  })
  getVendorDay(
    @ReqUser() user: any,
    @Query('user_id') userId: string,
    @Query('date') date?: string,
  ) {
    return this.reportsService.getVendorDay(userId, date, user);
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

  @Get('live-positions')
  @RequirePermissions(Permission.RUTAS_VER)
  @ApiOperation({
    summary:
      'Última posición por usuario de campo del tenant en una ventana reciente (seed del mapa en vivo)',
  })
  getLivePositions(@ReqUser() user: any, @Query('since_min') sinceMin?: string) {
    return this.reportsService.getLivePositions(user, {
      sinceMin: sinceMin ? Number(sinceMin) : undefined,
    });
  }

  @Post('route-pings')
  // Solo requiere autenticación: cubre a CUALQUIER rol de campo (colaborador con
  // VISITAS_REGISTRAR y vendedor con CAPTURE_TICKET_USE) sin churn de permisos.
  // Telemetría self-scoped: tenant_id/user_id salen del JWT (no del body), así
  // que un usuario solo puede insertar SUS propios pings. Las lecturas
  // (/routes/:id/idle, /idle/summary) siguen gateadas por RUTAS_VER.
  @ApiOperation({
    summary:
      'Ingesta bulk de breadcrumbs GPS del usuario de campo (idempotente por client_uuid) — Fase 2 tiempos muertos',
  })
  ingestRoutePings(@ReqUser() user: any, @Body() batch: RoutePingsBatchDto) {
    return this.reportsService.ingestRoutePings(batch, user);
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
