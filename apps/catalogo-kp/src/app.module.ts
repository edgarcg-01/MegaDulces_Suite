import { Module } from '@nestjs/common';
import { PlatformDbModule } from './platform-db/platform-db.module';
import { KpModule } from './kp/kp.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { CatalogoModule } from './catalogo/catalogo.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MonitorModule } from './monitor/monitor.module';
import { TiendaModule } from './tienda/tienda.module';
import { SaludModule } from './salud/salud.module';

@Module({
  imports: [
    PlatformDbModule,
    AuthModule,
    AdminModule,
    KpModule,
    CatalogoModule,
    DashboardModule,
    MonitorModule,
    TiendaModule,
    SaludModule,
  ],
})
export class AppModule {}
