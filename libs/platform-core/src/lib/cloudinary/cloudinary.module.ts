import { Module } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryService } from './cloudinary.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'CLOUDINARY',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        cloudinary.config({
          cloud_name: config.get('CLOUDINARY_CLOUD_NAME'),
          api_key: config.get('CLOUDINARY_API_KEY'),
          api_secret: config.get('CLOUDINARY_API_SECRET'),
        });
        return cloudinary; // 👈 retorna la instancia completa
      },
    },
    CloudinaryService,
    // Object storage S3 (Railway Bucket) para comprobantes PDF — reemplaza Cloudinary.
    // Se provee acá para que los 7 flujos que ya importan CloudinaryModule lo reciban sin re-wirear.
    ObjectStorageService,
  ],
  exports: [CloudinaryService, ObjectStorageService, 'CLOUDINARY'],
})
export class CloudinaryModule {}
