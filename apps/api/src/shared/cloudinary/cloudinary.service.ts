import { Injectable, Logger, Inject } from '@nestjs/common';
import { UploadApiResponse, UploadApiErrorResponse } from 'cloudinary'; // solo tipos
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(@Inject('CLOUDINARY') private readonly cloudinary: any) { // 👈 instancia inyectada
    this.logger.log('Cloudinary Service initialized');
  }

  async uploadImage(
    file: Express.Multer.File,
    folder = 'trade_marketing',
  ): Promise<UploadApiResponse> {
    this.logger.log(`Iniciando carga de imagen (Buffer) a carpeta: ${folder}`);
    return new Promise((resolve, reject) => {
      const upload = this.cloudinary.uploader.upload_stream( // 👈
        { folder },
        (error: UploadApiErrorResponse, result: UploadApiResponse) => {
          if (error) return reject(error);
          resolve(result);
        },
      );
      Readable.from(file.buffer).pipe(upload);
    });
  }

  async uploadImageBase64(base64Str: string, folder = 'trade_marketing'): Promise<UploadApiResponse> {
    this.logger.log(`Iniciando carga de imagen (Base64) a carpeta: ${folder}`);
    return this.cloudinary.uploader.upload(base64Str, { folder }); // 👈
  }

  async deleteImage(publicId: string): Promise<any> {
    try {
      this.logger.log(`Solicitando borrado a Cloudinary: ${publicId}`);
      return await this.cloudinary.uploader.destroy(publicId); // 👈
    } catch (error) {
      this.logger.error(`Error borrando ${publicId}:`, error);
      throw error;
    }
  }
}