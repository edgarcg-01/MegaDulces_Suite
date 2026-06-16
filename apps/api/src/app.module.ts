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
import { UsersModule } from '@megadulces/trade';
import { DailyCapturesModule } from '@megadulces/trade';
import { PlanogramsModule } from '@megadulces/trade';
import { CatalogsModule } from '@megadulces/trade';
// Fase K — AI product match en captures wizard paso 5.
import { AiProductMatcherModule } from '@megadulces/platform-core';
// Fase V — OCR del ticket del vendedor (Claude Haiku vision + matcher).
import { TicketExtractorModule } from '@megadulces/commercial';
import { ScoringModule } from '@megadulces/trade';
import { ScoringV2Module } from '@megadulces/trade';
import { ReportsModule } from '@megadulces/trade';
import { CommercialMapModule } from '@megadulces/trade';
import { StoresModule } from '@megadulces/trade';
import { VisitsModule } from '@megadulces/trade';
import { DailyAssignmentsModule } from '@megadulces/trade';
import { CronModule } from './modules/cron/cron.module';
import { DataModule } from '@megadulces/trade';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { WebSocketModule } from '@megadulces/trade';
// Multi-tenant modules (nueva DB) — registrados condicionalmente via ENABLE_MULTITENANT
import { NewDatabaseModule } from '@megadulces/platform-core';
import { TenantModule } from '@megadulces/platform-core';
import { TenantContextInterceptor } from '@megadulces/platform-core';
import { JwtAuthGuard } from '@megadulces/platform-core';
import { AuthMtModule } from './modules/auth-mt/auth-mt.module';
import { TenantsAdminModule } from './modules/tenants-admin/tenants-admin.module';
// Fase B — Core comercial (corre dentro del toggle multi-tenant)
import { CommercialCustomersModule } from '@megadulces/commercial';
import { CommercialWarehousesModule } from '@megadulces/commercial';
import { CommercialPricingModule } from '@megadulces/commercial';
import { CommercialInventoryModule } from '@megadulces/commercial';
import { CommercialOrdersModule } from '@megadulces/commercial';
import { CommercialAnalyticsModule } from '@megadulces/commercial';
import { CommercialAlertsModule } from '@megadulces/commercial';
import { CommercialRecommendationsModule } from '@megadulces/commercial';
// Fase M — Motor de Inteligencia: Customer 360 (feature store) + NBA (motor de decisión)
import { CommercialIntelligenceModule } from '@megadulces/commercial';
import { CommercialPromotionsModule } from '@megadulces/commercial';
import { CommercialProductsModule } from '@megadulces/commercial';
import { PortalAiOrderModule } from '@megadulces/commercial';
import { CommercialCatalogSearchModule } from '@megadulces/commercial';
// Fase E — Remote Manager / Televenta
import { CommercialTeleventaModule } from '@megadulces/commercial';
// Cierre de ruta — tickets venta/carga/combustible del vendedor (port Automation_RD)
import { CommercialRouteControlModule } from '@megadulces/commercial';
// Captura del vendedor — líneas de venta (OCR ticket) ancladas a la tienda
import { CommercialVendorSalesModule } from '@megadulces/commercial';
import { CommercialVendorRoutesModule } from '@megadulces/commercial';
import { CommercialTrackingModule } from '@megadulces/commercial';
// Observabilidad del Portal B2B (Web Vitals, errores, funnel)
import { CommercialTelemetryModule } from '@megadulces/commercial';
// Web Push del Portal B2B (notificaciones de pedido / promos)
import { CommercialPushModule } from '@megadulces/commercial';
// Fase J — Logística
import { LogisticsFleetModule } from '@megadulces/logistics';
import { LogisticsConfigModule } from '@megadulces/logistics';
import { LogisticsShipmentsModule } from '@megadulces/logistics';
import { LogisticsGuidesModule } from '@megadulces/logistics';
import { LogisticsExpensesModule } from '@megadulces/logistics';
import { LogisticsPayrollModule } from '@megadulces/logistics';
import { LogisticsAnalyticsModule } from '@megadulces/logistics';
// Fase J.8 — Migración desde repo origen: checklists, photos (Cloudinary), reports (jspdf)
import { LogisticsChecklistsModule } from '@megadulces/logistics';
import { LogisticsPhotosModule } from '@megadulces/logistics';
import { LogisticsReportsModule } from '@megadulces/logistics';
// Sprint M — sync ERP Mega_Dulces (.245) → postgres_platform (nightly cron + admin endpoints)
import { MegaDulcesSyncModule } from '@megadulces/commercial';
// Composition root: liga ORDER_FULFILLMENT_PORT (contracts) ← CommercialOrdersService.
// Permite que logística dispare el fulfill sin importar commercial (DI inversion).
import { OrderFulfillmentBindingModule } from './composition/order-fulfillment.binding.module';
import { CustomerProvisioningBindingModule } from './composition/customer-provisioning.binding.module';

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
      CommercialIntelligenceModule,
      CommercialPromotionsModule,
      CommercialProductsModule,
      PortalAiOrderModule,
      CommercialCatalogSearchModule,
      CommercialTeleventaModule,
      CommercialRouteControlModule,
      CommercialVendorSalesModule,
      CommercialVendorRoutesModule,
      CommercialTrackingModule,
      CommercialTelemetryModule,
      CommercialPushModule,
      // Binding del Port ANTES de logística (provee el token global que inyecta).
      OrderFulfillmentBindingModule,
      // Binding del Port de provisioning de clientes (StoresService lo inyecta @Optional).
      CustomerProvisioningBindingModule,
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
    CommercialMapModule,
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
