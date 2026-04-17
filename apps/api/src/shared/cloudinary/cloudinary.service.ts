import { Injectable, Logger, Inject } from '@nestjs/common';
import { UploadApiResponse, UploadApiErrorResponse } from 'cloudinary'; // solo tipos
import { Readable } from 'stream';
import sharp from 'sharp';

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
    try {
      this.logger.log('Comprimiendo imagen...');
      
      const compressedBuffer = await sharp(buffer)
        .resize({
          width: 1920, // Ancho máximo
          height: 1920, // Alto máximo
          fit: 'inside', // Mantener aspect ratio
          withoutEnlargement: true // No amplificar imágenes pequeñas
        })
        .jpeg({
          quality: 80, // Calidad JPEG (80%)
          progressive: true, // JPEG progresivo
          mozjpeg: true // Usar encoder mozjpeg si está disponible
        })
        .toBuffer();

      const originalSize = buffer.length;
      const compressedSize = compressedBuffer.length;
      const compressionRatio = ((originalSize - compressedSize) / originalSize * 100).toFixed(2);
      
      this.logger.log(
        `Imagen comprimida: ${originalSize} bytes -> ${compressedSize} bytes (${compressionRatio}% reducción)`
      );

      return compressedBuffer;
    } catch (error) {
      this.logger.error('Error comprimiendo imagen:', error);
      // Si falla la compresión, devolver el buffer original
      return buffer;
    }
  }

  async uploadImage(
    file: Express.Multer.File,
    folder = 'trade_marketing',
  ): Promise<UploadApiResponse> {
    this.logger.log(`Iniciando carga de imagen (Buffer) a carpeta: ${folder}`);
    
    // Comprimir imagen antes de subir
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
    
    // Convertir base64 a buffer
    const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Comprimir imagen
    const compressedBuffer = await this.compressImage(buffer);
    
    // Convertir de vuelta a base64 para subir
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
