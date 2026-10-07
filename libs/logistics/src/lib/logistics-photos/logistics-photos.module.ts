import { Module } from '@nestjs/common';
import { LogisticsPhotosService } from './logistics-photos.service';
import { LogisticsPhotosController } from './logistics-photos.controller';
import { CloudinaryModule } from '@megadulces/platform-core';

@Module({
  imports: [CloudinaryModule],
  controllers: [LogisticsPhotosController],
  providers: [LogisticsPhotosService],
  exports: [LogisticsPhotosService],
})
export class LogisticsPhotosModule {}
