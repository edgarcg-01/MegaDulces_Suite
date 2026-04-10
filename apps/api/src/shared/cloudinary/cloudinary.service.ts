import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
} from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(@Inject('CLOUDINARY') private cloudinaryConfig: any) {
    this.logger.log('Cloudinary Service initialized');

    // Verificar si faltan variables de entorno críticas
    const missing: string[] = [];
    if (!process.env.CLOUDINARY_CLOUD_NAME)
      missing.push('CLOUDINARY_CLOUD_NAME');
    if (!process.env.CLOUDINARY_API_KEY) missing.push('CLOUDINARY_API_KEY');
    if (!process.env.CLOUDINARY_API_SECRET)
      missing.push('CLOUDINARY_API_SECRET');

    if (missing.length > 0) {
      this.logger.warn(
        `¡ALERTA!: Faltan las siguientes variables de entorno para Cloudinary: ${missing.join(', ')}. ` +
          'Las fotos NO se almacenarán en producción hasta que se configuren.',
      );
    }
  }

  // Buffer (from Multer memory storage)
  async uploadImage(
    file: Express.Multer.File,
    folder: string = 'trade_marketing',
  ): Promise<UploadApiResponse> {
    this.logger.log(`Iniciando carga de imagen (Buffer) a carpeta: ${folder}`);
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        { folder },
        (error: UploadApiErrorResponse, result: UploadApiResponse) => {
          if (error) return reject(error);
          resolve(result);
        },
      );
      Readable.from(file.buffer).pipe(upload);
    });
  }

  // Base64 (from daily-captures)
  async uploadImageBase64(
    base64Str: string,
    folder: string = 'trade_marketing',
  ): Promise<UploadApiResponse> {
    console.log(
      '>>> CLOUDINARY INSTANCE CONFIG:',
      JSON.stringify(this.cloudinary.config()),
    );
    this.logger.log(`Iniciando carga de imagen (Base64) a carpeta: ${folder}`);
    return cloudinary.uploader.upload(base64Str, {
      folder,
    });
  }

  // Destruir imagen (para Cron Job)
  async deleteImage(publicId: string): Promise<any> {
    try {
      this.logger.log(`Solicitando borrado a Cloudinary: ${publicId}`);
      return await cloudinary.uploader.destroy(publicId);
    } catch (error) {
      this.logger.error(`Error borrando ${publicId}:`, error);
      throw error;
    }
  }
}
