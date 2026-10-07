// Port de inversión de dependencia: logística necesita disparar el fulfill
// de una orden comercial DENTRO de su misma transacción (atómico, anti-race).
// En vez de importar el servicio concreto de commercial (cruzaría la frontera
// de dominio), logística inyecta este token + interface. El binding al servicio
// real se hace en el composition root (app.module), único lugar que conoce
// ambos lados. Al extraer logística como servicio aparte, este binding se
// reemplaza por un cliente HTTP/RPC sin tocar el código de logística.

export const ORDER_FULFILLMENT_PORT = 'ORDER_FULFILLMENT_PORT';

export interface OrderFulfillmentPort {
  /**
   * Consume stock + escribe history + emite alerts para la orden, usando la
   * transacción provista (debe ser la misma trx abierta por el caller para
   * preservar atomicidad). `trx` se tipa `any` para no acoplar contracts a knex.
   * Idempotente: si la orden ya está fulfilled, no hace nada.
   */
  fulfillInTransaction(trx: any, orderId: string): Promise<unknown>;
}
