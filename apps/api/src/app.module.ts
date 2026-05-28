import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { DatabaseModule } from './shared/database/database.module';
import { AbilityModule } from './shared/ability/ability.module';
import { UsersModule } from './modules/users/users.module';
import { DailyCapturesModule } from './modules/daily-captures/daily-captures.module';
import { PlanogramsModule } from './modules/planograms/planograms.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
// Fase K — AI product match en captures wizard paso 5.
import { AiProductMatcherModule } from './modules/ai-product-matcher/ai-product-matcher.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { ScoringV2Module } from './modules/scoring/scoring-v2.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StoresModule } from './modules/stores/stores.module';
import { VisitsModule } from './modules/visits/visits.module';
import { ExhibitionsModule } from './modules/exhibitions/exhibitions.module';
import { DailyAssignmentsModule } from './modules/daily-assignments/daily-assignments.module';
import { CronModule } from './modules/cron/cron.module';
import { VisitasSyncModule } from './modules/visitas/visitas-sync.module';
import { DataModule } from './modules/data/data.module';
import { ScheduleModule } from '@nestjs/schedule';
import { WebSocketModule } from './modules/websocket/websocket.module';
// Multi-tenant modules (nueva DB) — registrados condicionalmente via ENABLE_MULTITENANT
import { NewDatabaseModule } from './shared/database/new-database.module';
import { TenantModule } from './shared/tenant/tenant.module';
import { TenantContextInterceptor } from './shared/tenant/tenant-context.interceptor';
import { JwtAuthGuard } from './shared/auth/jwt-auth.guard';
import { AuthMtModule } from './modules/auth-mt/auth-mt.module';
import { TenantsAdminModule } from './modules/tenants-admin/tenants-admin.module';
// Fase B — Core comercial (corre dentro del toggle multi-tenant)
import { CommercialCustomersModule } from './modules/commercial-customers/commercial-customers.module';
import { CommercialWarehousesModule } from './modules/commercial-warehouses/commercial-warehouses.module';
import { CommercialPricingModule } from './modules/commercial-pricing/commercial-pricing.module';
import { CommercialInventoryModule } from './modules/commercial-inventory/commercial-inventory.module';
import { CommercialOrdersModule } from './modules/commercial-orders/commercial-orders.module';
import { CommercialAnalyticsModule } from './modules/commercial-analytics/commercial-analytics.module';
import { CommercialAlertsModule } from './modules/commercial-alerts/commercial-alerts.module';
import { CommercialRecommendationsModule } from './modules/commercial-recommendations/commercial-recommendations.module';
import { CommercialPromotionsModule } from './modules/commercial-promotions/commercial-promotions.module';
// Fase E — Remote Manager / Televenta
import { CommercialTeleventaModule } from './modules/commercial-televenta/commercial-televenta.module';
// Fase J — Logística
import { LogisticsFleetModule } from './modules/logistics-fleet/logistics-fleet.module';
import { LogisticsConfigModule } from './modules/logistics-config/logistics-config.module';
import { LogisticsShipmentsModule } from './modules/logistics-shipments/logistics-shipments.module';
import { LogisticsGuidesModule } from './modules/logistics-guides/logistics-guides.module';
import { LogisticsExpensesModule } from './modules/logistics-expenses/logistics-expenses.module';
import { LogisticsPayrollModule } from './modules/logistics-payroll/logistics-payroll.module';
import { LogisticsAnalyticsModule } from './modules/logistics-analytics/logistics-analytics.module';
// Fase J.8 — Migración desde repo origen: checklists, photos (Cloudinary), reports (jspdf)
import { LogisticsChecklistsModule } from './modules/logistics-checklists/logistics-checklists.module';
import { LogisticsPhotosModule } from './modules/logistics-photos/logistics-photos.module';
import { LogisticsReportsModule } from './modules/logistics-reports/logistics-reports.module';

// Toggle para incluir los módulos multi-tenant sin romper la app legacy.
// Setear ENABLE_MULTITENANT=true en .env para activarlos.
const multitenantModules = process.env.ENABLE_MULTITENANT === 'true'
  ? [
      NewDatabaseModule,
      TenantModule,
      AuthMtModule,
      TenantsAdminModule,
      CommercialCustomersModule,
      CommercialWarehousesModule,
      CommercialPricingModule,
      CommercialInventoryModule,
      CommercialOrdersModule,
      CommercialAnalyticsModule,
      CommercialAlertsModule,
      CommercialRecommendationsModule,
      CommercialPromotionsModule,
      CommercialTeleventaModule,
      LogisticsFleetModule,
      LogisticsConfigModule,
      LogisticsShipmentsModule,
      LogisticsGuidesModule,
      LogisticsExpensesModule,
      LogisticsPayrollModule,
      LogisticsAnalyticsModule,
      LogisticsChecklistsModule,
      LogisticsPhotosModule,
      LogisticsReportsModule,
    ]
  : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // Rate limiting global: 3 tiers (short/medium/long) por IP.
    // Defaults pensados para mobile + web admin. Endpoints sensibles
    // (login, upload) pueden tener @Throttle más estricto por método.
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 10 },     // 10 req/seg
      { name: 'medium', ttl: 10_000, limit: 60 },  // 60 req/10seg
      { name: 'long', ttl: 60_000, limit: 200 },   // 200 req/min
    ]),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'view'),
      // Exclude API routes y el namespace WS de /reports/socket.io.
      // Sin esta segunda exclusión, el fallback SPA respondía con index.html
      // al handshake de socket.io → cliente recibía "websocket error".
      exclude: ['/api/{*path}', '/reports/socket.io/{*path}'],
    }),
    DatabaseModule,
    AbilityModule,
    AuthModule,
    UsersModule,
    DailyCapturesModule,
    PlanogramsModule,
    AiProductMatcherModule,
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
    DataModule,
    WebSocketModule,
    ScheduleModule.forRoot(),
    ...multitenantModules,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // ThrottlerGuard como APP_GUARD global aplica los límites a todos los
    // endpoints. Endpoints específicos pueden usar @Throttle o @SkipThrottle.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Interceptor global: extrae tenant_id del Bearer JWT y abre scope CLS.
    // Endpoints públicos (sin Bearer) pasan sin scope. Solo activo cuando
    // ENABLE_MULTITENANT=true (TenantContextInterceptor vive en TenantModule
    // que se carga condicionalmente). Cuando el toggle está off, el provider
    // factory devuelve un no-op interceptor.
    ...(process.env.ENABLE_MULTITENANT === 'true'
      ? [
          // JwtAuthGuard global: rechaza 401 si no hay Bearer válido.
          // Endpoints marcados con @Public() (login, health) lo evitan.
          // Antes de este guard, sin auth los endpoints retornaban 500
          // confuso porque current_tenant_id() no estaba seteado y RLS
          // bloqueaba la query downstream.
          { provide: APP_GUARD, useClass: JwtAuthGuard },
          { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        ]
      : []),
  ],
})
export class AppModule {}
