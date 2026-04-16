import { Controller, Post, Body, Get, Query, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { VisitasSyncService, VisitaSyncDto } from './visitas-sync.service';

@Controller('visitas')
export class VisitasSyncController {
  constructor(private readonly visitasSyncService: VisitasSyncService) {}

  /**
   * Endpoint principal para sincronización de visitas desde clientes offline
   */
  @Post('sincronizar')
  @HttpCode(HttpStatus.OK)
  async sincronizarVisita(@Body() visitaDto: VisitaSyncDto) {
    try {
      const resultado = await this.visitasSyncService.sincronizarVisita(visitaDto);
      
      return {
        success: true,
        data: resultado,
        message: resultado.mensaje
      };
    } catch (error) {
      console.error('[VisitasSyncController] Error en sincronización:', error);
      
      return {
        success: false,
        error: error.message,
        message: 'Error al sincronizar visita'
      };
    }
  }

  /**
   * Obtiene estadísticas de sincronización para dashboard administrativo
   */
  @Get('estadisticas-sincronizacion')
  async getEstadisticasSincronizacion(
    @Query('fecha_inicio') fechaInicio?: string,
    @Query('fecha_fin') fechaFin?: string,
    @Query('user_id') userId?: string
  ) {
    try {
      const estadisticas = await this.visitasSyncService.getEstadisticasSincronizacion({
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin,
        user_id: userId
      });

      return {
        success: true,
        data: estadisticas
      };
    } catch (error) {
      console.error('[VisitasSyncController] Error obteniendo estadísticas:', error);
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Obtiene visitas con posible fraude para revisión de auditoría
   */
  @Get('con-fraude')
  async getVisitasConFraude(@Query('limit') limit?: string) {
    try {
      const limite = limit ? parseInt(limit) : 50;
      const visitas = await this.visitasSyncService.getVisitasConFraude(limite);

      return {
        success: true,
        data: visitas,
        count: visitas.length
      };
    } catch (error) {
      console.error('[VisitasSyncController] Error obteniendo visitas con fraude:', error);
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Marca una visita como revisada (endpoint para auditoría)
   */
  @Post(':id/marcar-revisada')
  @HttpCode(HttpStatus.OK)
  async marcarVisitaRevisada(
    @Param('id') visitaId: string,
    @Body() body: { notas_auditor?: string }
  ) {
    try {
      await this.visitasSyncService.marcarVisitaRevisada(visitaId, body.notas_auditor);

      return {
        success: true,
        message: 'Visita marcada como revisada exitosamente'
      };
    } catch (error) {
      console.error('[VisitasSyncController] Error marcando visita como revisada:', error);
      
      return {
        success: false,
        error: error.message
      };
    }
  }
}
