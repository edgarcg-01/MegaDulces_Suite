import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksService } from './tasks.service';
import { CloudinaryModule } from '@megadulces/platform-core';

@Module({
  imports: [ScheduleModule.forRoot(), CloudinaryModule],
  providers: [TasksService],
})
export class TasksModule {}
