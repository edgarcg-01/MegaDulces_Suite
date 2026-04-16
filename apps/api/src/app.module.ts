import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { ScoringV2Module } from './modules/scoring/scoring-v2.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StoresModule } from './modules/stores/stores.module';
import { VisitsModule } from './modules/visits/visits.module';
import { ExhibitionsModule } from './modules/exhibitions/exhibitions.module';
import { DailyAssignmentsModule } from './modules/daily-assignments/daily-assignments.module';
import { CronModule } from './modules/cron/cron.module';
import { VisitasSyncModule } from './modules/visitas/visitas-sync.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'view'),
      exclude: ['/api/{*path}'],
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    CapturesModule,
    DailyCapturesModule,
    PlanogramsModule,
    CatalogsModule,
    ScoringModule,
    ScoringV2Module,
    ReportsModule,
    StoresModule,
    VisitsModule,
    ExhibitionsModule,
    DailyAssignmentsModule,
    CronModule,
    VisitasSyncModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
