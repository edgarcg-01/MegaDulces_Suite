import { Module } from '@nestjs/common';
import { PlatformDbModule } from './platform-db/platform-db.module';
import { KpModule } from './kp/kp.module';
import { SucursalesModule } from './sucursales/sucursales.module';
import { SaludModule } from './salud/salud.module';

// Recortado al verificador de precios de mostrador/kiosco (decisión del
// usuario, 2026-09-05): admin/usuarios, auth propio, catálogo interno,
// dashboard y la tienda pausada se retiran de este app -- ese trabajo sigue
// vivo en los repos standalone `catalogo-kp` y `Ecommerce-Mayorista`
// (https://github.com/0SistemasMD), separados de la integración a la Suite.
@Module({
  imports: [
    PlatformDbModule,
    KpModule,
    SucursalesModule,
    SaludModule,
  ],
})
export class AppModule {}
