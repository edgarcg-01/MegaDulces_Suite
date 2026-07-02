import { Module } from '@nestjs/common';
import { LogisticsHomeDispatchController } from './logistics-home-dispatch.controller';
import { LogisticsHomeDispatchService } from './logistics-home-dispatch.service';

/**
 * Fase LM.3 — despacho de pedidos a domicilio a repartidores en moto.
 * Crea embarque + guía + destinatario desde commercial.orders.delivery_address.
 * El check-in/salida y retorno reusan los endpoints de flota/embarques.
 */
@Module({
  controllers: [LogisticsHomeDispatchController],
  providers: [LogisticsHomeDispatchService],
  exports: [LogisticsHomeDispatchService],
})
export class LogisticsHomeDispatchModule {}
