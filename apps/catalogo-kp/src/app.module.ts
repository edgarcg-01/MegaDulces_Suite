import { Module } from '@nestjs/common';
import { KpConcentradaModule } from './kp-concentrada/kp-concentrada.module';
import { KpModule } from './kp/kp.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { CatalogoModule } from './catalogo/catalogo.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MonitorModule } from './monitor/monitor.module';
import { TiendaModule } from './tienda/tienda.module';

// CV.4 (salidas) queda diferido — sin uso real hoy (confirmado 2026-09-01).
// Ver docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md.
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
