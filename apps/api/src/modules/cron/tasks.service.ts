import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CloudinaryService } from '../../shared/cloudinary/cloudinary.service';

// Interfaz para tipar el JSON parseado y evitar el error 'never'
interface ExhibicionDiaria {
  fotoPublicId?: string;
  [key: string]: any;
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  // Método faltante agregado para el controlador
  async manualCleanup() {
    this.logger.log('Ejecución manual de limpieza iniciada.');
    await this.cleanOldCaptures();
  }

  // Se ejecuta todos los días a las 2:00 AM
  @Cron('0 2 * * *')
  async cleanOldCaptures() {
    // Paréntesis de cierre restaurado aquí
    this.logger.log(
      'Iniciando limpieza de registros con una antigüedad mayor a 30 días...',
    );

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    // 1. Limpiar Exhibitions Photos (y cascada)
    const oldPhotos = await this.knex('exhibition_photos')
      .where('created_at', '<', cutoffDate)
      .select('id', 'photo_public_id');

    for (const photo of oldPhotos) {
      if (photo.photo_public_id) {
        try {
          await this.cloudinaryService.deleteImage(photo.photo_public_id);
          this.logger.log(
            `Cloudinary public_id: ${photo.photo_public_id} borrado permanentemente.`,
          );
        } catch (err) {
          this.logger.error(
            `Omitiendo error de borrado por Cloudinary publicId: ${photo.photo_public_id}`,
          );
        }
      }
    }

    // Al borrar la foto de BD, se quita la tupla, o si borramos de 'visits' vuela en cascada
    if (oldPhotos.length > 0) {
      const ids = oldPhotos.map((p) => p.id);
      await this.knex('exhibition_photos').whereIn('id', ids).delete();
      this.logger.log(
        `Registros de fotos en exhibition_photos limpiados: ${ids.length}`,
      );
    }

    // 2. Limpiar Daily Captures (JSONB)
    const oldDailyCaptures = await this.knex('daily_captures')
      .where('created_at', '<', cutoffDate)
      .select('id', 'exhibiciones');

    for (const dc of oldDailyCaptures) {
      if (dc.exhibiciones) {
        // Tipado explícito aplicado aquí
        let exhibiciones: ExhibicionDiaria[] = [];
        try {
          exhibiciones =
            typeof dc.exhibiciones === 'string'
              ? JSON.parse(dc.exhibiciones)
              : dc.exhibiciones;
        } catch (e) {}

        for (const ex of exhibiciones) {
          if (ex.fotoPublicId) {
            try {
              await this.cloudinaryService.deleteImage(ex.fotoPublicId);
              this.logger.log(
                `Cloudinary public_id: ${ex.fotoPublicId} borrado.`,
              );
            } catch (err) {
              this.logger.error(
                `Error de Cloudinary al borrar daily capture img: ${ex.fotoPublicId}`,
              );
            }
          }
        }
      }
    }

    if (oldDailyCaptures.length > 0) {
      const ids = oldDailyCaptures.map((dc) => dc.id);
      await this.knex('daily_captures').whereIn('id', ids).delete();
      this.logger.log(
        `Fueron purgadas ${ids.length} capturas diarias muy antiguas.`,
      );
    }

    this.logger.log('Limpieza 30-días finalizada.');
  }
}
