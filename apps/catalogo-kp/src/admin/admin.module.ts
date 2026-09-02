import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { TiendaModule } from '../tienda/tienda.module';

@Module({
  // La configuración de cobro vive en PagosService, que es de la tienda: los
  // datos de Mercado Pago los usa el checkout, no la administración de
  // usuarios. Aquí sólo se expone para que un administrador pueda cambiarlos.
  imports: [TiendaModule],
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
