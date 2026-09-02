import { Module } from '@nestjs/common';
import { TiendaController } from './tienda.controller';
import { TiendaService } from './tienda.service';
import { CarritoController } from './carrito.controller';
import { CarritoService } from './carrito.service';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { PagosService } from './pagos.service';
import { PedidosService } from './pedidos.service';
import { ColaService } from './cola.service';
import { AvisosService } from './avisos.service';

@Module({
  // CheckoutController va ANTES que CarritoController: ambos declaran rutas
  // bajo 'tienda', y Nest resuelve por orden de registro.
  controllers: [TiendaController, CheckoutController, CarritoController],
  providers: [TiendaService, CarritoService, CheckoutService, PagosService,
              ColaService, PedidosService, AvisosService],
  exports:   [TiendaService, CarritoService, CheckoutService, PagosService,
              ColaService, PedidosService, AvisosService],
})
export class TiendaModule {
  constructor(
    private readonly pagos:  PagosService,
    private readonly cola:   ColaService,
    private readonly avisos: AvisosService,
  ) {}

  onModuleInit() {
    // Que la tienda no pueda cobrar con tarjeta tiene que verse en la bitácora
    // al arrancar, no descubrirse porque un cliente se quejó.
    this.pagos.avisarSiFalta();

    // El manejador se registra AQUÍ y no dentro de ColaService ni de
    // AvisosService: la cola necesita llamar a los avisos para enviarlos, y
    // los avisos necesitan la cola para encolarse. Registrarlo desde el
    // módulo, que conoce a los dos, evita esa dependencia circular.
    //
    // El manejador LANZA cuando el envío falla: así es como la cola sabe que
    // tiene que reintentar. Devolver un booleano se perdería.
    this.cola.registrar('aviso_cliente', async (carga) => {
      const id = Number(carga?.aviso_id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`Trabajo de aviso sin aviso_id válido: ${JSON.stringify(carga)}`);
      }
      const ok = await this.avisos.enviar(id);
      if (!ok) throw new Error(`No se pudo enviar el aviso ${id}`);
    });
  }
}
