import { Injectable, Logger } from '@nestjs/common';
import { v2 as cloudinary, UploadApiResponse, UploadApiErrorResponse } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  // Buffer (from Multer memory storage)
  async uploadImage(
    file: Express.Multer.File,
    folder: string = 'trade_marketing',
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        { folder },
        (error: UploadApiErrorResponse, result: UploadApiResponse) => {
          if (error) return reject(error);
          resolve(result);
        }
      );
      Readable.from(file.buffer).pipe(upload);
    });
  }

  // Base64 (from daily-captures)
  async uploadImageBase64(
    base64Str: string,
    folder: string = 'trade_marketing'
  ): Promise<UploadApiResponse> {
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
