import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CreateDailyCaptureDto } from './dto/create-daily-capture.dto';
import { CloudinaryService } from '../../shared/cloudinary/cloudinary.service';
import { ScoringV2Service } from '../scoring/scoring-v2.service';

@Injectable()
export class DailyCapturesService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly cloudinaryService: CloudinaryService,
    private readonly scoringV2Service: ScoringV2Service,
  ) {}

  async create(
    dto: CreateDailyCaptureDto,
    userId: string,
    username: string,
    zona: string,
  ) {
    console.log('[DailyCapturesService] 📥 Recibiendo datos del frontend:');
    console.log('  - folio:', dto.folio);
    console.log('  - userId:', userId);
    console.log('  - username:', username);
    console.log('  - zona:', zona);
    console.log('  - GPS recibido:', { latitud: dto.latitud, longitud: dto.longitud });
    console.log('  - stats:', dto.stats);
    console.log('  - exhibiciones count:', dto.exhibiciones?.length);

    // Validar coordenadas GPS
    const latitud = Number(dto.latitud);
    const longitud = Number(dto.longitud);
    if (!latitud || !longitud || latitud === 0 || longitud === 0) {
      console.warn('[DailyCapturesService] ⚠️ GPS inválido o no proporcionado:', { latitud, longitud });
    } else {
      console.log('[DailyCapturesService] ✅ GPS válido recibido:', { latitud, longitud });
    }

    // Procesar fotos Base64 subiéndolas a Cloudinary y guardando URL + Public ID
    console.log('[DailyCapturesService] 📸 Procesando fotos de exhibiciones...');
    let fotosSubidas = 0;
    let fotosFallidas = 0;

    const processedExhibiciones = await Promise.all(
      dto.exhibiciones.map(async (ex, index) => {
        if (ex.fotoBase64) {
          console.log(`[DailyCapturesService] 📤 Subiendo foto ${index + 1} a Cloudinary...`);
          try {
            const cloudinaryResult =
              await this.cloudinaryService.uploadImageBase64(
                ex.fotoBase64,
                `daily-captures/${dto.folio}`,
              );

            ex.fotoUrl = cloudinaryResult.secure_url;
            ex.fotoPublicId = cloudinaryResult.public_id;
            fotosSubidas++;
            console.log(`[DailyCapturesService] ✅ Foto ${index + 1} subida exitosamente:`, cloudinaryResult.secure_url);
          } catch (error) {
            fotosFallidas++;
            console.error(
              `[DailyCapturesService] ❌ Error subiendo foto ${index + 1} a Cloudinary:`,
              error.message || error
            );
            // En caso de error, dejar sin foto pero continuar el proceso
            ex.fotoUrl = null;
            ex.fotoPublicId = null;
          }
          // Remove heavy payload before persisting
          delete ex.fotoBase64;
        }
        return ex;
      }),
    );

    console.log(`[DailyCapturesService] 📊 Resumen de fotos: ${fotosSubidas} subidas, ${fotosFallidas} fallidas`);

    console.log('[DailyCapturesService] 💾 Insertando en daily_captures...');
    console.log('  - stats a insertar:', dto.stats);
    console.log('  - coordenadas a guardar:', { latitud, longitud });

    // Consultar score_maximo dinámico desde scoring_config_versions (para meta local opcional)
    const activeVersion = await this.scoringV2Service.getActiveVersion();
    const configVersionId = activeVersion?.id;
    
    // Recalcular los puntos puros con el Backend Engine y no de la app móvil
    let puntosBackendTotales = dto.stats.puntuacionTotal || 0;
    
    if (configVersionId && processedExhibiciones.length > 0) {
       try {
         const scoringDto = {
           config_version_id: configVersionId,
           exhibiciones: processedExhibiciones.map(ex => ({
             posicion_id: ex.ubicacionId,
             exhibicion_id: ex.conceptoId,
             nivel_ejecucion_id: ex.nivelEjecucionId || ex.nivel_ejecucion_id, // Asegurar mapeo según Frontend
           }))
         };
         
         const backendScore = await this.scoringV2Service.calculateVisitScore(scoringDto as any);
         puntosBackendTotales = backendScore.puntos_obtenidos;
         console.log('[DailyCapturesService] 🧮 Puntos recalculados por Backend Engine:', puntosBackendTotales);
       } catch (error) {
         console.warn('[DailyCapturesService] ⚠️ Fallo al recalcular scores, se usará valor del frontend. Error:', error.message);
       }
    }

    // Normalizar ventaTotal: si es 0 o menor que ventaAdicional, usar ventaAdicional
    const ventaAdicional = dto.stats.ventaAdicional || 0;
    const ventaTotalActual = dto.stats.ventaTotal || 0;
    const ventaTotalFinal = ventaTotalActual > 0 ? ventaTotalActual : ventaAdicional;

    // Agregar puntosTotales recalibrados
    const statsWithPct = {
      ...dto.stats,
      ventaTotal: ventaTotalFinal,
      puntuacionTotal: puntosBackendTotales,
      // Se eliminan campos legacy % obsoletos
    };

    console.log('[DailyCapturesService] 💾 Stats normalizados a insertar:', {
      ventaTotalRecibido: ventaTotalActual,
      ventaAdicional: ventaAdicional,
      ventaTotalFinal,
    });

    // Extraer fecha de hora_inicio o usar fecha actual
    const fecha = dto.horaInicio
      ? new Date(dto.horaInicio).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    const [dailyCapture] = await this.knex('daily_captures')
      .insert({
        folio: dto.folio,
        user_id: userId,
        captured_by_username: username,
        zona_captura: zona || 'No Asignada',
        fecha: fecha,
        hora_inicio: dto.horaInicio,
        hora_fin: dto.horaFin,
        exhibiciones: JSON.stringify(processedExhibiciones),
        stats: JSON.stringify(statsWithPct),
        latitud: latitud || 0,
        longitud: longitud || 0,
        store_id: dto.store_id || null,
      })
      .returning('*');

    console.log('[DailyCapturesService] ✅ Insert exitoso. Datos guardados:');
    console.log('  - id:', dailyCapture.id);
    console.log('  - folio:', dailyCapture.folio);
    console.log('  - GPS guardado:', { latitud: dailyCapture.latitud, longitud: dailyCapture.longitud });
    console.log('  - fecha/hora:', { fecha: dailyCapture.fecha, hora_inicio: dailyCapture.hora_inicio });
    console.log('  - stats:', dailyCapture.stats);

    return dailyCapture;
  }

  async findAll(
    fecha?: string,
    zona?: string,
    ejecutivo?: string,
    userId?: string,
  ) {
    const query = this.knex('daily_captures').select('*');
    if (fecha) {
      // Usar hora_inicio en lugar de fecha para evitar problemas de timezone
      query.whereRaw("DATE(hora_inicio) = ?", [fecha]);
    }
    if (zona) query.where({ zona_captura: zona });
    if (ejecutivo) query.where({ captured_by_username: ejecutivo });
    if (userId) query.where({ user_id: userId });

    query.orderBy('created_at', 'desc');
    return query;
  }

  async findOne(id: string) {
    const dailyCapture = await this.knex('daily_captures').where({ id }).first();
    if (!dailyCapture) {
      // Intentar por folio
      const fallback = await this.knex('daily_captures').where({ folio: id }).first();
      if (fallback) return fallback;

      throw new NotFoundException(
        `Validación fallida: Captura con identificador ${id} no encontrada`,
      );
    }
    return dailyCapture;
  }

  async cleanup() {
    const count = await this.knex('daily_captures').delete();
    return { message: `Eliminados ${count} registros de visitas` };
  }
}
