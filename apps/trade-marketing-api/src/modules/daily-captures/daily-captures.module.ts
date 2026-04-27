import { Module } from '@nestjs/common';
import { DailyCapturesController } from './daily-captures.controller';
import { DailyCapturesService } from './daily-captures.service';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';

@Module({
  imports: [CloudinaryModule],
  controllers: [DailyCapturesController],
  providers: [DailyCapturesService],
})
export class DailyCapturesModule {}
