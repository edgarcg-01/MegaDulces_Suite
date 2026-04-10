import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CreateDailyCaptureDto } from './dto/create-daily-capture.dto';
import { CloudinaryService } from '../../shared/cloudinary/cloudinary.service';

@Injectable()
export class DailyCapturesService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async create(
    dto: CreateDailyCaptureDto,
    userId: string,
    username: string,
    zona: string,
  ) {
    // Procesar fotos Base64 subiéndolas a Cloudinary y guardando URL + Public ID
    const processedExhibiciones = await Promise.all(
      dto.exhibiciones.map(async (ex) => {
        if (ex.fotoBase64) {
          try {
            const cloudinaryResult =
              await this.cloudinaryService.uploadImageBase64(
                ex.fotoBase64,
                `daily-captures/${dto.folio}`,
              );

            ex.fotoUrl = cloudinaryResult.secure_url;
            ex.fotoPublicId = cloudinaryResult.public_id;
          } catch (error) {
            console.error(
              `Error uploading exhibition photo to Cloudinary for folio ${dto.folio}:`,
              error,
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

    const [dailyCapture] = await this.knex('daily_captures')
      .insert({
        folio: dto.folio,
        user_id: userId,
        captured_by_username: username,
        zona_captura: zona || 'No Asignada',
        fecha: dto.fechaCaptura,
        hora_inicio: dto.horaInicio,
        hora_fin: dto.horaFin,
        exhibiciones: JSON.stringify(processedExhibiciones),
        stats: JSON.stringify(dto.stats),
        latitud: Number(dto.latitud),
        longitud: Number(dto.longitud),
      })
      .returning('*');

    return dailyCapture;
  }

  async findAll(
    fecha?: string,
    zona?: string,
    ejecutivo?: string,
    userId?: string,
  ) {
    const query = this.knex('daily_captures').select('*');
    if (fecha) query.where({ fecha });
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
}
