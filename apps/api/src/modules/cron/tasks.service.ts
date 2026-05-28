import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CloudinaryService } from '../../shared/cloudinary/cloudinary.service';

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

  async manualCleanup() {
    this.logger.log('Ejecución manual de limpieza de imágenes antiguas iniciada.');
    await this.cleanOldPhotos();
  }

  @Cron('0 2 * * *')
  async cleanOldPhotos() {
    this.logger.log(
      'Iniciando limpieza de Cloudinary imágenes huérfanas (>30 días)...',
    );

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    // 1. Borrar fotos huérfanas de exhibition_photos (>30 días)
    const oldPhotos = await this.knex('exhibition_photos')
      .where('created_at', '<', cutoffDate)
      .select('id', 'photo_public_id');

    const photoIds: string[] = [];
    for (const photo of oldPhotos) {
      if (photo.photo_public_id) {
        try {
          await this.cloudinaryService.deleteImage(photo.photo_public_id);
          this.logger.log(`Cloudinary public_id: ${photo.photo_public_id} borrado.`);
          photoIds.push(photo.id);
        } catch (err) {
          this.logger.error(`Error Cloudinary: ${photo.photo_public_id}`);
        }
      }
    }

    if (photoIds.length > 0) {
      await this.knex('exhibition_photos').whereIn('id', photoIds).delete();
      this.logger.log(`exhibition_photos limpiados: ${photoIds.length}`);
    }

    // 2. Borrar fotos Cloudinary de daily_captures antiguas, SIN borrar el registro
    const oldDailyCaptures = await this.knex('daily_captures')
      .where('created_at', '<', cutoffDate)
      .select('id', 'exhibiciones');

    for (const dc of oldDailyCaptures) {
      if (dc.exhibiciones) {
        let exhibiciones: ExhibicionDiaria[] = [];
        try {
          exhibiciones =
            typeof dc.exhibiciones === 'string'
              ? JSON.parse(dc.exhibiciones)
              : dc.exhibiciones;
        } catch (e) {
          // Si el JSONB es inválido, loguear y skip esta captura (no abortar
          // el cron entero). Investigar el registro corrupto manualmente.
          this.logger.warn(
            `daily_captures.exhibiciones inválido para id=${dc.id}: ${(e as Error).message}. Skip.`,
          );
          continue;
        }

        let modified = false;
        for (const ex of exhibiciones) {
          if (ex.fotoPublicId) {
            try {
              await this.cloudinaryService.deleteImage(ex.fotoPublicId);
              this.logger.log(`Cloudinary: ${ex.fotoPublicId} borrado.`);
              delete ex.fotoPublicId;
              modified = true;
            } catch (err) {
              this.logger.error(`Error Cloudinary: ${ex.fotoPublicId}`);
            }
          }
        }

        if (modified) {
          await this.knex('daily_captures')
            .where({ id: dc.id })
            .update({ exhibiciones: JSON.stringify(exhibiciones) });
        }
      }
    }

    this.logger.log('Limpieza de fotos Cloudinary >30 días finalizada (registros BD preservados).');
  }
}
