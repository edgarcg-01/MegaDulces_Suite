import { Module } from '@nestjs/common';
import { SaludController } from './salud.controller';
import { SaludService } from './salud.service';

@Module({
  controllers: [SaludController],
  providers: [SaludService],
})
export class SaludModule {}
