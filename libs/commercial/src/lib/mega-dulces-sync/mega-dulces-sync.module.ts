import { Module } from '@nestjs/common';
import { MegaDulcesSyncService } from './mega-dulces-sync.service';
import { MegaDulcesSyncController } from './mega-dulces-sync.controller';

@Module({
  controllers: [MegaDulcesSyncController],
  providers: [MegaDulcesSyncService],
  exports: [MegaDulcesSyncService],
})
export class MegaDulcesSyncModule {}
