import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

// CV.5 agrega `imports: [TiendaModule]` cuando las rutas de
// pedidos/pagos/cola vuelvan a este controller — ver admin.controller.ts.
@Module({
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
