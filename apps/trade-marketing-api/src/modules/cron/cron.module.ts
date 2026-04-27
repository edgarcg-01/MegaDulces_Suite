import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CronController } from './cron.controller';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';
import { DatabaseModule } from '../../shared/database/database.module';

@Module({
  imports: [CloudinaryModule, DatabaseModule],
  controllers: [CronController],
  providers: [TasksService],
})
export class CronModule {}
