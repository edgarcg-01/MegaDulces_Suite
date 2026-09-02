import { Module } from '@nestjs/common';
import { ErroresController } from './errores.controller';
import { ErroresService } from './errores.service';

@Module({
  controllers: [ErroresController],
  providers: [ErroresService],
  exports: [ErroresService],
})
export class MonitorModule {}
