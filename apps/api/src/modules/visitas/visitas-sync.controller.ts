import { Controller, Post, Body, Get, Query, Param, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { VisitasSyncService, VisitaSyncDto } from './visitas-sync.service';

@Controller('visitas')
export class VisitasSyncController {
  private readonly logger = new Logger(VisitasSyncController.name);

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
      this.logger.error('Error en sincronización:: ' + (error as Error).message);
      
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
      this.logger.error('Error obteniendo estadísticas:: ' + (error as Error).message);
      
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
      this.logger.error('Error obteniendo visitas con fraude:: ' + (error as Error).message);
      
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
      this.logger.error('Error marcando visita como revisada:: ' + (error as Error).message);
      
      return {
        success: false,
        error: error.message
      };
    }
  }
}
