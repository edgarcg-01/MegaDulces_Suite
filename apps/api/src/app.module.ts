import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
// ServeStaticModule + join removidos — nginx sirve el SPA, NestJS solo /api/*.
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { DatabaseModule } from '@megadulces/platform-core';
import { VectorDatabaseModule } from '@megadulces/platform-core';
import { AbilityModule } from '@megadulces/platform-core';
import { UsersModule } from './modules/users/users.module';
import { DailyCapturesModule } from './modules/daily-captures/daily-captures.module';
import { PlanogramsModule } from './modules/planograms/planograms.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
// Fase K — AI product match en captures wizard paso 5.
import { AiProductMatcherModule } from './modules/ai-product-matcher/ai-product-matcher.module';
// Fase V — OCR del ticket del vendedor (Claude Haiku vision + matcher).
import { TicketExtractorModule } from './modules/ticket-extractor/ticket-extractor.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { ScoringV2Module } from './modules/scoring/scoring-v2.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StoresModule } from './modules/stores/stores.module';
import { VisitsModule } from './modules/visits/visits.module';
import { DailyAssignmentsModule } from './modules/daily-assignments/daily-assignments.module';
import { CronModule } from './modules/cron/cron.module';
import { DataModule } from './modules/data/data.module';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { WebSocketModule } from './modules/websocket/websocket.module';
// Multi-tenant modules (nueva DB) — registrados condicionalmente via ENABLE_MULTITENANT
import { NewDatabaseModule } from '@megadulces/platform-core';
import { TenantModule } from '@megadulces/platform-core';
import { TenantContextInterceptor } from '@megadulces/platform-core';
import { JwtAuthGuard } from '@megadulces/platform-core';
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
import { CommercialProductsModule } from './modules/commercial-products/commercial-products.module';
import { PortalAiOrderModule } from './modules/portal-ai-order/portal-ai-order.module';
import { CommercialCatalogSearchModule } from './modules/commercial-catalog-search/commercial-catalog-search.module';
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
// Sprint M — sync ERP Mega_Dulces (.245) → postgres_platform (nightly cron + admin endpoints)
import { MegaDulcesSyncModule } from './modules/mega-dulces-sync/mega-dulces-sync.module';

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
      CommercialProductsModule,
      PortalAiOrderModule,
      CommercialCatalogSearchModule,
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
      MegaDulcesSyncModule,
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
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'short', ttl: 1000, limit: 10 },     // 10 req/seg
        { name: 'medium', ttl: 10_000, limit: 60 },  // 60 req/10seg
        { name: 'long', ttl: 60_000, limit: 200 },   // 200 req/min
      ],
      // Bypass para regression suite. Setear THROTTLE_DISABLED=true en el
      // entorno del API antes de correr database/run-all-tests.js. NUNCA
      // dejarlo activo en prod.
      skipIf: () => process.env.THROTTLE_DISABLED === 'true',
    }),
    // ServeStaticModule REMOVIDO 2026-06-01: el SPA lo sirve nginx directo
    // desde /usr/share/nginx/html en el puerto $PORT. NestJS solo recibe
    // requests proxied por nginx con prefix /api/* o /reports/socket.io/*.
    // Mantener ServeStaticModule causaba un bug grave: el `exclude` con
    // patrón `/api/{*path}` no matcheaba bien en Express 5 + path-to-regexp
    // v8 → CUALQUIER request a NestJS que no resolvía a un controller caía
    // al fallback static y tiraba "ENOENT: stat dist/apps/view/index.html"
    // con 404 en JSON. Sin el módulo, Nest devuelve su 404 estándar para
    // rutas inexistentes, que es lo correcto.
    DatabaseModule,
    VectorDatabaseModule,
    AbilityModule,
    AuthModule,
    UsersModule,
    DailyCapturesModule,
    PlanogramsModule,
    AiProductMatcherModule,
    TicketExtractorModule,
    CatalogsModule,
    ScoringModule,
    ScoringV2Module,
    ReportsModule,
    StoresModule,
    VisitsModule,
    DailyAssignmentsModule,
    CronModule,
    DataModule,
    WebSocketModule,
    ScheduleModule.forRoot(),
    // Bus de eventos in-process para side-effects cross-domain (síncrono).
    // CONVENCIÓN: emitir SOLO post-commit (nunca dentro de una trx abierta).
    EventEmitterModule.forRoot(),
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
