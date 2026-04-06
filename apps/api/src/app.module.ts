import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { DatabaseModule } from './shared/database/database.module';
import { UsersModule } from './modules/users/users.module';
import { CapturesModule } from './modules/captures/captures.module';
import { DailyCapturesModule } from './modules/daily-captures/daily-captures.module';
import { PlanogramsModule } from './modules/planograms/planograms.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StoresModule } from './modules/stores/stores.module';
import { VisitsModule } from './modules/visits/visits.module';
import { ExhibitionsModule } from './modules/exhibitions/exhibitions.module';
import { DailyAssignmentsModule } from './modules/daily-assignments/daily-assignments.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'view', 'browser'),
      exclude: ['/api*'],
    }),
    DatabaseModule, 
    AuthModule, 
    UsersModule, 
    CapturesModule, 
    DailyCapturesModule,
    PlanogramsModule,
    CatalogsModule,
    ScoringModule,
    ReportsModule,
    StoresModule,
    VisitsModule,
    ExhibitionsModule,
    DailyAssignmentsModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
