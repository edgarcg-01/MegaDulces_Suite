import { Module } from '@nestjs/common';
import { KpConcentradaModule } from './kp-concentrada/kp-concentrada.module';
import { KpModule } from './kp/kp.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';

// CV.2+ agrega aquí CatalogoModule, TiendaModule, MonitorModule,
// SalidasModule, DashboardModule — uno por sub-sprint, ver
// docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md.
@Module({
  imports: [KpConcentradaModule, AuthModule, AdminModule, KpModule],
})
export class AppModule {}
