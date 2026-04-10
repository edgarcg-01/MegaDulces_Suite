import { Module } from '@nestjs/common';
import { ExhibitionsController } from './exhibitions.controller';
import { ExhibitionsService } from './exhibitions.service';
import { ScoringModule } from '../scoring/scoring.module';
import { CloudinaryModule } from '../../shared/cloudinary/cloudinary.module';

@Module({
  imports: [ScoringModule, CloudinaryModule],
  controllers: [ExhibitionsController],
  providers: [ExhibitionsService]
})
export class ExhibitionsModule {}
