import { Injectable, Logger, Inject } from '@nestjs/common';
import { UploadApiResponse, UploadApiErrorResponse } from 'cloudinary';
import { Readable } from 'stream';

let sharp: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sharp = require('sharp');
} catch (e) {
  // sharp is optional
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(@Inject('CLOUDINARY') private readonly cloudinary: any) {
    this.logger.log('Cloudinary Service initialized');
  }

  /**
   * Comprime una imagen usando sharp antes de subirla
   * @param buffer Buffer de la imagen original
   * @returns Buffer de la imagen comprimida
   */
  private async compressImage(buffer: Buffer): Promise<Buffer> {
    if (!sharp) {
      this.logger.warn('Sharp module not available. Skipping image compression.');
      return buffer;
    }

    try {
      this.logger.log('Comprimiendo imagen...');
      
      const compressedBuffer = await sharp(buffer)
        .resize({
          width: 1920,
          height: 1920,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({
          quality: 80,
          progressive: true,
          mozjpeg: true,
        })
        .toBuffer();

      const originalSize = buffer.length;
      const compressedSize = compressedBuffer.length;
      const compressionRatio = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);
      
      this.logger.log(
        `Imagen comprimida: ${originalSize} bytes -> ${compressedSize} bytes (${compressionRatio}% reducción)`,
      );

      return compressedBuffer;
    } catch (error) {
      this.logger.error('Error comprimiendo imagen:', error);
      return buffer;
    }
  }

  async uploadImage(
    file: Express.Multer.File,
    folder = 'trade_marketing',
  ): Promise<UploadApiResponse> {
    this.logger.log(`Iniciando carga de imagen (Buffer) a carpeta: ${folder}`);
    
    const compressedBuffer = await this.compressImage(file.buffer);
    
    return new Promise((resolve, reject) => {
      const upload = this.cloudinary.uploader.upload_stream(
        { folder },
        (error: UploadApiErrorResponse, result: UploadApiResponse) => {
          if (error) return reject(error);
          resolve(result);
        },
      );
      Readable.from(compressedBuffer).pipe(upload);
    });
  }

  async uploadImageBase64(base64Str: string, folder = 'trade_marketing'): Promise<UploadApiResponse> {
    this.logger.log(`Iniciando carga de imagen (Base64) a carpeta: ${folder}`);
    
    const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    const compressedBuffer = await this.compressImage(buffer);
    
    const compressedBase64 = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
    
    return this.cloudinary.uploader.upload(compressedBase64, { folder });
  }

  async deleteImage(publicId: string): Promise<any> {
    try {
      this.logger.log(`Solicitando borrado a Cloudinary: ${publicId}`);
      return await this.cloudinary.uploader.destroy(publicId);
    } catch (error) {
      this.logger.error(`Error borrando ${publicId}:`, error);
      throw error;
    }
  }
}
