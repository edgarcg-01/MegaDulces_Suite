import { Module } from '@nestjs/common';
import { KpConcentradaModule } from './kp-concentrada/kp-concentrada.module';
import { KpModule } from './kp/kp.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { CatalogoModule } from './catalogo/catalogo.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MonitorModule } from './monitor/monitor.module';
import { TiendaModule } from './tienda/tienda.module';

@Module({
  imports: [
    KpConcentradaModule,
    AuthModule,
    AdminModule,
    KpModule,
    CatalogoModule,
    DashboardModule,
    MonitorModule,
    TiendaModule,
  ],
})
export class AppModule {}
