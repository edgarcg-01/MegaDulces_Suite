import { Module } from '@nestjs/common';
import { KpConcentradaModule } from './kp-concentrada/kp-concentrada.module';
import { KpModule } from './kp/kp.module';

// CV.1+ agrega aquí AuthModule, AdminModule, CatalogoModule, TiendaModule,
// MonitorModule, SalidasModule, DashboardModule — uno por sub-sprint, ver
// docs/IMPLEMENTACION/FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md.
@Module({
  imports: [KpConcentradaModule, KpModule],
})
export class AppModule {}
