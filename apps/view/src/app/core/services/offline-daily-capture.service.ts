import { Injectable, inject } from '@angular/core';
import { OfflineDatabaseService } from './offline-database.service';
import { GeoValidationService } from './geo-validation.service';
import { OfflineSyncService } from './offline-sync.service';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class OfflineDailyCaptureService {
  private db = inject(OfflineDatabaseService);
  private geoValidation = inject(GeoValidationService);
  private syncService = inject(OfflineSyncService);
  private auth = inject(AuthService);

  /**
   * Valida ubicación para iniciar visita offline
   * Retorna la ubicación validada o error
   */
  async validarUbicacionParaVisita(tiendaId: string): Promise<{
    exito: boolean;
    mensaje: string;
    ubicacion?: {
      lat: number;
      lng: number;
      precision: number;
    };
    distancia?: number;
  }> {
    try {
      // Verificar que tenemos la tienda en catálogo offline
      const tienda = await this.db.getTiendaById(tiendaId);
      if (!tienda) {
        return {
          exito: false,
          mensaje: 'Tienda no encontrada en catálogo offline. Sincronice datos primero.'
        };
      }

      // Obtener ubicación con validación
      const ubicacion = await this.geoValidation.obtenerUbicacionConFallback();
      
      // Validar distancia a la tienda
      const validacion = this.geoValidation.validarUbicacion(
        ubicacion,
        { lat: tienda.lat, lng: tienda.lng }
      );

      if (!validacion.valido) {
        return {
          exito: false,
          mensaje: validacion.mensaje
        };
      }

      return {
        exito: true,
        mensaje: `Ubicación válida. ${validacion.mensaje}`,
        ubicacion: {
          lat: ubicacion.lat,
          lng: ubicacion.lng,
          precision: ubicacion.precision
        },
        distancia: validacion.distancia
      };

    } catch (error) {
      console.error('[OfflineDailyCapture] Error validando ubicación:', error);
      return {
        exito: false,
        mensaje: `Error: ${(error as Error).message}`
      };
    }
  }

  /**
   * Guarda la captura completa offline
   * Recibe los datos de la visita como parámetros para evitar dependencia circular
   */
  async guardarCapturaOffline(
    tiendaId: string,
    userId: string,
    datosVisita: {
      horaInicio: string;
      horaFin: string;
      exhibiciones: any[];
      stats: any;
      latitud: number | null;
      longitud: number | null;
      precision?: number;
    }
  ): Promise<{
    exito: boolean;
    mensaje: string;
    visitaId?: string;
  }> {
    try {
      if (!datosVisita.latitud || !datosVisita.longitud) {
        return {
          exito: false,
          mensaje: 'No se ha capturado la ubicación GPS'
        };
      }

      const ubicacion = {
        lat: datosVisita.latitud,
        lng: datosVisita.longitud,
        precision: datosVisita.precision || 20
      };

      const datos = {
        horaInicio: datosVisita.horaInicio,
        horaFin: datosVisita.horaFin,
        exhibiciones: datosVisita.exhibiciones,
        stats: datosVisita.stats
      };

      // Guardar usando el servicio de sincronización
      const visitaId = await this.syncService.guardarVisitaOffline(
        tiendaId,
        userId,
        datos,
        ubicacion
      );

      return {
        exito: true,
        mensaje: 'Visita guardada exitosamente. Se sincronizará cuando haya conexión.',
        visitaId
      };

    } catch (error) {
      console.error('[OfflineDailyCapture] Error guardando captura offline:', error);
      return {
        exito: false,
        mensaje: `Error guardando visita: ${(error as Error).message}`
      };
    }
  }

  /**
   * Carga catálogos para uso offline
   */
  async sincronizarCatalogosOffline(): Promise<{
    exito: boolean;
    mensaje: string;
    catalogosActualizados?: string[];
  }> {
    try {
      const estado = this.syncService.getEstadoActual();
      
      if (!estado.online) {
        return {
          exito: false,
          mensaje: 'Se requiere conexión a internet para sincronizar catálogos'
        };
      }

      // Forzar sincronización (esto incluye catálogos)
      await this.syncService.forzarSincronizacion();

      const catalogos = await this.db.getCatalogos();
      const catalogosActualizados = catalogos.map(c => c.tipo);

      return {
        exito: true,
        mensaje: `Catálogos actualizados: ${catalogosActualizados.join(', ')}`,
        catalogosActualizados
      };

    } catch (error) {
      console.error('[OfflineDailyCapture] Error sincronizando catálogos:', error);
      return {
        exito: false,
        mensaje: `Error sincronizando catálogos: ${(error as Error).message}`
      };
    }
  }

  /**
   * Obtiene tiendas disponibles offline
   */
  async getTiendasOffline(): Promise<any[]> {
    try {
      const tiendas = await this.db.getTiendas();
      return tiendas.map(tienda => ({
        id: tienda.id,
        nombre: tienda.nombre,
        direccion: tienda.direccion,
        zona: tienda.zona,
        ultima_sincronizacion: tienda.ultima_sincronizacion,
        disponible: true
      }));
    } catch (error) {
      console.error('[OfflineDailyCapture] Error obteniendo tiendas offline:', error);
      return [];
    }
  }

  /**
   * Verifica el estado offline del sistema
   */
  async getEstadoOffline(): Promise<{
    online: boolean;
    tiendasDisponibles: number;
    visitasPendientes: number;
    catalogosActualizados: boolean;
    ultimaSincronizacion: string | null;
    gpsDisponible: boolean;
  }> {
    try {
      const [estadoSync, estadisticasDB, tiendas] = await Promise.all([
        this.syncService.getEstadoActual(),
        this.db.getEstadisticasOffline(),
        this.db.getTiendas()
      ]);

      const gpsDisponible = 'geolocation' in navigator;
      const catalogosActualizados = estadisticasDB.catalogosActualizados > 0;

      return {
        online: estadoSync.online,
        tiendasDisponibles: tiendas.length,
        visitasPendientes: estadisticasDB.visitasPendientes,
        catalogosActualizados,
        ultimaSincronizacion: estadisticasDB.ultimoSync,
        gpsDisponible
      };

    } catch (error) {
      console.error('[OfflineDailyCapture] Error obteniendo estado offline:', error);
      return {
        online: navigator.onLine,
        tiendasDisponibles: 0,
        visitasPendientes: 0,
        catalogosActualizados: false,
        ultimaSincronizacion: null,
        gpsDisponible: 'geolocation' in navigator
      };
    }
  }

  /**
   * Obtiene estadísticas detalladas para dashboard offline
   */
  async getEstadisticasOffline(): Promise<any> {
    try {
      const [estadoSync, estadisticasDB, logs] = await Promise.all([
        this.syncService.getEstadoActual(),
        this.db.getEstadisticasOffline(),
        this.db.getSyncLogs(10)
      ]);

      return {
        conexion: {
          online: estadoSync.online,
          sincronizando: estadoSync.sincronizando,
          ultimaSincronizacion: estadoSync.ultimoSync
        },
        datos: {
          tiendasOffline: estadisticasDB.tiendasOffline,
          visitasPendientes: estadisticasDB.visitasPendientes,
          catalogosActualizados: estadisticasDB.catalogosActualizados
        },
        actividadReciente: logs.map(log => ({
          tipo: log.tipo,
          estado: log.estado,
          mensaje: log.mensaje,
          fecha: log.fecha
        }))
      };

    } catch (error) {
      console.error('[OfflineDailyCapture] Error obteniendo estadísticas:', error);
      return null;
    }
  }

  /**
   * Fuerza una sincronización manual
   */
  async forzarSincronizacionManual(): Promise<{
    exito: boolean;
    mensaje: string;
    resultado?: any;
  }> {
    try {
      const resultado = await this.syncService.forzarSincronizacion();
      
      return {
        exito: true,
        mensaje: `Sincronización completada: ${resultado.exitosas} exitosas, ${resultado.fallidas} fallidas`,
        resultado
      };

    } catch (error) {
      console.error('[OfflineDailyCapture] Error en sincronización manual:', error);
      return {
        exito: false,
        mensaje: `Error en sincronización: ${(error as Error).message}`
      };
    }
  }

  /**
   * Limpia datos antiguos offline
   */
  async limpiarDatosOffline(): Promise<{
    exito: boolean;
    mensaje: string;
  }> {
    try {
      await this.db.limpiarDatosAntiguos();
      
      return {
        exito: true,
        mensaje: 'Datos antiguos limpiados exitosamente'
      };

    } catch (error) {
      console.error('[OfflineDailyCapture] Error limpiando datos:', error);
      return {
        exito: false,
        mensaje: `Error limpiando datos: ${(error as Error).message}`
      };
    }
  }
}
