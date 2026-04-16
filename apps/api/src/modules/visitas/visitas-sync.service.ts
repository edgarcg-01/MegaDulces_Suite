import { Injectable, Inject, BadRequestException, ConflictException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

export interface VisitaSyncDto {
  id: string; // UUID v4 para idempotencia
  tienda_id: string;
  user_id: string;
  fecha: string;
  hora_inicio: string;
  hora_fin: string;
  latitud: number;
  longitud: number;
  precision_gps: number;
  exhibiciones: any[];
  stats: any;
  flag_fraude?: boolean;
  fecha_creacion: string;
  intentos_sincronizacion: number;
}

export interface GeoValidationBackend {
  distancia_tienda: number; // metros
  coordenadas_tienda: { lat: number; lng: number };
  flag_fraude_backend: boolean;
  confianza_ubicacion: 'alta' | 'media' | 'baja';
}

@Injectable()
export class VisitasSyncService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /**
   * Sincroniza una visita desde el cliente con idempotencia
   */
  async sincronizarVisita(visitaDto: VisitaSyncDto): Promise<{
    id: string;
    folio: string;
    estado: 'creada' | 'duplicada';
    validacion_geolocalizacion: GeoValidationBackend;
    mensaje: string;
  }> {
    try {
      // 1. Verificar idempotencia por UUID
      const visitaExistente = await this.knex('daily_captures')
        .where({ sync_uuid: visitaDto.id })
        .first();

      if (visitaExistente) {
        console.log(`[VisitasSync] Visita duplicada detectada: ${visitaDto.id}`);
        return {
          id: visitaExistente.id,
          folio: visitaExistente.folio,
          estado: 'duplicada',
          validacion_geolocalizacion: await this.validarGeolocalizacion(visitaDto),
          mensaje: 'Visita ya registrada previamente'
        };
      }

      // 2. Validar geolocalización en backend
      const validacionGeo = await this.validarGeolocalizacion(visitaDto);

      // 3. Validar que la tienda exista
      const tienda = await this.knex('tiendas')
        .where({ id: visitaDto.tienda_id })
        .first();

      if (!tienda) {
        throw new BadRequestException('Tienda no encontrada');
      }

      // 4. Validar que el usuario exista
      const usuario = await this.knex('users')
        .where({ id: visitaDto.user_id })
        .first();

      if (!usuario) {
        throw new BadRequestException('Usuario no encontrado');
      }

      // 5. Generar folio único
      const folio = await this.generarFolioUnico(usuario.username);

      // 6. Insertar visita con todas las validaciones
      const [nuevaVisita] = await this.knex('daily_captures')
        .insert({
          folio,
          user_id: visitaDto.user_id,
          tienda_id: visitaDto.tienda_id,
          fecha: visitaDto.fecha,
          hora_inicio: visitaDto.hora_inicio,
          hora_fin: visitaDto.hora_fin,
          latitud: visitaDto.latitud,
          longitud: visitaDto.longitud,
          precision_gps: visitaDto.precision_gps,
          exhibiciones: JSON.stringify(visitaDto.exhibiciones),
          stats: JSON.stringify(visitaDto.stats),
          sync_uuid: visitaDto.id, // UUID para idempotencia
          flag_fraude_frontend: visitaDto.flag_fraude || false,
          flag_fraude_backend: validacionGeo.flag_fraude_backend,
          distancia_tienda: validacionGeo.distancia_tienda,
          confianza_ubicacion: validacionGeo.confianza_ubicacion,
          intentos_sincronizacion: visitaDto.intentos_sincronizacion,
          fecha_creacion_dispositivo: visitaDto.fecha_creacion,
          fecha_sincronizacion: this.knex.fn.now(),
          created_at: this.knex.fn.now(),
          updated_at: this.knex.fn.now()
        })
        .returning('*');

      // 7. Log de sincronización
      await this.registrarLogSincronizacion({
        visita_id: nuevaVisita.id,
        sync_uuid: visitaDto.id,
        user_id: visitaDto.user_id,
        estado: 'exitoso',
        detalles: {
          intentos: visitaDto.intentos_sincronizacion,
          validacion_geo: validacionGeo,
          folio_generado: folio
        }
      });

      console.log(`[VisitasSync] Visita sincronizada exitosamente: ${nuevaVisita.id} (${folio})`);

      return {
        id: nuevaVisita.id,
        folio: nuevaVisita.folio,
        estado: 'creada',
        validacion_geolocalizacion: validacionGeo,
        mensaje: 'Visita registrada exitosamente'
      };

    } catch (error) {
      // Registrar log de error
      await this.registrarLogSincronizacion({
        visita_id: null,
        sync_uuid: visitaDto.id,
        user_id: visitaDto.user_id,
        estado: 'error',
        detalles: {
          error: error.message,
          intentos: visitaDto.intentos_sincronizacion
        }
      });

      throw error;
    }
  }

  /**
   * Valida la geolocalización en el backend para prevenir fraudes
   */
  private async validarGeolocalizacion(visitaDto: VisitaSyncDto): Promise<GeoValidationBackend> {
    try {
      // Obtener coordenadas reales de la tienda
      const tienda = await this.knex('tiendas')
        .where({ id: visitaDto.tienda_id })
        .first();

      if (!tienda || !tienda.latitud || !tienda.longitud) {
        return {
          distancia_tienda: 0,
          coordenadas_tienda: { lat: 0, lng: 0 },
          flag_fraude_backend: true,
          confianza_ubicacion: 'baja'
        };
      }

      // Calcular distancia usando Haversine
      const distancia = this.calcularDistanciaHaversine(
        { lat: visitaDto.latitud, lng: visitaDto.longitud },
        { lat: tienda.latitud, lng: tienda.longitud }
      );

      // Determinar nivel de confianza basado en precisión GPS
      let confianza: 'alta' | 'media' | 'baja';
      if (visitaDto.precision_gps <= 10) {
        confianza = 'alta';
      } else if (visitaDto.precision_gps <= 30) {
        confianza = 'media';
      } else {
        confianza = 'baja';
      }

      // Detectar posibles fraudes
      const UMBRAL_DISTANCIA_METROS = 100;
      const flagFraude = distancia > UMBRAL_DISTANCIA_METROS || confianza === 'baja';

      return {
        distancia_tienda: Math.round(distancia),
        coordenadas_tienda: { lat: tienda.latitud, lng: tienda.longitud },
        flag_fraude_backend: flagFraude,
        confianza_ubicacion: confianza
      };

    } catch (error) {
      console.error('[VisitasSync] Error validando geolocalización:', error);
      return {
        distancia_tienda: 0,
        coordenadas_tienda: { lat: 0, lng: 0 },
        flag_fraude_backend: true,
        confianza_ubicacion: 'baja'
      };
    }
  }

  /**
   * Calcula distancia entre dos puntos usando fórmula de Haversine
   */
  private calcularDistanciaHaversine(punto1: { lat: number; lng: number }, punto2: { lat: number; lng: number }): number {
    const R = 6371e3; // Radio de la Tierra en metros
    const φ1 = this.toRadians(punto1.lat);
    const φ2 = this.toRadians(punto2.lat);
    const Δφ = this.toRadians(punto2.lat - punto1.lat);
    const Δλ = this.toRadians(punto2.lng - punto1.lng);

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c; // Distancia en metros
  }

  /**
   * Genera folio único basado en username y timestamp
   */
  private async generarFolioUnico(username: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0].substring(8, 14);
    const baseFolio = `${username.charAt(0).toUpperCase()}-${timestamp}`;
    
    // Verificar si ya existe y agregar sufijo si es necesario
    let folio = baseFolio;
    let contador = 1;
    
    while (await this.knex('daily_captures').where({ folio }).first()) {
      folio = `${baseFolio}-${contador}`;
      contador++;
    }
    
    return folio;
  }

  /**
   * Registra log de sincronización para auditoría
   */
  private async registrarLogSincronizacion(log: {
    visita_id: string | null;
    sync_uuid: string;
    user_id: string;
    estado: 'exitoso' | 'error' | 'duplicado';
    detalles: any;
  }): Promise<void> {
    try {
      await this.knex('sync_logs').insert({
        visita_id: log.visita_id,
        sync_uuid: log.sync_uuid,
        user_id: log.user_id,
        estado: log.estado,
        detalles: JSON.stringify(log.detalles),
        fecha: this.knex.fn.now()
      });
    } catch (error) {
      console.error('[VisitasSync] Error registrando log de sincronización:', error);
      // No lanzar error para no interrumpir el flujo principal
    }
  }

  /**
   * Obtiene estadísticas de sincronización
   */
  async getEstadisticasSincronizacion(filtros?: {
    fecha_inicio?: string;
    fecha_fin?: string;
    user_id?: string;
  }): Promise<{
    total_visitas: number;
    visitas_sincronizadas: number;
    visitas_con_fraude: number;
    distancia_promedio: number;
    precision_promedio: number;
    errores_sincronizacion: number;
  }> {
    let query = this.knex('daily_captures');

    if (filtros) {
      if (filtros.fecha_inicio) {
        query = query.where('fecha', '>=', filtros.fecha_inicio);
      }
      if (filtros.fecha_fin) {
        query = query.where('fecha', '<=', filtros.fecha_fin);
      }
      if (filtros.user_id) {
        query = query.where('user_id', filtros.user_id);
      }
    }

    const estadisticas = await query
      .select(
        this.knex.raw('COUNT(*) as total_visitas'),
        this.knex.raw('COUNT(CASE WHEN sync_uuid IS NOT NULL THEN 1 END) as visitas_sincronizadas'),
        this.knex.raw('COUNT(CASE WHEN flag_fraude_backend = true OR flag_fraude_frontend = true THEN 1 END) as visitas_con_fraude'),
        this.knex.raw('AVG(distancia_tienda) as distancia_promedio'),
        this.knex.raw('AVG(precision_gps) as precision_promedio')
      )
      .first();

    // Contar errores de sincronización
    const erroresQuery = this.knex('sync_logs').where({ estado: 'error' });
    if (filtros?.fecha_inicio) {
      erroresQuery.where('fecha', '>=', filtros.fecha_inicio);
    }
    if (filtros?.fecha_fin) {
      erroresQuery.where('fecha', '<=', filtros.fecha_fin);
    }
    if (filtros?.user_id) {
      erroresQuery.where('user_id', filtros.user_id);
    }

    const erroresCount = await erroresQuery.count().first();

    return {
      total_visitas: parseInt(estadisticas.total_visitas) || 0,
      visitas_sincronizadas: parseInt(estadisticas.visitas_sincronizadas) || 0,
      visitas_con_fraude: parseInt(estadisticas.visitas_con_fraude) || 0,
      distancia_promedio: Math.round(parseFloat(estadisticas.distancia_promedio) || 0),
      precision_promedio: Math.round(parseFloat(estadisticas.precision_promedio) || 0),
      errores_sincronizacion: parseInt((erroresCount?.count ?? '0').toString()) || 0
    };
  }

  /**
   * Obtiene visitas con posible fraude para revisión
   */
  async getVisitasConFraude(limit: number = 50): Promise<any[]> {
    return await this.knex('daily_captures')
      .where('flag_fraude_backend', true)
      .orWhere('flag_fraude_frontend', true)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('*');
  }

  /**
   * Marca una visita como revisada (para auditoría)
   */
  async marcarVisitaRevisada(visitaId: string, notasAuditor?: string): Promise<void> {
    await this.knex('daily_captures')
      .where({ id: visitaId })
      .update({
        flag_revisado_auditoria: true,
        fecha_revision_auditoria: this.knex.fn.now(),
        notas_auditoria: notasAuditor
      });
  }

  /**
   * Utilidad para convertir grados a radianes
   */
  private toRadians(grados: number): number {
    return grados * (Math.PI / 180);
  }
}
