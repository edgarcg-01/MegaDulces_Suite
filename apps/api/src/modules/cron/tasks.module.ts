import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksService } from './tasks.service';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';

@Module({
  imports: [ScheduleModule.forRoot(), CloudinaryModule],
  providers: [TasksService]
})
export class TasksModule {}
