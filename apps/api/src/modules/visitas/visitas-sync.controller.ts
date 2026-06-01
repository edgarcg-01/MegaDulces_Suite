import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { VisitasSyncService, VisitaSyncDto } from './visitas-sync.service';

/**
 * Endpoints de sincronización offline de visitas + auditoría.
 *
 * Rutas canónicas en INGLÉS (`/visits-sync/*`). Las antiguas en español
 * (`/visitas/*`) se mantienen como alias por compat con scripts externos /
 * cualquier consumidor no inventariado al momento de la migración.
 *
 * Los handlers reales viven en este archivo en formato EN. La clase
 * `VisitasSyncLegacyController` abajo es un thin proxy que re-rutea los
 * paths viejos al mismo servicio.
 */
@ApiTags('visits-sync')
@Controller('visits-sync')
export class VisitasSyncController {
  private readonly logger = new Logger(VisitasSyncController.name);

  constructor(private readonly visitasSyncService: VisitasSyncService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sincroniza una visita desde un cliente offline' })
  async syncVisit(@Body() visitaDto: VisitaSyncDto) {
    try {
      const resultado = await this.visitasSyncService.sincronizarVisita(visitaDto);
      return { success: true, data: resultado, message: resultado.mensaje };
    } catch (error) {
      this.logger.error('Error en sincronización: ' + (error as Error).message);
      return { success: false, error: error.message, message: 'Error al sincronizar visita' };
    }
  }

  @Get('stats')
  @ApiOperation({ summary: 'Estadísticas de sincronización (admin)' })
  async getStats(
    // English (canonical) — Spanish kept as alias para no romper queries existentes.
    @Query('date_from') dateFromEn?: string,
    @Query('date_to') dateToEn?: string,
    @Query('user_id') userId?: string,
    @Query('fecha_inicio') dateFromEs?: string,
    @Query('fecha_fin') dateToEs?: string,
  ) {
    try {
      const estadisticas = await this.visitasSyncService.getEstadisticasSincronizacion({
        fecha_inicio: dateFromEn ?? dateFromEs,
        fecha_fin: dateToEn ?? dateToEs,
        user_id: userId,
      });
      return { success: true, data: estadisticas };
    } catch (error) {
      this.logger.error('Error obteniendo estadísticas: ' + (error as Error).message);
      return { success: false, error: error.message };
    }
  }

  @Get('flagged')
  @ApiOperation({ summary: 'Visitas con sospecha de fraude para revisión auditoría' })
  async getFlagged(@Query('limit') limit?: string) {
    try {
      const limite = limit ? parseInt(limit) : 50;
      const visitas = await this.visitasSyncService.getVisitasConFraude(limite);
      return { success: true, data: visitas, count: visitas.length };
    } catch (error) {
      this.logger.error('Error obteniendo visitas con fraude: ' + (error as Error).message);
      return { success: false, error: error.message };
    }
  }

  @Post(':id/mark-reviewed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marca una visita como revisada (auditoría)' })
  async markReviewed(
    @Param('id') visitaId: string,
    @Body() body: { auditor_notes?: string; notas_auditor?: string },
  ) {
    try {
      await this.visitasSyncService.marcarVisitaRevisada(
        visitaId,
        body.auditor_notes ?? body.notas_auditor,
      );
      return { success: true, message: 'Visita marcada como revisada exitosamente' };
    } catch (error) {
      this.logger.error('Error marcando visita como revisada: ' + (error as Error).message);
      return { success: false, error: error.message };
    }
  }
}

/**
 * @deprecated Aliases en español de los endpoints arriba. Mantenidos por
 * compatibilidad con scripts externos. Para código nuevo usar `/visits-sync/*`.
 *
 * Estos handlers comparten el mismo `VisitasSyncService` — son thin proxies.
 */
@ApiTags('visitas-sync (deprecated)')
@Controller('visitas')
export class VisitasSyncLegacyController {
  constructor(private readonly canonical: VisitasSyncController) {}

  @Post('sincronizar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[DEPRECATED] usar POST /visits-sync/sync' })
  sincronizar(@Body() visitaDto: VisitaSyncDto) {
    return this.canonical.syncVisit(visitaDto);
  }

  @Get('estadisticas-sincronizacion')
  @ApiOperation({ summary: '[DEPRECATED] usar GET /visits-sync/stats' })
  estadisticas(
    @Query('fecha_inicio') fechaInicio?: string,
    @Query('fecha_fin') fechaFin?: string,
    @Query('user_id') userId?: string,
  ) {
    return this.canonical.getStats(undefined, undefined, userId, fechaInicio, fechaFin);
  }

  @Get('con-fraude')
  @ApiOperation({ summary: '[DEPRECATED] usar GET /visits-sync/flagged' })
  conFraude(@Query('limit') limit?: string) {
    return this.canonical.getFlagged(limit);
  }

  @Post(':id/marcar-revisada')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[DEPRECATED] usar POST /visits-sync/:id/mark-reviewed' })
  marcarRevisada(
    @Param('id') visitaId: string,
    @Body() body: { notas_auditor?: string },
  ) {
    return this.canonical.markReviewed(visitaId, { notas_auditor: body.notas_auditor });
  }
}
