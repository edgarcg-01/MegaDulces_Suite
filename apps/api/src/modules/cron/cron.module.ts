import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CronController } from './cron.controller';
import { CloudinaryModule } from '@megadulces/platform-core';
import { DatabaseModule } from '@megadulces/platform-core';

@Module({
  imports: [CloudinaryModule, DatabaseModule],
  controllers: [CronController],
  providers: [TasksService],
})
export class CronModule {}
